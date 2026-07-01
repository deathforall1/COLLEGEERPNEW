const cron = require('node-cron');
const { getAllUsers, getUserScheduleState, saveUserScheduleState, getSessionNotes } = require('./database');
const { fetchXLRIERPData, sessionMatchesSection, activityMatchesCourses } = require('./erp-client');

// Helper to format Date into YYYY-MM-DD
function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

// Staggered queue helper to prevent overloading ERP or hitting Render RAM limit
async function processBatch(users, bot) {
  console.log(`[Scheduler] Starting daily alert sweep for ${users.length} users.`);
  
  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    console.log(`[Scheduler] Processing user ${i + 1}/${users.length}: ${user.email}`);
    
    try {
      // 1. Fetch fresh ERP data & session notes
      const [data, sessionNotes] = await Promise.all([
        fetchXLRIERPData(user.email, user.password),
        getSessionNotes(user.chatId)
      ]);
      
      // Calculate target date (today) in Asia/Kolkata timezone
      const tzOffset = 5.5 * 60 * 60 * 1000; // IST is UTC+5.5
      const nowIST = new Date(Date.now() + tzOffset);
      const todayStr = formatDate(nowIST);
      
      // 2. Filter sessions for today
      const activeCourseOfferIds = new Set(data.courses.map(c => c.id));
      const todaySessions = data.sessions.filter(s => {
        if (s.classDate !== todayStr) return false;
        if (!s.courseOfferId) return true; // Keep general announcements
        if (!activeCourseOfferIds.has(s.courseOfferId)) return false; // Must be registered
        return sessionMatchesSection(s, user.sections); // Match section
      });
      
      // Sort today sessions by start time
      todaySessions.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
      
      // 3. Filter activities for the next 7 days
      const sevenDaysLater = new Date(nowIST.getTime() + 7 * 24 * 60 * 60 * 1000);
      const sevenDaysLaterStr = formatDate(sevenDaysLater);
      
      const upcomingActivities = data.activities.filter(act => {
        if (!act.date) return false;
        if (act.date < todayStr || act.date > sevenDaysLaterStr) return false;
        return activityMatchesCourses(act, data.courses);
      });
      
      // Sort activities by date and start time
      upcomingActivities.sort((a, b) => {
        const dateComp = a.date.localeCompare(b.date);
        if (dateComp !== 0) return dateComp;
        return (a.startTime || '').localeCompare(b.startTime || '');
      });
      
      // 4. Construct Telegram Message
      let message = `📅 *XLRI Schedule for Today (${todayStr})*\n\n`;
      
      if (todaySessions.length === 0) {
        message += `🎉 *No classes scheduled today!* Enjoy your day.\n\n`;
      } else {
        todaySessions.forEach(s => {
          const startTime = (s.startTime || '').slice(0, 5);
          const endTime = (s.endTime || '').slice(0, 5);
          const courseName = s.course?.courseName || 'Class';
          const courseCode = s.course?.courseCode ? ` (${s.course.courseCode})` : '';
          const venue = s.venue?.name ? `${s.venue.name}${s.venue.code ? ` (${s.venue.code})` : ''}` : 'Not Specified';
          const faculty = s.faculty ? [s.faculty.prefix, s.faculty.firstName, s.faculty.lastName].filter(Boolean).join(' ') : 'Not Specified';
          const status = s.status === 'cancelled' ? '❌ *CANCELLED* ' : '';
          
          let classMsg = `🕒 *${startTime} - ${endTime}*\n📚 *${status}${courseName}${courseCode}*\n📍 Venue: ${venue}\n👨‍🏫 Faculty: ${faculty}\n`;
          
          // Print note if present
          const sessionId = s.sessionId || `session-${s.classDate}-${s.startTime}`;
          if (sessionNotes && sessionNotes[sessionId]) {
            classMsg += `📌 *Note:* _${sessionNotes[sessionId]}_\n`;
          }
          
          message += classMsg + `\n`;
        });
      }
      
      message += `🔔 *Upcoming Activities (Next 7 Days)*\n`;
      if (upcomingActivities.length === 0) {
        message += `✅ No quizzes or activities scheduled.\n`;
      } else {
        upcomingActivities.forEach(act => {
          const actDate = act.date;
          const startTime = (act.startTime || '').slice(0, 5);
          const name = act.name || 'Activity';
          const venue = act.venue?.name ? `📍 ${act.venue.name}` : '';
          
          const isExam = /exam|quiz|term/i.test(name);
          const emoji = isExam ? '⚠️' : '•';
          const styledName = isExam ? `*${name.toUpperCase()}*` : name;
          
          message += `${emoji} *[${actDate}] ${startTime}* - ${styledName} ${venue}\n`;
        });
      }
      
      // Send message to Telegram Chat
      await bot.sendMessage(user.chatId, message, { parse_mode: 'Markdown' });
      console.log(`[Scheduler] Alert sent successfully to ${user.email}`);
      
    } catch (err) {
      console.error(`[Scheduler] Failed to process user ${user.email}:`, err.message);
      
      // Send error alert to the user so they know ERP sync failed
      try {
        await bot.sendMessage(user.chatId, `⚠️ *ERP Schedule Sync Alert*\nFailed to automatically refresh your schedule from XLRI ERP: ${err.message}. Please check your login credentials with /login or try again later.`, { parse_mode: 'Markdown' });
      } catch (tgErr) {
        console.error(`[Scheduler] Could not send error message to telegram for ${user.email}:`, tgErr.message);
      }
    }
    
    // Stagger next execution by 3 seconds
    if (i < users.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  
  console.log('[Scheduler] Finished daily alert sweep.');
}

// Background scheduler checker for real-time changes
async function checkScheduleChanges(bot) {
  console.log('[Scheduler] Starting schedule change check sweep.');
  const users = await getAllUsers();
  if (users.length === 0) {
    console.log('[Scheduler] No registered users to check.');
    return;
  }

  const tzOffset = 5.5 * 60 * 60 * 1000;
  const nowIST = new Date(Date.now() + tzOffset);
  const todayStr = formatDate(nowIST);

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    console.log(`[Scheduler] Checking changes for user ${i + 1}/${users.length}: ${user.email}`);

    try {
      // 1. Fetch fresh ERP data
      const data = await fetchXLRIERPData(user.email, user.password);
      
      // 2. Filter sessions (registered courses & sections)
      const activeCourseOfferIds = new Set(data.courses.map(c => c.id));
      const filteredSessions = data.sessions.filter(s => {
        if (!s.courseOfferId) return true; // General announcements
        if (!activeCourseOfferIds.has(s.courseOfferId)) return false; // Must be registered
        return sessionMatchesSection(s, user.sections); // Match section
      });

      // 3. Filter activities (registered courses)
      const filteredActivities = data.activities.filter(act => {
        return activityMatchesCourses(act, data.courses);
      });

      // 4. Retrieve last state
      const lastState = await getUserScheduleState(user.chatId);
      const isFirstRun = !lastState || Object.keys(lastState).length === 0;

      const oldSessions = lastState.sessions || {};
      const newSessions = {};
      const alerts = [];

      // Process sessions
      filteredSessions.forEach(s => {
        const id = s.sessionId || `session-${s.classDate}-${s.startTime}`;
        const state = {
          courseCode: s.course?.courseCode || '',
          courseName: s.course?.courseName || 'Class',
          classDate: s.classDate,
          startTime: s.startTime || '',
          endTime: s.endTime || '',
          venue: s.venue?.name || '',
          status: s.status || 'scheduled'
        };
        newSessions[id] = state;

        if (!isFirstRun) {
          const old = oldSessions[id];
          if (!old) {
            // New class scheduled (only alert if date is today or future)
            if (s.classDate >= todayStr) {
              const timeStr = s.startTime ? ` at ${s.startTime.slice(0, 5)}` : '';
              alerts.push(`🆕 *New Class Scheduled!*\n📚 *${state.courseName}${state.courseCode ? ` (${state.courseCode})` : ''}*\n📅 Date: ${s.classDate}${timeStr}\n📍 Venue: ${state.venue || 'Not Specified'}`);
            }
          } else {
            // Check for changes
            const timeChanged = old.startTime !== state.startTime || old.endTime !== state.endTime;
            const dateChanged = old.classDate !== state.classDate;
            const venueChanged = old.venue !== state.venue;
            const statusChanged = old.status !== state.status;

            if (statusChanged && state.status === 'cancelled') {
              const oldTimeStr = old.startTime ? ` at ${old.startTime.slice(0, 5)}` : '';
              alerts.push(`❌ *Class Cancelled!*\n📚 *${state.courseName}${state.courseCode ? ` (${state.courseCode})` : ''}*\n📅 Date: ${state.classDate}${oldTimeStr}`);
            } else if (dateChanged || timeChanged || venueChanged) {
              const oldTimeStr = old.startTime ? `${old.startTime.slice(0, 5)} - ${old.endTime.slice(0, 5)}` : '';
              const newTimeStr = state.startTime ? `${state.startTime.slice(0, 5)} - ${state.endTime.slice(0, 5)}` : '';
              alerts.push(`🕒 *Class Rescheduled!*\n📚 *${state.courseName}${state.courseCode ? ` (${state.courseCode})` : ''}*\n📅 New Date: ${state.classDate}\n🕒 New Time: ${newTimeStr || 'Not Specified'}\n📍 Venue: ${state.venue || 'Not Specified'}\n_(Was: ${old.classDate} at ${oldTimeStr || 'Not Specified'} @ ${old.venue || 'Not Specified'})_`);
            }
          }
        }
      });

      // Check for removed classes (in old but not in new, and in future)
      if (!isFirstRun) {
        Object.keys(oldSessions).forEach(id => {
          if (!newSessions[id]) {
            const old = oldSessions[id];
            if (old.classDate >= todayStr && old.status !== 'cancelled') {
              const timeStr = old.startTime ? ` at ${old.startTime.slice(0, 5)}` : '';
              alerts.push(`❌ *Class Removed from Schedule!*\n📚 *${old.courseName}${old.courseCode ? ` (${old.courseCode})` : ''}*\n📅 Date: ${old.classDate}${timeStr}`);
            }
          }
        });
      }

      // Process activities
      const oldActivities = lastState.activities || {};
      const newActivities = {};

      filteredActivities.forEach(act => {
        const id = act.id || `activity-${act.date}-${act.startTime}`;
        const state = {
          name: act.name || 'Activity',
          date: act.date,
          startTime: act.startTime || '',
          venue: act.venue?.name || ''
        };
        newActivities[id] = state;

        if (!isFirstRun) {
          const old = oldActivities[id];
          if (!old) {
            if (act.date >= todayStr) {
              const timeStr = act.startTime ? ` at ${act.startTime.slice(0, 5)}` : '';
              const isExam = /exam|quiz|term/i.test(state.name);
              const header = isExam ? `⚠️ *NEW EXAM/QUIZ SCHEDULED!*` : `🔔 *New Activity Scheduled!*`;
              alerts.push(`${header}\n📢 *${state.name}*\n📅 Date: ${act.date}${timeStr}\n📍 Venue: ${state.venue || 'Not Specified'}`);
            }
          } else {
            const dateChanged = old.date !== state.date;
            const timeChanged = old.startTime !== state.startTime;
            const venueChanged = old.venue !== state.venue;
            const nameChanged = old.name !== state.name;

            if (dateChanged || timeChanged || venueChanged || nameChanged) {
              const newTimeStr = state.startTime ? ` at ${state.startTime.slice(0, 5)}` : '';
              const isExam = /exam|quiz|term/i.test(state.name);
              const header = isExam ? `⚠️ *CRITICAL: EXAM/ACTIVITY CHANGED!*` : `🔔 *Activity Updated!*`;
              alerts.push(`${header}\n📢 *${state.name}*\n📅 New Date: ${state.date}${newTimeStr}\n📍 Venue: ${state.venue || 'Not Specified'}\n_(Was: ${old.name} on ${old.date} @ ${old.venue || 'Not Specified'})_`);
            }
          }
        }
      });

      // Check for removed activities
      if (!isFirstRun) {
        Object.keys(oldActivities).forEach(id => {
          if (!newActivities[id]) {
            const old = oldActivities[id];
            if (old.date >= todayStr) {
              const timeStr = old.startTime ? ` at ${old.startTime.slice(0, 5)}` : '';
              const isExam = /exam|quiz|term/i.test(old.name);
              const header = isExam ? `❌ *EXAM/QUIZ CANCELLED!*` : `❌ *Activity Removed/Cancelled!*`;
              alerts.push(`${header}\n📢 *${old.name}*\n📅 Date: ${old.date}${timeStr}`);
            }
          }
        });
      }

      // 5. Send alerts if any
      if (alerts.length > 0) {
        const messageHeader = `🔔 *XLRI Schedule Update Alert* 🔔\nWe detected changes in your class schedule or activities:\n\n`;
        const consolidatedMessage = messageHeader + alerts.join('\n\n');
        await bot.sendMessage(user.chatId, consolidatedMessage, { parse_mode: 'Markdown' });
        console.log(`[Scheduler] Sent change alerts to ${user.email}`);
      }

      // 6. Save current state
      await saveUserScheduleState(user.chatId, {
        sessions: newSessions,
        activities: newActivities
      });

    } catch (err) {
      console.error(`[Scheduler] Change check failed for user ${user.email}:`, err.message);
    }

    // Stagger checks by 3 seconds
    if (i < users.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  console.log('[Scheduler] Finished schedule change check sweep.');
}

// Initialize Cron Schedule
function initScheduler(bot) {
  // Cron schedule: Run at 12:00 AM (midnight) every day in Asia/Kolkata timezone
  cron.schedule('0 0 * * *', async () => {
    try {
      const users = await getAllUsers();
      if (users.length === 0) {
        console.log('[Scheduler] No registered users to alert.');
        return;
      }
      await processBatch(users, bot);
    } catch (err) {
      console.error('[Scheduler] Error running daily cron job:', err);
    }
  }, {
    scheduled: true,
    timezone: 'Asia/Kolkata'
  });

  // Cron schedule: Run every 5 minutes for real-time schedule changes
  cron.schedule('*/5 * * * *', async () => {
    try {
      await checkScheduleChanges(bot);
    } catch (err) {
      console.error('[Scheduler] Error running change checker cron job:', err);
    }
  }, {
    scheduled: true,
    timezone: 'Asia/Kolkata'
  });
  
  console.log('[Scheduler] Nightly scheduler active (Scheduled for 12:00 AM IST daily).');
  console.log('[Scheduler] Real-time change checker active (Scheduled for every 5 minutes).');
}

module.exports = {
  initScheduler,
  processBatch,
  checkScheduleChanges
};
