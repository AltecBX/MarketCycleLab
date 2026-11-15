/**
 * Realized weekly returns board (owner specification section 7).
 *
 * Definitions
 * - A week is the Monday to Friday group that contains a session. It is labeled by its nominal
 *   Friday, and it belongs to the year, month and "Week 1 to 5" ordinal of that Friday label.
 *   A holiday short week keeps its true first and last session and its traded day count.
 * - Base close = the final completed close of the prior week. It must be the last exchange session
 *   before the week's first expected session. A missing base is reported, never bridged.
 * - return        = C(last) / base - 1
 *   gap           = open(first) / base - 1
 *   low, high     = min(low) / base - 1, max(high) / base - 1 (intraday, earliest date on ties)
 *   close in range = (C - L) / (H - L) over the week's intraday range, Unavailable when H = L
 *   relative volume = mean volume of the week / mean volume of the 20 sessions before the week
 *   sigma move    = return / (sample std of the 20 daily returns before the week x sqrt(traded days))
 *                   which needs 21 consecutive price anchors before the week
 *   SPY           = SPY close(last) / SPY close(base date) - 1 on the same dates, excess = return - SPY
 *   year extremes = close relative to the highest and lowest daily closes of the calendar year of
 *                   the week's last session, through that session
 *   SMA50         = close / SMA50 - 1 on the week's last session
 * - Status. 'complete' has every expected session. 'partial' is still trading at the as-of date,
 *   or history starts inside the week. 'missing' lacks an expected completed bar.
 *   Only complete weeks with a valid base are counted in statistics, streaks and next week inference.
 * - "Red" and "green" for a week mean a negative or positive weekly return versus the base close.
 *
 * Everything is past-only. A week's measures use that week's bars and earlier bars. The only
 * forward field is `nextWeekRet`, which is an outcome and is Unavailable until the next week completes.
 */
import {
  addDays, dayOf, fridayOf, isoWeek, mondayOf, monthOf, nextSession, prevSession, sessionOnOrAfter, sessionsOfWeek, weekday, weekdayName, yearOf,
} from './core/calendar';
import { sma } from './core/indicators';
import { minusMonths, sliceAsOf } from './core/series';
import { distribution, mean, median, quantile, sampleStd, wilson, yearClusterEffectiveN } from './core/stats';
import {
  isNa, isNum, na, numOrNull,
  type Bar, type DateStatus, type Distribution, type EarningsEvent, type EarningsTime, type ISODate, type Maybe, type Proportion, type Unavailable,
} from './core/types';

export const WEEKLY_BOARD_DEFAULTS = {
  provenance: 'spec' as const,
  /** Color strength saturates at a 9% weekly move. */
  colorCap: 0.09,
  /** Volume flag V at 1.3x the prior 20 session average or more. */
  volumeFlag: 1.3,
  /** Weak close: bottom 20% of the range on a down week. Strong close: top 20% on an up week. */
  weakClose: 0.2,
  strongClose: 0.8,
  /** Big weekly move for the next week study. */
  bigMove: 0.05,
  dipLevels: [-0.03, -0.05, -0.08] as const,
  /** Seasonality buckets under this many observations are flagged sparse. */
  sparseBelow: 10,
  seasonalityYears: 10,
  priorSessions: 20,
};

export type WeekStatus = 'complete' | 'partial' | 'missing';

export interface WeekDay {
  date: ISODate;
  /** ISO weekday, 1 = Monday. */
  weekday: number;
  weekdayName: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  /** Close relative to the prior week's final close. */
  rel: Maybe<number>;
  /** Close versus the previous session's close. Unavailable when that session is not in the series. */
  dayRet: Maybe<number>;
}

export interface WeekEarnings {
  reportDate: ISODate;
  time: EarningsTime;
  status: DateStatus;
  fiscalPeriod?: string;
  /** First regular session that can react. Null when the release time is unknown. */
  reactionDate: ISODate | null;
  reportInWeek: boolean;
  reactionInWeek: boolean;
  detail: string;
}

export interface YearExtreme {
  /** Close / extreme close - 1. */
  value: number;
  date: ISODate;
  close: number;
  /** First session of that calendar year present in the series. */
  coverageFrom: ISODate;
}

export interface WeekRecord {
  /** Monday of the week. */
  key: ISODate;
  /** Nominal Friday label. */
  label: ISODate;
  labelYear: number;
  labelMonth: number;
  /** Ordinal of the Friday label inside its month, 1 to 5. */
  ordinalInMonth: number;
  isoYear: number;
  isoWeek: number;
  firstSession: ISODate | null;
  lastSession: ISODate | null;
  expectedSessions: ISODate[];
  expectedDays: number;
  tradedDays: number;
  status: WeekStatus;
  statusNote: string | null;
  /** True when the week enters statistics, streaks and next week inference. */
  counted: boolean;
  base: Maybe<{ date: ISODate; close: number }>;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  ret: Maybe<number>;
  gap: Maybe<number>;
  lowRet: Maybe<number>;
  highRet: Maybe<number>;
  closeInRange: Maybe<number>;
  highDate: ISODate | null;
  lowDate: ISODate | null;
  highWeekday: string | null;
  lowWeekday: string | null;
  relVolume: Maybe<number>;
  sigma: Maybe<number>;
  spyRet: Maybe<number>;
  excess: Maybe<number>;
  closeVsYearHigh: Maybe<YearExtreme>;
  closeVsYearLow: Maybe<YearExtreme>;
  closeVsSma50: Maybe<number>;
  days: WeekDay[];
  earnings: WeekEarnings[];
  /** Return of the following week once that week is complete. An outcome, not a feature. */
  nextWeekRet: Maybe<number>;
  flags: {
    earnings: boolean;
    highVolume: boolean;
    /** Traded day count when the week has fewer than five expected sessions, otherwise null. */
    shortWeekDays: number | null;
  };
  /** Signed color strength in [-1, 1], capped at a 9% move. */
  intensity: Maybe<number>;
}

export interface WeeklyBoardInput {
  bars: readonly Bar[];
  /** Comparison series, normally SPY. Null or omitted means no comparison. */
  spy?: readonly Bar[] | null;
  /** Earnings events of this instrument. Null or omitted means no earnings markers. */
  earnings?: readonly EarningsEvent[] | null;
  /** Calendar year to show. Defaults to the year of the last bar. */
  year?: number;
  /** Freeze the series at this date. Later rows are ignored. */
  asOf?: ISODate;
  /** Latest completed exchange session by the clock. A session up to here that the series lacks is missing. */
  expectedThrough?: ISODate;
}

const reactionSession = (e: EarningsEvent): ISODate | null => {
  if (e.time === 'bmo' || e.time === 'during') return sessionOnOrAfter(e.date);
  if (e.time === 'amc') return nextSession(e.date);
  return null;
};

const earningsDetail = (e: EarningsEvent, reaction: ISODate | null): string => {
  const when =
    e.time === 'bmo' ? 'before the open' : e.time === 'amc' ? 'after the close' : e.time === 'during' ? 'during the session' : 'at an unknown time';
  const head = `${e.status === 'confirmed' ? 'Confirmed' : 'Estimated'} report ${e.date} ${when}.`;
  return reaction ? `${head} First reacting session ${reaction}.` : `${head} First reacting session not determined.`;
};

const unavailableAll = (reason: Unavailable) => ({
  ret: reason as Maybe<number>,
  gap: reason as Maybe<number>,
  lowRet: reason as Maybe<number>,
  highRet: reason as Maybe<number>,
  closeInRange: reason as Maybe<number>,
  relVolume: reason as Maybe<number>,
  sigma: reason as Maybe<number>,
});

/**
 * Build every week of the series, oldest first. Weeks with no expected exchange session are skipped.
 */
export const buildWeeks = (input: WeeklyBoardInput): WeekRecord[] => {
  const bars = input.asOf ? sliceAsOf(input.bars, input.asOf) : input.bars;
  if (bars.length === 0) return [];
  const D = WEEKLY_BOARD_DEFAULTS;
  const firstDate = bars[0]!.date;
  const lastDate = bars[bars.length - 1]!.date;
  const cap = input.asOf && input.expectedThrough && input.expectedThrough > input.asOf ? input.asOf : input.expectedThrough;
  const expectedThrough = cap && cap > lastDate ? cap : lastDate;

  const closes = bars.map((b) => b.close);
  const sma50 = sma(closes, 50);

  // Running calendar-year closing extremes, earliest index on ties.
  const yrHigh: number[] = new Array(bars.length);
  const yrLow: number[] = new Array(bars.length);
  const yrFirst: number[] = new Array(bars.length);
  for (let i = 0; i < bars.length; i++) {
    const sameYear = i > 0 && bars[i - 1]!.date.slice(0, 4) === bars[i]!.date.slice(0, 4);
    if (!sameYear) {
      yrHigh[i] = i;
      yrLow[i] = i;
      yrFirst[i] = i;
    } else {
      yrHigh[i] = closes[i]! > closes[yrHigh[i - 1]!]! ? i : yrHigh[i - 1]!;
      yrLow[i] = closes[i]! < closes[yrLow[i - 1]!]! ? i : yrLow[i - 1]!;
      yrFirst[i] = yrFirst[i - 1]!;
    }
  }

  const spy = input.spy && input.spy.length > 0 ? input.spy : null;
  const spyClose = new Map<ISODate, number>();
  if (spy) for (const b of spy) spyClose.set(b.date, b.close);

  const earningsByWeek = new Map<ISODate, { e: EarningsEvent; reaction: ISODate | null }[]>();
  if (input.earnings) {
    for (const e of input.earnings) {
      const reaction = reactionSession(e);
      const keys = new Set<ISODate>([mondayOf(e.date)]);
      if (reaction) keys.add(mondayOf(reaction));
      for (const k of keys) {
        const list = earningsByWeek.get(k) ?? [];
        list.push({ e, reaction });
        earningsByWeek.set(k, list);
      }
    }
  }

  const weeks: WeekRecord[] = [];
  let p = 0;
  const endMonday = mondayOf(expectedThrough);
  for (let monday = mondayOf(firstDate); monday <= endMonday; monday = addDays(monday, 7)) {
    const friday = addDays(monday, 4);
    const sunday = addDays(monday, 6);
    const expected = sessionsOfWeek(monday);
    const s = p;
    while (p < bars.length && bars[p]!.date <= sunday) p++;
    const e = p;
    if (expected.length === 0 && e === s) continue;

    const have = new Set<ISODate>();
    for (let k = s; k < e; k++) have.add(bars[k]!.date);
    const missingDue = expected.filter((d) => d <= expectedThrough && !have.has(d));
    let status: WeekStatus;
    let statusNote: string | null = null;
    if (missingDue.length > 0) {
      if (missingDue.every((d) => d < firstDate)) {
        status = 'partial';
        statusNote = `History starts ${firstDate}, inside this week`;
      } else {
        status = 'missing';
        statusNote = `Missing completed session ${missingDue.join(', ')}`;
      }
    } else if (expected.some((d) => d > expectedThrough)) {
      status = 'partial';
      statusNote = `Week still trading. Completed through ${expectedThrough}`;
    } else {
      status = 'complete';
    }

    let base: Maybe<{ date: ISODate; close: number }>;
    if (s === 0) base = na('missing-base-close', 'No close before this week in the series');
    else if (expected.length === 0) base = na('missing-session', 'Week has no expected exchange session');
    else {
      const want = prevSession(expected[0]!);
      const prev = bars[s - 1]!;
      base = prev.date === want ? { date: prev.date, close: prev.close } : na('missing-session', `Expected prior close on ${want}, series has ${prev.date}`);
    }

    const iso = isoWeek(monday);
    const rec: WeekRecord = {
      key: monday,
      label: friday,
      labelYear: yearOf(friday),
      labelMonth: monthOf(friday),
      ordinalInMonth: Math.floor((dayOf(friday) - 1) / 7) + 1,
      isoYear: iso.year,
      isoWeek: iso.week,
      firstSession: e > s ? bars[s]!.date : null,
      lastSession: e > s ? bars[e - 1]!.date : null,
      expectedSessions: expected,
      expectedDays: expected.length,
      tradedDays: e - s,
      status,
      statusNote,
      counted: false,
      base,
      open: null,
      high: null,
      low: null,
      close: null,
      ...unavailableAll(na('missing-session', 'No completed session in this week')),
      highDate: null,
      lowDate: null,
      highWeekday: null,
      lowWeekday: null,
      spyRet: na('no-coverage', 'No comparison series'),
      excess: na('no-coverage', 'No comparison series'),
      closeVsYearHigh: na('missing-session', 'No completed session in this week'),
      closeVsYearLow: na('missing-session', 'No completed session in this week'),
      closeVsSma50: na('missing-session', 'No completed session in this week'),
      days: [],
      earnings: [],
      nextWeekRet: na('not-matured', 'Next week is not complete'),
      flags: { earnings: false, highVolume: false, shortWeekDays: expected.length < 5 ? e - s : null },
      intensity: na('missing-session', 'No completed session in this week'),
    };

    const ev = earningsByWeek.get(monday);
    if (ev) {
      rec.earnings = ev
        .map(({ e: x, reaction }) => {
          const w: WeekEarnings = {
            reportDate: x.date,
            time: x.time,
            status: x.status,
            reactionDate: reaction,
            reportInWeek: mondayOf(x.date) === monday,
            reactionInWeek: reaction !== null && mondayOf(reaction) === monday,
            detail: earningsDetail(x, reaction),
          };
          if (x.fiscalPeriod) w.fiscalPeriod = x.fiscalPeriod;
          return w;
        })
        .sort((a, b) => (a.reportDate < b.reportDate ? -1 : a.reportDate > b.reportDate ? 1 : 0));
      rec.flags.earnings = rec.earnings.length > 0;
    }

    if (e > s) {
      const first = bars[s]!;
      const last = bars[e - 1]!;
      let hi = s;
      let lo = s;
      for (let k = s + 1; k < e; k++) {
        if (bars[k]!.high > bars[hi]!.high) hi = k;
        if (bars[k]!.low < bars[lo]!.low) lo = k;
      }
      const H = bars[hi]!.high;
      const L = bars[lo]!.low;
      rec.open = first.open;
      rec.high = H;
      rec.low = L;
      rec.close = last.close;
      rec.highDate = bars[hi]!.date;
      rec.lowDate = bars[lo]!.date;
      rec.highWeekday = weekdayName(bars[hi]!.date);
      rec.lowWeekday = weekdayName(bars[lo]!.date);

      const baseVal = isNa(base) ? null : base;
      const baseNa = isNa(base) ? base : na('missing-base-close', 'No base close');
      for (let k = s; k < e; k++) {
        const b = bars[k]!;
        const prev = k > 0 ? bars[k - 1]! : null;
        const dayRet: Maybe<number> = !prev
          ? na('missing-base-close', 'No earlier close in the series')
          : prev.date === prevSession(b.date)
            ? b.close / prev.close - 1
            : na('missing-session', `Previous session ${prevSession(b.date)} is not in the series`);
        rec.days.push({
          date: b.date,
          weekday: weekday(b.date),
          weekdayName: weekdayName(b.date),
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume,
          rel: baseVal ? b.close / baseVal.close - 1 : baseNa,
          dayRet,
        });
      }

      const li = e - 1;
      const yFrom = bars[yrFirst[li]!]!.date;
      const yh = bars[yrHigh[li]!]!;
      const yl = bars[yrLow[li]!]!;
      rec.closeVsYearHigh = { value: last.close / yh.close - 1, date: yh.date, close: yh.close, coverageFrom: yFrom };
      rec.closeVsYearLow = { value: last.close / yl.close - 1, date: yl.date, close: yl.close, coverageFrom: yFrom };
      const m50 = sma50[li];
      rec.closeVsSma50 = isNum(m50) ? last.close / m50 - 1 : na('insufficient-history', 'Fewer than 50 completed sessions');

      if (status === 'missing') {
        const r = na('missing-session', statusNote ?? 'Missing completed session');
        Object.assign(rec, unavailableAll(r));
        rec.intensity = r;
        if (spy) {
          rec.spyRet = r;
          rec.excess = r;
        }
      } else if (!baseVal) {
        Object.assign(rec, unavailableAll(baseNa));
        rec.intensity = baseNa;
        if (spy) {
          rec.spyRet = baseNa;
          rec.excess = baseNa;
        }
      } else {
        const bc = baseVal.close;
        const ret = last.close / bc - 1;
        rec.ret = ret;
        rec.gap = first.open / bc - 1;
        rec.lowRet = L / bc - 1;
        rec.highRet = H / bc - 1;
        rec.closeInRange = H > L ? (last.close - L) / (H - L) : na('flat-range', 'Weekly high equals weekly low');
        rec.intensity = (Math.sign(ret) * Math.min(Math.abs(ret), D.colorCap)) / D.colorCap;

        // Relative volume: this week's mean volume over the mean of the 20 sessions before the week.
        const N = D.priorSessions;
        if (s < N) rec.relVolume = na('insufficient-history', `Fewer than ${N} sessions before the week`);
        else {
          let wv = 0;
          let pv = 0;
          let ok = true;
          for (let k = s; k < e; k++) {
            const v = bars[k]!.volume;
            if (v === null) ok = false;
            else wv += v;
          }
          for (let k = s - N; k < s; k++) {
            const v = bars[k]!.volume;
            if (v === null) ok = false;
            else pv += v;
          }
          if (!ok) rec.relVolume = na('no-coverage', 'Volume not verified for the week or the prior 20 sessions');
          else if (pv <= 0) rec.relVolume = na('flat-range', 'Prior 20 session volume is zero');
          else rec.relVolume = wv / (e - s) / (pv / N);
        }
        if (isNum(rec.relVolume) && rec.relVolume >= D.volumeFlag) rec.flags.highVolume = true;

        // Sigma move: needs 21 consecutive price anchors before the week for 20 daily returns.
        if (s < N + 1) rec.sigma = na('insufficient-history', `Fewer than ${N + 1} price anchors before the week`);
        else {
          const rets: number[] = [];
          let contiguous = true;
          for (let k = s - N; k < s; k++) {
            if (bars[k - 1]!.date !== prevSession(bars[k]!.date)) contiguous = false;
            rets.push(bars[k]!.close / bars[k - 1]!.close - 1);
          }
          const sd = sampleStd(rets);
          if (!contiguous) rec.sigma = na('missing-session', 'A session is missing inside the 21 price anchors before the week');
          else if (!(sd > 0)) rec.sigma = na('flat-range', 'Prior 20 daily returns have no variation');
          else rec.sigma = ret / (sd * Math.sqrt(e - s));
        }

        if (spy) {
          const sb = spyClose.get(baseVal.date);
          const sl = spyClose.get(last.date);
          let covered = sb !== undefined && sl !== undefined;
          for (let k = s; k < e && covered; k++) if (!spyClose.has(bars[k]!.date)) covered = false;
          if (covered && sb !== undefined && sl !== undefined && sb > 0) {
            rec.spyRet = sl / sb - 1;
            rec.excess = ret - rec.spyRet;
          } else {
            const r = na('no-coverage', 'Comparison series does not cover the same sessions');
            rec.spyRet = r;
            rec.excess = r;
          }
        }
        rec.counted = status === 'complete';
      }
    }
    weeks.push(rec);
  }

  for (let w = 0; w < weeks.length - 1; w++) {
    const cur = weeks[w]!;
    const next = weeks[w + 1]!;
    if (next.counted && isNum(next.ret)) cur.nextWeekRet = next.ret;
    else if (next.status === 'partial') cur.nextWeekRet = na('not-matured', 'Next week is not complete');
    else cur.nextWeekRet = na('missing-session', 'Next week has no valid completed return');
  }
  return weeks;
};

export type StreakDirection = 'up' | 'down' | 'flat';

export interface WeekStreak {
  direction: StreakDirection;
  length: number;
  firstLabel: ISODate;
  lastLabel: ISODate;
  /** Base close the chained move starts from: the close before the first week of the streak. */
  fromDate: ISODate;
  fromClose: number;
  toDate: ISODate;
  toClose: number;
  /** toClose / fromClose - 1. */
  chained: number;
}

const directionOf = (w: WeekRecord): StreakDirection | null => {
  if (!w.counted || !isNum(w.ret)) return null;
  return w.ret > 0 ? 'up' : w.ret < 0 ? 'down' : 'flat';
};

const makeStreak = (run: readonly WeekRecord[], direction: StreakDirection): WeekStreak | null => {
  const a = run[0];
  const z = run[run.length - 1];
  if (!a || !z || isNa(a.base) || z.close === null || z.lastSession === null) return null;
  return {
    direction,
    length: run.length,
    firstLabel: a.label,
    lastLabel: z.label,
    fromDate: a.base.date,
    fromClose: a.base.close,
    toDate: z.lastSession,
    toClose: z.close,
    chained: z.close / a.base.close - 1,
  };
};

/** Maximal runs of consecutive counted weeks with the same direction. An uncounted week breaks a run. */
export const weekStreaks = (weeks: readonly WeekRecord[]): WeekStreak[] => {
  const out: WeekStreak[] = [];
  let run: WeekRecord[] = [];
  let dir: StreakDirection | null = null;
  const flush = () => {
    if (run.length > 0 && dir) {
      const st = makeStreak(run, dir);
      if (st) out.push(st);
    }
    run = [];
    dir = null;
  };
  for (const w of weeks) {
    const d = directionOf(w);
    if (d === null) {
      flush();
      continue;
    }
    if (d !== dir) flush();
    dir = d;
    run.push(w);
  }
  flush();
  return out;
};

export interface CurrentStreak extends WeekStreak {
  /** True when no streak of the same direction inside the year is longer. */
  isLongestOfYear: boolean;
  /** True when the streak began in a week labeled in an earlier year. */
  startedBeforeYear: boolean;
}

export interface WeeklySummary {
  completedWeeks: number;
  upWeeks: number;
  downWeeks: number;
  flatWeeks: number;
  partialWeeks: number;
  missingWeeks: number;
  /** Complete weeks without a valid base close. They are shown but not counted. */
  uncountedCompleteWeeks: number;
  upRate: Proportion | null;
  medianReturn: Maybe<number>;
  averageReturn: Maybe<number>;
  currentStreak: Maybe<CurrentStreak>;
  longestUp: WeekStreak | null;
  longestDown: WeekStreak | null;
  lastWeek: Maybe<{ label: ISODate; ret: number; sigma: Maybe<number>; relVolume: Maybe<number>; lowRet: Maybe<number> }>;
  best: Maybe<{ label: ISODate; ret: number }>;
  worst: Maybe<{ label: ISODate; ret: number }>;
  /** Median of the weekly low versus the prior close. */
  medianWeekLow: Maybe<number>;
  /** The level 80% of counted weeks stayed above: the 20th percentile of weekly low versus prior close. */
  stayedAbove80: Maybe<number>;
  spy: Maybe<{ comparableWeeks: number; beat: number; beatRate: Proportion | null; runningExcess: number }>;
}

export interface GridCell {
  label: ISODate;
  week: WeekRecord;
}

export interface GridRow {
  month: number;
  /** Index 0 is Week 1. Null where the month has no such Friday or the week is outside the data. */
  cells: (GridCell | null)[];
  counted: number;
  upWeeks: number;
  highest: Maybe<{ ret: number; label: ISODate }>;
  deepestDip: Maybe<{ lowRet: number; label: ISODate }>;
}

export interface GridFooter {
  ordinal: number;
  weeksCounted: number;
  median: Maybe<number>;
  average: Maybe<number>;
  winRate: Proportion | null;
}

export interface WeeklyGrid {
  rows: GridRow[];
  footer: GridFooter[];
}

export interface RangeChartPoint {
  label: ISODate;
  month: number;
  status: WeekStatus;
  counted: boolean;
  lowRet: number | null;
  highRet: number | null;
  closeRet: number | null;
  earnings: boolean;
}

export interface NextWeekStudy {
  threshold: number;
  weeks: { label: ISODate; ret: number; nextWeekRet: number | null }[];
  /** Weeks with a completed following week. */
  matured: number;
  nextWeek: Distribution | null;
  nextWeekUp: Proportion | null;
}

export interface WeeklyTells {
  weakCloseDownWeeks: { count: number; ofDownWeeks: number; labels: ISODate[] };
  strongCloseUpWeeks: { count: number; ofUpWeeks: number; labels: ISODate[] };
  gapUpClosedRed: { count: number; ofGapUps: number; labels: ISODate[] };
  gapDownClosedGreen: { count: number; ofGapDowns: number; labels: ISODate[] };
  thursdayFridayLows: Proportion | null;
  bigDown: NextWeekStudy;
  bigUp: NextWeekStudy;
  earningsWeeks: { label: ISODate; ret: number | null; range: number | null; closeInRange: number | null; detail: string }[];
  mostUnusual: { label: ISODate; ret: number; sigma: number }[];
  longestUp: WeekStreak | null;
  longestDown: WeekStreak | null;
}

export interface DayOfWeekRow {
  weekday: number;
  name: string;
  /** Daily returns observed on this weekday. */
  n: number;
  average: Maybe<number>;
  median: Maybe<number>;
  winRate: Proportion | null;
  /** Counted weeks whose intraday high, or low, was set on this weekday. */
  highsSet: number;
  lowsSet: number;
  weeksCounted: number;
}

export interface DipPlot {
  points: { label: ISODate; lowRet: number; closeRet: number; outcome: 'up' | 'down' | 'flat'; isLast: boolean }[];
  median: Maybe<number>;
  /** 20th and 10th percentile of the weekly low versus prior close. 80% and 90% of weeks stayed above them. */
  p20: Maybe<number>;
  p10: Maybe<number>;
  below: { level: number; count: number }[];
  /** Weeks that dipped 5% or more and still closed green. */
  dipped5: number;
  dipped5Recovered: number;
  n: number;
}

export interface SpyView {
  available: boolean;
  reason: string | null;
  bars: { label: ISODate; excess: number; running: number }[];
  /** Counted weeks left out because the comparison did not cover the same sessions. */
  excluded: number;
}

export interface WeeklyTableRow {
  label: ISODate;
  firstSession: ISODate | null;
  lastSession: ISODate | null;
  status: WeekStatus;
  counted: boolean;
  tradedDays: number;
  ret: number | null;
  gap: number | null;
  lowRet: number | null;
  highRet: number | null;
  closeInRange: number | null;
  highWeekday: string | null;
  lowWeekday: string | null;
  relVolume: number | null;
  sigma: number | null;
  spyRet: number | null;
  excess: number | null;
  closeVsYearHigh: number | null;
  closeVsYearLow: number | null;
  closeVsSma50: number | null;
  nextWeekRet: number | null;
  earnings: boolean;
}

export interface WeeklyBoard {
  year: number;
  /** Label years that have at least one week in the series. */
  availableYears: number[];
  /** Last completed session in the series used. */
  asOf: ISODate | null;
  weeks: WeekRecord[];
  summary: WeeklySummary;
  grid: WeeklyGrid;
  rangeChart: RangeChartPoint[];
  tells: WeeklyTells;
  dayOfWeek: DayOfWeekRow[];
  dip: DipPlot;
  spyView: SpyView;
  table: WeeklyTableRow[];
  comparisonProvided: boolean;
  earningsProvided: boolean;
}

const maybeMedian = (xs: readonly number[]): Maybe<number> => (xs.length ? median(xs) : na('sample-too-small', 'No counted weeks'));
const maybeMean = (xs: readonly number[]): Maybe<number> => (xs.length ? mean(xs) : na('sample-too-small', 'No counted weeks'));
const longest = (streaks: readonly WeekStreak[], dir: StreakDirection): WeekStreak | null => {
  let best: WeekStreak | null = null;
  for (const s of streaks) if (s.direction === dir && (!best || s.length > best.length)) best = s;
  return best;
};

const nextWeekStudy = (counted: readonly WeekRecord[], threshold: number, side: 'down' | 'up'): NextWeekStudy => {
  const hit = counted.filter((w) => isNum(w.ret) && (side === 'down' ? w.ret <= -threshold : w.ret >= threshold));
  const weeks = hit.map((w) => ({ label: w.label, ret: w.ret as number, nextWeekRet: numOrNull(w.nextWeekRet) }));
  const next = weeks.filter((w) => w.nextWeekRet !== null).map((w) => w.nextWeekRet as number);
  const labels = weeks.filter((w) => w.nextWeekRet !== null).map((w) => w.label);
  return {
    threshold: side === 'down' ? -threshold : threshold,
    weeks,
    matured: next.length,
    nextWeek: distribution(next),
    nextWeekUp: wilson(next.filter((r) => r > 0).length, next.length, 0.95, yearClusterEffectiveN(labels)),
  };
};

const summarize = (yearWeeks: readonly WeekRecord[], allWeeks: readonly WeekRecord[], comparisonProvided: boolean): WeeklySummary => {
  const counted = yearWeeks.filter((w) => w.counted);
  const rets = counted.map((w) => w.ret as number);
  const up = rets.filter((r) => r > 0).length;
  const down = rets.filter((r) => r < 0).length;
  const yearStreaks = weekStreaks(yearWeeks);
  const longestUp = longest(yearStreaks, 'up');
  const longestDown = longest(yearStreaks, 'down');

  let currentStreak: Maybe<CurrentStreak> = na('sample-too-small', 'No counted weeks');
  const lastCounted = counted[counted.length - 1];
  if (lastCounted) {
    const j = allWeeks.indexOf(lastCounted);
    const later = yearWeeks.filter((w) => w.key > lastCounted.key && !(w.status === 'partial'));
    if (later.length > 0) {
      currentStreak = na('missing-session', `A later week (${later[0]!.label}) has no valid completed return`);
    } else {
      const dir = directionOf(lastCounted)!;
      let i = j;
      while (i > 0 && directionOf(allWeeks[i - 1]!) === dir) i--;
      const run = allWeeks.slice(i, j + 1);
      const st = makeStreak(run, dir);
      if (st) {
        const best = longest(yearStreaks, dir);
        currentStreak = {
          ...st,
          isLongestOfYear: !best || st.length >= best.length,
          startedBeforeYear: run[0]!.labelYear < lastCounted.labelYear,
        };
      }
    }
  }

  let best: WeekRecord | null = null;
  let worst: WeekRecord | null = null;
  for (const w of counted) {
    if (!best || (w.ret as number) > (best.ret as number)) best = w;
    if (!worst || (w.ret as number) < (worst.ret as number)) worst = w;
  }
  const lows = counted.map((w) => w.lowRet).filter(isNum);
  const comparable = counted.filter((w) => isNum(w.excess));
  const beat = comparable.filter((w) => (w.excess as number) > 0).length;

  return {
    completedWeeks: counted.length,
    upWeeks: up,
    downWeeks: down,
    flatWeeks: counted.length - up - down,
    partialWeeks: yearWeeks.filter((w) => w.status === 'partial').length,
    missingWeeks: yearWeeks.filter((w) => w.status === 'missing').length,
    uncountedCompleteWeeks: yearWeeks.filter((w) => w.status === 'complete' && !w.counted).length,
    upRate: wilson(up, counted.length),
    medianReturn: maybeMedian(rets),
    averageReturn: maybeMean(rets),
    currentStreak,
    longestUp,
    longestDown,
    lastWeek: lastCounted
      ? { label: lastCounted.label, ret: lastCounted.ret as number, sigma: lastCounted.sigma, relVolume: lastCounted.relVolume, lowRet: lastCounted.lowRet }
      : na('sample-too-small', 'No counted weeks'),
    best: best ? { label: best.label, ret: best.ret as number } : na('sample-too-small', 'No counted weeks'),
    worst: worst ? { label: worst.label, ret: worst.ret as number } : na('sample-too-small', 'No counted weeks'),
    medianWeekLow: maybeMedian(lows),
    stayedAbove80: lows.length ? quantile(lows, 0.2) : na('sample-too-small', 'No counted weeks'),
    spy: !comparisonProvided
      ? na('no-coverage', 'No comparison series')
      : comparable.length === 0
        ? na('no-coverage', 'Comparison series does not cover any counted week')
        : {
            comparableWeeks: comparable.length,
            beat,
            beatRate: wilson(beat, comparable.length),
            runningExcess: comparable.reduce((a, w) => a + (w.excess as number), 0),
          },
  };
};

const buildGrid = (yearWeeks: readonly WeekRecord[]): WeeklyGrid => {
  const rows: GridRow[] = [];
  for (let m = 1; m <= 12; m++) {
    const cells: (GridCell | null)[] = [null, null, null, null, null];
    const inMonth = yearWeeks.filter((w) => w.labelMonth === m);
    for (const w of inMonth) cells[w.ordinalInMonth - 1] = { label: w.label, week: w };
    const counted = inMonth.filter((w) => w.counted);
    let hi: WeekRecord | null = null;
    let dip: WeekRecord | null = null;
    for (const w of counted) {
      if (!hi || (w.ret as number) > (hi.ret as number)) hi = w;
      if (isNum(w.lowRet) && (!dip || w.lowRet < (dip.lowRet as number))) dip = w;
    }
    rows.push({
      month: m,
      cells,
      counted: counted.length,
      upWeeks: counted.filter((w) => (w.ret as number) > 0).length,
      highest: hi ? { ret: hi.ret as number, label: hi.label } : na('sample-too-small', 'No counted weeks in this month'),
      deepestDip: dip ? { lowRet: dip.lowRet as number, label: dip.label } : na('sample-too-small', 'No counted weeks in this month'),
    });
  }
  const footer: GridFooter[] = [];
  for (let o = 1; o <= 5; o++) {
    const rets = yearWeeks.filter((w) => w.counted && w.ordinalInMonth === o).map((w) => w.ret as number);
    footer.push({
      ordinal: o,
      weeksCounted: rets.length,
      median: maybeMedian(rets),
      average: maybeMean(rets),
      winRate: wilson(rets.filter((r) => r > 0).length, rets.length),
    });
  }
  return { rows, footer };
};

const buildTells = (yearWeeks: readonly WeekRecord[], yearStreaks: readonly WeekStreak[]): WeeklyTells => {
  const D = WEEKLY_BOARD_DEFAULTS;
  const counted = yearWeeks.filter((w) => w.counted);
  const downWeeks = counted.filter((w) => (w.ret as number) < 0);
  const upWeeks = counted.filter((w) => (w.ret as number) > 0);
  const weak = downWeeks.filter((w) => isNum(w.closeInRange) && w.closeInRange <= D.weakClose);
  const strong = upWeeks.filter((w) => isNum(w.closeInRange) && w.closeInRange >= D.strongClose);
  const gapUps = counted.filter((w) => isNum(w.gap) && w.gap > 0);
  const gapDowns = counted.filter((w) => isNum(w.gap) && w.gap < 0);
  const gapUpRed = gapUps.filter((w) => (w.ret as number) < 0);
  const gapDownGreen = gapDowns.filter((w) => (w.ret as number) > 0);
  const withLow = counted.filter((w) => w.lowDate !== null);
  const lateLows = withLow.filter((w) => weekday(w.lowDate as ISODate) >= 4).length;
  const unusual = counted
    .filter((w) => isNum(w.sigma))
    .map((w) => ({ label: w.label, ret: w.ret as number, sigma: w.sigma as number }))
    .sort((a, b) => Math.abs(b.sigma) - Math.abs(a.sigma))
    .slice(0, 5);
  return {
    weakCloseDownWeeks: { count: weak.length, ofDownWeeks: downWeeks.length, labels: weak.map((w) => w.label) },
    strongCloseUpWeeks: { count: strong.length, ofUpWeeks: upWeeks.length, labels: strong.map((w) => w.label) },
    gapUpClosedRed: { count: gapUpRed.length, ofGapUps: gapUps.length, labels: gapUpRed.map((w) => w.label) },
    gapDownClosedGreen: { count: gapDownGreen.length, ofGapDowns: gapDowns.length, labels: gapDownGreen.map((w) => w.label) },
    thursdayFridayLows: wilson(lateLows, withLow.length),
    bigDown: nextWeekStudy(counted, D.bigMove, 'down'),
    bigUp: nextWeekStudy(counted, D.bigMove, 'up'),
    earningsWeeks: yearWeeks
      .filter((w) => w.flags.earnings)
      .map((w) => ({
        label: w.label,
        ret: numOrNull(w.ret),
        range: isNum(w.highRet) && isNum(w.lowRet) ? w.highRet - w.lowRet : null,
        closeInRange: numOrNull(w.closeInRange),
        detail: w.earnings.map((x) => x.detail).join(' '),
      })),
    mostUnusual: unusual,
    longestUp: longest(yearStreaks, 'up'),
    longestDown: longest(yearStreaks, 'down'),
  };
};

const buildDayOfWeek = (yearWeeks: readonly WeekRecord[]): DayOfWeekRow[] => {
  const counted = yearWeeks.filter((w) => w.counted);
  const rows: DayOfWeekRow[] = [];
  for (let wd = 1; wd <= 5; wd++) {
    const rets: number[] = [];
    const dates: ISODate[] = [];
    for (const w of yearWeeks) {
      if (w.status === 'missing') continue;
      for (const d of w.days) {
        if (d.weekday === wd && isNum(d.dayRet)) {
          rets.push(d.dayRet);
          dates.push(d.date);
        }
      }
    }
    rows.push({
      weekday: wd,
      name: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'][wd - 1]!,
      n: rets.length,
      average: rets.length ? mean(rets) : na('sample-too-small', 'No daily returns on this weekday'),
      median: rets.length ? median(rets) : na('sample-too-small', 'No daily returns on this weekday'),
      winRate: wilson(rets.filter((r) => r > 0).length, rets.length),
      highsSet: counted.filter((w) => w.highDate !== null && weekday(w.highDate) === wd).length,
      lowsSet: counted.filter((w) => w.lowDate !== null && weekday(w.lowDate) === wd).length,
      weeksCounted: counted.length,
    });
  }
  return rows;
};

const buildDip = (yearWeeks: readonly WeekRecord[]): DipPlot => {
  const D = WEEKLY_BOARD_DEFAULTS;
  const counted = yearWeeks.filter((w) => w.counted && isNum(w.lowRet));
  const lastLabel = counted[counted.length - 1]?.label ?? null;
  const points = counted.map((w) => {
    const r = w.ret as number;
    return {
      label: w.label,
      lowRet: w.lowRet as number,
      closeRet: r,
      outcome: (r > 0 ? 'up' : r < 0 ? 'down' : 'flat') as 'up' | 'down' | 'flat',
      isLast: w.label === lastLabel,
    };
  });
  const lows = points.map((p) => p.lowRet);
  const none = na('sample-too-small', 'No counted weeks');
  const dipped5 = points.filter((p) => p.lowRet <= -0.05);
  return {
    points,
    median: lows.length ? median(lows) : none,
    p20: lows.length ? quantile(lows, 0.2) : none,
    p10: lows.length ? quantile(lows, 0.1) : none,
    below: D.dipLevels.map((level) => ({ level, count: lows.filter((l) => l <= level).length })),
    dipped5: dipped5.length,
    dipped5Recovered: dipped5.filter((p) => p.closeRet > 0).length,
    n: points.length,
  };
};

const buildSpyView = (yearWeeks: readonly WeekRecord[], comparisonProvided: boolean): SpyView => {
  if (!comparisonProvided) return { available: false, reason: 'No comparison series', bars: [], excluded: 0 };
  const counted = yearWeeks.filter((w) => w.counted);
  let running = 0;
  const bars: SpyView['bars'] = [];
  for (const w of counted) {
    if (!isNum(w.excess)) continue;
    running += w.excess;
    bars.push({ label: w.label, excess: w.excess, running });
  }
  const excluded = counted.length - bars.length;
  if (bars.length === 0) return { available: false, reason: 'Comparison series does not cover any counted week', bars, excluded };
  return { available: true, reason: excluded > 0 ? `${excluded} counted weeks lack same session comparison coverage` : null, bars, excluded };
};

const toTableRow = (w: WeekRecord): WeeklyTableRow => ({
  label: w.label,
  firstSession: w.firstSession,
  lastSession: w.lastSession,
  status: w.status,
  counted: w.counted,
  tradedDays: w.tradedDays,
  ret: numOrNull(w.ret),
  gap: numOrNull(w.gap),
  lowRet: numOrNull(w.lowRet),
  highRet: numOrNull(w.highRet),
  closeInRange: numOrNull(w.closeInRange),
  highWeekday: w.highWeekday,
  lowWeekday: w.lowWeekday,
  relVolume: numOrNull(w.relVolume),
  sigma: numOrNull(w.sigma),
  spyRet: numOrNull(w.spyRet),
  excess: numOrNull(w.excess),
  closeVsYearHigh: isNa(w.closeVsYearHigh) ? null : w.closeVsYearHigh.value,
  closeVsYearLow: isNa(w.closeVsYearLow) ? null : w.closeVsYearLow.value,
  closeVsSma50: numOrNull(w.closeVsSma50),
  nextWeekRet: numOrNull(w.nextWeekRet),
  earnings: w.flags.earnings,
});

/**
 * The weekly board for one label year. `weeksAll` lets a caller reuse `buildWeeks` output across
 * year switches. It must come from the same input.
 */
export const weeklyBoard = (input: WeeklyBoardInput, weeksAll?: readonly WeekRecord[]): WeeklyBoard => {
  const all = weeksAll ?? buildWeeks(input);
  const withBars = all.filter((w) => w.lastSession !== null);
  const lastSession = withBars.length ? withBars[withBars.length - 1]!.lastSession : null;
  const year = input.year ?? (lastSession ? yearOf(lastSession) : all.length ? all[all.length - 1]!.labelYear : 1970);
  const yearWeeks = all.filter((w) => w.labelYear === year);
  const comparisonProvided = !!input.spy && input.spy.length > 0;
  const yearStreaks = weekStreaks(yearWeeks);
  return {
    year,
    availableYears: [...new Set(all.map((w) => w.labelYear))].sort((a, b) => a - b),
    asOf: lastSession,
    weeks: yearWeeks,
    summary: summarize(yearWeeks, all, comparisonProvided),
    grid: buildGrid(yearWeeks),
    rangeChart: yearWeeks.map((w) => ({
      label: w.label,
      month: w.labelMonth,
      status: w.status,
      counted: w.counted,
      lowRet: numOrNull(w.lowRet),
      highRet: numOrNull(w.highRet),
      closeRet: numOrNull(w.ret),
      earnings: w.flags.earnings,
    })),
    tells: buildTells(yearWeeks, yearStreaks),
    dayOfWeek: buildDayOfWeek(yearWeeks),
    dip: buildDip(yearWeeks),
    spyView: buildSpyView(yearWeeks, comparisonProvided),
    table: yearWeeks.map(toTableRow),
    comparisonProvided,
    earningsProvided: !!input.earnings,
  };
};

export interface SeasonalityBucket {
  /** ISO week of year (1 to 53) or week ordinal in month (1 to 5). */
  key: number;
  n: number;
  median: Maybe<number>;
  average: Maybe<number>;
  winRate: Proportion | null;
  /** True under ten observations. */
  sparse: boolean;
  best: number | null;
  worst: number | null;
  labels: ISODate[];
}

export interface WeeklySeasonality {
  /** Requested lookback in years. */
  years: number;
  fromLabel: ISODate | null;
  toLabel: ISODate | null;
  /** Distinct label years actually covered. */
  yearsCovered: number[];
  weeksCounted: number;
  byIsoWeek: SeasonalityBucket[];
  byOrdinalInMonth: SeasonalityBucket[];
}

const bucketize = (weeks: readonly WeekRecord[], keyOf: (w: WeekRecord) => number): SeasonalityBucket[] => {
  const groups = new Map<number, WeekRecord[]>();
  for (const w of weeks) {
    const k = keyOf(w);
    const g = groups.get(k) ?? [];
    g.push(w);
    groups.set(k, g);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, g]) => {
      const rets = g.map((w) => w.ret as number);
      const labels = g.map((w) => w.label);
      return {
        key,
        n: rets.length,
        median: maybeMedian(rets),
        average: maybeMean(rets),
        winRate: wilson(rets.filter((r) => r > 0).length, rets.length, 0.95, yearClusterEffectiveN(labels)),
        sparse: rets.length < WEEKLY_BOARD_DEFAULTS.sparseBelow,
        best: rets.length ? Math.max(...rets) : null,
        worst: rets.length ? Math.min(...rets) : null,
        labels,
      };
    });
};

/**
 * Seasonality over roughly the last `years` years of counted weeks, by ISO week of year and by the
 * week ordinal in month. ISO week 53 appears only in the years that have one, so it is always sparse.
 */
export const weeklySeasonality = (weeksAll: readonly WeekRecord[], years: number = WEEKLY_BOARD_DEFAULTS.seasonalityYears): WeeklySeasonality => {
  const counted = weeksAll.filter((w) => w.counted);
  const last = counted[counted.length - 1];
  if (!last) return { years, fromLabel: null, toLabel: null, yearsCovered: [], weeksCounted: 0, byIsoWeek: [], byOrdinalInMonth: [] };
  const cutoff = minusMonths(last.label, 12 * years);
  const sel = counted.filter((w) => w.label > cutoff);
  return {
    years,
    fromLabel: sel[0]?.label ?? null,
    toLabel: last.label,
    yearsCovered: [...new Set(sel.map((w) => w.labelYear))].sort((a, b) => a - b),
    weeksCounted: sel.length,
    byIsoWeek: bucketize(sel, (w) => w.isoWeek),
    byOrdinalInMonth: bucketize(sel, (w) => w.ordinalInMonth),
  };
};

export type WeeklySortKey = Exclude<keyof WeeklyTableRow, 'status' | 'counted' | 'earnings'>;

/** Stable sort for the full table. Null values sort last in either direction. */
export const sortWeeklyRows = (rows: readonly WeeklyTableRow[], key: WeeklySortKey, dir: 'asc' | 'desc'): WeeklyTableRow[] => {
  const sign = dir === 'asc' ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const x = a.row[key];
      const y = b.row[key];
      if (x === null && y === null) return a.i - b.i;
      if (x === null) return 1;
      if (y === null) return -1;
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
      return c !== 0 ? sign * c : a.i - b.i;
    })
    .map((x) => x.row);
};

export interface WeeklyAcceptanceSummary {
  year: number;
  completedWeeks: number;
  upWeeks: number;
  best: { label: ISODate; ret: number } | null;
  worst: { label: ISODate; ret: number } | null;
  lastWeek: {
    label: ISODate;
    close: number | null;
    ret: number;
    sigma: number | null;
    lowRet: number | null;
    closeVsYearHigh: number | null;
    yearHighDate: ISODate | null;
    closeVsYearLow: number | null;
    yearLowDate: ISODate | null;
    yearLowClose: number | null;
  } | null;
  /** Current streak when it is a losing streak, with the chained move from the close before it. */
  losingStreak: { length: number; chained: number; fromDate: ISODate; fromClose: number } | null;
  earningsWeeks: { label: ISODate; ret: number | null }[];
}

/**
 * The figures the owner acceptance fixture checks, taken from a built board. Pass real bars
 * through `weeklyBoard` and compare this output with the recorded fixture values.
 */
export const weeklyAcceptanceSummary = (board: WeeklyBoard): WeeklyAcceptanceSummary => {
  const s = board.summary;
  const counted = board.weeks.filter((w) => w.counted);
  const last = counted[counted.length - 1] ?? null;
  const streak = isNa(s.currentStreak) ? null : s.currentStreak;
  return {
    year: board.year,
    completedWeeks: s.completedWeeks,
    upWeeks: s.upWeeks,
    best: isNa(s.best) ? null : s.best,
    worst: isNa(s.worst) ? null : s.worst,
    lastWeek: last
      ? {
          label: last.label,
          close: last.close,
          ret: last.ret as number,
          sigma: numOrNull(last.sigma),
          lowRet: numOrNull(last.lowRet),
          closeVsYearHigh: isNa(last.closeVsYearHigh) ? null : last.closeVsYearHigh.value,
          yearHighDate: isNa(last.closeVsYearHigh) ? null : last.closeVsYearHigh.date,
          closeVsYearLow: isNa(last.closeVsYearLow) ? null : last.closeVsYearLow.value,
          yearLowDate: isNa(last.closeVsYearLow) ? null : last.closeVsYearLow.date,
          yearLowClose: isNa(last.closeVsYearLow) ? null : last.closeVsYearLow.close,
        }
      : null,
    losingStreak:
      streak && streak.direction === 'down' ? { length: streak.length, chained: streak.chained, fromDate: streak.fromDate, fromClose: streak.fromClose } : null,
    earningsWeeks: board.weeks.filter((w) => w.flags.earnings).map((w) => ({ label: w.label, ret: numOrNull(w.ret) })),
  };
};

/** Nominal Friday label for any date. Convenience for callers that link a date to a board cell. */
export const weekLabelOf = (date: ISODate): ISODate => fridayOf(date);
