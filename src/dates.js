// Small natural-language date parser for deadlines coming from emails/texts.
// Times are interpreted in the server's local timezone (set TZ, e.g. TZ=America/New_York).
// Date-only values default to DEFAULT_DUE_HOUR (17:00, end of business day).

export const DEFAULT_DUE_HOUR = 17;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const monthIndex = (s) => MONTHS.indexOf(s.slice(0, 3).toLowerCase());
const dayIndex = (s) => DAYS.indexOf(s.slice(0, 3).toLowerCase());

/** Pull a trailing/embedded time ("5pm", "5:30 pm", "17:00", "at 9am", "noon") out of the string. */
function extractTime(str) {
  let s = str;
  let time = null;
  const named = s.match(/\b(noon|midday|midnight|eod|end of day|cob)\b/i);
  if (named) {
    const w = named[1].toLowerCase();
    time = w === 'midnight' ? [23, 59] : w === 'noon' || w === 'midday' ? [12, 0] : [DEFAULT_DUE_HOUR, 0];
    s = s.replace(named[0], ' ');
  }
  const m = s.match(/\b(?:at\s+|@\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/i)
    || s.match(/\b(?:at\s+|@\s*)?([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2] || 0);
    const ap = (m[3] || '').toLowerCase().replace(/\./g, '');
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h <= 23 && min <= 59) {
      time = [h, min];
      s = s.replace(m[0], ' ');
    }
  }
  return { rest: s.replace(/\s+/g, ' ').trim(), time };
}

function atTime(d, time) {
  const out = new Date(d);
  const [h, m] = time || [DEFAULT_DUE_HOUR, 0];
  out.setHours(h, m, 0, 0);
  return out;
}

function addDays(d, n) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/** Roll a month/day without a year forward to the next occurrence. */
function nextOccurrence(now, month, day, time) {
  let d = atTime(new Date(now.getFullYear(), month, day), time);
  if (d.getMonth() !== month) return null; // e.g. Feb 31
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (d < startOfToday) d = atTime(new Date(now.getFullYear() + 1, month, day), time);
  return d;
}

/**
 * Parse a due-date phrase.
 * @returns {{ date: Date|null, clear?: boolean } | null} null = not understood; {clear:true} = remove the deadline
 */
export function parseDue(input, now = new Date()) {
  if (input == null) return null;
  const raw = String(input).trim().toLowerCase().replace(/[,]/g, ' ').replace(/\s+/g, ' ');
  if (!raw) return null;
  if (/^(none|no|clear|remove|null|-)$/.test(raw)) return { date: null, clear: true };

  // ISO first so "2026-11-20T14:00" isn't mangled by time extraction.
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2}))?$/);
  if (iso) {
    const [, y, mo, d, h, mi] = iso;
    const date = new Date(Number(y), Number(mo) - 1, Number(d), h ? Number(h) : DEFAULT_DUE_HOUR, mi ? Number(mi) : 0);
    return isNaN(date) ? null : { date };
  }

  const { rest, time } = extractTime(raw);
  const s = rest.replace(/^(by|on|due|before)\s+/, '').trim();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (s === '' && time) {
    const d = atTime(today, time);
    return { date: d < now ? addDays(d, 1) : d };
  }
  if (/^(today|tonight|eod|end of day)$/.test(s)) return { date: atTime(today, time || (s === 'tonight' ? [21, 0] : null)) };
  if (/^(tomorrow|tmrw|tmr|tom)$/.test(s)) return { date: atTime(addDays(today, 1), time) };
  if (/^(eow|end of (the )?week|this week)$/.test(s)) {
    const delta = (5 - today.getDay() + 7) % 7; // Friday
    return { date: atTime(addDays(today, delta), time) };
  }
  if (/^next week$/.test(s)) {
    const delta = ((1 - today.getDay() + 7) % 7) || 7; // next Monday
    return { date: atTime(addDays(today, delta), time) };
  }
  if (/^(eom|end of (the )?month)$/.test(s)) {
    return { date: atTime(new Date(today.getFullYear(), today.getMonth() + 1, 0), time) };
  }

  let m = s.match(/^in (\d+|a|an|one|two|three) (minute|min|hour|hr|day|week|month)s?$/);
  if (m) {
    const words = { a: 1, an: 1, one: 1, two: 2, three: 3 };
    const n = words[m[1]] ?? Number(m[1]);
    const unit = m[2];
    if (unit.startsWith('min')) return { date: new Date(now.getTime() + n * 60e3) };
    if (unit.startsWith('h')) return { date: new Date(now.getTime() + n * 3600e3) };
    if (unit === 'day') return { date: atTime(addDays(today, n), time) };
    if (unit === 'week') return { date: atTime(addDays(today, 7 * n), time) };
    const d = new Date(today);
    d.setMonth(d.getMonth() + n);
    return { date: atTime(d, time) };
  }

  m = s.match(/^(this |next )?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*$/);
  if (m && dayIndex(m[2]) >= 0) {
    const target = dayIndex(m[2]);
    let delta = (target - today.getDay() + 7) % 7;
    if (m[1] === 'next ' && delta === 0) delta = 7;
    // "friday" on a Friday means today (if the time hasn't passed), otherwise next week
    let d = atTime(addDays(today, delta), time);
    if (d < now) d = addDays(d, 7);
    return { date: d };
  }

  // "nov 20", "november 20 2026", "nov 20th"
  m = s.match(/^([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/);
  if (m && monthIndex(m[1]) >= 0) {
    const mo = monthIndex(m[1]);
    const day = Number(m[2]);
    if (m[3]) return { date: atTime(new Date(Number(m[3]), mo, day), time) };
    const d = nextOccurrence(now, mo, day, time);
    return d ? { date: d } : null;
  }
  // "20 nov", "20th november 2026"
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3,9})\.?(?: (\d{4}))?$/);
  if (m && monthIndex(m[2]) >= 0) {
    const mo = monthIndex(m[2]);
    const day = Number(m[1]);
    if (m[3]) return { date: atTime(new Date(Number(m[3]), mo, day), time) };
    const d = nextOccurrence(now, mo, day, time);
    return d ? { date: d } : null;
  }
  // US numeric: 11/20, 11/20/26, 11/20/2026
  m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/);
  if (m) {
    const mo = Number(m[1]) - 1;
    const day = Number(m[2]);
    if (mo < 0 || mo > 11 || day < 1 || day > 31) return null;
    if (m[3]) {
      const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      return { date: atTime(new Date(y, mo, day), time) };
    }
    const d = nextOccurrence(now, mo, day, time);
    return d ? { date: d } : null;
  }

  // Last resort: let JS try (handles RFC dates like "Thu, 20 Nov 2026 17:00:00 -0500").
  const fallback = new Date(String(input));
  if (!isNaN(fallback) && /\d/.test(String(input))) return { date: fallback };
  return null;
}
