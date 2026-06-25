const TelegramBot = require('node-telegram-bot-api').TelegramBot || require('node-telegram-bot-api');
const axios = require('axios');
const { initDatabase, saveUser, saveUserSections, getUser, deleteUser } = require('./database');
const { fetchXLRIERPData, sessionMatchesSection, activityMatchesCourses } = require('./erp-client');
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

  // Initialize DB and Scheduler
  initDatabase().then(() => {
    initScheduler(bot);
  }).catch(err => {
    console.error('[Bot] Database initialization failed. Scheduler/Bot features might fail:', err);
  });

  // /start command
  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const greeting = `👋 *Welcome to the XLRI ERP Bot!*\n\nI can automatically send your schedule every night and help you query your classes, quizzes, mess menu, and grades directly in Telegram.\n\n🔑 *Get Started:*\nTo link your XLRI account, use the login command:\n\`/login your_email@astra.xlri.ac.in your_password\`\n\n⚙️ *Available Commands:*\n• /schedule - Fetch today and tomorrow's classes\n• /activities - List quizzes/activities for the next 7 days\n• /calendar - Open the interactive monthly calendar WebApp\n• /sections - Select your course sections\n• /mess\\_menu - View today's mess menu (Provisional)\n• /grades - View your grades and CGPA (Provisional)\n• /logout - Permanent deletion of your credentials\n\n_Note: Credentials are stored locally on our Render server using AES-256 encryption._`;
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
    const data = query.data; // Format: sec_courseOfferId_sectionLetter
    
    if (!data.startsWith('sec_')) return;
    
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
  });

  // /schedule command
  bot.onText(/\/schedule/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);

    if (!user) {
      return bot.sendMessage(chatId, `⚠️ *Not Registered.*\nPlease log in first using:\n\`/login email password\``, { parse_mode: 'Markdown' });
    }

    const loadingMsg = await bot.sendMessage(chatId, `📅 *Fetching schedule...*`, { parse_mode: 'Markdown' });

    try {
      const data = await fetchXLRIERPData(user.email, user.password);
      
      const tzOffset = 5.5 * 60 * 60 * 1000;
      const todayIST = new Date(Date.now() + tzOffset);
      const tomorrowIST = new Date(todayIST.getTime() + 24 * 60 * 60 * 1000);
      
      const todayStr = formatDate(todayIST);
      const tomorrowStr = formatDate(tomorrowIST);
      
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

      const todaySessions = getScheduleForDate(todayStr);
      const tomorrowSessions = getScheduleForDate(tomorrowStr);

      let response = `📅 *Your XLRI Timetable*\n\n`;
      
      // Today
      response += `*Today (${todayStr})*:\n`;
      if (todaySessions.length === 0) {
        response += `🎉 No classes scheduled!\n\n`;
      } else {
        todaySessions.forEach(s => {
          const start = (s.startTime || '').slice(0, 5);
          const end = (s.endTime || '').slice(0, 5);
          const name = s.course?.courseName || 'Class';
          const cancel = s.status === 'cancelled' ? '❌ *CANCELLED* ' : '';
          const venue = s.venue?.name ? ` @ ${s.venue.name}` : '';
          response += `• *${start}-${end}*: ${cancel}${name}${venue}\n`;
        });
        response += `\n`;
      }
      
      // Tomorrow
      response += `*Tomorrow (${tomorrowStr})*:\n`;
      if (tomorrowSessions.length === 0) {
        response += `🎉 No classes scheduled!\n`;
      } else {
        tomorrowSessions.forEach(s => {
          const start = (s.startTime || '').slice(0, 5);
          const end = (s.endTime || '').slice(0, 5);
          const name = s.course?.courseName || 'Class';
          const cancel = s.status === 'cancelled' ? '❌ *CANCELLED* ' : '';
          const venue = s.venue?.name ? ` @ ${s.venue.name}` : '';
          response += `• *${start}-${end}*: ${cancel}${name}${venue}\n`;
        });
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
          response += `• *${act.date}${timeStr}*:\n  📢 *${act.name || 'Activity'}*${venueStr}\n\n`;
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

  // /mess_menu command (Provisional discovery)
  bot.onText(/\/mess_menu/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);

    if (!user) {
      return bot.sendMessage(chatId, `⚠️ *Not Registered.*\nPlease log in first using:\n\`/login email password\``, { parse_mode: 'Markdown' });
    }

    const loadingMsg = await bot.sendMessage(chatId, `🍽️ *Scanning ERP endpoints for Mess Menu...*`, { parse_mode: 'Markdown' });

    try {
      const result = await probeERPEndpoints(user.email, user.password, MENU_CANDIDATES);
      
      if (result) {
        let response = `🍽️ *Mess Menu Found!* (via \`${result.path}\`)\n\n`;
        response += `\`\`\`json\n${JSON.stringify(result.data, null, 2).slice(0, 3000)}\n\`\`\``;
        bot.editMessageText(response, { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' });
      } else {
        const errorText = `⚠️ *Mess Menu Endpoint Not Found*\n\nWe probed candidate paths but the ERP did not respond on them.\n\n💡 *How to solve this:*\n1. Log in to ERP on your computer browser.\n2. Open Developer Tools (**Inspect** $\rightarrow$ **Network** tab).\n3. Click on the **Mess Menu** page in the ERP.\n4. Share the API request URL (e.g. \`/api/v1/...\`) with the developer to link this command permanently!`;
        bot.editMessageText(errorText, { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' });
      }
    } catch (err) {
      bot.editMessageText(`❌ Connection error: ${err.message}`, { chat_id: chatId, message_id: loadingMsg.message_id });
    }
  });

  // /grades command (Provisional discovery)
  bot.onText(/\/grades/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await getUser(chatId);

    if (!user) {
      return bot.sendMessage(chatId, `⚠️ *Not Registered.*\nPlease log in first using:\n\`/login email password\``, { parse_mode: 'Markdown' });
    }

    const loadingMsg = await bot.sendMessage(chatId, `📈 *Scanning ERP endpoints for Grades/Grids...*`, { parse_mode: 'Markdown' });

    try {
      const result = await probeERPEndpoints(user.email, user.password, GRADES_CANDIDATES);
      
      if (result) {
        let response = `📈 *Grades Found!* (via \`${result.path}\`)\n\n`;
        response += `\`\`\`json\n${JSON.stringify(result.data, null, 2).slice(0, 3000)}\n\`\`\``;
        bot.editMessageText(response, { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' });
      } else {
        const errorText = `⚠️ *Grades/Grids Endpoint Not Found*\n\nWe probed candidate paths but the ERP did not respond on them.\n\n💡 *How to solve this:*\n1. Log in to ERP on your computer browser.\n2. Open Developer Tools (**Inspect** $\rightarrow$ **Network** tab).\n3. Click on the **Grades/Grids** page in the ERP.\n4. Share the API request URL (e.g. \`/api/v1/...\`) with the developer to link this command permanently!`;
        bot.editMessageText(errorText, { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' });
      }
    } catch (err) {
      bot.editMessageText(`❌ Connection error: ${err.message}`, { chat_id: chatId, message_id: loadingMsg.message_id });
    }
  });

  return bot;
}

module.exports = {
  initBot
};
