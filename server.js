require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { generateICS } = require('./ics-generator');

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_FILE = process.env.VERCEL
  ? path.join('/tmp', 'cache.json')
  : path.join(__dirname, 'cache.json');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cache helpers
function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error reading cache:', err);
  }
  return {};
}

function writeCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing cache:', err);
  }
}

/**
 * Matching logic: check if user's selected section letter matches the class session's section suffix.
 * e.g., if user section is "A", session sections like "BJ25-4-A" and "BJ25-4-ABCD" will match.
 */
function sessionMatchesSection(session, userSections) {
  // If session has no course offer, keep it
  if (!session.courseOfferId) return true;

  // Get the user's selected section for this course offer
  const userSection = userSections[session.courseOfferId];
  if (!userSection) return true; // If no section selected for this course, default to show it

  // Get the session's section code
  const sectionCode = session.section?.sectionCode || session.sectionCode || '';
  if (!sectionCode) return true; // If session has no section code, it is for everyone

  // Split by hyphen to get the suffix (e.g. "BJ25-4-A" -> "A", "BJ25-4-ABCD" -> "ABCD")
  const parts = sectionCode.split('-');
  const suffix = parts[parts.length - 1].toUpperCase();

  const uSec = userSection.toUpperCase().trim();

  // Check if the user's section letter is in the suffix (e.g. 'A' in 'ABCD')
  return suffix.includes(uSec);
}

/**
 * Activity filtering logic: check if the activity is academic and if its prefix code
 * matches any of the student's registered course codes.
 * e.g., "LSC - Quiz" matches only if student has course "LSC".
 */
function activityMatchesCourses(activity, registeredCourses) {
  if (activity.type !== 'Academic') {
    return true; // Keep all non-academic activities
  }

  const name = activity.name || '';
  // Look for a pattern like "CODE - Activity Name" (e.g., "SDM - Mid-Term" or "LSC - Quiz")
  const match = name.match(/^([A-Za-z0-9]+)\s*-\s*/);
  if (!match) {
    return true; // If it doesn't match the pattern, keep it (fail-safe)
  }

  const courseCodePrefix = match[1].toUpperCase().trim();

  // Check if this courseCodePrefix matches any of the user's registered course codes
  const hasCourse = registeredCourses.some(c => {
    const code = (c.courseCode || '').toUpperCase().trim();
    return code === courseCodePrefix;
  });

  return hasCourse;
}

/**
 * Core helper to login and fetch timetable data from XLRI ERP
 */
async function fetchXLRIERPData(email, password) {
  const ERP_BASE = 'https://xlerp.xlri.ac.in/api/v1';

  console.log(`[ERP] Authenticating user: ${email}`);
  
  // 1. Login
  const loginRes = await axios.post(`${ERP_BASE}/auth/login`, {
    email,
    password
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000
  });

  const loginData = loginRes.data;
  
  // Verify if 2FA is triggered
  if (loginData.requiresAction === '2fa') {
    throw new Error('Two-factor authentication (OTP) is required on this account. This calendar integration only supports direct login (no OTP). Please disable OTP in your ERP security settings.');
  }

  // Support both direct root token or nested data.token
  const token = loginData.token || loginData.data?.token;
  if (!token) {
    throw new Error('Authentication succeeded but no access token was returned.');
  }

  console.log(`[ERP] Login successful. Token retrieved.`);

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  // 2. Fetch profile info
  let profile = {};
  try {
    const profileRes = await axios.get(`${ERP_BASE}/auth/me`, { headers, timeout: 10000 });
    profile = profileRes.data?.data || profileRes.data || {};
  } catch (err) {
    console.warn(`[ERP] Warning: Failed to fetch profile details: ${err.message}`);
    profile = { email };
  }

  // Calculate dynamic date range (current date - 15 days to current date + 90 days)
  const now = new Date();
  const start = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);

  console.log(`[ERP] Fetching schedule from ${startDate} to ${endDate}`);

  // 3. Fetch all registered courses, sessions, activities, and holidays concurrently
  const [coursesRes, sessionsRes, activitiesRes, holidaysRes] = await Promise.all([
    axios.get(`${ERP_BASE}/course-offerings/my`, {
      headers,
      params: { limit: 100 }, // Fetch all registered courses without 'time' filter
      timeout: 15000
    }),
    axios.get(`${ERP_BASE}/schedule/my-schedule/student`, {
      headers,
      params: { startDate, endDate },
      timeout: 15000
    }),
    axios.get(`${ERP_BASE}/class-activities/my`, {
      headers,
      params: { startDate, endDate },
      timeout: 15000
    }),
    axios.get(`${ERP_BASE}/schedule/holidays/my`, {
      headers,
      params: { startDate, endDate },
      timeout: 15000
    })
  ]);

  // Extract schedule arrays first
  const sessions = sessionsRes.data?.data || sessionsRes.data || [];
  
  const rawActivities = activitiesRes.data?.data || activitiesRes.data || [];
  const activities = Array.isArray(rawActivities) ? rawActivities : (rawActivities.data || []);
  
  const holidays = holidaysRes.data?.data || holidaysRes.data || [];

  // Find all courseOfferIds that actually have active scheduled sessions
  const scheduledCourseOfferIds = new Set(sessions.map(s => s.courseOfferId).filter(Boolean));

  // Extract and filter courses: only keep registered courses that have active scheduled sessions in the date range
  const coursesData = coursesRes.data?.data || coursesRes.data || [];
  const rawCourses = Array.isArray(coursesData) ? coursesData : (coursesData.data || []);
  const courses = rawCourses
    .map(c => ({
      id: c.id || c.courseOfferId,
      courseCode: c.course?.courseCode || c.courseCode || '',
      courseName: c.course?.courseName || c.courseName || '',
      courseOfferCode: c.courseOfferCode || ''
    }))
    .filter(c => scheduledCourseOfferIds.has(c.id));

  console.log(`[ERP] Successfully fetched ${courses.length} active registered courses, ${sessions.length} sessions, ${activities.length} activities, ${holidays.length} holidays.`);

  return {
    profile,
    courses,
    sessions,
    activities,
    holidays
  };
}

/**
 * 1. Main calendar subscription endpoint (.ics feed)
 * Example: GET /api/calendar?email=abc@xlri.ac.in&password=my_password
 */
app.get('/api/calendar', async (req, res) => {
  const { email, password } = req.query;

  if (!email || !password) {
    res.setHeader('Content-Type', 'text/plain');
    return res.status(400).send('Error: Missing email or password query parameters.');
  }

  const cache = readCache();
  const cachedData = cache[email.toLowerCase()];
  const now = Date.now();
  const cacheDuration = 5 * 60 * 1000; // Cache for 5 minutes
  if (cachedData && cachedData.icsContent && (now - cachedData.cachedAt < cacheDuration)) {
    console.log(`[Calendar] Serving cached calendar for ${email} (Cache Age: ${Math.round((now - cachedData.cachedAt) / 60000)}m)`);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="calendar.ics"');
    return res.send(cachedData.icsContent);
  }

  // Refresh cache
  try {
    const data = await fetchXLRIERPData(email, password);
    const sections = cachedData?.sections || {};

    // Filter sessions: only include if they correspond to an active registered course AND match the section filter
    const activeCourseOfferIds = new Set(data.courses.map(c => c.id));
    const filteredSessions = data.sessions.filter(s => {
      if (!s.courseOfferId) return true; // keep general sessions
      if (!activeCourseOfferIds.has(s.courseOfferId)) return false; // exclude if not registered
      return sessionMatchesSection(s, sections); // check section match
    });

    // Filter activities: only keep academic activities if they belong to registered courses
    const filteredActivities = data.activities.filter(act => activityMatchesCourses(act, data.courses));
    
    const icsContent = generateICS(filteredSessions, filteredActivities, data.holidays);

    // Save to cache (raw data + current sections)
    cache[email.toLowerCase()] = {
      cachedAt: now,
      icsContent,
      sessions: data.sessions, // Store raw sessions list
      activities: data.activities,
      holidays: data.holidays,
      profile: data.profile,
      courses: data.courses,
      sections
    };
    writeCache(cache);

    console.log(`[Calendar] Generated and cached new calendar feed for ${email}`);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="calendar.ics"');
    return res.send(icsContent);
  } catch (err) {
    console.error(`[Calendar] Error compiling feed for ${email}: ${err.message}`);
    
    // Fail-safe: Return stale cache if available, so Google Calendar doesn't throw sync errors
    if (cachedData && cachedData.icsContent) {
      console.log(`[Calendar] Returning stale cache fallback for ${email} due to ERP connection error.`);
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="calendar.ics"');
      return res.send(cachedData.icsContent);
    }

    res.setHeader('Content-Type', 'text/plain');
    return res.status(500).send(`Error fetching calendar feed from XLRI ERP: ${err.message}`);
  }
});

/**
 * 2. Preview endpoint
 * Authenticates user, generates/updates cache, and returns JSON structure for visual preview
 */
app.post('/api/preview', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Missing email or password.' });
  }

  try {
    const data = await fetchXLRIERPData(email, password);
    
    // Get existing sections from cache if any
    const cache = readCache();
    const cachedData = cache[email.toLowerCase()];
    const sections = cachedData?.sections || {};

    // Filter sessions: only include if they correspond to an active registered course AND match the section filter
    const activeCourseOfferIds = new Set(data.courses.map(c => c.id));
    const filteredSessions = data.sessions.filter(s => {
      if (!s.courseOfferId) return true;
      if (!activeCourseOfferIds.has(s.courseOfferId)) return false;
      return sessionMatchesSection(s, sections);
    });

    // Filter activities: only keep academic activities if they belong to registered courses
    const filteredActivities = data.activities.filter(act => activityMatchesCourses(act, data.courses));
    
    const icsContent = generateICS(filteredSessions, filteredActivities, data.holidays);

    // Save to cache (raw data + current sections)
    cache[email.toLowerCase()] = {
      cachedAt: Date.now(),
      icsContent,
      sessions: data.sessions, // Store raw
      activities: data.activities,
      holidays: data.holidays,
      profile: data.profile,
      courses: data.courses,
      sections
    };
    writeCache(cache);

    // Return visual metadata
    return res.json({
      success: true,
      profile: data.profile,
      courses: data.courses,
      savedSections: sections,
      sessionsCount: filteredSessions.length,
      activitiesCount: filteredActivities.length,
      holidaysCount: data.holidays.length,
      sessions: filteredSessions, // Return filtered sessions list
      activities: filteredActivities,
      holidays: data.holidays
    });
  } catch (err) {
    console.error(`[Preview] Error fetching preview for ${email}: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * 3. Save sections endpoint
 * Updates sections map, filters cached sessions, and regenerates the calendar feed
 */
app.post('/api/save-sections', async (req, res) => {
  const { email, password, sections } = req.body;

  if (!email || !password || !sections) {
    return res.status(400).json({ error: 'Missing email, password, or sections.' });
  }

  try {
    const cache = readCache();
    let cachedData = cache[email.toLowerCase()];

    // If cache doesn't exist, fetch fresh data from ERP
    if (!cachedData) {
      console.log(`[Sections] Cache not found for ${email}. Fetching fresh ERP data...`);
      const freshData = await fetchXLRIERPData(email, password);
      cachedData = {
        cachedAt: Date.now(),
        sessions: freshData.sessions,
        activities: freshData.activities,
        holidays: freshData.holidays,
        profile: freshData.profile,
        courses: freshData.courses,
        sections: {}
      };
    }

    // Save updated sections
    cachedData.sections = sections;

    // Filter sessions using updated sections map and registered courses list
    const activeCourseOfferIds = new Set(cachedData.courses.map(c => c.id));
    const filteredSessions = cachedData.sessions.filter(s => {
      if (!s.courseOfferId) return true;
      if (!activeCourseOfferIds.has(s.courseOfferId)) return false;
      return sessionMatchesSection(s, sections);
    });

    // Filter activities: only keep academic activities if they belong to registered courses
    const filteredActivities = cachedData.activities.filter(act => activityMatchesCourses(act, cachedData.courses));
    
    // Regenerate ICS Content
    const icsContent = generateICS(filteredSessions, filteredActivities, cachedData.holidays);
    cachedData.icsContent = icsContent;
    cachedData.cachedAt = Date.now(); // Reset cache age so calendar fetches the new version

    cache[email.toLowerCase()] = cachedData;
    writeCache(cache);

    console.log(`[Sections] Updated course sections and regenerated calendar for ${email}`);

    return res.json({
      success: true,
      sessions: filteredSessions,
      sessionsCount: filteredSessions.length
    });
  } catch (err) {
    console.error(`[Sections] Error saving sections for ${email}: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// Fallback to serve the dashboard on direct routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(` XLRI ERP Google Calendar Bot is running locally!`);
  console.log(` URL: http://localhost:${PORT}`);
  console.log(`==================================================`);
});
