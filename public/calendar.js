// Initialize Telegram WebApp SDK
const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

// Application State
let studentData = null;
let currentMonth = new Date().getMonth(); // 0-11
let currentYear = new Date().getFullYear();
let selectedDateStr = null; // Format: YYYY-MM-DD

// Retrieve elements
const loadingOverlay = document.getElementById('loadingOverlay');
const errorOverlay = document.getElementById('errorOverlay');
const errorTitle = document.getElementById('errorTitle');
const errorDesc = document.getElementById('errorDesc');
const userName = document.getElementById('userName');
const userEmail = document.getElementById('userEmail');
const userAvatar = document.getElementById('userAvatar');
const currentMonthYearLabel = document.getElementById('currentMonthYear');
const daysGrid = document.getElementById('daysGrid');
const selectedDateLabel = document.getElementById('selectedDateLabel');
const timelineContainer = document.getElementById('timelineContainer');

const prevMonthBtn = document.getElementById('prevMonthBtn');
const nextMonthBtn = document.getElementById('nextMonthBtn');

// Month Names mapping
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

// Helper to format Date object into YYYY-MM-DD (Kolkata timezone offset)
function formatDateString(year, month, day) {
  const mm = String(month + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

// Fetch user data from server
async function fetchSchedule() {
  // Read chatId from URL query parameters (for local testing) or safely from Telegram SDK
  const urlParams = new URLSearchParams(window.location.search);
  const chatId = urlParams.get('chatId') || tg.initDataUnsafe?.user?.id;

  if (!chatId) {
    showError('Access Error', 'No Telegram chat profile detected. Please open this page directly from your Telegram Bot chat.');
    return;
  }

  try {
    const response = await fetch(`/api/telegram-schedule?chatId=${chatId}`);
    
    if (!response.ok) {
      const errData = await response.json();
      showError('Authentication Failed', errData.error || 'Failed to retrieve schedule from server.');
      return;
    }

    studentData = await response.json();
    displayUserProfile();
    
    // Set default selected date to Today and render
    const today = new Date();
    selectedDateStr = formatDateString(today.getFullYear(), today.getMonth(), today.getDate());
    
    // Set view to today's month
    currentMonth = today.getMonth();
    currentYear = today.getFullYear();
    
    renderCalendar();
    renderDayDetails(selectedDateStr);
    
    // Hide loader
    loadingOverlay.classList.add('hidden');
    
  } catch (err) {
    showError('Connection Error', `Unable to reach the server. Please check your internet connection: ${err.message}`);
  }
}

// Display error page
function showError(title, message) {
  errorTitle.textContent = title;
  errorDesc.textContent = message;
  loadingOverlay.classList.add('hidden');
  errorOverlay.classList.remove('hidden');
}

// Render user profile info
function displayUserProfile() {
  if (!studentData || !studentData.profile) return;
  
  const profile = studentData.profile;
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ') || 'Student';
  const email = profile.email || 'student@xlri.ac.in';
  
  userName.textContent = name;
  userEmail.textContent = email;
  
  // Set avatar initials
  const initials = [profile.firstName, profile.lastName]
    .filter(Boolean)
    .map(p => p[0].toUpperCase())
    .join('');
  
  userAvatar.textContent = initials || 'U';
}

// Render monthly calendar grid
function renderCalendar() {
  daysGrid.innerHTML = '';
  currentMonthYearLabel.textContent = `${MONTH_NAMES[currentMonth]} ${currentYear}`;
  
  // Get weekday index of the first day (Monday = 0, Tuesday = 1, ..., Sunday = 6)
  const firstDay = new Date(currentYear, currentMonth, 1).getDay();
  const firstDayIndex = firstDay === 0 ? 6 : firstDay - 1;
  
  // Get total days in current month
  const totalDays = new Date(currentYear, currentMonth + 1, 0).getDate();
  
  // Generate blank prefix cells
  for (let i = 0; i < firstDayIndex; i++) {
    const emptyCell = document.createElement('div');
    emptyCell.className = 'day-cell empty-cell';
    daysGrid.appendChild(emptyCell);
  }
  
  // Generate active date cells
  const today = new Date();
  const todayStr = formatDateString(today.getFullYear(), today.getMonth(), today.getDate());

  for (let day = 1; day <= totalDays; day++) {
    const dateStr = formatDateString(currentYear, currentMonth, day);
    
    const dayCell = document.createElement('div');
    dayCell.className = 'day-cell';
    dayCell.textContent = day;
    
    // Highlight today
    if (dateStr === todayStr) {
      dayCell.classList.add('today-cell');
    }
    
    // Highlight selected cell
    if (dateStr === selectedDateStr) {
      dayCell.classList.add('selected-cell');
    }
    
    // Check for events (classes, quizzes, holidays)
    const dayEvents = getEventsForDate(dateStr);
    if (dayEvents.hasEvents) {
      const dotsContainer = document.createElement('div');
      dotsContainer.className = 'dots-container';
      
      if (dayEvents.classesCount > 0) {
        const dot = document.createElement('div');
        dot.className = 'dot dot-class';
        dotsContainer.appendChild(dot);
      }
      if (dayEvents.activitiesCount > 0) {
        const dot = document.createElement('div');
        dot.className = 'dot dot-activity';
        dotsContainer.appendChild(dot);
      }
      if (dayEvents.holidaysCount > 0) {
        const dot = document.createElement('div');
        dot.className = 'dot dot-holiday';
        dotsContainer.appendChild(dot);
      }
      
      dayCell.appendChild(dotsContainer);
    }
    
    // Click event handler
    dayCell.addEventListener('click', () => {
      // Remove old selection
      const previousSelected = daysGrid.querySelector('.selected-cell');
      if (previousSelected) {
        previousSelected.classList.remove('selected-cell');
      }
      
      // Apply new selection
      dayCell.classList.add('selected-cell');
      selectedDateStr = dateStr;
      
      // Update details panel
      renderDayDetails(dateStr);
    });
    
    daysGrid.appendChild(dayCell);
  }
}

// Retrieve events counts for a given date
function getEventsForDate(dateStr) {
  if (!studentData) return { hasEvents: false };
  
  const classes = studentData.sessions.filter(s => s.classDate === dateStr);
  const activities = studentData.activities.filter(a => a.date === dateStr);
  const holidays = studentData.holidays.filter(h => {
    // Holidays can be multi-day; check if dateStr falls within [startDate, endDate]
    const date = new Date(dateStr + 'T00:00:00Z');
    const start = new Date(h.startDate + 'T00:00:00Z');
    const end = new Date((h.endDate || h.startDate) + 'T00:00:00Z');
    return date >= start && date <= end;
  });
  
  return {
    hasEvents: classes.length > 0 || activities.length > 0 || holidays.length > 0,
    classesCount: classes.length,
    activitiesCount: activities.length,
    holidaysCount: holidays.length,
    classes,
    activities,
    holidays
  };
}

// Render schedule timeline list in the details panel
function renderDayDetails(dateStr) {
  selectedDateLabel.textContent = `Schedule for ${dateStr}`;
  timelineContainer.innerHTML = '';
  
  const events = getEventsForDate(dateStr);
  
  if (!events.hasEvents) {
    timelineContainer.innerHTML = `<div class="no-events-text">🎉 No classes, quizzes, or holidays! Enjoy your day off.</div>`;
    return;
  }
  
  const items = [];
  
  // 1. Map Class Sessions
  events.classes.forEach(s => {
    const cancelPrefix = (s.status === 'cancelled' || s.isCancelled) ? '❌ [CANCELLED] ' : '';
    items.push({
      type: 'class',
      time: `${(s.startTime || '').slice(0, 5)} - ${(s.endTime || '').slice(0, 5)}`,
      name: `${cancelPrefix}${s.course?.courseName || 'Class'}`,
      meta: `Code: ${s.course?.courseCode || 'N/A'} | Venue: ${s.venue?.name || 'Not Specified'} | Faculty: ${s.faculty ? [s.faculty.prefix, s.faculty.firstName, s.faculty.lastName].filter(Boolean).join(' ') : 'Not Specified'}`,
      sortTime: s.startTime || ''
    });
  });
  
  // 2. Map Activities
  events.activities.forEach(act => {
    items.push({
      type: 'activity',
      time: act.startTime ? act.startTime.slice(0, 5) : 'Quiz/Act',
      name: `🔔 ${act.name || 'Activity'}`,
      meta: `Type: ${act.type || 'Non-Academic'} | Venue: ${act.venue?.name || 'Not Specified'}`,
      sortTime: act.startTime || '00:00'
    });
  });
  
  // 3. Map Holidays
  events.holidays.forEach(h => {
    items.push({
      type: 'holiday',
      time: 'ALL DAY',
      name: `🌴 Holiday: ${h.name || 'Holiday'}`,
      meta: h.description || `Type: ${h.type || 'Holiday'}`,
      sortTime: '00:00' // Holidays go at the top
    });
  });
  
  // Sort items by time slot
  items.sort((a, b) => a.sortTime.localeCompare(b.sortTime));
  
  // Append items to list
  items.forEach(item => {
    const itemEl = document.createElement('div');
    itemEl.className = `timeline-item strip-${item.type}`;
    
    itemEl.innerHTML = `
      <div class="time-slot">${item.time}</div>
      <div class="event-info">
        <div class="event-name">${item.name}</div>
        <div class="event-meta">${item.meta}</div>
      </div>
    `;
    
    timelineContainer.appendChild(itemEl);
  });
}

// Header monthly controls
prevMonthBtn.addEventListener('click', () => {
  if (currentMonth === 0) {
    currentMonth = 11;
    currentYear -= 1;
  } else {
    currentMonth -= 1;
  }
  renderCalendar();
});

nextMonthBtn.addEventListener('click', () => {
  if (currentMonth === 11) {
    currentMonth = 0;
    currentYear += 1;
  } else {
    currentMonth += 1;
  }
  renderCalendar();
});

// Load the schedule on script startup
fetchSchedule();
