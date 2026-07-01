const TelegramBot = require('node-telegram-bot-api').TelegramBot || require('node-telegram-bot-api');
const axios = require('axios');
const { 
  initDatabase, 
  saveUser, 
  saveUserSections, 
  getUser, 
  deleteUser, 
  getAllUsers, 
  getUserByEmail, 
  saveUserScheduleState, 
  createShareRequest, 
  getShares, 
  deleteShare, 
  areFriends,
  saveSessionNote,
  getSessionNotes,
  deleteSessionNote
} = require('./database');
const { fetchXLRIERPData, sessionMatchesSection, activityMatchesCourses, fetchXLRIERPMessMenu, fetchXLRIERPGrades } = require('./erp-client');
const { initScheduler } = require('./scheduler');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || 'http://localhost:3000';

// Candidate paths for discovery
const MENU_CANDIDATES = [
  '/mess-menu/me',
  '/me/mess-menu',
  '/me/mess-menu/my',
  '/mess-menu/my',
  '/mess-menu',
  '/mess/menu',
  '/menu/my',
  '/menu',
  '/mess',
  '/canteen/menu',
  '/canteen'
];

const GRADES_CANDIDATES = [
  '/course-offerings/me/grades',
  '/me/grades',
  '/me/grades/my',
  '/student-grids',
  '/grades/my',
  '/grades',
  '/marks/my',
  '/marks',
  '/academic-record',
  '/course-offerings/my-grids',
  '/course-offerings/grades',
  '/exams/grades',
  '/exams/marks',
  '/results'
];

// Helper to format date into YYYY-MM-DD
function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

// Helper to calculate free intervals shared between two students
function calculateCommonFreeSlots(sessionsA, sessionsB, dateStr) {
  const startLimit = 8 * 60; // 08:00 AM
  const endLimit = 21 * 60;  // 09:00 PM
  
  // Timeline: 0 to 1440 minutes, initialized to true (free)
  const timeline = new Array(1440).fill(true);
  
  const parseTimeToMins = (timeStr) => {
    if (!timeStr) return null;
    const parts = timeStr.split(':');
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  };
  
  const markBusy = (sessions) => {
    sessions.forEach(s => {
      if (s.classDate === dateStr && s.status !== 'cancelled') {
        const start = parseTimeToMins(s.startTime);
        const end = parseTimeToMins(s.endTime);
        if (start !== null && end !== null) {
          for (let m = start; m < end; m++) {
            timeline[m] = false;
          }
        }
      }
    });
  };
  
  markBusy(sessionsA);
  markBusy(sessionsB);
  
  const freeIntervals = [];
  let inInterval = false;
  let startOfInterval = null;
  
  for (let m = startLimit; m <= endLimit; m++) {
    const isFree = timeline[m];
    if (isFree && !inInterval) {
      inInterval = true;
      startOfInterval = m;
    } else if (!isFree && inInterval) {
      inInterval = false;
      const endOfInterval = m;
      if (endOfInterval - startOfInterval >= 30) {
        freeIntervals.push({ start: startOfInterval, end: endOfInterval });
      }
    }
  }
  
  if (inInterval) {
    if (endLimit - startOfInterval >= 30) {
      freeIntervals.push({ start: startOfInterval, end: endLimit });
    }
  }
  
  const formatTime = (mins) => {
    const hh = String(Math.floor(mins / 60)).padStart(2, '0');
    const mm = String(mins % 60).padStart(2, '0');
    return `${hh}:${mm}`;
  };
  
  return freeIntervals.map(interval => {
    return `${formatTime(interval.start)} - ${formatTime(interval.end)}`;
  });
}

// Probing helper for unverified ERP endpoints
async function probeERPEndpoints(email, password, candidates) {
  const ERP_BASE = 'https://xlerp.xlri.ac.in/api/v1';
  
  // Get an active session token
  const loginRes = await axios.post(`${ERP_BASE}/auth/login`, {
    email,
    password
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000
  });

  const token = loginRes.data?.token || loginRes.data?.data?.token;
  if (!token) {
    throw new Error('Authentication failed during probe.');
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  // Test candidates
  for (const path of candidates) {
    try {
      console.log(`[Probe] Testing candidate path: ${ERP_BASE}${path}`);
      const res = await axios.get(`${ERP_BASE}${path}`, { headers, timeout: 5000 });
      if (res.status === 200 && res.data) {
        console.log(`[Probe] SUCCESS on path: ${path}`);
        return { path, data: res.data };
      }
    } catch (err) {
      console.log(`[Probe] FAILED on path ${path}: ${err.message}`);
    }
  }
  return null;
}

// Generate inline keyboard for course section selection
function getSectionKeyboard(courseOfferId, currentSection = '') {
  const sections = ['A', 'B', 'C', 'D', 'None'];
  const buttons = sections.map(s => {
    const isSelected = (s === 'None' && !currentSection) || (currentSection && s.toUpperCase() === currentSection.toUpperCase());
    const label = isSelected ? `✅ ${s}` : s;
    const value = s === 'None' ? '' : s;
    return {
      text: label,
      callback_data: `sec_${courseOfferId}_${value}`
    };
  });
  
  // Arrange in rows of 3
  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 3) {
    keyboard.push(buttons.slice(i, i + 3));
  }
  return { inline_keyboard: keyboard };
}

function initBot() {
  if (!TOKEN) {
    console.warn('⚠️ [Bot] TELEGRAM_BOT_TOKEN is not defined in the environment. Telegram Bot is disabled.');
    return null;
  }

  const bot = new TelegramBot(TOKEN, { polling: true });
  console.log('[Bot] Telegram Bot listener initialized successfully.');

  // Handle polling errors gracefully to avoid flooding logs with temporary gateway issues
  bot.on('polling_error', (error) => {
    const msg = error.message || '';
    if (msg.includes('502 Bad Gateway') || msg.includes('504 Gateway Timeout') || msg.includes('ETIMEDOUT') || msg.includes('EFIMEOUT')) {
      // Ignore temporary connection timeouts and gateway errors
      return;
    }
    console.warn('[Bot] Telegram Polling Warning:', msg || error);
  });

  // Register commands for autocomplete / menu list
  bot.setMyCommands([
    { command: 'start', description: 'Welcome message and bot overview' },
    { command: 'login', description: 'Link XLRI credentials: /login email password' },
    { command: 'schedule', description: 'Show today and tomorrow\'s classes' },
    { command: 'activities', description: 'Show academic activities for next 7 days' },
    { command: 'sections', description: 'Select sections for your registered courses' },
    { command: 'share', description: 'Share calendar with a classmate' },
    { command: 'unshare', description: 'Stop calendar sharing with a classmate' },
    { command: 'friends', description: 'Check shared calendars & free slots' },
    { command: 'note', description: 'Add reminder for next class: /note text' },
    { command: 'mess_menu', description: 'View mess menu (e.g. /mess_menu tomorrow)' },
    { command: 'grades', description: 'View grades and CGPA summary' },
    { command: 'calendar', description: 'Open interactive calendar WebApp' },
    { command: 'logout', description: 'Delete your credentials and logout' }
  ]).then(() => {
    console.log('[Bot] Autocomplete commands registered successfully with Telegram.');
  }).catch(err => {
    console.error('[Bot] Failed to register autocomplete commands:', err.message);
  });

  // Initialize DB and Scheduler
  initDatabase().then(() => {
    initScheduler(bot);
  }).catch(err => {
    console.error('[Bot] Database initialization failed. Scheduler/Bot features might fail:', err);
  });

  // /start command
  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const greeting = `👋 *Welcome to the XLRI ERP Bot!*\n\nI can automatically send your schedule every night and help you query your classes, quizzes, mess menu, and grades directly in Telegram.\n\n🔑 *Get Started:*\nTo link your XLRI account, use the login command:\n\`/login your_email@astra.xlri.ac.in your_password\`\n\n⚙️ *Available Commands:*\n• /schedule - Fetch today and tomorrow's classes\n• /activities - List quizzes/activities for the next 7 days\n• /calendar - Open the interactive monthly calendar WebApp\n• /sections - Select your course sections\n• /share - Share calendar with a classmate\n• /unshare - Stop calendar sharing with a classmate\n• /friends - View linked friends and check common free slots\n• /mess\\_menu - View today's mess menu\n• /grades - View your grades and CGPA\n• /logout - Permanent deletion of your credentials\n\n_Note: Credentials are stored securely and encrypted on disk using AES-256._`;
    bot.sendMessage(chatId, greeting, { parse_mode: 'Markdown' });
  });

  // /login command
  bot.onText(/\/login\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const input = match[1].trim().split(/\s+/);
    
    if (input.length < 2) {
      return bot.sendMessage(chatId, `❌ *Invalid Format.*\nUse: \`/login email password\``, { parse_mode: 'Markdown' });
    }

    const email = input[0];
    // Reconstruct password if it contains spaces
    const password = input.slice(1).join(' ');

    const loadingMsg = await bot.sendMessage(chatId, `🔑 *Authenticating with XLRI ERP...* Please wait.`, { parse_mode: 'Markdown' });

    try {
      // Validate credentials against ERP
      const erpData = await fetchXLRIERPData(email, password);
      
      // Save user to encrypted SQLite database
      await saveUser(chatId, email, password);
      
      bot.editMessageText(
        `✅ *Registration Successful!*\n\nWelcome, *${erpData.profile?.firstName || 'Student'}*.\nYour email \`${email}\` is now linked.\n\n⚙️ Next, run /sections to select your classes so I can filter out sessions you don't belong to.`,
        { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' }
      );
    } catch (err) {
      bot.editMessageText(
        `❌ *Authentication Failed:*\n${err.message}\n\nPlease verify your email and password and try again.`,
        { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' }
      );
    }
  });

  // /logout command
  bot.onText(/\/logout/, async (msg) => {
    const chatId = msg.chat.id;
    const deleted = await deleteUser(chatId);
    
    if (deleted) {
      bot.sendMessage(chatId, `👋 *Logged Out.*\nYour credentials have been permanently deleted from our server. Auto-notifications are now disabled.`, { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(chatId, `ℹ️ You are not currently registered. Use /login to link your account.`, { parse_mode: 'Markdown' });
    }
  });

  // /sections command
  bot.onText(/\/sections/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);
    
    if (!user) {
      return bot.sendMessage(chatId, `⚠️ *Not Registered.*\nPlease log in first using:\n\`/login email password\``, { parse_mode: 'Markdown' });
    }

    const loadingMsg = await bot.sendMessage(chatId, `🔄 Fetching registered courses...`, { parse_mode: 'Markdown' });

    try {
      const data = await fetchXLRIERPData(user.email, user.password);
      
      if (data.courses.length === 0) {
        return bot.editMessageText(`ℹ️ No active registered courses found on your ERP profile for the current term.`, { chat_id: chatId, message_id: loadingMsg.message_id });
      }

      await bot.deleteMessage(chatId, loadingMsg.message_id);
      
      await bot.sendMessage(chatId, `⚙️ *Select Sections*\nChoose your section for each active course. This filters your calendar feed and nightly alerts so you only see your classes:`);
      
      for (const course of data.courses) {
        const currentSec = user.sections[course.id] || '';
        const courseLabel = `📚 *${course.courseCode}* - ${course.courseName}`;
        
        await bot.sendMessage(chatId, courseLabel, {
          parse_mode: 'Markdown',
          reply_markup: getSectionKeyboard(course.id, currentSec)
        });
      }
    } catch (err) {
      bot.editMessageText(`❌ Failed to fetch courses: ${err.message}`, { chat_id: chatId, message_id: loadingMsg.message_id });
    }
  });

  // Inline buttons callback handler
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    
    // 1. Sections Configuration Callback
    if (data.startsWith('sec_')) {
      const parts = data.split('_');
      const courseOfferId = parts[1];
      const sectionLetter = parts[2] || ''; // Empty string if 'None'
      
      const user = await getUser(chatId);
      if (!user) {
        return bot.answerCallbackQuery(query.id, { text: 'Session expired. Please log in again.', show_alert: true });
      }
      
      // Update section preference in database
      user.sections[courseOfferId] = sectionLetter;
      await saveUserSections(chatId, user.sections);
      
      // Reset schedule state to baseline so they don't get false alerts on next cron check
      await saveUserScheduleState(chatId, '{}');
      
      // Edit the keyboard markup to reflect selection
      try {
        await bot.editMessageReplyMarkup(
          getSectionKeyboard(courseOfferId, sectionLetter),
          { chat_id: chatId, message_id: query.message.message_id }
        );
        bot.answerCallbackQuery(query.id, { text: `Section set to ${sectionLetter || 'None'}!` });
      } catch (err) {
        console.error('[Bot] Failed to edit callback markup:', err.message);
        bot.answerCallbackQuery(query.id, { text: 'Section saved successfully!' });
      }
      return;
    }

    // 2. Unshare Callback
    if (data.startsWith('unsh_')) {
      const friendId = data.split('_')[1];
      const user = await getUser(chatId);
      if (!user) return bot.answerCallbackQuery(query.id, { text: 'Session expired. Please log in again.' });
      
      const friend = await getUser(friendId);
      await deleteShare(chatId, friendId);
      
      await bot.deleteMessage(chatId, query.message.message_id);
      bot.sendMessage(chatId, `✅ Stopped sharing calendar with *${friend?.email || 'classmate'}*.`, { parse_mode: 'Markdown' });
      if (friend) {
        bot.sendMessage(friend.chatId, `⚠️ *Calendar Sharing Stopped.*\n**${user.email}** has stopped sharing their calendar with you.`, { parse_mode: 'Markdown' });
      }
      return bot.answerCallbackQuery(query.id, { text: 'Sharing revoked successfully.' });
    }

    // 3. Accept Share Callback
    if (data.startsWith('acc_')) {
      const friendId = data.split('_')[1];
      const user = await getUser(chatId);
      if (!user) return bot.answerCallbackQuery(query.id, { text: 'Session expired.' });
      
      const friend = await getUser(friendId);
      if (!friend) return bot.answerCallbackQuery(query.id, { text: 'Friend not found.' });

      await createShareRequest(chatId, friendId);
      await bot.deleteMessage(chatId, query.message.message_id);
      
      bot.sendMessage(chatId, `✅ *Calendar Sharing Linked!*\nYou and *${friend.email}* are mutually sharing calendars now.`, { parse_mode: 'Markdown' });
      bot.sendMessage(friend.chatId, `🔔 *Calendar Sharing Linked!*\n**${user.email}** accepted your share request.`, { parse_mode: 'Markdown' });
      return bot.answerCallbackQuery(query.id, { text: 'Sharing request accepted!' });
    }

    // 4. Compare Callback (Free-Busy calculation)
    if (data.startsWith('comp_')) {
      const parts = data.split('_');
      const friendId = parts[1];
      const day = parts[2]; // 'today' or 'tomorrow'
      
      const user = await getUser(chatId);
      if (!user) return bot.answerCallbackQuery(query.id, { text: 'Session expired.' });

      const friend = await getUser(friendId);
      if (!friend) return bot.answerCallbackQuery(query.id, { text: 'Friend not found.' });

      const friends = await areFriends(chatId, friendId);
      if (!friends) {
        return bot.answerCallbackQuery(query.id, { text: 'You must be mutual friends to compare calendars.', show_alert: true });
      }

      await bot.answerCallbackQuery(query.id, { text: `Comparing schedules...` });
      const compareMsg = await bot.sendMessage(chatId, `🔄 *Fetching and comparing schedules...*`, { parse_mode: 'Markdown' });

      try {
        const [userData, friendData] = await Promise.all([
          fetchXLRIERPData(user.email, user.password),
          fetchXLRIERPData(friend.email, friend.password)
        ]);

        const tzOffset = 5.5 * 60 * 60 * 1000;
        const todayIST = new Date(Date.now() + tzOffset);
        let targetDate = todayIST;
        let label = 'Today';

        if (day === 'tomorrow') {
          targetDate = new Date(todayIST.getTime() + 24 * 60 * 60 * 1000);
          label = 'Tomorrow';
        }
        
        const dateStr = formatDate(targetDate);
        
        // Filter User Sessions
        const activeCourseOfferIdsUser = new Set(userData.courses.map(c => c.id));
        const filteredUserSessions = userData.sessions.filter(s => {
          if (!s.courseOfferId) return true;
          if (!activeCourseOfferIdsUser.has(s.courseOfferId)) return false;
          return sessionMatchesSection(s, user.sections);
        });

        // Filter Friend Sessions
        const activeCourseOfferIdsFriend = new Set(friendData.courses.map(c => c.id));
        const filteredFriendSessions = friendData.sessions.filter(s => {
          if (!s.courseOfferId) return true;
          if (!activeCourseOfferIdsFriend.has(s.courseOfferId)) return false;
          return sessionMatchesSection(s, friend.sections);
        });

        // Parse schedules into free slots timeline
        const freeSlots = calculateCommonFreeSlots(filteredUserSessions, filteredFriendSessions, dateStr);
        
        let response = `🟢 *Common Free Slots (${label} - ${dateStr})* 🟢\n`;
        response += `👥 Between you and *${friend.email.split('@')[0].toUpperCase()}*:\n\n`;
        
        if (freeSlots.length === 0) {
          response += `⚠️ *No common free slots found* between 08:00 AM and 09:00 PM. Busy day!`;
        } else {
          freeSlots.forEach(slot => {
            response += `• *${slot}*\n`;
          });
        }
        
        await bot.editMessageText(response, { chat_id: chatId, message_id: compareMsg.message_id, parse_mode: 'Markdown' });

      } catch (err) {
        await bot.editMessageText(`❌ Failed to compare calendars: ${err.message}`, { chat_id: chatId, message_id: compareMsg.message_id });
      }
      return;
    }
  });

  // /schedule command
  bot.onText(/\/schedule(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);

    if (!user) {
      return bot.sendMessage(chatId, `⚠️ *Not Registered.*\nPlease log in first using:\n\`/login email password\``, { parse_mode: 'Markdown' });
    }

    const numDaysArg = match[1] ? parseInt(match[1], 10) : null;
    const limit = numDaysArg !== null ? Math.min(Math.max(numDaysArg, 1), 14) : 2;

    const loadingMsg = await bot.sendMessage(chatId, `📅 *Fetching schedule for next ${limit} days...*`, { parse_mode: 'Markdown' });

    try {
      const [data, sessionNotes] = await Promise.all([
        fetchXLRIERPData(user.email, user.password),
        getSessionNotes(chatId)
      ]);
      
      const tzOffset = 5.5 * 60 * 60 * 1000;
      const todayIST = new Date(Date.now() + tzOffset);
      const activeCourseOfferIds = new Set(data.courses.map(c => c.id));
      
      const getScheduleForDate = (dateStr) => {
        return data.sessions
          .filter(s => {
            if (s.classDate !== dateStr) return false;
            if (!s.courseOfferId) return true;
            if (!activeCourseOfferIds.has(s.courseOfferId)) return false;
            return sessionMatchesSection(s, user.sections);
          })
          .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
      };

      const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      let response = `📅 *Your XLRI Timetable (${limit} Day${limit > 1 ? 's' : ''})*\n\n`;

      for (let i = 0; i < limit; i++) {
        const targetDate = new Date(todayIST.getTime() + i * 24 * 60 * 60 * 1000);
        const dateStr = formatDate(targetDate);
        const sessions = getScheduleForDate(dateStr);
        
        let label = '';
        if (i === 0) {
          label = `Today (${dateStr})`;
        } else if (i === 1) {
          label = `Tomorrow (${dateStr})`;
        } else {
          label = `${daysOfWeek[targetDate.getUTCDay()]} (${dateStr})`;
        }

        response += `*${label}*:\n`;

        if (sessions.length === 0) {
          response += `🎉 No classes scheduled!\n\n`;
        } else {
          sessions.forEach(s => {
            const start = (s.startTime || '').slice(0, 5);
            const end = (s.endTime || '').slice(0, 5);
            const name = s.course?.courseName || 'Class';
            const cancel = s.status === 'cancelled' ? '❌ *CANCELLED* ' : '';
            const venue = s.venue?.name ? ` @ ${s.venue.name}` : '';
            
            let item = `• *${start}-${end}*: ${cancel}${name}${venue}`;
            const sessionId = s.sessionId || `session-${s.classDate}-${s.startTime}`;
            if (sessionNotes && sessionNotes[sessionId]) {
              item += `\n  📌 *Note:* _${sessionNotes[sessionId]}_`;
            }
            response += item + `\n`;
          });
          response += `\n`;
        }
      }

      if (response.length > 4000) {
        response = response.slice(0, 4000) + '\n\n_(Truncated due to Telegram message length limits)_';
      }

      bot.editMessageText(response, { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' });
    } catch (err) {
      bot.editMessageText(`❌ Failed to fetch schedule: ${err.message}`, { chat_id: chatId, message_id: loadingMsg.message_id });
    }
  });

  // /activities command
  bot.onText(/\/activities/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);

    if (!user) {
      return bot.sendMessage(chatId, `⚠️ *Not Registered.*\nPlease log in first using:\n\`/login email password\``, { parse_mode: 'Markdown' });
    }

    const loadingMsg = await bot.sendMessage(chatId, `🔔 *Fetching upcoming activities...*`, { parse_mode: 'Markdown' });

    try {
      const data = await fetchXLRIERPData(user.email, user.password);
      
      const tzOffset = 5.5 * 60 * 60 * 1000;
      const todayIST = new Date(Date.now() + tzOffset);
      const sevenDaysLater = new Date(todayIST.getTime() + 7 * 24 * 60 * 60 * 1000);
      
      const todayStr = formatDate(todayIST);
      const limitStr = formatDate(sevenDaysLater);
      
      const upcoming = data.activities.filter(act => {
        if (!act.date || act.date < todayStr || act.date > limitStr) return false;
        return activityMatchesCourses(act, data.courses);
      }).sort((a, b) => {
        const dateComp = a.date.localeCompare(b.date);
        if (dateComp !== 0) return dateComp;
        return (a.startTime || '').localeCompare(b.startTime || '');
      });

      let response = `🔔 *Academic Activities (Next 7 Days)*\n\n`;
      if (upcoming.length === 0) {
        response += `✅ *All Clear!* No quizzes, assignments, or presentations found in this period.`;
      } else {
        upcoming.forEach(act => {
          const timeStr = act.startTime ? ` at ${act.startTime.slice(0, 5)}` : '';
          const venueStr = act.venue?.name ? ` [📍 ${act.venue.name}]` : '';
          const name = act.name || 'Activity';
          
          const isExam = /exam|quiz|term/i.test(name);
          const emoji = isExam ? '⚠️' : '•';
          const styledName = isExam ? `*${name.toUpperCase()}*` : name;
          
          response += `${emoji} *${act.date}${timeStr}*:\n  📢 ${styledName}${venueStr}\n\n`;
        });
      }

      bot.editMessageText(response, { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' });
    } catch (err) {
      bot.editMessageText(`❌ Failed to fetch activities: ${err.message}`, { chat_id: chatId, message_id: loadingMsg.message_id });
    }
  });

  // /calendar command
  bot.onText(/\/calendar/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);

    if (!user) {
      return bot.sendMessage(chatId, `⚠️ *Not Registered.*\nPlease log in first using:\n\`/login email password\``, { parse_mode: 'Markdown' });
    }

    const webappUrl = `${WEBAPP_URL}/calendar.html`;
    
    bot.sendMessage(chatId, `📅 *Interactive Calendar View*\n\nOpen your personal XLRI monthly calendar directly inside Telegram to see your classes, quizzes, and holidays.`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📅 Open Calendar', web_app: { url: webappUrl } }
          ]
        ]
      }
    });
  });

  // /mess_menu command
  bot.onText(/\/mess_menu(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);

    if (!user) {
      return bot.sendMessage(chatId, `⚠️ *Not Registered.*\nPlease log in first using:\n\`/login email password\``, { parse_mode: 'Markdown' });
    }

    const daysOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const tzOffset = 5.5 * 60 * 60 * 1000;
    const todayIST = new Date(Date.now() + tzOffset);
    
    let targetDay = daysOfWeek[todayIST.getUTCDay()];
    let label = 'Today';

    if (match[1]) {
      const arg = match[1].toLowerCase().trim();
      if (arg === 'tomorrow' || arg === 'tmrw') {
        const tomorrowIST = new Date(todayIST.getTime() + 24 * 60 * 60 * 1000);
        targetDay = daysOfWeek[tomorrowIST.getUTCDay()];
        label = 'Tomorrow';
      } else if (daysOfWeek.includes(arg)) {
        targetDay = arg;
        label = arg.charAt(0).toUpperCase() + arg.slice(1);
      } else {
        return bot.sendMessage(chatId, `⚠️ *Invalid Day.*\nUse: \`/mess_menu\` (today), \`/mess_menu tomorrow\`, or e.g. \`/mess_menu monday\`.`, { parse_mode: 'Markdown' });
      }
    }

    const loadingMsg = await bot.sendMessage(chatId, `🍽️ *Fetching Mess Menu for ${label}...*`, { parse_mode: 'Markdown' });

    try {
      const menuData = await fetchXLRIERPMessMenu(user.email, user.password);
      
      if (menuData && menuData.success && menuData.data) {
        const data = menuData.data;
        const messName = data.mess?.name || 'Mess';
        const month = data.month || '';
        
        let response = `🍽️ *Mess Menu for ${label} (${targetDay.charAt(0).toUpperCase() + targetDay.slice(1)})* 🍽️\n`;
        response += `🏫 *Mess:* ${messName}\n`;
        if (month) response += `📅 *Month:* ${month.charAt(0).toUpperCase() + month.slice(1)}\n`;
        response += `\n`;
        
        let mealsFound = false;
        if (Array.isArray(data.meals)) {
          data.meals.forEach(meal => {
            let mealText = '';
            if (Array.isArray(meal.items)) {
              meal.items.forEach(item => {
                const itemDayValue = item.days?.[targetDay];
                if (itemDayValue && itemDayValue.trim()) {
                  mealText += `  • *${item.category}:* ${itemDayValue.trim()}\n`;
                }
              });
            }
            if (mealText) {
              response += `🍳 *${meal.mealType}*\n${mealText}\n`;
              mealsFound = true;
            }
          });
        }
        
        if (!mealsFound) {
          response += `ℹ️ No menu items found scheduled for ${targetDay}.`;
        }
        
        bot.editMessageText(response, { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' });
      } else {
        bot.editMessageText(`⚠️ *Mess Menu Empty/Unavailable.*\nCould not retrieve structured menu data from the ERP.`, { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' });
      }
    } catch (err) {
      bot.editMessageText(`❌ Connection error: ${err.message}`, { chat_id: chatId, message_id: loadingMsg.message_id });
    }
  });

  // /grades command
  bot.onText(/\/grades/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);

    if (!user) {
      return bot.sendMessage(chatId, `⚠️ *Not Registered.*\nPlease log in first using:\n\`/login email password\``, { parse_mode: 'Markdown' });
    }

    const loadingMsg = await bot.sendMessage(chatId, `📈 *Fetching your Grades/CGPA...*`, { parse_mode: 'Markdown' });

    try {
      const gradesData = await fetchXLRIERPGrades(user.email, user.password);
      
      if (gradesData && gradesData.success && gradesData.data) {
        const data = gradesData.data;
        const studentName = data.student?.name || 'Student';
        const studentId = data.student?.studentId || '';
        
        let response = `📈 *Your Grades & CGPA* 📈\n`;
        response += `👤 *Name:* ${studentName} (${studentId})\n`;
        if (data.summary) {
          response += `⭐️ *CGPA:* \`${data.summary.cgpa || 'N/A'}\`\n`;
          response += `📚 *Credits:* ${data.summary.totalCredits || 0} | *Courses:* ${data.summary.totalCourses || 0} | *Terms:* ${data.summary.totalTerms || 0}\n`;
        }
        response += `\n`;

        let messages = [];
        let currentMsg = response;

        if (Array.isArray(data.terms)) {
          data.terms.forEach(term => {
            let termText = `*Term ${term.termCode || 'N/A'}* (GPA: \`${term.gpa || 'N/A'}\` | Credits: ${term.totalCredits || 0})\n`;
            if (Array.isArray(term.courses)) {
              term.courses.forEach(c => {
                const grade = c.finalGrade || c.grade || '-';
                termText += `  • \`${c.courseCode}\`: *${grade}* (${c.courseOfferCredit || 0} Cr) - ${c.courseName}\n`;
              });
            }
            termText += `\n`;
            
            if (currentMsg.length + termText.length > 4000) {
              messages.push(currentMsg);
              currentMsg = termText;
            } else {
              currentMsg += termText;
            }
          });
        }
        messages.push(currentMsg);

        for (let i = 0; i < messages.length; i++) {
          if (i === 0) {
            await bot.editMessageText(messages[i], { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' });
          } else {
            await bot.sendMessage(chatId, messages[i], { parse_mode: 'Markdown' });
          }
        }
      } else {
        bot.editMessageText(`⚠️ *Grades Empty/Unavailable.*\nCould not retrieve structured grades data from the ERP.`, { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' });
      }
    } catch (err) {
      bot.editMessageText(`❌ Connection error: ${err.message}`, { chat_id: chatId, message_id: loadingMsg.message_id });
    }
  });

  // /share command
  bot.onText(/\/share(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);

    if (!user) {
      return bot.sendMessage(chatId, `⚠️ *Not Registered.*\nPlease log in first using:\n\`/login email password\``, { parse_mode: 'Markdown' });
    }

    if (!match[1]) {
      return bot.sendMessage(chatId, `ℹ️ *Calendar Sharing*\nTo share your calendar with a classmate, type:\n\`/share friend_email@astra.xlri.ac.in\`\nor their Student ID (e.g. \`/share B25019\`).\n\n_Note: Sharing is mutual. Once both of you request each other, you will be able to see each other's schedules and check free/busy slots!_`, { parse_mode: 'Markdown' });
    }

    const targetInput = match[1].trim().toLowerCase();
    
    // Look up friend in DB by email or student ID
    let friend = null;
    if (targetInput.includes('@')) {
      friend = await getUserByEmail(targetInput);
    } else {
      const allUsers = await getAllUsers();
      friend = allUsers.find(u => {
        const emailParts = u.email.split('@');
        return emailParts[0].toLowerCase() === targetInput;
      });
    }

    if (!friend) {
      return bot.sendMessage(chatId, `❌ *User Not Registered.*\nWe could not find a student registered with email or ID \`${targetInput}\`.\n\nAsk them to log in to this bot first!`, { parse_mode: 'Markdown' });
    }

    if (friend.chatId === user.chatId) {
      return bot.sendMessage(chatId, `⚠️ You cannot share your calendar with yourself!`, { parse_mode: 'Markdown' });
    }

    const loadingMsg = await bot.sendMessage(chatId, `🔄 *Processing share request...*`, { parse_mode: 'Markdown' });

    try {
      const status = await createShareRequest(chatId, friend.chatId);

      if (status === 'accepted') {
        bot.editMessageText(
          `✅ *Calendar Sharing Linked!*\nYou and *${friend.email}* are now mutually sharing calendars.\n\nRun /friends to compare schedules or check common free slots!`,
          { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' }
        );
        bot.sendMessage(
          friend.chatId,
          `🔔 *Calendar Sharing Linked!*\n**${user.email}** accepted your share request. You are now mutually sharing calendars.\n\nRun /friends to compare schedules or check common free slots!`,
          { parse_mode: 'Markdown' }
        );
      } else {
        bot.editMessageText(
          `✉️ *Share Request Sent!*\nYour request has been sent to *${friend.email}*.\n\nThey must run \`/share ${user.email}\` to accept and finalize the mutual link.`,
          { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' }
        );
        bot.sendMessage(
          friend.chatId,
          `🔔 *Calendar Share Request!*\n**${user.email}** wants to share calendars with you.\n\nTo accept and share back, run:\n\`/share ${user.email}\``,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (err) {
      bot.editMessageText(`❌ Failed to share: ${err.message}`, { chat_id: chatId, message_id: loadingMsg.message_id });
    }
  });

  // /unshare command
  bot.onText(/\/unshare(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);

    if (!user) {
      return bot.sendMessage(chatId, `⚠️ *Not Registered.*\nPlease log in first using:\n\`/login email password\``, { parse_mode: 'Markdown' });
    }

    if (!match[1]) {
      return bot.sendMessage(chatId, `ℹ️ *Revoke Calendar Sharing*\nTo stop sharing your calendar with a classmate, type:\n\`/unshare friend_email@astra.xlri.ac.in\`\nor their Student ID (e.g. \`/unshare B25019\`).`, { parse_mode: 'Markdown' });
    }

    const targetInput = match[1].trim().toLowerCase();
    
    let friend = null;
    if (targetInput.includes('@')) {
      friend = await getUserByEmail(targetInput);
    } else {
      const allUsers = await getAllUsers();
      friend = allUsers.find(u => u.email.split('@')[0].toLowerCase() === targetInput);
    }

    if (!friend) {
      return bot.sendMessage(chatId, `❌ *User Not Found.*\nNo registered student found with email or ID \`${targetInput}\`.`, { parse_mode: 'Markdown' });
    }

    const deleted = await deleteShare(chatId, friend.chatId);
    
    if (deleted) {
      bot.sendMessage(chatId, `✅ *Calendar Sharing Revoked.*\nYou stopped sharing calendars with *${friend.email}*.`, { parse_mode: 'Markdown' });
      bot.sendMessage(friend.chatId, `⚠️ *Calendar Sharing Stopped.*\n**${user.email}** has stopped sharing their calendar with you.`, { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(chatId, `ℹ️ You are not sharing calendars with *${friend.email}*.`, { parse_mode: 'Markdown' });
    }
  });

  // /friends command
  bot.onText(/\/friends/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);

    if (!user) {
      return bot.sendMessage(chatId, `⚠️ *Not Registered.*\nPlease log in first using:\n\`/login email password\``, { parse_mode: 'Markdown' });
    }

    const loadingMsg = await bot.sendMessage(chatId, `🔄 Loading sharing list...`, { parse_mode: 'Markdown' });

    try {
      const shares = await getShares(chatId);
      
      if (shares.length === 0) {
        await bot.deleteMessage(chatId, loadingMsg.message_id);
        return bot.sendMessage(
          chatId,
          `👥 *My Sharing Circle*\nYou are not sharing calendars with anyone yet.\n\n💡 *To get started:*\nRun \`/share friend_email@astra.xlri.ac.in\` to request mutual sharing with a classmate.`,
          { parse_mode: 'Markdown' }
        );
      }

      await bot.deleteMessage(chatId, loadingMsg.message_id);
      await bot.sendMessage(chatId, `👥 *My Calendar Sharing Circle*`);

      for (const share of shares) {
        const friendEmail = share.friendEmail;
        const studentId = friendEmail.split('@')[0].toUpperCase();
        
        if (share.status === 'accepted') {
          const inlineKeyboard = {
            inline_keyboard: [
              [
                { text: '📅 Compare Today', callback_data: `comp_${share.friendId}_today` },
                { text: '📅 Compare Tomorrow', callback_data: `comp_${share.friendId}_tomorrow` }
              ],
              [
                { text: '❌ Revoke Share', callback_data: `unsh_${share.friendId}` }
              ]
            ]
          };
          
          await bot.sendMessage(chatId, `🟢 *Mutually Sharing: ${friendEmail} (${studentId})*`, {
            parse_mode: 'Markdown',
            reply_markup: inlineKeyboard
          });
        } else {
          if (share.isRequester) {
            const inlineKeyboard = {
              inline_keyboard: [
                [
                  { text: '❌ Cancel Request', callback_data: `unsh_${share.friendId}` }
                ]
              ]
            };
            await bot.sendMessage(chatId, `⏳ *Pending Approval from: ${friendEmail} (${studentId})*\n_Waiting for them to run \`/share ${user.email}\`_`, {
              parse_mode: 'Markdown',
              reply_markup: inlineKeyboard
            });
          } else {
            const inlineKeyboard = {
              inline_keyboard: [
                [
                  { text: '✅ Accept Share', callback_data: `acc_${share.friendId}` },
                  { text: '❌ Reject', callback_data: `unsh_${share.friendId}` }
                ]
              ]
            };
            await bot.sendMessage(chatId, `🔔 *Share Request from: ${friendEmail} (${studentId})*\n_Click Accept to share back and link calendars._`, {
              parse_mode: 'Markdown',
              reply_markup: inlineKeyboard
            });
          }
        }
      }
    } catch (err) {
      bot.editMessageText(`❌ Failed to load shares: ${err.message}`, { chat_id: chatId, message_id: loadingMsg.message_id });
    }
  });

  // /note command (saves custom session notes)
  bot.onText(/\/note(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);

    if (!user) {
      return bot.sendMessage(chatId, `⚠️ *Not Registered.*\nPlease log in first using:\n\`/login email password\``, { parse_mode: 'Markdown' });
    }

    if (!match[1]) {
      return bot.sendMessage(chatId, `ℹ️ *Add Note for Next Class*\nUse this command to attach a reminder note to your next class session.\n\nUsage: \`/note <your note text>\`\nExample: \`/note review pages 10-20 of case study\``, { parse_mode: 'Markdown' });
    }

    const noteText = match[1].trim();
    const loadingMsg = await bot.sendMessage(chatId, `🔄 *Finding your next class session...*`, { parse_mode: 'Markdown' });

    try {
      const data = await fetchXLRIERPData(user.email, user.password);
      
      const tzOffset = 5.5 * 60 * 60 * 1000;
      const nowIST = new Date(Date.now() + tzOffset);
      const todayStr = formatDate(nowIST);
      const currentHourMin = nowIST.toISOString().slice(11, 19); // "HH:MM:SS"

      const activeCourseOfferIds = new Set(data.courses.map(c => c.id));
      const filteredSessions = data.sessions.filter(s => {
        if (!s.courseOfferId) return true;
        if (!activeCourseOfferIds.has(s.courseOfferId)) return false;
        return sessionMatchesSection(s, user.sections);
      });

      // Sort sessions by date and start time
      filteredSessions.sort((a, b) => {
        const dateComp = a.classDate.localeCompare(b.classDate);
        if (dateComp !== 0) return dateComp;
        return (a.startTime || '').localeCompare(b.startTime || '');
      });

      // Find the first session that has not ended yet (today or future)
      const nextSession = filteredSessions.find(s => {
        if (s.classDate > todayStr) return true;
        if (s.classDate === todayStr) {
          return (s.endTime || '23:59:59') > currentHourMin;
        }
        return false;
      });

      if (!nextSession) {
        return bot.editMessageText(`⚠️ *No upcoming classes found* in your schedule to attach a reminder to.`, { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' });
      }

      const sessionId = nextSession.sessionId || `session-${nextSession.classDate}-${nextSession.startTime}`;
      const courseName = nextSession.course?.courseName || 'Class';
      const courseCode = nextSession.course?.courseCode ? ` (${nextSession.course.courseCode})` : '';
      const startTime = (nextSession.startTime || '').slice(0, 5);

      // Save note to database
      await saveSessionNote(chatId, sessionId, noteText);

      const successText = `📌 *Reminder Added for Next Class!*\n\n📚 *Course:* ${courseName}${courseCode}\n📅 *Class Date:* ${nextSession.classDate} at ${startTime}\n📝 *Note:* _${noteText}_\n\n_This note will show up in your /schedule and daily morning alerts!_`;
      await bot.editMessageText(successText, { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' });

    } catch (err) {
      bot.editMessageText(`❌ Failed to add note: ${err.message}`, { chat_id: chatId, message_id: loadingMsg.message_id });
    }
  });

  return bot;
}

module.exports = {
  initBot
};
