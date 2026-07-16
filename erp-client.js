const axios = require('axios');

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

async function fetchXLRIERPMessMenu(email, password) {
  const ERP_BASE = 'https://xlerp.xlri.ac.in/api/v1';
  console.log(`[ERP] Fetching mess menu for user: ${email}`);
  const loginRes = await axios.post(`${ERP_BASE}/auth/login`, {
    email,
    password
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000
  });

  const token = loginRes.data?.token || loginRes.data?.data?.token;
  if (!token) {
    throw new Error('Authentication failed.');
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  const menuRes = await axios.get(`${ERP_BASE}/mess-menu/me`, { headers, timeout: 10000 });
  return menuRes.data;
}

async function fetchXLRIERPGrades(email, password) {
  const ERP_BASE = 'https://xlerp.xlri.ac.in/api/v1';
  console.log(`[ERP] Fetching grades for user: ${email}`);
  const loginRes = await axios.post(`${ERP_BASE}/auth/login`, {
    email,
    password
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000
  });

  const token = loginRes.data?.token || loginRes.data?.data?.token;
  if (!token) {
    throw new Error('Authentication failed.');
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  const gradesRes = await axios.get(`${ERP_BASE}/course-offerings/me/grades`, { headers, timeout: 10000 });
  return gradesRes.data;
}

async function fetchXLRIERPAttendance(email, password) {
  const ERP_BASE = 'https://xlerp.xlri.ac.in/api/v1';
  console.log(`[ERP] Fetching attendance for user: ${email}`);

  const loginRes = await axios.post(`${ERP_BASE}/auth/login`, {
    email,
    password
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000
  });

  const token = loginRes.data?.token || loginRes.data?.data?.token;
  if (!token) {
    throw new Error('Authentication failed.');
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  const gradesRes = await axios.get(`${ERP_BASE}/course-offerings/me/grades`, { headers, timeout: 15000 });
  const terms = gradesRes.data?.data?.terms || [];

  const nowStr = new Date().toISOString().slice(0, 10);
  // Filter terms that have started
  const startedTerms = terms.filter(t => t.startDate && t.startDate.slice(0, 10) <= nowStr);
  // Sort by startDate descending to get the most recent term
  startedTerms.sort((a, b) => b.startDate.localeCompare(a.startDate));
  const currentTerm = startedTerms[0];

  if (!currentTerm || !currentTerm.courses) {
    return {
      termName: 'No active term',
      termCode: '',
      attendance: []
    };
  }

  const promises = currentTerm.courses.map(async (c) => {
    const url = `${ERP_BASE}/attendance/student/${c.enrollmentId}`;
    try {
      const res = await axios.get(url, { headers, timeout: 10000 });
      const records = res.data?.data || [];

      const total = records.length;
      const attended = records.filter(r => r.isPresent === true).length;

      let percent = 100;
      if (total > 0) {
        percent = Math.round((attended / total) * 1000) / 10;
      }

      let band = 'safe';
      if (percent < 75) band = 'danger';
      else if (percent < 80) band = 'warning';

      // Calculate bunk verdict
      let skippable = 0;
      while (total + skippable + 1 > 0 && attended / (total + skippable + 1) >= 0.75) {
        skippable += 1;
      }

      let needed = 0;
      if (percent < 75) {
        while ((attended + needed) / (total + needed) < 0.75) {
          needed += 1;
        }
      }

      const bunkVerdict = percent >= 75
        ? { mode: 'skip', count: skippable }
        : { mode: 'recover', count: needed };

      return {
        courseCode: c.courseCode,
        courseName: c.courseName,
        total,
        attended,
        percent,
        band,
        bunkVerdict
      };
    } catch (err) {
      console.error(`[ERP] Failed to fetch attendance for ${c.courseName}:`, err.message);
      return {
        courseCode: c.courseCode,
        courseName: c.courseName,
        total: 0,
        attended: 0,
        percent: 100,
        band: 'safe',
        bunkVerdict: { mode: 'skip', count: 0 },
        error: err.message
      };
    }
  });

  const results = await Promise.all(promises);
  return {
    termName: currentTerm.termName,
    termCode: currentTerm.termCode,
    attendance: results
  };
}

module.exports = {
  sessionMatchesSection,
  activityMatchesCourses,
  fetchXLRIERPData,
  fetchXLRIERPMessMenu,
  fetchXLRIERPGrades,
  fetchXLRIERPAttendance
};
