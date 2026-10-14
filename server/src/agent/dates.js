// Date helpers for the agent. Small local models are unreliable at date arithmetic ("this Friday" came
// back as Thursday), so the prompt gets a ready-made calendar to copy from, and the words the caller
// actually said ("Friday", "tomorrow") are resolved here in code, where the answer cannot be wrong.
// Pure functions, no imports: tested in scripts/test-agent.js.

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const pad = (n) => String(n).padStart(2, '0');

export function toISODate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
const weekdayName = (date) => date.toLocaleDateString('en-US', { weekday: 'long' });

// "- Tuesday 2026-10-13 (today)" lines for the next `days` days, for the model to copy dates from.
export function buildCalendar(now = new Date(), days = 14) {
  const today = startOfDay(now);
  const lines = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(today, i);
    const label = i === 0 ? ' (today)' : i === 1 ? ' (tomorrow)' : '';
    lines.push(`- ${weekdayName(day)} ${toISODate(day)}${label}`);
  }
  return lines.join('\n');
}

// Finds the day the caller named in their message and returns it as YYYY-MM-DD, or '' when the
// message names no day or names several. A bare weekday means the next one after today;
// "next Friday" means the first Friday at least 7 days away.
export function resolveRelativeDate(text, now = new Date()) {
  const lower = String(text || '').toLowerCase();
  const today = startOfDay(now);
  const found = new Set();

  for (const match of lower.matchAll(/\b(day after tomorrow|tomorrow|tonight|today)\b/g)) {
    const offset = match[1] === 'day after tomorrow' ? 2 : match[1] === 'tomorrow' ? 1 : 0;
    found.add(toISODate(addDays(today, offset)));
  }

  const weekdayPattern = new RegExp(`\\b(?:(next|this)\\s+)?(${WEEKDAYS.join('|')})\\b`, 'g');
  for (const match of lower.matchAll(weekdayPattern)) {
    let delta = (WEEKDAYS.indexOf(match[2]) - today.getDay() + 7) % 7;
    if (delta === 0) delta = 7; // saying today's weekday means next week's
    if (match[1] === 'next' && delta < 7) delta += 7;
    found.add(toISODate(addDays(today, delta)));
  }

  return found.size === 1 ? [...found][0] : '';
}

// True when the message seems to give a calendar date ("20th", "Oct 20", "20/10", "2026-10-20").
export function looksLikeDate(text) {
  return /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b\d{1,2}[/.-]\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}(st|nd|rd|th)\b/i.test(
    String(text || '')
  );
}

export function isPastDate(isoDate, now = new Date()) {
  return typeof isoDate === 'string' && isoDate < toISODate(now); // YYYY-MM-DD strings sort like dates
}
