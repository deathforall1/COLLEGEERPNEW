// Frontend Controller for XLRI Timetable Sync Bot

// Global State
let calendarData = {
  sessions: [],
  activities: [],
  holidays: [],
  courses: [],
  savedSections: {},
  profile: {}
};
let currentPreviewView = 'sessions'; // default

// DOM Elements
const connectionCard = document.getElementById('connection-card');
const successCard = document.getElementById('success-card');
const loginForm = document.getElementById('login-form');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const btnSubmit = document.getElementById('btn-submit');
const btnText = btnSubmit.querySelector('.btn-text');
const btnLoader = btnSubmit.querySelector('.btn-loader');
const errorBox = document.getElementById('error-message');
const errorText = errorBox.querySelector('.error-text');

const studentName = document.getElementById('student-name');
const studentMeta = document.getElementById('student-meta');
const feedUrlInput = document.getElementById('feed-url');
const btnCopy = document.getElementById('btn-copy');
const btnDownload = document.getElementById('btn-download');
const btnReconnect = document.getElementById('btn-reconnect');

// Course Sections Configuration Elements
const coursesList = document.getElementById('courses-list');
const sectionsForm = document.getElementById('sections-form');
const btnSaveSections = document.getElementById('btn-save-sections');
const saveBtnText = btnSaveSections.querySelector('.save-btn-text');
const saveBtnLoader = btnSaveSections.querySelector('.save-btn-loader');
const toastMessage = document.getElementById('sections-success-message');

const previewCounts = document.getElementById('preview-counts');
const previewContainer = document.getElementById('preview-container');

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
  // Setup instructions tabs
  setupInstructionsTabs();
  
  // Setup preview category tabs
  setupPreviewTabs();
  
  // Setup copy button
  btnCopy.addEventListener('click', copyFeedUrl);
  
  // Setup reconnect button
  btnReconnect.addEventListener('click', disconnectAccount);
  
  // Setup login form submit
  loginForm.addEventListener('submit', handleLogin);

  // Setup sections form submit
  sectionsForm.addEventListener('submit', handleSaveSections);
  
  // Check if credentials exist in LocalStorage
  autoLogin();
});

// Auto login if credentials saved
async function autoLogin() {
  const savedEmail = localStorage.getItem('xlri_erp_email');
  const savedPassword = localStorage.getItem('xlri_erp_password');
  
  if (savedEmail && savedPassword) {
    emailInput.value = savedEmail;
    passwordInput.value = savedPassword;
    
    // Trigger login flow
    showLoading(true);
    try {
      await performAuthentication(savedEmail, savedPassword);
    } catch (err) {
      console.warn('Auto-login failed, clearing saved credentials:', err);
      localStorage.removeItem('xlri_erp_email');
      localStorage.removeItem('xlri_erp_password');
      showLoading(false);
    }
  }
}

// Handle login form submission
async function handleLogin(e) {
  e.preventDefault();
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  
  if (!email || !password) return;
  
  showLoading(true);
  hideError();
  
  try {
    await performAuthentication(email, password);
    // Save credentials for convenience
    localStorage.setItem('xlri_erp_email', email);
    localStorage.setItem('xlri_erp_password', password);
  } catch (err) {
    showError(err.message || 'Failed to authenticate. Please check your credentials and network connection.');
    showLoading(false);
  }
}

// Perform auth and data fetch api call
async function performAuthentication(email, password) {
  const response = await fetch('/api/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  
  const result = await response.json();
  
  if (!response.ok || !result.success) {
    throw new Error(result.error || 'Server error occurred during authentication.');
  }
  
  // Store globally
  calendarData.sessions = result.sessions || [];
  calendarData.activities = result.activities || [];
  calendarData.holidays = result.holidays || [];
  calendarData.courses = result.courses || [];
  calendarData.savedSections = result.savedSections || {};
  calendarData.profile = result.profile || {};
  
  // Transition UI
  showDashboard(email, password);
}

// Show success dashboard
function showDashboard(email, password) {
  connectionCard.classList.add('hidden');
  successCard.classList.remove('hidden');
  
  // Set user profile details
  const user = calendarData.profile.user || calendarData.profile;
  const name = user.firstName ? `${user.firstName} ${user.lastName || ''}`.trim() : 'XLRI Student';
  studentName.textContent = `Welcome, ${name}!`;
  
  let meta = email;
  if (calendarData.profile.roles && calendarData.profile.roles.length > 0) {
    const roleStr = calendarData.profile.roles.map(r => r.name || r).join(' / ');
    meta = `${roleStr.toUpperCase()} · ${email}`;
  }
  studentMeta.textContent = meta;
  
  // Generate calendar link
  const origin = window.location.origin;
  const feedUrl = `${origin}/api/calendar?email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`;
  feedUrlInput.value = feedUrl;
  btnDownload.href = feedUrl;
  
  // Render Course Sections Form list
  renderCoursesList();

  // Render default schedule view
  renderPreview();
}

// Render the list of courses with section selections
function renderCoursesList() {
  coursesList.innerHTML = '';
  
  if (calendarData.courses.length === 0) {
    coursesList.innerHTML = '<div class="loader-placeholder">No registered courses found for this term.</div>';
    return;
  }
  
  // Sort courses by code
  const sortedCourses = calendarData.courses.slice().sort((a, b) => a.courseCode.localeCompare(b.courseCode));
  
  sortedCourses.forEach(c => {
    const itemEl = document.createElement('div');
    itemEl.className = 'course-item';
    
    const savedSec = calendarData.savedSections[c.id] || '';
    
    itemEl.innerHTML = `
      <div class="course-info">
        <span class="course-code-badge">${c.courseCode || 'CORE'} ${c.courseOfferCode ? `· ${c.courseOfferCode}` : ''}</span>
        <span class="course-name-text" title="${c.courseName}">${c.courseName}</span>
      </div>
      <div class="select-wrapper">
        <select class="section-select" data-course-id="${c.id}">
          <option value="" ${savedSec === '' ? 'selected' : ''}>Not Set</option>
          <option value="A" ${savedSec === 'A' ? 'selected' : ''}>Section A</option>
          <option value="B" ${savedSec === 'B' ? 'selected' : ''}>Section B</option>
          <option value="C" ${savedSec === 'C' ? 'selected' : ''}>Section C</option>
          <option value="D" ${savedSec === 'D' ? 'selected' : ''}>Section D</option>
        </select>
      </div>
    `;
    
    coursesList.appendChild(itemEl);
  });
}

// Handle Sections Form submission
async function handleSaveSections(e) {
  e.preventDefault();
  
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  
  // Collect dropdown selections
  const sections = {};
  const selects = coursesList.querySelectorAll('.section-select');
  selects.forEach(select => {
    const courseId = select.dataset.courseId;
    const value = select.value;
    if (value) {
      sections[courseId] = value;
    }
  });
  
  // Show loading
  btnSaveSections.disabled = true;
  saveBtnText.classList.add('hidden');
  saveBtnLoader.classList.remove('hidden');
  toastMessage.classList.add('hidden');
  
  try {
    const response = await fetch('/api/save-sections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, sections })
    });
    
    const result = await response.json();
    
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Failed to save section preferences.');
    }
    
    // Update visual preview sessions list with filtered sessions
    calendarData.sessions = result.sessions || [];
    calendarData.savedSections = sections;
    
    // Render updated preview
    renderPreview();
    
    // Show success toast
    toastMessage.classList.remove('hidden');
    setTimeout(() => {
      toastMessage.classList.add('hidden');
    }, 4000);
    
  } catch (err) {
    alert(err.message || 'Error occurred while saving sections.');
  } finally {
    // Hide loading
    btnSaveSections.disabled = false;
    saveBtnText.classList.remove('hidden');
    saveBtnLoader.classList.add('hidden');
  }
}

// Render the Visual Preview list
function renderPreview() {
  previewContainer.innerHTML = '';
  
  let items = [];
  let noItemsMsg = '';
  let colorClass = '';
  
  if (currentPreviewView === 'sessions') {
    items = calendarData.sessions.slice().sort((a, b) => {
      const dateCompare = a.classDate.localeCompare(b.classDate);
      if (dateCompare !== 0) return dateCompare;
      return (a.startTime || '').localeCompare(b.startTime || '');
    });
    noItemsMsg = 'No class sessions scheduled for your selected sections.';
    previewCounts.textContent = `${items.length} classes loaded`;
    colorClass = 'type-class';
  } else if (currentPreviewView === 'activities') {
    items = calendarData.activities.slice().sort((a, b) => {
      const dateCompare = a.date.localeCompare(b.date);
      if (dateCompare !== 0) return dateCompare;
      return (a.startTime || '').localeCompare(b.startTime || '');
    });
    noItemsMsg = 'No upcoming activities found.';
    previewCounts.textContent = `${items.length} activities loaded`;
    colorClass = 'type-activity';
  } else if (currentPreviewView === 'holidays') {
    items = calendarData.holidays.slice().sort((a, b) => a.startDate.localeCompare(b.startDate));
    noItemsMsg = 'No holidays scheduled in this range.';
    previewCounts.textContent = `${items.length} holidays loaded`;
    colorClass = 'type-holiday';
  }
  
  if (items.length === 0) {
    previewContainer.innerHTML = `<div class="loader-placeholder">${noItemsMsg}</div>`;
    return;
  }
  
  items.forEach(item => {
    const itemEl = document.createElement('div');
    itemEl.className = `preview-item ${colorClass}`;
    
    let timeStart = '--:--';
    let timeEnd = '';
    let dateStr = '';
    let title = '';
    let metaHTML = '';
    
    if (currentPreviewView === 'sessions') {
      timeStart = item.startTime ? item.startTime.substring(0, 5) : '--:--';
      timeEnd = item.endTime ? item.endTime.substring(0, 5) : '';
      dateStr = formatDate(item.classDate);
      
      const isCancelled = item.isCancelled || item.status === 'cancelled';
      const titleClass = isCancelled ? 'cancelled-line' : '';
      
      title = `<span class="${titleClass}">${item.course?.courseName || 'Class'}</span>`;
      if (isCancelled) {
        title += ` <span class="item-badge badge-cancelled">Cancelled</span>`;
      }
      if (item.iAmTa) {
        title += ` <span class="item-badge badge-ta">TA</span>`;
      }
      
      const venueName = item.venue?.name || '';
      const faculty = item.faculty ? [item.faculty.prefix, item.faculty.firstName, item.faculty.lastName].filter(Boolean).join(' ') : '';
      const secCode = item.section?.sectionCode ? `Sec ${item.section.sectionCode}` : '';
      
      metaHTML = `
        <div class="item-metadata">
          <div class="meta-field"><span class="meta-icon">📅</span> ${dateStr}</div>
          ${venueName ? `<div class="meta-field"><span class="meta-icon">📍</span> ${venueName}</div>` : ''}
          ${secCode ? `<div class="meta-field"><span class="meta-icon">👥</span> ${secCode}</div>` : ''}
          ${faculty ? `<div class="meta-field"><span class="meta-icon">👨‍🏫</span> ${faculty}</div>` : ''}
        </div>
      `;
    } else if (currentPreviewView === 'activities') {
      timeStart = item.startTime ? item.startTime.substring(0, 5) : '--:--';
      timeEnd = item.endTime ? item.endTime.substring(0, 5) : '';
      dateStr = formatDate(item.date);
      title = `<span>${item.name || 'Activity'}</span>`;
      
      const venueName = item.venue?.name || '';
      const type = item.type || 'Other';
      
      metaHTML = `
        <div class="item-metadata">
          <div class="meta-field"><span class="meta-icon">📅</span> ${dateStr}</div>
          <div class="meta-field"><span class="meta-icon">🏷️</span> ${type}</div>
          ${venueName ? `<div class="meta-field"><span class="meta-icon">📍</span> ${venueName}</div>` : ''}
          ${item.description ? `<div class="meta-field"><span class="meta-icon">📝</span> ${item.description}</div>` : ''}
        </div>
      `;
    } else if (currentPreviewView === 'holidays') {
      timeStart = 'All';
      timeEnd = 'Day';
      const start = formatDate(item.startDate);
      const end = item.endDate && item.endDate !== item.startDate ? formatDate(item.endDate) : '';
      dateStr = end ? `${start} to ${end}` : start;
      title = `<span>${item.name || 'Holiday'}</span>`;
      
      metaHTML = `
        <div class="item-metadata">
          <div class="meta-field"><span class="meta-icon">📅</span> ${dateStr}</div>
          <div class="meta-field"><span class="meta-icon">🏷️</span> ${item.type || 'Holiday'}</div>
          ${item.description ? `<div class="meta-field"><span class="meta-icon">📝</span> ${item.description}</div>` : ''}
        </div>
      `;
    }
    
    itemEl.innerHTML = `
      <div class="item-time-box">
        <div class="item-time-start">${timeStart}</div>
        ${timeEnd ? `<div class="item-time-end">${timeEnd}</div>` : ''}
      </div>
      <div class="item-details">
        <h4 class="item-title">${title}</h4>
        ${metaHTML}
      </div>
    `;
    
    previewContainer.appendChild(itemEl);
  });
}

// Date Formatter helper (e.g. 2026-06-21 -> Sun, Jun 21)
function formatDate(dateStr) {
  try {
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    });
  } catch (err) {
    return dateStr;
  }
}

// Copy URL to clipboard
function copyFeedUrl() {
  feedUrlInput.select();
  feedUrlInput.setSelectionRange(0, 99999); // mobile
  
  navigator.clipboard.writeText(feedUrlInput.value)
    .then(() => {
      const originalText = btnCopy.textContent;
      btnCopy.textContent = 'Copied! ✓';
      btnCopy.style.background = 'rgba(16, 185, 129, 0.2)';
      btnCopy.style.borderColor = 'rgba(16, 185, 129, 0.4)';
      
      setTimeout(() => {
        btnCopy.textContent = originalText;
        btnCopy.style.background = '';
        btnCopy.style.borderColor = '';
      }, 2000);
    })
    .catch(err => {
      alert('Could not copy link automatically, please select and copy manually.');
    });
}

// Disconnect/Logout action
function disconnectAccount() {
  localStorage.removeItem('xlri_erp_email');
  localStorage.removeItem('xlri_erp_password');
  
  calendarData = { sessions: [], activities: [], holidays: [], courses: [], savedSections: {}, profile: {} };
  
  emailInput.value = '';
  passwordInput.value = '';
  
  successCard.classList.add('hidden');
  connectionCard.classList.remove('hidden');
  
  showLoading(false);
  hideError();
}

// Setup tab panels for instructions
function setupInstructionsTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // Deactivate all
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
      
      // Activate clicked
      tab.classList.add('active');
      const tabId = `tab-${tab.dataset.tab}`;
      document.getElementById(tabId).classList.add('active');
    });
  });
}

// Setup preview categories tab panels
function setupPreviewTabs() {
  const tabs = document.querySelectorAll('.preview-tab-btn');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.preview-tab-btn').forEach(btn => btn.classList.remove('active'));
      tab.classList.add('active');
      currentPreviewView = tab.dataset.view;
      renderPreview();
    });
  });
}

// Helper to show/hide loading states on login button
function showLoading(isLoading) {
  if (isLoading) {
    btnSubmit.disabled = true;
    btnText.classList.add('hidden');
    btnLoader.classList.remove('hidden');
  } else {
    btnSubmit.disabled = false;
    btnText.classList.remove('hidden');
    btnLoader.classList.add('hidden');
  }
}

// Helper to display error message
function showError(msg) {
  errorText.textContent = msg;
  errorBox.classList.remove('hidden');
}

// Helper to hide error message
function hideError() {
  errorBox.classList.add('hidden');
  errorText.textContent = '';
}
