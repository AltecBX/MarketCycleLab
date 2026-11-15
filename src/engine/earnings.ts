/**
 * Earnings calendar, reaction sessions and reaction studies.
 *
 * Definitions:
 * - First price reaction session. A before open release, or a release during the session, reacts
 *   in the same day regular session. An after close release reacts in the next session. A release
 *   dated on a non trading day reacts in the next session whatever its time. A release on a
 *   session date with unknown time is ambiguous and the reaction is withheld.
 * - Pre close p is the last completed close before the reaction session r.
 * - Runup over k sessions is C(p) / C(p - k) - 1. It ends before the reaction.
 * - First reacting close return is C(r) / C(p) - 1. Gap is O(r) / C(p) - 1. Session move is
 *   C(r) / O(r) - 1. Magnitude is the absolute first reacting close return.
 * - Drift over h sessions is C(r + h) / C(r) - 1. It starts after the first reacting close.
 * - A path lists each close once. Offset 0 is the reaction close, offset -1 is the pre close.
 * - Surprise fields are reported separately from price fields with their own availability.
 * - Expected move comparison is an expiry magnitude: the option implied absolute move to an actual
 *   expiry against the realized absolute close to close move over the same period. It is not
 *   isolated earnings volatility, not a probability and not a direction.
 */
import {
  addDays, fridayOf, holidayName, isSession, mondayOf, nextSession, prevSession, sessionOnOrAfter, sessionOnOrBefore, sessionsBetween, toDayNum, weekdayName,
} from './core/calendar';
import { indexOfDate, indexOnOrBefore } from './core/series';
import { distribution, quantile, wilson, yearClusterEffectiveN } from './core/stats';
import {
  isNa, na, type Bar, type DateStatus, type Distribution, type EarningsEvent, type EarningsTime, type ISODate, type Maybe, type Proportion, type SecurityType, type SourceCapture,
} from './core/types';

export const RUNUP_WINDOWS = [5, 10, 15, 20] as const;
export const DRIFT_WINDOWS = [1, 5, 10, 20] as const;

export const EARNINGS_DEFAULTS = {
  /** Sessions shown before and after the reaction in a normalized path. */
  pathBefore: 20,
  pathAfter: 20,
  /** Legacy display alignment in calendar days around the release date. */
  calendarFrom: -42,
  calendarTo: 28,
  /** Largest relative gap between a capture's underlying price and the completed close. */
  basisTolerance: 0.005,
  provenance: 'spec' as const,
};

/** The first regular session that can react to a release, or the reason it is withheld. */
export const reactionSession = (event: Pick<EarningsEvent, 'date' | 'time'>): Maybe<ISODate> => {
  if (!isSession(event.date)) return sessionOnOrAfter(event.date);
  switch (event.time) {
    case 'bmo':
    case 'during':
      return event.date;
    case 'amc':
      return nextSession(event.date);
    case 'unknown':
      return na('ambiguous-timing', `Release time on ${event.date} is unknown, so the first reacting session cannot be identified`);
  }
};

/** Stable report id. One report per instrument and release date. */
export const reportId = (e: Pick<EarningsEvent, 'instrumentId' | 'date'>): string => `${e.instrumentId}:${e.date}`;

/** Display label that names the fiscal period when known and always carries the date. */
export const reportLabel = (e: Pick<EarningsEvent, 'date' | 'fiscalPeriod'>): string =>
  e.fiscalPeriod ? `${e.fiscalPeriod} (${e.date})` : e.date;

export const fiscalQuarterOf = (e: Pick<EarningsEvent, 'fiscalPeriod'>): number | null => {
  const m = e.fiscalPeriod ? /Q([1-4])/.exec(e.fiscalPeriod) : null;
  return m ? Number(m[1]) : null;
};

const statusRank = (s: DateStatus): number => (s === 'confirmed' ? 0 : 1);

export interface NormalizedEvents {
  /** Unique by report id, sorted by date. */
  events: EarningsEvent[];
  duplicatesRemoved: number;
  /** Fiscal periods that appear with more than one release date. */
  periodConflicts: { fiscalPeriod: string; dates: ISODate[] }[];
}

/**
 * Remove duplicate rows of the same report (same instrument and date). A confirmed row wins over
 * an estimated one, then the row with the later `knownAt`. Rows are never merged field by field.
 */
export const normalizeEvents = (events: readonly EarningsEvent[]): NormalizedEvents => {
  const byId = new Map<string, EarningsEvent>();
  let duplicatesRemoved = 0;
  for (const e of events) {
    const id = reportId(e);
    const cur = byId.get(id);
    if (!cur) {
      byId.set(id, e);
      continue;
    }
    duplicatesRemoved++;
    const better =
      statusRank(e.status) < statusRank(cur.status) ||
      (statusRank(e.status) === statusRank(cur.status) && (e.knownAt ?? '') > (cur.knownAt ?? ''));
    if (better) byId.set(id, e);
  }
  const out = [...byId.values()].sort((a, b) => (a.date === b.date ? a.symbol.localeCompare(b.symbol) : a.date < b.date ? -1 : 1));
  const byPeriod = new Map<string, Set<ISODate>>();
  for (const e of out) {
    if (!e.fiscalPeriod) continue;
    const k = `${e.instrumentId}|${e.fiscalPeriod}`;
    if (!byPeriod.has(k)) byPeriod.set(k, new Set());
    byPeriod.get(k)!.add(e.date);
  }
  const periodConflicts: NormalizedEvents['periodConflicts'] = [];
  for (const [k, dates] of byPeriod) {
    if (dates.size > 1) periodConflicts.push({ fiscalPeriod: k.split('|')[1]!, dates: [...dates].sort() });
  }
  return { events: out, duplicatesRemoved, periodConflicts };
};

/** True when bars a..b are consecutive exchange sessions with nothing missing between them. */
const contiguous = (bars: readonly Bar[], a: number, b: number): boolean => {
  if (a < 0 || b >= bars.length || a > b) return false;
  return sessionsBetween(bars[a]!.date, bars[b]!.date).length === b - a + 1;
};

export interface Surprise {
  available: boolean;
  actual: number | null;
  estimate: number | null;
  /** actual - estimate. */
  difference: number | null;
  /** (actual - estimate) / |estimate|. Null when the estimate is zero or missing. */
  pct: number | null;
}

const surpriseOf = (actual: number | null | undefined, estimate: number | null | undefined): Surprise => {
  const a = typeof actual === 'number' && Number.isFinite(actual) ? actual : null;
  const e = typeof estimate === 'number' && Number.isFinite(estimate) ? estimate : null;
  const available = a !== null && e !== null;
  return {
    available,
    actual: a,
    estimate: e,
    difference: available ? a - e : null,
    pct: available && e !== 0 ? (a - e) / Math.abs(e) : null,
  };
};

export interface PathPoint {
  /** Sessions from the reaction close. 0 is the reaction close, -1 is the pre close. */
  offset: number;
  date: ISODate;
  /** Close relative to the pre close: C / C(p) - 1. The pre close itself is 0. */
  ret: number;
}

export interface ReactionRow {
  id: string;
  label: string;
  event: EarningsEvent;
  fiscalQuarter: number | null;
  reactionDate: Maybe<ISODate>;
  preCloseDate: Maybe<ISODate>;
  preClose: Maybe<number>;
  /** Runups keyed by window length in sessions. */
  runups: Record<number, Maybe<number>>;
  /** First reacting close versus the pre close. */
  reaction: Maybe<number>;
  gap: Maybe<number>;
  session: Maybe<number>;
  /** Intraday extremes of the reaction session versus the pre close. Order inside the bar is unknown. */
  reactionHigh: Maybe<number>;
  reactionLow: Maybe<number>;
  magnitude: Maybe<number>;
  /** Drift from the first reacting close, keyed by horizon in sessions. */
  drift: Record<number, Maybe<number>>;
  eps: Surprise;
  revenue: Surprise;
  /** Normalized closes around the reaction. Each close appears once. */
  path: PathPoint[];
  /** True when the path covers the full requested window on both sides. */
  pathComplete: boolean;
}

export interface ReactionOptions {
  pathBefore?: number;
  pathAfter?: number;
}

/** Price and surprise study for one report. `bars` must already be cut at the as-of date. */
export const earningsReaction = (bars: readonly Bar[], event: EarningsEvent, opts: ReactionOptions = {}): ReactionRow => {
  const before = opts.pathBefore ?? EARNINGS_DEFAULTS.pathBefore;
  const after = opts.pathAfter ?? EARNINGS_DEFAULTS.pathAfter;
  const row: ReactionRow = {
    id: reportId(event),
    label: reportLabel(event),
    event,
    fiscalQuarter: fiscalQuarterOf(event),
    reactionDate: na('no-coverage'),
    preCloseDate: na('no-coverage'),
    preClose: na('no-coverage'),
    runups: {},
    reaction: na('no-coverage'),
    gap: na('no-coverage'),
    session: na('no-coverage'),
    reactionHigh: na('no-coverage'),
    reactionLow: na('no-coverage'),
    magnitude: na('no-coverage'),
    drift: {},
    eps: surpriseOf(event.epsActual, event.epsEstimate),
    revenue: surpriseOf(event.revenueActual, event.revenueEstimate),
    path: [],
    pathComplete: false,
  };
  const fill = (reason: Maybe<number>) => {
    row.reaction = row.gap = row.session = row.reactionHigh = row.reactionLow = row.magnitude = row.preClose = reason;
    for (const k of RUNUP_WINDOWS) row.runups[k] = reason;
    for (const h of DRIFT_WINDOWS) row.drift[h] = reason;
  };
  const r = reactionSession(event);
  row.reactionDate = r;
  if (isNa(r)) {
    row.preCloseDate = r;
    fill(r);
    return row;
  }
  const lastDate = bars.length ? bars[bars.length - 1]!.date : null;
  if (lastDate === null || r > lastDate) {
    const why = na('not-matured', `Reaction session ${r} is after the latest completed session`);
    row.preCloseDate = why;
    fill(why);
    return row;
  }
  const ri = indexOfDate(bars, r);
  if (ri < 0) {
    const why = na(r < bars[0]!.date ? 'insufficient-history' : 'missing-session', `No completed bar for the reaction session ${r}`);
    row.preCloseDate = why;
    fill(why);
    return row;
  }
  const p = ri - 1;
  if (p < 0 || bars[p]!.date !== prevSession(r)) {
    const why = na(p < 0 ? 'insufficient-history' : 'missing-session', `No close on ${prevSession(r)}, the session before the reaction`);
    row.preCloseDate = why;
    fill(why);
    return row;
  }
  const pre = bars[p]!;
  const rb = bars[ri]!;
  row.preCloseDate = pre.date;
  row.preClose = pre.close;
  row.reaction = rb.close / pre.close - 1;
  row.gap = rb.open / pre.close - 1;
  row.session = rb.close / rb.open - 1;
  row.reactionHigh = rb.high / pre.close - 1;
  row.reactionLow = rb.low / pre.close - 1;
  row.magnitude = Math.abs(rb.close / pre.close - 1);
  for (const k of RUNUP_WINDOWS) {
    if (p - k < 0) row.runups[k] = na('insufficient-history', `Needs ${k} sessions before the pre close`);
    else if (!contiguous(bars, p - k, p)) row.runups[k] = na('missing-session', 'A session is missing inside the runup window');
    else row.runups[k] = pre.close / bars[p - k]!.close - 1;
  }
  for (const h of DRIFT_WINDOWS) {
    if (ri + h >= bars.length) row.drift[h] = na('not-matured', `Needs ${h} completed sessions after ${r}`);
    else if (!contiguous(bars, ri, ri + h)) row.drift[h] = na('missing-session', 'A session is missing inside the drift window');
    else row.drift[h] = bars[ri + h]!.close / rb.close - 1;
  }
  // Path: walk outward from the pre close and stop at the first gap, so no close is carried.
  let lo = p;
  while (lo > ri - before && lo - 1 >= 0 && bars[lo - 1]!.date === prevSession(bars[lo]!.date)) lo--;
  let hi = ri;
  while (hi < ri + after && hi + 1 < bars.length && bars[hi + 1]!.date === nextSession(bars[hi]!.date)) hi++;
  for (let j = lo; j <= hi; j++) row.path.push({ offset: j - ri, date: bars[j]!.date, ret: bars[j]!.close / pre.close - 1 });
  row.pathComplete = lo === ri - before && hi === ri + after;
  return row;
};

export interface MeasureSummary {
  /** Reports with this measure available. The denominator for everything in this summary. */
  n: number;
  /** Reports where the measure is unavailable, by reason code. */
  unavailable: Record<string, number>;
  distribution: Distribution | null;
  /** Share of reports with a positive value. */
  positive: Proportion | null;
}

const summarize = (values: readonly Maybe<number>[], dates: readonly ISODate[], level: number): MeasureSummary => {
  const xs: number[] = [];
  const ds: ISODate[] = [];
  const unavailable: Record<string, number> = {};
  values.forEach((v, i) => {
    if (typeof v === 'number') {
      xs.push(v);
      ds.push(dates[i]!);
    } else unavailable[v.code] = (unavailable[v.code] ?? 0) + 1;
  });
  return {
    n: xs.length,
    unavailable,
    distribution: distribution(xs),
    positive: wilson(xs.filter((x) => x > 0).length, xs.length, level, yearClusterEffectiveN(ds)),
  };
};

export interface EarningsStudy {
  asOf: ISODate | null;
  /** Past reports, oldest first. */
  rows: ReactionRow[];
  duplicatesRemoved: number;
  periodConflicts: NormalizedEvents['periodConflicts'];
  /** Reports dated after the as-of date. They are not part of any denominator. */
  upcoming: EarningsEvent[];
  reaction: MeasureSummary;
  gap: MeasureSummary;
  magnitude: MeasureSummary;
  runups: Record<number, MeasureSummary>;
  drift: Record<number, MeasureSummary>;
  /** Reports whose 20 session drift and 20 session runup are both available: the common coverage sample. */
  commonCoverage: number;
  epsSurpriseAvailable: number;
}

export interface StudyOptions extends ReactionOptions {
  /** Cut everything at this completed session. Defaults to the last bar. */
  asOf?: ISODate;
  level?: number;
}

/** Reaction study across all reports of one instrument, frozen at the as-of date. */
export const earningsStudy = (allBars: readonly Bar[], events: readonly EarningsEvent[], opts: StudyOptions = {}): EarningsStudy => {
  const lastIdx = opts.asOf ? indexOnOrBefore(allBars, opts.asOf) : allBars.length - 1;
  const bars = allBars.slice(0, lastIdx + 1);
  const asOf = bars.length ? bars[bars.length - 1]!.date : null;
  const norm = normalizeEvents(events);
  const past = norm.events.filter((e) => asOf !== null && e.date <= asOf);
  const upcoming = norm.events.filter((e) => asOf === null || e.date > asOf);
  const rows = past.map((e) => earningsReaction(bars, e, opts));
  const level = opts.level ?? 0.95;
  const dates = rows.map((r) => r.event.date);
  const runups: Record<number, MeasureSummary> = {};
  for (const k of RUNUP_WINDOWS) runups[k] = summarize(rows.map((r) => r.runups[k]!), dates, level);
  const drift: Record<number, MeasureSummary> = {};
  for (const h of DRIFT_WINDOWS) drift[h] = summarize(rows.map((r) => r.drift[h]!), dates, level);
  return {
    asOf,
    rows,
    duplicatesRemoved: norm.duplicatesRemoved,
    periodConflicts: norm.periodConflicts,
    upcoming,
    reaction: summarize(rows.map((r) => r.reaction), dates, level),
    gap: summarize(rows.map((r) => r.gap), dates, level),
    magnitude: summarize(rows.map((r) => r.magnitude), dates, level),
    runups,
    drift,
    commonCoverage: rows.filter((r) => typeof r.runups[20] === 'number' && typeof r.drift[20] === 'number').length,
    epsSurpriseAvailable: rows.filter((r) => r.eps.available).length,
  };
};

export interface PathEnvelope {
  from: number;
  to: number;
  offsets: number[];
  median: number[];
  p10: number[];
  p25: number[];
  p75: number[];
  p90: number[];
  /** Reports whose path covers every offset in the window. The envelope and the endpoint use these. */
  n: number;
  /** Reports left out because their path does not cover the whole window. */
  excluded: number;
  /** Ids of the reports inside the envelope. */
  ids: string[];
  /** Endpoint values at `to`, one per included report. */
  endpoint: number[];
}

/**
 * Median and percentile envelope of normalized paths over offsets from..to. Only reports whose
 * path covers the whole window enter, so every offset has the same sample.
 */
export const pathEnvelope = (rows: readonly ReactionRow[], from: number, to: number): Maybe<PathEnvelope> => {
  const offsets: number[] = [];
  for (let k = from; k <= to; k++) offsets.push(k);
  const included: { id: string; values: number[] }[] = [];
  let excluded = 0;
  for (const r of rows) {
    const map = new Map(r.path.map((p) => [p.offset, p.ret]));
    if (offsets.every((k) => map.has(k))) included.push({ id: r.id, values: offsets.map((k) => map.get(k)!) });
    else excluded++;
  }
  if (included.length === 0) return na('sample-too-small', 'No report covers the whole path window');
  const col = (j: number) => included.map((x) => x.values[j]!);
  const q = (p: number) => offsets.map((_, j) => quantile(col(j), p));
  return {
    from,
    to,
    offsets,
    median: q(0.5),
    p10: q(0.1),
    p25: q(0.25),
    p75: q(0.75),
    p90: q(0.9),
    n: included.length,
    excluded,
    ids: included.map((x) => x.id),
    endpoint: col(offsets.length - 1),
  };
};

export interface QuarterComparison {
  quarter: number;
  /** Reports of the chosen fiscal quarter. */
  selected: ReactionRow[];
  /** Every report, including the chosen quarter. */
  all: ReactionRow[];
  selectedEnvelope: Maybe<PathEnvelope>;
  allEnvelope: Maybe<PathEnvelope>;
  /** Reports with no fiscal period label. They can only appear in the all reports group. */
  unlabeled: number;
}

/** Compare one fiscal quarter's reports with all reports on the same normalized path window. */
export const compareQuarter = (study: EarningsStudy, quarter: number, from = -EARNINGS_DEFAULTS.pathBefore, to = EARNINGS_DEFAULTS.pathAfter): QuarterComparison => {
  const selected = study.rows.filter((r) => r.fiscalQuarter === quarter);
  return {
    quarter,
    selected,
    all: study.rows,
    selectedEnvelope: pathEnvelope(selected, from, to),
    allEnvelope: pathEnvelope(study.rows, from, to),
    unlabeled: study.rows.filter((r) => r.fiscalQuarter === null).length,
  };
};

export interface CalendarOffsetPoint {
  /** Calendar days from the release date. */
  offset: number;
  /** The calendar date at this offset. */
  calendarDate: ISODate;
  /** The trading date of the close shown. Equals calendarDate unless carried. */
  priceDate: ISODate;
  /** Close relative to the base close. */
  ret: number;
  /**
   * True when the calendar date is not a trading day and the previous close is repeated for
   * display alignment. Carried points are never return inputs.
   */
  carried: boolean;
}

export interface CalendarOffsetPath {
  id: string;
  label: string;
  baseDate: ISODate;
  baseClose: number;
  points: CalendarOffsetPoint[];
  /** Trading points only. Use these for any calculation. */
  tradingPoints: CalendarOffsetPoint[];
  /** Set when the path stops before the last requested offset because data ends. */
  truncatedAt: ISODate | null;
}

/**
 * Legacy display alignment by calendar offset from the release date. The base is the last
 * completed close on or before the first offset. Non trading dates repeat the previous close and
 * are flagged `carried`. The path stops at the last available bar.
 */
export const calendarOffsetPath = (
  bars: readonly Bar[],
  event: EarningsEvent,
  fromDays: number = EARNINGS_DEFAULTS.calendarFrom,
  toDays: number = EARNINGS_DEFAULTS.calendarTo,
): Maybe<CalendarOffsetPath> => {
  if (bars.length === 0) return na('no-coverage', 'No price history');
  const startDate = addDays(event.date, fromDays);
  const bi = indexOnOrBefore(bars, startDate);
  if (bi < 0) return na('insufficient-history', `History starts after ${startDate}`);
  const base = bars[bi]!;
  if (base.date !== sessionOnOrBefore(startDate)) return na('missing-session', `Expected a base close on ${sessionOnOrBefore(startDate)}`);
  const lastDate = bars[bars.length - 1]!.date;
  const points: CalendarOffsetPoint[] = [];
  let truncatedAt: ISODate | null = null;
  let j = bi;
  for (let d = fromDays; d <= toDays; d++) {
    const calendarDate = addDays(event.date, d);
    if (calendarDate > lastDate) {
      truncatedAt = lastDate;
      break;
    }
    while (j + 1 < bars.length && bars[j + 1]!.date <= calendarDate) j++;
    const b = bars[j]!;
    points.push({ offset: d, calendarDate, priceDate: b.date, ret: b.close / base.close - 1, carried: b.date !== calendarDate });
  }
  return {
    id: reportId(event),
    label: reportLabel(event),
    baseDate: base.date,
    baseClose: base.close,
    points,
    tradingPoints: points.filter((p) => !p.carried),
    truncatedAt,
  };
};

export interface NextEarnings {
  date: ISODate;
  time: EarningsTime;
  status: DateStatus;
  fiscalPeriod: string | null;
  /** Calendar days from today. 0 means today. */
  daysUntil: number;
  /** Exchange sessions strictly after today through the release date. */
  sessionsUntil: number;
  /** First session that can react, or the reason it is withheld. */
  reactionDate: Maybe<ISODate>;
  source: SourceCapture;
}

/**
 * The next usable future earnings date on or after `today`. Funds return not-applicable. A stock
 * with no future date returns an actionable no-coverage reason.
 */
export const nextEarnings = (events: Maybe<readonly EarningsEvent[]>, today: ISODate, type: SecurityType = 'stock'): Maybe<NextEarnings> => {
  if (type === 'etf' || type === 'index') return na('not-applicable', 'Funds and indexes do not report earnings');
  if (isNa(events)) return events;
  const future = normalizeEvents(events).events.filter((e) => e.date >= today);
  // A confirmed date wins when a confirmed and an estimated row sit close together for one report.
  const first = future[0];
  if (!first) return na('no-coverage', 'No future earnings date in the current capture. Retry the earnings source or check the issuer calendar.');
  const confirmedNear = future.find((e) => e.status === 'confirmed' && toDayNum(e.date) - toDayNum(first.date) <= 45);
  const pick = first.status === 'confirmed' ? first : confirmedNear ?? first;
  return {
    date: pick.date,
    time: pick.time,
    status: pick.status,
    fiscalPeriod: pick.fiscalPeriod ?? null,
    daysUntil: toDayNum(pick.date) - toDayNum(today),
    sessionsUntil: sessionsBetween(addDays(today, 1), pick.date).length,
    reactionDate: reactionSession(pick),
    source: pick.source,
  };
};

/* ------------------------------------------------------------------ calendar */

/** Minimal shape of a calendar row. `CalendarEntry` from the data contracts satisfies it. */
export interface CalendarRow extends EarningsEvent {
  name?: string;
  marketCap?: number | null;
}

export interface CalendarWindow {
  from: ISODate;
  to: ISODate;
  label: string;
}

export type CalendarPreset = 'today' | 'tomorrow' | 'this-week' | 'next-week';

/**
 * Date windows for quick navigation. "Tomorrow" is the next exchange session after today, so a
 * Friday maps to Monday and a holiday is skipped. Weeks run Monday to Friday.
 */
export const calendarWindow = (today: ISODate, preset: CalendarPreset): CalendarWindow => {
  switch (preset) {
    case 'today':
      return { from: today, to: today, label: `Today, ${weekdayName(today)} ${today}` };
    case 'tomorrow': {
      const d = nextSession(today);
      return { from: d, to: d, label: `Next session, ${weekdayName(d)} ${d}` };
    }
    case 'this-week': {
      const to = fridayOf(today);
      return { from: today, to: to < today ? today : to, label: `This week through ${to < today ? today : to}` };
    }
    case 'next-week': {
      const mon = addDays(mondayOf(today), 7);
      return { from: mon, to: addDays(mon, 4), label: `Week of ${mon}` };
    }
  }
};

export interface CalendarFilter {
  /** Keep only these release times. Empty or missing keeps all. */
  times?: readonly EarningsTime[];
  status?: DateStatus;
  /** Case insensitive match on ticker or company name. */
  search?: string;
  /** Keep only these display symbols (watch list or portfolio scope). */
  symbols?: readonly string[];
  /** Keep only rows flagged with a source conflict. */
  conflictsOnly?: boolean;
}

export interface CalendarItem<T extends CalendarRow = CalendarRow> {
  entry: T;
  id: string;
  /** First reacting session, or the reason it is withheld. */
  reactionDate: Maybe<ISODate>;
  /** Other dates reported for the same instrument's report by other rows. Empty when sources agree. */
  conflictDates: ISODate[];
  conflictSources: string[];
}

const TIME_ORDER: Record<EarningsTime, number> = { bmo: 0, during: 1, amc: 2, unknown: 3 };
export const TIME_LABEL: Record<EarningsTime, string> = { bmo: 'Before open', during: 'During session', amc: 'After close', unknown: 'Time unknown' };

/**
 * Merge calendar rows from several captures. Rows for one instrument that fall within
 * `conflictDays` calendar days of each other are treated as the same report. When their dates
 * differ the preferred row (confirmed first, then latest `knownAt`) is kept and the other dates
 * are listed as a visible conflict. Rows with the same instrument and date are deduplicated,
 * which also covers a double listing of one instrument.
 */
export const mergeCalendar = <T extends CalendarRow>(rows: readonly T[], conflictDays = 45): CalendarItem<T>[] => {
  const byInstrument = new Map<string, T[]>();
  for (const r of rows) {
    if (!byInstrument.has(r.instrumentId)) byInstrument.set(r.instrumentId, []);
    byInstrument.get(r.instrumentId)!.push(r);
  }
  const out: CalendarItem<T>[] = [];
  for (const list of byInstrument.values()) {
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    let cluster: T[] = [];
    const flush = () => {
      if (cluster.length === 0) return;
      // Deterministic preference: confirmed first, then latest knownAt, then earliest date.
      const best = cluster.reduce((acc, e) => {
        const sr = statusRank(e.status) - statusRank(acc.status);
        if (sr !== 0) return sr < 0 ? e : acc;
        if ((e.knownAt ?? '') !== (acc.knownAt ?? '')) return (e.knownAt ?? '') > (acc.knownAt ?? '') ? e : acc;
        return acc;
      }, cluster[0]!);
      const others = cluster.filter((e) => e.date !== best.date);
      out.push({
        entry: best,
        id: reportId(best),
        reactionDate: reactionSession(best),
        conflictDates: [...new Set(others.map((e) => e.date))].sort(),
        conflictSources: [...new Set(others.map((e) => e.source.provider))].sort(),
      });
      cluster = [];
    };
    for (const r of list) {
      const head = cluster[0];
      if (head && toDayNum(r.date) - toDayNum(head.date) > conflictDays) flush();
      cluster.push(r);
    }
    flush();
  }
  return out;
};

export const filterCalendar = <T extends CalendarRow>(items: readonly CalendarItem<T>[], f: CalendarFilter = {}): CalendarItem<T>[] => {
  const q = f.search?.trim().toLowerCase() ?? '';
  const scope = f.symbols ? new Set(f.symbols.map((s) => s.toUpperCase())) : null;
  const times = f.times && f.times.length ? new Set(f.times) : null;
  return items.filter((it) => {
    const e = it.entry;
    if (times && !times.has(e.time)) return false;
    if (f.status && e.status !== f.status) return false;
    if (scope && !scope.has(e.symbol.toUpperCase())) return false;
    if (f.conflictsOnly && it.conflictDates.length === 0) return false;
    if (q && !e.symbol.toLowerCase().includes(q) && !(e.name ?? '').toLowerCase().includes(q)) return false;
    return true;
  });
};

/** Schedule order: before open, during, after close, unknown last. Then larger market cap, then symbol. */
export const sortBySchedule = <T extends CalendarRow>(items: readonly CalendarItem<T>[]): CalendarItem<T>[] =>
  [...items].sort((a, b) => {
    if (a.entry.date !== b.entry.date) return a.entry.date < b.entry.date ? -1 : 1;
    const t = TIME_ORDER[a.entry.time] - TIME_ORDER[b.entry.time];
    if (t !== 0) return t;
    const ca = a.entry.marketCap ?? null;
    const cb = b.entry.marketCap ?? null;
    if (ca !== cb) {
      if (ca === null) return 1;
      if (cb === null) return -1;
      return cb - ca;
    }
    return a.entry.symbol.localeCompare(b.entry.symbol);
  });

export interface CalendarDay<T extends CalendarRow = CalendarRow> {
  date: ISODate;
  weekday: string;
  isSession: boolean;
  /** Holiday or closure name when the exchange is closed on a weekday. */
  closure: string | null;
  items: CalendarItem<T>[];
  counts: Record<EarningsTime, number>;
  confirmed: number;
  estimated: number;
}

/**
 * Group items by date for an inclusive window. Every exchange session in the window appears, even
 * when empty. A non trading date appears only when a source lists a report on it, flagged so the
 * view can say the date is expected to move.
 */
export const groupCalendar = <T extends CalendarRow>(items: readonly CalendarItem<T>[], from: ISODate, to: ISODate): CalendarDay<T>[] => {
  const inWindow = sortBySchedule(items.filter((it) => it.entry.date >= from && it.entry.date <= to));
  const dates = new Set<ISODate>(sessionsBetween(from, to));
  for (const it of inWindow) dates.add(it.entry.date);
  return [...dates].sort().map((date) => {
    const dayItems = inWindow.filter((it) => it.entry.date === date);
    const counts: Record<EarningsTime, number> = { bmo: 0, during: 0, amc: 0, unknown: 0 };
    for (const it of dayItems) counts[it.entry.time]++;
    return {
      date,
      weekday: weekdayName(date),
      isSession: isSession(date),
      closure: holidayName(date),
      items: dayItems,
      counts,
      confirmed: dayItems.filter((it) => it.entry.status === 'confirmed').length,
      estimated: dayItems.filter((it) => it.entry.status === 'estimated').length,
    };
  });
};

/* ------------------------------------------------------------- expected move */

export interface ImpliedMoveCapture {
  /** Session whose completed close the option quote refers to. */
  quoteDate: ISODate;
  /** Actual option expiry date. */
  expiry: ISODate;
  /** Option implied absolute move to that expiry, as a fraction of the underlying. */
  impliedMove: number;
  /** Underlying price the capture used. Checked against the completed close on the quote date. */
  underlyingPrice: number;
  source: SourceCapture;
}

export interface ExpiryMagnitude {
  label: 'Expiry magnitude';
  quoteDate: ISODate;
  /** Last trading session on or before the expiry date. */
  expirySession: ISODate;
  sessions: number;
  implied: number;
  /** |C(expiry session) / C(quote date) - 1|. */
  realized: number;
  /** realized / implied. Above 1 means the realized move exceeded the implied magnitude. */
  ratio: number;
  /** Reaction sessions of known reports that fall inside the period, for context only. */
  reactionsInside: ISODate[];
  note: string;
}

/**
 * Compare an option implied move to an actual expiry with the realized absolute move over the
 * same period. Compared only when the capture's underlying price matches the completed close on
 * the quote date and the expiry session has completed.
 */
export const expectedVsRealized = (
  bars: readonly Bar[],
  capture: ImpliedMoveCapture,
  events: readonly EarningsEvent[] = [],
  tolerance: number = EARNINGS_DEFAULTS.basisTolerance,
): Maybe<ExpiryMagnitude> => {
  if (!(capture.impliedMove > 0) || !(capture.underlyingPrice > 0)) return na('invalid-input', 'Implied move and underlying price must be positive');
  if (capture.expiry <= capture.quoteDate) return na('invalid-input', 'Expiry must be after the quote date');
  const qi = indexOfDate(bars, capture.quoteDate);
  if (qi < 0) return na('missing-session', `No completed close on the quote date ${capture.quoteDate}`);
  const q = bars[qi]!;
  if (Math.abs(q.close / capture.underlyingPrice - 1) > tolerance) {
    return na('basis-mismatch', `Capture underlying ${capture.underlyingPrice} does not match the ${capture.quoteDate} close ${q.close}`);
  }
  const expirySession = sessionOnOrBefore(capture.expiry);
  const last = bars[bars.length - 1]!.date;
  if (expirySession > last) return na('not-matured', `Expiry session ${expirySession} has not completed`);
  const ei = indexOfDate(bars, expirySession);
  if (ei < 0) return na('missing-session', `No completed close on the expiry session ${expirySession}`);
  const realized = Math.abs(bars[ei]!.close / q.close - 1);
  const reactionsInside: ISODate[] = [];
  for (const e of events) {
    const r = reactionSession(e);
    if (!isNa(r) && r > capture.quoteDate && r <= expirySession) reactionsInside.push(r);
  }
  return {
    label: 'Expiry magnitude',
    quoteDate: capture.quoteDate,
    expirySession,
    sessions: ei - qi,
    implied: capture.impliedMove,
    realized,
    ratio: realized / capture.impliedMove,
    reactionsInside,
    note: 'Implied move to the option expiry against the realized absolute move over the same period. Not isolated earnings volatility, not a probability, not a direction.',
  };
};
