require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { generateICS } = require('./ics-generator');
const { initBot } = require('./bot');
const { fetchXLRIERPData, sessionMatchesSection, activityMatchesCourses } = require('./erp-client');
const { getUser } = require('./database');

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

/**
 * 4. Fetch schedule by Telegram chatId
 * Example: GET /api/telegram-schedule?chatId=12345678
 */
app.get('/api/telegram-schedule', async (req, res) => {
  const { chatId } = req.query;

  if (!chatId) {
    return res.status(400).json({ error: 'Missing chatId query parameter.' });
  }

  try {
    const user = await getUser(chatId);
    if (!user) {
      return res.status(404).json({ error: 'User registration not found. Please register in the Telegram bot using /login.' });
    }

    const cache = readCache();
    let cachedData = cache[user.email.toLowerCase()];
    const now = Date.now();
    const cacheDuration = 5 * 60 * 1000; // Cache for 5 minutes

    // If cache is stale or missing, refresh from ERP
    if (!cachedData || (now - cachedData.cachedAt >= cacheDuration)) {
      console.log(`[API] Refreshing ERP cache for chatId: ${chatId} (${user.email})`);
      try {
        const data = await fetchXLRIERPData(user.email, user.password);
        cachedData = {
          cachedAt: now,
          sessions: data.sessions,
          activities: data.activities,
          holidays: data.holidays,
          profile: data.profile,
          courses: data.courses,
          sections: user.sections // Use sections from DB
        };
        // Generate temporary ICS content for the cache file helper
        cachedData.icsContent = '';
        cache[user.email.toLowerCase()] = cachedData;
        writeCache(cache);
      } catch (err) {
        console.error(`[API] ERP connection error during background refresh for ${user.email}: ${err.message}`);
        // If cache exists, fall back to stale cache
        if (!cachedData) {
          return res.status(500).json({ error: `Failed to fetch data from XLRI ERP: ${err.message}` });
        }
      }
    }

    // Filter sessions & activities using user's section choices
    const activeCourseOfferIds = new Set(cachedData.courses.map(c => c.id));
    const filteredSessions = cachedData.sessions.filter(s => {
      if (!s.courseOfferId) return true;
      if (!activeCourseOfferIds.has(s.courseOfferId)) return false;
      return sessionMatchesSection(s, user.sections);
    });

    const filteredActivities = cachedData.activities.filter(act => {
      return activityMatchesCourses(act, cachedData.courses);
    });

    return res.json({
      success: true,
      profile: cachedData.profile,
      courses: cachedData.courses,
      sections: user.sections,
      sessions: filteredSessions,
      activities: filteredActivities,
      holidays: cachedData.holidays
    });

  } catch (err) {
    console.error(`[API] Error fetching Telegram schedule for chatId ${chatId}: ${err.message}`);
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
  
  // Start the Telegram Bot (if token is defined)
  initBot();
});




