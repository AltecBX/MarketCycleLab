/**
 * Series validation, coverage, alignment and period bases shared by every engine.
 */
import {
  addDays, isSession, monthOf, periodKey, prevSession, sessionOnOrBefore, sessionsBetween, toDayNum, yearOf, ymd, mondayOf, quarterOf, dayOf, monthEnd,
} from './calendar';
import { na, type Bar, type Coverage, type ISODate, type Maybe } from './types';

export type BarIssueCode = 'out-of-order' | 'duplicate-date' | 'non-finite' | 'non-positive' | 'ohlc-containment' | 'non-session-date' | 'negative-volume';

export interface BarIssue {
  code: BarIssueCode;
  date: ISODate;
  index: number;
  detail: string;
}

/** Structural validation. A series with any issue must not feed an engine until it is repaired or cut. */
export const validateBars = (bars: readonly Bar[]): BarIssue[] => {
  const issues: BarIssue[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const push = (code: BarIssueCode, detail: string) => issues.push({ code, date: b.date, index: i, detail });
    const vals = [b.open, b.high, b.low, b.close];
    if (vals.some((v) => !Number.isFinite(v))) {
      push('non-finite', 'open, high, low or close is not a finite number');
      continue;
    }
    if (vals.some((v) => v <= 0)) push('non-positive', 'open, high, low or close is not positive');
    const eps = 1e-9 * Math.max(...vals.map(Math.abs));
    if (b.high + eps < Math.max(b.open, b.close, b.low) || b.low - eps > Math.min(b.open, b.close, b.high)) {
      push('ohlc-containment', 'high or low does not contain open and close');
    }
    if (b.volume !== null && (!Number.isFinite(b.volume) || b.volume < 0)) push('negative-volume', 'volume is negative or not finite');
    if (!isSession(b.date)) push('non-session-date', 'date is not an exchange session');
    if (i > 0) {
      const prev = bars[i - 1]!.date;
      if (b.date === prev) push('duplicate-date', 'date repeats');
      else if (b.date < prev) push('out-of-order', 'date precedes the previous row');
    }
  }
  return issues;
};

export const buildCoverage = (bars: readonly Bar[], requestedFrom?: ISODate): Coverage => {
  if (bars.length === 0) {
    return { first: null, last: null, sessions: 0, missingSessions: [], complete: false, requestedFrom, note: 'No completed sessions' };
  }
  const first = bars[0]!.date;
  const last = bars[bars.length - 1]!.date;
  const have = new Set(bars.map((b) => b.date));
  const missing = sessionsBetween(first, last).filter((d) => !have.has(d));
  const reachesRequest = requestedFrom === undefined || first <= sessionOnOrBeforeSafe(requestedFrom);
  return {
    first,
    last,
    sessions: bars.length,
    missingSessions: missing,
    complete: missing.length === 0 && reachesRequest,
    requestedFrom,
    note: !reachesRequest ? `History starts ${first}, later than the requested ${requestedFrom}` : undefined,
  };
};

const sessionOnOrBeforeSafe = (d: ISODate): ISODate => {
  // First session on or after the requested start is what the window can reach at best.
  let x = d;
  while (!isSession(x)) x = addDays(x, 1);
  return x;
};

/** Index of the last bar with date <= `date`, or -1. Binary search. */
export const indexOnOrBefore = (bars: readonly Bar[], date: ISODate): number => {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.date <= date) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
};

/** Index of the bar with exactly this date, or -1. */
export const indexOfDate = (bars: readonly Bar[], date: ISODate): number => {
  const i = indexOnOrBefore(bars, date);
  return i >= 0 && bars[i]!.date === date ? i : -1;
};

/** Bars with date <= asOf. Use this to freeze a historical cut. Later rows can never leak in. */
export const sliceAsOf = <T extends { date: ISODate }>(rows: readonly T[], asOf: ISODate): T[] => {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.date <= asOf) lo = mid + 1;
    else hi = mid;
  }
  return rows.slice(0, lo);
};

export interface Alignment {
  dates: ISODate[];
  ia: number[];
  ib: number[];
  /** Dates present in exactly one of the two series inside the overlapping range. */
  dropped: number;
}

/** Same-date inner join of two series. Reports how many rows were dropped inside the common range. */
export const alignBars = (a: readonly Bar[], b: readonly Bar[]): Alignment => {
  const dates: ISODate[] = [];
  const ia: number[] = [];
  const ib: number[] = [];
  let i = 0;
  let j = 0;
  let dropped = 0;
  const start = a.length && b.length ? (a[0]!.date > b[0]!.date ? a[0]!.date : b[0]!.date) : '';
  const end = a.length && b.length ? (a[a.length - 1]!.date < b[b.length - 1]!.date ? a[a.length - 1]!.date : b[b.length - 1]!.date) : '';
  while (i < a.length && j < b.length) {
    const da = a[i]!.date;
    const db = b[j]!.date;
    if (da === db) {
      dates.push(da);
      ia.push(i);
      ib.push(j);
      i++;
      j++;
    } else if (da < db) {
      if (da >= start && da <= end) dropped++;
      i++;
    } else {
      if (db >= start && db <= end) dropped++;
      j++;
    }
  }
  return { dates, ia, ib, dropped };
};

export type Period = 'W' | 'M' | 'Q' | 'Y';

/** First calendar day of the period containing the date. */
export const periodStart = (iso: ISODate, period: Period): ISODate => {
  switch (period) {
    case 'W':
      return mondayOf(iso);
    case 'M':
      return ymd(yearOf(iso), monthOf(iso), 1);
    case 'Q':
      return ymd(yearOf(iso), (quarterOf(iso) - 1) * 3 + 1, 1);
    case 'Y':
      return ymd(yearOf(iso), 1, 1);
  }
};

/**
 * Index of the base close for a period-to-date return at bar i: the final completed close of the
 * preceding period. The base bar must be the last exchange session before the period starts.
 * A series that begins inside the period, or that is missing that session, has no valid base and
 * returns a structured reason. It never falls back to the first close inside the period.
 */
export const periodBaseIndex = (bars: readonly Bar[], i: number, period: Period): Maybe<number> => {
  const b = bars[i];
  if (!b) return na('invalid-input', 'index outside series');
  const key = periodKey(b.date, period);
  let j = i;
  while (j > 0 && periodKey(bars[j - 1]!.date, period) === key) j--;
  if (j === 0) return na('missing-base-close', `No close before the ${period} period that contains ${b.date}`);
  const expected = prevSession(periodStart(b.date, period));
  const base = bars[j - 1]!;
  if (base.date !== expected) {
    return na('missing-session', `Expected base close on ${expected}, series has ${base.date}`);
  }
  return j - 1;
};

export interface PeriodReturn {
  period: Period;
  ret: number;
  baseDate: ISODate;
  baseClose: number;
  endDate: ISODate;
  endClose: number;
}

/** Period-to-date price return at bar i using the preceding period's final close as base. */
export const periodToDate = (bars: readonly Bar[], i: number, period: Period): Maybe<PeriodReturn> => {
  const base = periodBaseIndex(bars, i, period);
  if (typeof base !== 'number') return base;
  const b = bars[base]!;
  const e = bars[i]!;
  return { period, ret: e.close / b.close - 1, baseDate: b.date, baseClose: b.close, endDate: e.date, endClose: e.close };
};

/** Calendar date n months before the anchor, clamped to the end of a shorter month. */
export const minusMonths = (iso: ISODate, months: number): ISODate => {
  const total = yearOf(iso) * 12 + (monthOf(iso) - 1) - months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const lastDay = dayOf(monthEnd(ymd(y, m, 1)));
  return ymd(y, m, Math.min(dayOf(iso), lastDay));
};

/**
 * Base index for a trailing calendar window of `months` ending at bar i: the last completed close
 * on or before the calendar date `months` before the anchor. The window is (base, anchor].
 * Unavailable when the series does not reach back that far.
 */
export const trailingMonthsBaseIndex = (bars: readonly Bar[], i: number, months: number): Maybe<number> => {
  const b = bars[i];
  if (!b) return na('invalid-input', 'index outside series');
  const cut = minusMonths(b.date, months);
  const j = indexOnOrBefore(bars, cut);
  if (j < 0) return na('insufficient-history', `History starts after ${cut}`);
  // The base must be the session on or before the cut date, otherwise the window start is not covered.
  if (bars[j]!.date !== sessionOnOrBefore(cut)) return na('missing-session', `Expected a close on ${sessionOnOrBefore(cut)}`);
  return j;
};

/** Number of calendar days between two dates. */
export const calendarDaysBetween = (a: ISODate, b: ISODate): number => toDayNum(b) - toDayNum(a);

/** Price return from base close to endpoint close: C(t) / C(b) - 1. */
export const priceReturn = (endClose: number, baseClose: number): number => endClose / baseClose - 1;

/** Arithmetic excess in percentage points (as a fraction): R(stock) - R(benchmark). */
export const excessPp = (stockReturn: number, benchmarkReturn: number): number => stockReturn - benchmarkReturn;

/** Relative wealth: (1 + R(stock)) / (1 + R(benchmark)). Multiply by 100 for a start-100 chart. */
export const relativeWealth = (stockReturn: number, benchmarkReturn: number): number => (1 + stockReturn) / (1 + benchmarkReturn);
