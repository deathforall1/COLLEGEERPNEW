/**
 * Helper to escape characters for iCalendar format
 */
function escapeICS(str) {
  if (!str) return '';
  return str
    .toString()
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}

/**
 * Helper to format date and time to YYYYMMDDTHHMMSS
 */
function formatDateTime(dateStr, timeStr) {
  const date = dateStr.replace(/-/g, '');
  const time = timeStr ? timeStr.replace(/:/g, '') : '000000';
  return `${date}T${time}`;
}

/**
 * Helper to add one day and format as YYYYMMDD (for non-inclusive all-day end dates)
 */
function addOneDay(dateStr) {
  const date = new Date(dateStr + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Simple line folding helper to ensure lines are <= 75 characters (RFC 5545)
 */
function foldLine(line) {
  if (line.length <= 75) return line;
  let result = '';
  let index = 0;
  while (index < line.length) {
    if (index === 0) {
      result += line.substring(0, 75);
      index += 75;
    } else {
      result += '\r\n ' + line.substring(index, index + 74);
      index += 74;
    }
  }
  return result;
}

/**
 * Formats a single line or folded lines for ICS
 */
function writeLine(key, value) {
  const escapedValue = escapeICS(value);
  const rawLine = `${key}:${escapedValue}`;
  return foldLine(rawLine) + '\r\n';
}

/**
 * Generates an iCalendar RFC 5545 string
 * @param {Array} sessions - Class sessions
 * @param {Array} activities - Student activities
 * @param {Array} holidays - Academic holidays
 * @returns {string} ICS content
 */
function generateICS(sessions = [], activities = [], holidays = []) {
  const dtstamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  
  let ics = '';
  ics += 'BEGIN:VCALENDAR\r\n';
  ics += 'VERSION:2.0\r\n';
  ics += 'PRODID:-//XLRI ERP Calendar Bot//EN\r\n';
  ics += 'CALSCALE:GREGORIAN\r\n';
  ics += 'METHOD:PUBLISH\r\n';
  ics += 'X-WR-CALNAME:XLRI ERP Schedule\r\n';
  ics += 'X-WR-TIMEZONE:Asia/Kolkata\r\n';
  
  // Asia/Kolkata Timezone Definition
  ics += 'BEGIN:VTIMEZONE\r\n';
  ics += 'TZID:Asia/Kolkata\r\n';
  ics += 'X-LIC-LOCATION:Asia/Kolkata\r\n';
  ics += 'BEGIN:STANDARD\r\n';
  ics += 'TZOFFSETFROM:+0530\r\n';
  ics += 'TZOFFSETTO:+0530\r\n';
  ics += 'TZNAME:IST\r\n';
  ics += 'DTSTART:19700101T000000\r\n';
  ics += 'END:STANDARD\r\n';
  ics += 'END:VTIMEZONE\r\n';

  // 1. Process Class Sessions
  for (const s of sessions) {
    if (!s.classDate) continue;
    
    ics += 'BEGIN:VEVENT\r\n';
    ics += `UID:session-${s.sessionId || Math.random().toString(36).substr(2, 9)}@xlerp-bot\r\n`;
    ics += `DTSTAMP:${dtstamp}\r\n`;
    
    const startStr = formatDateTime(s.classDate, s.startTime);
    const endStr = formatDateTime(s.classDate, s.endTime);
    
    ics += `DTSTART;TZID=Asia/Kolkata:${startStr}\r\n`;
    ics += `DTEND;TZID=Asia/Kolkata:${endStr}\r\n`;
    
    // Summary
    const courseName = s.course?.courseName || 'Class';
    const courseCode = s.course?.courseCode ? ` (${s.course.courseCode})` : '';
    const section = s.section?.sectionCode ? ` - Sec ${s.section.sectionCode}` : '';
    const cancelledPrefix = (s.isCancelled || s.status === 'cancelled') ? '[CANCELLED] ' : '';
    const summary = `${cancelledPrefix}${courseName}${courseCode}${section}`;
    ics += writeLine('SUMMARY', summary);
    
    // Location
    const venueName = s.venue?.name || '';
    const venueCode = s.venue?.code ? ` (${s.venue.code})` : '';
    const location = `${venueName}${venueCode}`.trim();
    if (location) {
      ics += writeLine('LOCATION', location);
    }
    
    // Description
    const facultyName = s.faculty ? [s.faculty.prefix, s.faculty.firstName, s.faculty.lastName].filter(Boolean).join(' ') : '';
    const batchName = s.batch?.batchName || s.batch?.batchId || '';
    
    let description = '';
    if (facultyName) description += `Instructor: ${facultyName}\n`;
    if (batchName) description += `Batch: ${batchName}\n`;
    if (s.section?.sectionCode) description += `Section: ${s.section.sectionCode}\n`;
    if (s.status) description += `Status: ${s.status}\n`;
    if (s.isRescheduled && s.originalDate) description += `Note: Rescheduled from ${s.originalDate}\n`;
    if (s.iAmTa) description += `Role: Teaching Assistant (TA)\n`;
    
    ics += writeLine('DESCRIPTION', description.trim());
    
    if (s.isCancelled || s.status === 'cancelled') {
      ics += 'STATUS:CANCELLED\r\n';
    } else {
      ics += 'STATUS:CONFIRMED\r\n';
    }
    
    ics += 'END:VEVENT\r\n';
  }

  // 2. Process Student Activities
  for (const act of activities) {
    if (!act.date) continue;
    
    ics += 'BEGIN:VEVENT\r\n';
    ics += `UID:activity-${act.id || Math.random().toString(36).substr(2, 9)}@xlerp-bot\r\n`;
    ics += `DTSTAMP:${dtstamp}\r\n`;
    
    const startStr = formatDateTime(act.date, act.startTime);
    const endStr = formatDateTime(act.date, act.endTime);
    
    ics += `DTSTART;TZID=Asia/Kolkata:${startStr}\r\n`;
    ics += `DTEND;TZID=Asia/Kolkata:${endStr}\r\n`;
    
    // Summary
    const summary = `Activity: ${act.name || 'Student Activity'}`;
    ics += writeLine('SUMMARY', summary);
    
    // Location
    const venueName = act.venue?.name || '';
    const venueCode = act.venue?.code ? ` (${act.venue.code})` : '';
    const location = `${venueName}${venueCode}`.trim();
    if (location) {
      ics += writeLine('LOCATION', location);
    }
    
    // Description
    let description = '';
    if (act.type) description += `Type: ${act.type}\n`;
    if (act.batchSection?.sectionCode) description += `Section: ${act.batchSection.sectionCode}\n`;
    if (act.description) description += `Description: ${act.description}\n`;
    
    ics += writeLine('DESCRIPTION', description.trim());
    ics += 'STATUS:CONFIRMED\r\n';
    ics += 'END:VEVENT\r\n';
  }

  // 3. Process Holidays
  for (const h of holidays) {
    if (!h.startDate) continue;
    
    ics += 'BEGIN:VEVENT\r\n';
    ics += `UID:holiday-${h.holidayId || Math.random().toString(36).substr(2, 9)}@xlerp-bot\r\n`;
    ics += `DTSTAMP:${dtstamp}\r\n`;
    
    const startStr = h.startDate.replace(/-/g, '');
    const endStr = addOneDay(h.endDate || h.startDate);
    
    ics += `DTSTART;VALUE=DATE:${startStr}\r\n`;
    ics += `DTEND;VALUE=DATE:${endStr}\r\n`;
    
    // Summary
    const summary = `Holiday: ${h.name || 'Academic Holiday'}`;
    ics += writeLine('SUMMARY', summary);
    
    // Description
    let description = '';
    if (h.type) description += `Type: ${h.type}\n`;
    if (h.description) description += `Description: ${h.description}\n`;
    
    ics += writeLine('DESCRIPTION', description.trim());
    ics += 'STATUS:CONFIRMED\r\n';
    ics += 'END:VEVENT\r\n';
  }

  ics += 'END:VCALENDAR\r\n';
  return ics;
}

module.exports = {
  generateICS
};
