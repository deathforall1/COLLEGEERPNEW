const cron = require('node-cron');
const { getAllUsers } = require('./database');
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
      // 1. Fetch fresh ERP data
      const data = await fetchXLRIERPData(user.email, user.password);
      
      // Calculate target date (tomorrow) in Asia/Kolkata timezone
      const tzOffset = 5.5 * 60 * 60 * 1000; // IST is UTC+5.5
      const nowIST = new Date(Date.now() + tzOffset);
      const tomorrowIST = new Date(nowIST.getTime() + 24 * 60 * 60 * 1000);
      const tomorrowStr = formatDate(tomorrowIST);
      
      // 2. Filter sessions for tomorrow
      const activeCourseOfferIds = new Set(data.courses.map(c => c.id));
      const tomorrowSessions = data.sessions.filter(s => {
        if (s.classDate !== tomorrowStr) return false;
        if (!s.courseOfferId) return true; // Keep general announcements
        if (!activeCourseOfferIds.has(s.courseOfferId)) return false; // Must be registered
        return sessionMatchesSection(s, user.sections); // Match section
      });
      
      // Sort tomorrow sessions by start time
      tomorrowSessions.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
      
      // 3. Filter activities for the next 7 days
      const sevenDaysLater = new Date(tomorrowIST.getTime() + 7 * 24 * 60 * 60 * 1000);
      const sevenDaysLaterStr = formatDate(sevenDaysLater);
      
      const upcomingActivities = data.activities.filter(act => {
        if (!act.date) return false;
        if (act.date < tomorrowStr || act.date > sevenDaysLaterStr) return false;
        return activityMatchesCourses(act, data.courses);
      });
      
      // Sort activities by date and start time
      upcomingActivities.sort((a, b) => {
        const dateComp = a.date.localeCompare(b.date);
        if (dateComp !== 0) return dateComp;
        return (a.startTime || '').localeCompare(b.startTime || '');
      });
      
      // 4. Construct Telegram Message
      let message = `📅 *XLRI Schedule for Tomorrow (${tomorrowStr})*\n\n`;
      
      if (tomorrowSessions.length === 0) {
        message += `🎉 *No classes scheduled!* Enjoy your day off.\n\n`;
      } else {
        tomorrowSessions.forEach(s => {
          const startTime = (s.startTime || '').slice(0, 5);
          const endTime = (s.endTime || '').slice(0, 5);
          const courseName = s.course?.courseName || 'Class';
          const courseCode = s.course?.courseCode ? ` (${s.course.courseCode})` : '';
          const venue = s.venue?.name ? `${s.venue.name}${s.venue.code ? ` (${s.venue.code})` : ''}` : 'Not Specified';
          const faculty = s.faculty ? [s.faculty.prefix, s.faculty.firstName, s.faculty.lastName].filter(Boolean).join(' ') : 'Not Specified';
          const status = s.status === 'cancelled' ? '❌ *CANCELLED* ' : '';
          
          message += `🕒 *${startTime} - ${endTime}*\n📚 *${status}${courseName}${courseCode}*\n📍 Venue: ${venue}\n👨‍🏫 Faculty: ${faculty}\n\n`;
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
          message += `• *[${actDate}] ${startTime}* - ${name} ${venue}\n`;
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
  
  console.log('[Scheduler] Nightly scheduler active (Scheduled for 12:00 AM IST daily).');
}

module.exports = {
  initScheduler,
  processBatch // Exported for manual trigger testing
};
