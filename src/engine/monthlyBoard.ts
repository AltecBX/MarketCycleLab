/**
 * Monthly returns board, year extremes, month seasonality and year to date helpers.
 *
 * Definitions
 * - Monthly price return: final close of the month divided by the final close of the preceding
 *   month, minus 1. The base must be the last exchange session before the month starts.
 * - Year return, highest YTD and lowest YTD share one base: the final close of the previous year.
 *   Extremes are taken over DAILY CLOSES inside the year and carry their observed dates. They are
 *   never clamped to zero and never use intraday highs or lows. A year that ends up can have a
 *   positive or a negative lowest YTD.
 * - Prices are split-consistent quote closes without dividend reinvestment.
 * - A period is complete only when the series reaches the last exchange session of the period and
 *   has a valid base. The as-of month and year are partial until then. A period the history starts
 *   inside has no base: its return is Unavailable and a separately labeled since-first-date figure
 *   is offered for illustration only.
 * - Historical statistics use complete periods only.
 */
import { lastSessionOfMonth, monthOf, sessionOnOrBefore, sessionsBetween, sessionsOfMonth, yearOf, ymd } from './core/calendar';
import { periodBaseIndex } from './core/series';
import { mean, median, midrankPercentile, wilson } from './core/stats';
import { isNa, na, type Bar, type ISODate, type Maybe, type Proportion } from './core/types';

export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export const MONTHLY_BOARD_DEFAULTS = {
  provenance: 'proposed',
  /** Wilson confidence level for win rates. */
  level: 0.95,
} as const;

/**
 * - complete: valid base and the final exchange session of the period is present.
 * - current-partial: the as-of period, still in progress.
 * - listing-partial: the history starts inside the period, so there is no base close.
 * - missing-data: a required session (the base or the period end) is absent from the series.
 * - no-data: inside the history but the series has no session in the period.
 * - outside-history: before the first bar or after the as-of date.
 */
export type PeriodStatus = 'complete' | 'current-partial' | 'listing-partial' | 'missing-data' | 'no-data' | 'outside-history';

export interface SinceFirst {
  /** Last close of the period divided by the first available close in it, minus 1. Illustrative only. */
  ret: number;
  fromDate: ISODate;
  toDate: ISODate;
}

export interface MonthCell {
  year: number;
  /** 1 to 12. */
  month: number;
  status: PeriodStatus;
  /** Price return versus the preceding month's final close. Month to date when status is current-partial. */
  ret: Maybe<number>;
  baseDate: ISODate | null;
  baseClose: number | null;
  firstDate: ISODate | null;
  endDate: ISODate | null;
  endClose: number | null;
  /** Sessions present in the series for this month. */
  sessions: number;
  /** Exchange sessions in the full calendar month. */
  expectedSessions: number;
  /** Expected sessions between the first and last available date of the month that the series lacks. */
  missingSessions: number;
  /** Only for listing-partial. Never mixed into statistics. */
  sinceFirst: SinceFirst | null;
  /** True only for complete periods. */
  countsInStats: boolean;
}

export interface YtdExtreme {
  /** Close divided by the previous year end close, minus 1. */
  ret: number;
  date: ISODate;
  close: number;
}

export interface YearRow {
  year: number;
  /** Twelve cells, January first. */
  months: MonthCell[];
  status: PeriodStatus;
  /** Full year price return when complete, year to date when current-partial. */
  yearReturn: Maybe<number>;
  /** True when yearReturn is a year to date figure for an unfinished year. */
  isYtd: boolean;
  baseDate: ISODate | null;
  baseClose: number | null;
  endDate: ISODate | null;
  endClose: number | null;
  /** Highest and lowest year to date return over daily closes, on the previous year end base. */
  highestYtd: Maybe<YtdExtreme>;
  lowestYtd: Maybe<YtdExtreme>;
  sessions: number;
  missingSessions: number;
  sinceFirst: SinceFirst | null;
  countsInStats: boolean;
}

export interface PeriodStats {
  /** Complete periods counted. */
  n: number;
  positive: number;
  negative: number;
  flat: number;
  median: Maybe<number>;
  mean: Maybe<number>;
  /** Share of complete periods with a positive return, with its Wilson interval. Null when n is 0. */
  win: Proportion | null;
  best: { year: number; ret: number } | null;
  worst: { year: number; ret: number } | null;
}

export interface MonthlyBoard {
  asOf: ISODate | null;
  firstDate: ISODate | null;
  /** Oldest year first. */
  years: YearRow[];
  /** Twelve entries, January first. Complete months only. */
  monthStats: PeriodStats[];
  /** Complete calendar years only. */
  yearStats: PeriodStats;
  /** Number of complete calendar years. */
  completeYears: number;
  currentMonth: { year: number; month: number; partial: boolean } | null;
  basis: string;
  legend: { status: PeriodStatus; label: string }[];
}

interface Range {
  a: number;
  b: number;
}

const groupBy = (bars: readonly Bar[], keyLen: 4 | 7): Map<string, Range> => {
  const out = new Map<string, Range>();
  for (let i = 0; i < bars.length; i++) {
    const k = bars[i]!.date.slice(0, keyLen);
    const r = out.get(k);
    if (r) r.b = i;
    else out.set(k, { a: i, b: i });
  }
  return out;
};

const stats = (rows: readonly { year: number; ret: number }[], level: number): PeriodStats => {
  const rets = rows.map((r) => r.ret);
  const positive = rets.filter((r) => r > 0).length;
  const negative = rets.filter((r) => r < 0).length;
  const none = na('sample-too-small', 'No complete period');
  let best: PeriodStats['best'] = null;
  let worst: PeriodStats['worst'] = null;
  for (const r of rows) {
    if (!best || r.ret > best.ret) best = { year: r.year, ret: r.ret };
    if (!worst || r.ret < worst.ret) worst = { year: r.year, ret: r.ret };
  }
  return {
    n: rets.length,
    positive,
    negative,
    flat: rets.length - positive - negative,
    median: rets.length ? median(rets) : none,
    mean: rets.length ? mean(rets) : none,
    win: wilson(positive, rets.length, level),
    best,
    worst,
  };
};

const missingBetween = (bars: readonly Bar[], r: Range): number =>
  sessionsBetween(bars[r.a]!.date, bars[r.b]!.date).length - (r.b - r.a + 1);

const emptyMonth = (year: number, month: number, status: PeriodStatus, detail: string): MonthCell => ({
  year,
  month,
  status,
  ret: na('no-coverage', detail),
  baseDate: null,
  baseClose: null,
  firstDate: null,
  endDate: null,
  endClose: null,
  sessions: 0,
  expectedSessions: sessionsOfMonth(year, month).length,
  missingSessions: 0,
  sinceFirst: null,
  countsInStats: false,
});

const monthCell = (bars: readonly Bar[], year: number, month: number, r: Range | undefined): MonthCell => {
  const first = bars[0]!.date;
  const asOf = bars[bars.length - 1]!.date;
  const key = ymd(year, month, 1).slice(0, 7);
  if (!r) {
    const outside = key < first.slice(0, 7) || key > asOf.slice(0, 7);
    return emptyMonth(year, month, outside ? 'outside-history' : 'no-data', outside ? 'Outside the available history' : 'No completed session in this month');
  }
  const start = bars[r.a]!;
  const end = bars[r.b]!;
  const expected = sessionsOfMonth(year, month);
  const lastExpected = expected[expected.length - 1]!;
  const base = periodBaseIndex(bars, r.b, 'M');
  const cell: MonthCell = {
    year,
    month,
    status: 'complete',
    ret: 0,
    baseDate: null,
    baseClose: null,
    firstDate: start.date,
    endDate: end.date,
    endClose: end.close,
    sessions: r.b - r.a + 1,
    expectedSessions: expected.length,
    missingSessions: missingBetween(bars, r),
    sinceFirst: null,
    countsInStats: false,
  };
  if (isNa(base)) {
    cell.ret = base;
    if (r.a === 0) {
      cell.status = 'listing-partial';
      cell.sinceFirst = { ret: end.close / start.close - 1, fromDate: start.date, toDate: end.date };
    } else cell.status = 'missing-data';
    return cell;
  }
  const b = bars[base]!;
  cell.baseDate = b.date;
  cell.baseClose = b.close;
  if (end.date === lastExpected) {
    cell.ret = end.close / b.close - 1;
    cell.countsInStats = true;
  } else if (r.b === bars.length - 1) {
    cell.status = 'current-partial';
    cell.ret = end.close / b.close - 1;
  } else {
    cell.status = 'missing-data';
    cell.ret = na('missing-session', `Month end close on ${lastExpected} is missing`);
  }
  return cell;
};

const yearRow = (bars: readonly Bar[], year: number, r: Range | undefined, months: MonthCell[]): YearRow => {
  const row: YearRow = {
    year,
    months,
    status: 'no-data',
    yearReturn: na('no-coverage', 'No completed session in this year'),
    isYtd: false,
    baseDate: null,
    baseClose: null,
    endDate: null,
    endClose: null,
    highestYtd: na('no-coverage', 'No completed session in this year'),
    lowestYtd: na('no-coverage', 'No completed session in this year'),
    sessions: 0,
    missingSessions: 0,
    sinceFirst: null,
    countsInStats: false,
  };
  if (!r) return row;
  const start = bars[r.a]!;
  const end = bars[r.b]!;
  row.endDate = end.date;
  row.endClose = end.close;
  row.sessions = r.b - r.a + 1;
  row.missingSessions = missingBetween(bars, r);
  const base = periodBaseIndex(bars, r.b, 'Y');
  if (isNa(base)) {
    row.yearReturn = base;
    row.highestYtd = base;
    row.lowestYtd = base;
    if (r.a === 0) {
      row.status = 'listing-partial';
      row.sinceFirst = { ret: end.close / start.close - 1, fromDate: start.date, toDate: end.date };
    } else row.status = 'missing-data';
    return row;
  }
  const b = bars[base]!;
  row.baseDate = b.date;
  row.baseClose = b.close;
  let hi = r.a;
  let lo = r.a;
  for (let i = r.a + 1; i <= r.b; i++) {
    // Strict comparisons keep the earliest date on ties.
    if (bars[i]!.close > bars[hi]!.close) hi = i;
    if (bars[i]!.close < bars[lo]!.close) lo = i;
  }
  row.highestYtd = { ret: bars[hi]!.close / b.close - 1, date: bars[hi]!.date, close: bars[hi]!.close };
  row.lowestYtd = { ret: bars[lo]!.close / b.close - 1, date: bars[lo]!.date, close: bars[lo]!.close };
  const lastExpected = sessionOnOrBefore(ymd(year, 12, 31));
  if (end.date === lastExpected) {
    row.status = 'complete';
    row.yearReturn = end.close / b.close - 1;
    row.countsInStats = true;
  } else if (r.b === bars.length - 1) {
    row.status = 'current-partial';
    row.isYtd = true;
    row.yearReturn = end.close / b.close - 1;
  } else {
    row.status = 'missing-data';
    row.yearReturn = na('missing-session', `Year end close on ${lastExpected} is missing`);
  }
  return row;
};

const LEGEND: { status: PeriodStatus; label: string }[] = [
  { status: 'complete', label: 'Complete period. Counted in statistics.' },
  { status: 'current-partial', label: 'In progress. Month or year to date, not counted in statistics.' },
  { status: 'listing-partial', label: 'History starts inside this period. No base close, not counted.' },
  { status: 'missing-data', label: 'A required session is missing. Not counted.' },
  { status: 'no-data', label: 'No session available in this period.' },
  { status: 'outside-history', label: 'Outside the available history.' },
];

/** Monthly returns board for the whole series. The last bar is the as-of session. */
export const monthlyBoard = (bars: readonly Bar[], level: number = MONTHLY_BOARD_DEFAULTS.level): MonthlyBoard => {
  const basis = 'Price return on split consistent closes. Dividends are not reinvested.';
  if (bars.length === 0) {
    return { asOf: null, firstDate: null, years: [], monthStats: MONTH_NAMES.map(() => stats([], level)), yearStats: stats([], level), completeYears: 0, currentMonth: null, basis, legend: LEGEND };
  }
  const first = bars[0]!.date;
  const asOf = bars[bars.length - 1]!.date;
  const byMonth = groupBy(bars, 7);
  const byYear = groupBy(bars, 4);
  const years: YearRow[] = [];
  for (let y = yearOf(first); y <= yearOf(asOf); y++) {
    const months: MonthCell[] = [];
    for (let m = 1; m <= 12; m++) months.push(monthCell(bars, y, m, byMonth.get(ymd(y, m, 1).slice(0, 7))));
    years.push(yearRow(bars, y, byYear.get(String(y).padStart(4, '0')), months));
  }
  const monthStats = MONTH_NAMES.map((_, k) =>
    stats(
      years.flatMap((yr) => {
        const c = yr.months[k]!;
        return c.countsInStats && !isNa(c.ret) ? [{ year: yr.year, ret: c.ret }] : [];
      }),
      level,
    ),
  );
  const yearStats = stats(
    years.flatMap((yr) => (yr.countsInStats && !isNa(yr.yearReturn) ? [{ year: yr.year, ret: yr.yearReturn }] : [])),
    level,
  );
  return {
    asOf,
    firstDate: first,
    years,
    monthStats,
    yearStats,
    completeYears: yearStats.n,
    currentMonth: { year: yearOf(asOf), month: monthOf(asOf), partial: asOf !== lastSessionOfMonth(asOf) },
    basis,
    legend: LEGEND,
  };
};

export interface ElapsedRow {
  year: number;
  month: number;
  /** Close after the same number of sessions divided by that period's base close, minus 1. */
  retAtElapsed: number;
  dateAtElapsed: ISODate;
  /** Return from that session to the end of the period. Only for periods that completed. */
  restOfPeriod: Maybe<number>;
  /** Full period return. Only for periods that completed. */
  periodReturn: Maybe<number>;
}

export interface ElapsedCohort {
  label: string;
  rows: ElapsedRow[];
  n: number;
  /** Earlier periods left out, by reason. */
  excluded: { noBase: number; tooFewSessions: number; missingSessions: number };
  median: Maybe<number>;
  /** Midrank percentile of the current return among the cohort: (lower + half equal) / n. */
  percentileOfCurrent: Maybe<number>;
  lower: number;
  higher: number;
}

export interface ElapsedComparison {
  asOf: ISODate;
  period: 'M' | 'Y';
  year: number;
  /** 1 to 12 for a month comparison, null for a year comparison. */
  month: number | null;
  /** Completed sessions elapsed in the current period, including the as-of session. */
  elapsedSessions: number;
  currentRet: number;
  baseDate: ISODate;
  baseClose: number;
  /** Same calendar month in earlier years. Null for a year comparison. */
  sameMonth: ElapsedCohort | null;
  /** All earlier months, or all earlier years for a year comparison. */
  all: ElapsedCohort;
}

const firstSessionsOf = (bars: readonly Bar[], r: Range, period: 'M' | 'Y', k: number): boolean => {
  // The first k bars of the period must be the first k exchange sessions of the period.
  const d = bars[r.a]!.date;
  const from = period === 'M' ? ymd(yearOf(d), monthOf(d), 1) : ymd(yearOf(d), 1, 1);
  const to = period === 'M' ? lastSessionOfMonth(d) : ymd(yearOf(d), 12, 31);
  const expected = sessionsBetween(from, to);
  if (expected.length < k || r.b - r.a + 1 < k) return false;
  for (let j = 0; j < k; j++) if (bars[r.a + j]!.date !== expected[j]) return false;
  return true;
};

const elapsedCompare = (bars: readonly Bar[], period: 'M' | 'Y'): Maybe<ElapsedComparison> => {
  const last = bars.length - 1;
  if (last < 0) return na('no-coverage', 'No completed sessions');
  const asOf = bars[last]!.date;
  const groups = groupBy(bars, period === 'M' ? 7 : 4);
  const curKey = asOf.slice(0, period === 'M' ? 7 : 4);
  const cur = groups.get(curKey)!;
  const base = periodBaseIndex(bars, last, period);
  if (isNa(base)) return base;
  const k = cur.b - cur.a + 1;
  if (!firstSessionsOf(bars, cur, period, k)) return na('missing-session', 'The current period is missing an exchange session');
  const baseBar = bars[base]!;
  const currentRet = bars[last]!.close / baseBar.close - 1;

  const cohort = (label: string, keep: (key: string) => boolean): ElapsedCohort => {
    const rows: ElapsedRow[] = [];
    const excluded = { noBase: 0, tooFewSessions: 0, missingSessions: 0 };
    for (const [key, r] of groups) {
      if (key === curKey || !keep(key)) continue;
      const pb = periodBaseIndex(bars, r.b, period);
      if (isNa(pb)) {
        excluded.noBase++;
        continue;
      }
      if (!firstSessionsOf(bars, r, period, k)) {
        const d = bars[r.a]!.date;
        const expectedCount =
          period === 'M' ? sessionsOfMonth(yearOf(d), monthOf(d)).length : sessionsBetween(ymd(yearOf(d), 1, 1), ymd(yearOf(d), 12, 31)).length;
        if (expectedCount < k) excluded.tooFewSessions++;
        else excluded.missingSessions++;
        continue;
      }
      const bc = bars[pb]!.close;
      const at = bars[r.a + k - 1]!;
      const end = bars[r.b]!;
      const lastExpected = period === 'M' ? lastSessionOfMonth(end.date) : sessionOnOrBefore(ymd(yearOf(end.date), 12, 31));
      const done = end.date === lastExpected;
      const notDone = na('incomplete-period', 'Period did not complete in the series');
      rows.push({
        year: yearOf(at.date),
        month: monthOf(at.date),
        retAtElapsed: at.close / bc - 1,
        dateAtElapsed: at.date,
        restOfPeriod: done ? end.close / at.close - 1 : notDone,
        periodReturn: done ? end.close / bc - 1 : notDone,
      });
    }
    const rets = rows.map((x) => x.retAtElapsed);
    const none = na('sample-too-small', 'No comparable earlier period');
    return {
      label,
      rows,
      n: rows.length,
      excluded,
      median: rets.length ? median(rets) : none,
      percentileOfCurrent: rets.length ? midrankPercentile(rets, currentRet) : none,
      lower: rets.filter((x) => x < currentRet).length,
      higher: rets.filter((x) => x > currentRet).length,
    };
  };

  const mm = asOf.slice(5, 7);
  return {
    asOf,
    period,
    year: yearOf(asOf),
    month: period === 'M' ? monthOf(asOf) : null,
    elapsedSessions: k,
    currentRet,
    baseDate: baseBar.date,
    baseClose: baseBar.close,
    sameMonth: period === 'M' ? cohort(`${MONTH_NAMES[monthOf(asOf) - 1]} of earlier years after ${k} sessions`, (key) => key.slice(5, 7) === mm) : null,
    all: cohort(period === 'M' ? `All earlier months after ${k} sessions` : `All earlier years after ${k} sessions`, () => true),
  };
};

/**
 * The current month to date return against earlier months after the same number of elapsed
 * sessions: the same calendar month of earlier years, and separately all earlier months.
 * Months shorter than the elapsed count, months without a base and months missing a session
 * inside the compared stretch are excluded and counted.
 */
export const monthElapsedComparison = (bars: readonly Bar[]): Maybe<ElapsedComparison> => elapsedCompare(bars, 'M');

/** The current year to date return against earlier years after the same number of elapsed sessions. */
export const yearElapsedComparison = (bars: readonly Bar[]): Maybe<ElapsedComparison> => elapsedCompare(bars, 'Y');

export interface YtdSummary {
  asOf: ISODate;
  year: number;
  /** C / previous year end close - 1. */
  ret: number;
  baseDate: ISODate;
  baseClose: number;
  close: number;
  /** Highest and lowest daily close of the year through the as-of date, on the same base. */
  high: YtdExtreme;
  low: YtdExtreme;
  /** (C - lowest close) / (highest close - lowest close). Unavailable when the range is flat. */
  rangePosition: Maybe<number>;
  /** C / highest close of the year - 1. */
  fromYearHigh: number;
  /** C / lowest close of the year - 1. */
  fromYearLow: number;
  sessions: number;
}

/** Year to date return at bar i (default: last bar) and where the close sits inside the year's closing range. */
export const ytdSummary = (bars: readonly Bar[], i = bars.length - 1): Maybe<YtdSummary> => {
  const b = bars[i];
  if (!b) return na('no-coverage', 'No completed sessions');
  const base = periodBaseIndex(bars, i, 'Y');
  if (isNa(base)) return base;
  const bb = bars[base]!;
  let hi = base + 1;
  let lo = base + 1;
  for (let j = base + 2; j <= i; j++) {
    if (bars[j]!.close > bars[hi]!.close) hi = j;
    if (bars[j]!.close < bars[lo]!.close) lo = j;
  }
  const H = bars[hi]!;
  const L = bars[lo]!;
  return {
    asOf: b.date,
    year: yearOf(b.date),
    ret: b.close / bb.close - 1,
    baseDate: bb.date,
    baseClose: bb.close,
    close: b.close,
    high: { ret: H.close / bb.close - 1, date: H.date, close: H.close },
    low: { ret: L.close / bb.close - 1, date: L.date, close: L.close },
    rangePosition: H.close === L.close ? na('flat-range', 'Highest and lowest close of the year are equal') : (b.close - L.close) / (H.close - L.close),
    fromYearHigh: b.close / H.close - 1,
    fromYearLow: b.close / L.close - 1,
    sessions: i - base,
  };
};
