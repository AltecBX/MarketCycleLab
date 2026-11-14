/**
 * U.S. equity exchange session calendar (NYSE and Nasdaq regular sessions).
 *
 * Rule-based for 1998 onward, plus the dated unscheduled closures listed below. Years before 1998
 * are outside the verified range and `calendarCoverage()` says so. Session dates are exchange-local
 * calendar dates, so every function here is timezone free: dates are handled as UTC day numbers.
 *
 * A provider can be missing a session this calendar expects. That is reported as a missing session.
 * It is never silently treated as the previous trading day.
 */
import type { ISODate } from './types';

const MS_DAY = 86_400_000;

export const toDayNum = (iso: ISODate): number => {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  return Math.round(Date.UTC(y, m - 1, d) / MS_DAY);
};

export const fromDayNum = (n: number): ISODate => new Date(n * MS_DAY).toISOString().slice(0, 10);

export const isIsoDate = (s: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return fromDayNum(toDayNum(s)) === s;
};

export const ymd = (y: number, m: number, d: number): ISODate =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export const yearOf = (iso: ISODate): number => Number(iso.slice(0, 4));
export const monthOf = (iso: ISODate): number => Number(iso.slice(5, 7));
export const dayOf = (iso: ISODate): number => Number(iso.slice(8, 10));
export const quarterOf = (iso: ISODate): number => Math.floor((monthOf(iso) - 1) / 3) + 1;

/** ISO weekday. 1 = Monday ... 7 = Sunday. */
export const weekday = (iso: ISODate): number => {
  const w = new Date(toDayNum(iso) * MS_DAY).getUTCDay();
  return w === 0 ? 7 : w;
};

export const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const weekdayName = (iso: ISODate): string => WEEKDAY_NAMES[weekday(iso) - 1] ?? '';

export const addDays = (iso: ISODate, n: number): ISODate => fromDayNum(toDayNum(iso) + n);

/** Monday of the Monday to Friday week containing the date. Verified pattern d - WEEKDAY(d,2) + 1. */
export const mondayOf = (iso: ISODate): ISODate => addDays(iso, 1 - weekday(iso));
/** Nominal Friday label of the Monday to Friday week containing the date. */
export const fridayOf = (iso: ISODate): ISODate => addDays(mondayOf(iso), 4);

/** ISO 8601 week number and ISO week-year. */
export const isoWeek = (iso: ISODate): { year: number; week: number } => {
  const thursday = addDays(mondayOf(iso), 3);
  const y = yearOf(thursday);
  const jan4 = ymd(y, 1, 4);
  const week1Monday = mondayOf(jan4);
  const week = Math.round((toDayNum(mondayOf(iso)) - toDayNum(week1Monday)) / 7) + 1;
  return { year: y, week };
};

/** Nth weekday of a month. weekdayIso 1..7, n 1-based. */
const nthWeekday = (y: number, m: number, weekdayIso: number, n: number): ISODate => {
  const first = ymd(y, m, 1);
  const offset = (weekdayIso - weekday(first) + 7) % 7;
  return addDays(first, offset + 7 * (n - 1));
};

const lastWeekday = (y: number, m: number, weekdayIso: number): ISODate => {
  const firstNext = m === 12 ? ymd(y + 1, 1, 1) : ymd(y, m + 1, 1);
  const last = addDays(firstNext, -1);
  const back = (weekday(last) - weekdayIso + 7) % 7;
  return addDays(last, -back);
};

/** Gregorian Easter Sunday (anonymous algorithm). */
const easterSunday = (y: number): ISODate => {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(y, month, day);
};

/**
 * Unscheduled full-day closures inside the verified range.
 * Each entry carries its reason so Data and methods can show it.
 */
export const SPECIAL_CLOSURES: Readonly<Record<ISODate, string>> = {
  '2001-09-11': 'September 11 attacks',
  '2001-09-12': 'September 11 attacks',
  '2001-09-13': 'September 11 attacks',
  '2001-09-14': 'September 11 attacks',
  '2004-06-11': 'National day of mourning, President Reagan',
  '2007-01-02': 'National day of mourning, President Ford',
  '2012-10-29': 'Hurricane Sandy',
  '2012-10-30': 'Hurricane Sandy',
  '2018-12-05': 'National day of mourning, President G. H. W. Bush',
  '2025-01-09': 'National day of mourning, President Carter',
};

export const CALENDAR_FIRST_YEAR = 1998;
export const CALENDAR_VERSION = 'us-equity-rules-v1';

/** A fixed-date holiday observed on Friday when it falls on Saturday and Monday when on Sunday. */
const observed = (date: ISODate): ISODate | null => {
  const w = weekday(date);
  if (w === 6) return addDays(date, -1);
  if (w === 7) return addDays(date, 1);
  return date;
};

const holidayCache = new Map<number, Map<ISODate, string>>();

/** Full-day market holidays and unscheduled closures for a calendar year, with names. */
export const holidaysOfYear = (y: number): Map<ISODate, string> => {
  const hit = holidayCache.get(y);
  if (hit) return hit;
  const out = new Map<ISODate, string>();
  const add = (d: ISODate | null, name: string) => {
    if (d && yearOf(d) === y) out.set(d, name);
  };
  // New Year's Day. When January 1 is a Saturday the exchange does not close the prior Friday.
  const ny = ymd(y, 1, 1);
  if (weekday(ny) === 7) add(addDays(ny, 1), "New Year's Day (observed)");
  else if (weekday(ny) !== 6) add(ny, "New Year's Day");
  add(nthWeekday(y, 1, 1, 3), 'Martin Luther King Jr. Day');
  add(nthWeekday(y, 2, 1, 3), "Washington's Birthday");
  add(addDays(easterSunday(y), -2), 'Good Friday');
  add(lastWeekday(y, 5, 1), 'Memorial Day');
  if (y >= 2022) add(observed(ymd(y, 6, 19)), 'Juneteenth');
  add(observed(ymd(y, 7, 4)), 'Independence Day');
  add(nthWeekday(y, 9, 1, 1), 'Labor Day');
  add(nthWeekday(y, 11, 4, 4), 'Thanksgiving Day');
  add(observed(ymd(y, 12, 25)), 'Christmas Day');
  for (const [d, name] of Object.entries(SPECIAL_CLOSURES)) add(d, name);
  holidayCache.set(y, out);
  return out;
};

export const holidayName = (iso: ISODate): string | null => holidaysOfYear(yearOf(iso)).get(iso) ?? null;

/** True when the exchange holds a regular session on the date. */
export const isSession = (iso: ISODate): boolean => {
  if (weekday(iso) >= 6) return false;
  return !holidaysOfYear(yearOf(iso)).has(iso);
};

/** Scheduled 1:00 p.m. ET early closes: day after Thanksgiving, Christmas Eve, July 3. */
export const isEarlyClose = (iso: ISODate): boolean => {
  if (!isSession(iso)) return false;
  const y = yearOf(iso);
  if (iso === addDays(nthWeekday(y, 11, 4, 4), 1)) return true;
  if (iso === ymd(y, 12, 24)) return true;
  // July 3 closes early when July 4 itself is a weekday holiday (Tuesday to Friday).
  if (iso === ymd(y, 7, 3)) {
    const w4 = weekday(ymd(y, 7, 4));
    return w4 >= 2 && w4 <= 5;
  }
  return false;
};

/** Regular close in ET, 'HH:MM'. */
export const closeTimeET = (iso: ISODate): string | null =>
  isSession(iso) ? (isEarlyClose(iso) ? '13:00' : '16:00') : null;

export const nextSession = (iso: ISODate): ISODate => {
  let d = addDays(iso, 1);
  while (!isSession(d)) d = addDays(d, 1);
  return d;
};

export const prevSession = (iso: ISODate): ISODate => {
  let d = addDays(iso, -1);
  while (!isSession(d)) d = addDays(d, -1);
  return d;
};

/** The date itself when it is a session, otherwise the most recent earlier session. */
export const sessionOnOrBefore = (iso: ISODate): ISODate => (isSession(iso) ? iso : prevSession(iso));
export const sessionOnOrAfter = (iso: ISODate): ISODate => (isSession(iso) ? iso : nextSession(iso));

/** Sessions in the inclusive date range. */
export const sessionsBetween = (from: ISODate, to: ISODate): ISODate[] => {
  const out: ISODate[] = [];
  const end = toDayNum(to);
  for (let n = toDayNum(from); n <= end; n++) {
    const d = fromDayNum(n);
    if (isSession(d)) out.push(d);
  }
  return out;
};

/** Move by n sessions. n may be negative. n = 0 returns the session on or before the date. */
export const addSessions = (iso: ISODate, n: number): ISODate => {
  let d = sessionOnOrBefore(iso);
  if (n > 0) for (let i = 0; i < n; i++) d = nextSession(d);
  if (n < 0) for (let i = 0; i < -n; i++) d = prevSession(d);
  return d;
};

export const monthStart = (iso: ISODate): ISODate => ymd(yearOf(iso), monthOf(iso), 1);
export const monthEnd = (iso: ISODate): ISODate => {
  const y = yearOf(iso);
  const m = monthOf(iso);
  return addDays(m === 12 ? ymd(y + 1, 1, 1) : ymd(y, m + 1, 1), -1);
};

export const sessionsOfMonth = (y: number, m: number): ISODate[] =>
  sessionsBetween(ymd(y, m, 1), monthEnd(ymd(y, m, 1)));

/** Expected sessions of the Monday to Friday week that contains the date. */
export const sessionsOfWeek = (iso: ISODate): ISODate[] => sessionsBetween(mondayOf(iso), fridayOf(iso));

/** Planned sessions strictly after the anchor through the end of its calendar month. */
export const remainingSessionsInMonth = (anchor: ISODate): ISODate[] =>
  sessionsBetween(addDays(anchor, 1), monthEnd(anchor));

/** Last session of the calendar month containing the date. */
export const lastSessionOfMonth = (iso: ISODate): ISODate => sessionOnOrBefore(monthEnd(iso));

/** Period key helpers used by period-to-date bases. */
export const periodKey = (iso: ISODate, period: 'W' | 'M' | 'Q' | 'Y'): string => {
  switch (period) {
    case 'W':
      return mondayOf(iso);
    case 'M':
      return iso.slice(0, 7);
    case 'Q':
      return `${yearOf(iso)}-Q${quarterOf(iso)}`;
    case 'Y':
      return iso.slice(0, 4);
  }
};

export const calendarCoverage = (): { firstYear: number; version: string; note: string } => ({
  firstYear: CALENDAR_FIRST_YEAR,
  version: CALENDAR_VERSION,
  note:
    'Rule-based U.S. equity regular sessions from 1998 with dated unscheduled closures. ' +
    'Earlier years and future schedule changes need a verified exchange source.',
});

/**
 * The latest session whose regular close has happened at the given instant.
 * `nowUtc` is an ISO timestamp. Uses America/New_York wall time through Intl.
 */
export const latestCompletedSession = (nowUtc: string): ISODate => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(nowUtc));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const today = `${get('year')}-${get('month')}-${get('day')}`;
  const hm = `${get('hour')}:${get('minute')}`;
  const close = closeTimeET(today);
  if (close && hm >= close) return today;
  return prevSession(today);
};
