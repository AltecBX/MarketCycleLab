/**
 * Monthly Reversal and monthly selling intelligence. Primitives: state, cohorts, matching,
 * outcomes, recovery feasibility. The calibrated candidate, the study orchestrator, scenarios,
 * chart paths and the scanner live in monthlyReversalModel.ts.
 *
 * Definitions
 * - Month: the exchange calendar month of a completed session anchor. The base is the final close
 *   of the preceding calendar month. Without that close the state is Unavailable.
 * - MTD return: anchor close / prior month close - 1. Always on the close basis.
 * - Day classification basis: 'prior-close' (close vs previous close) or 'open' (close vs same
 *   session open). The basis changes current and historical classifications together. Magnitudes
 *   named `ret` are always close vs previous close. `classMove` is the move on the chosen basis.
 * - Ordinal age: 1 based count of the month's sessions through the anchor. Remaining sessions come
 *   from the exchange calendar.
 * - Drawdown: anchor close / peak - 1 where the peak is the highest of the prior month close and
 *   the month's closes through the anchor (earliest on ties).
 * - Cohort: at most one anchor per earlier month at the equivalent ordinal (or elapsed fraction),
 *   needing the prior month close and every session through the anchor. Excluded months carry a reason.
 * - Outcomes have their own denominators. A matured outcome needs every session of its window.
 *   Endpoint, first touch, closing target and held target are different outcomes.
 * - A displayed conditional frequency needs at least 10 eligible months and 3 distinct years. The
 *   Wilson interval uses the conservative year cluster effective sample size.
 *
 * Everything is as of the anchor. Rows after the anchor are cut before any computation.
 */
import { lastSessionOfMonth, monthOf, prevSession, sessionsOfMonth, yearOf } from './core/calendar';
import { rollingReturnStd, sma, type Series } from './core/indicators';
import { firstTouch } from './core/outcomes';
import { minusMonths, periodBaseIndex, periodToDate, sliceAsOf } from './core/series';
import { distinctYears, distribution, mean, median, sampleStd, wilson, yearClusterEffectiveN } from './core/stats';
import { isNa, na, type Bar, type Distribution, type EarningsEvent, type ISODate, type Maybe, type Proportion, type Unavailable } from './core/types';

// ---------------------------------------------------------------------------------------------
// Options and defaults
// ---------------------------------------------------------------------------------------------

export type ClassBasis = 'prior-close' | 'open';
export type DayClass = 'up' | 'down' | 'flat';
export type AnchorPosition = 'ordinal' | 'fraction';

export type FeatureKey =
  | 'negativeShare'
  | 'mtdReturn'
  | 'drawdown'
  | 'closingStreak'
  | 'recentNegativeShare'
  | 'lossAcceleration'
  | 'downsideDaySize'
  | 'dailyVol'
  | 'vsMarket'
  | 'vsSector'
  | 'marketAbove200'
  | 'marketVol'
  | 'stockAbove50'
  | 'stockAbove200'
  | 'earningsKnown';

export const FEATURE_LABELS: Readonly<Record<FeatureKey, string>> = {
  negativeShare: 'Share of down sessions this month',
  mtdReturn: 'Month to date return',
  drawdown: 'Drawdown from the month reference peak',
  closingStreak: 'Current closing streak, down is negative',
  recentNegativeShare: 'Share of down sessions in the recent window',
  lossAcceleration: 'Recent average daily return minus earlier average',
  downsideDaySize: 'Average size of down sessions',
  dailyVol: 'Daily volatility this month',
  vsMarket: 'Month to date return minus market',
  vsSector: 'Month to date return minus sector',
  marketAbove200: 'Market above its 200 session average',
  marketVol: 'Market 20 session daily volatility',
  stockAbove50: 'Stock above its 50 session average',
  stockAbove200: 'Stock above its 200 session average',
  earningsKnown: 'Earnings known by the anchor inside the window',
};

const BINARY_FEATURES: ReadonlySet<FeatureKey> = new Set(['marketAbove200', 'stockAbove50', 'stockAbove200', 'earningsKnown']);

/**
 * Match weights. The reference weights were not available when this was written, so every feature
 * weighs the same. Reconcile with monthly-reversal-study.mjs before a parity claim.
 */
export const DEFAULT_WEIGHTS: Readonly<Record<FeatureKey, number>> & { readonly provenance: 'proposed' } = {
  negativeShare: 1,
  mtdReturn: 1,
  drawdown: 1,
  closingStreak: 1,
  recentNegativeShare: 1,
  lossAcceleration: 1,
  downsideDaySize: 1,
  dailyVol: 1,
  vsMarket: 1,
  vsSector: 1,
  marketAbove200: 1,
  marketVol: 1,
  stockAbove50: 1,
  stockAbove200: 1,
  earningsKnown: 1,
  provenance: 'proposed',
};

/** One unit of normalized difference per feature. Binary features differ by 0 or 1. Proposed. */
export const DEFAULT_SCALES: Readonly<Record<FeatureKey, number>> & { readonly provenance: 'proposed' } = {
  negativeShare: 0.2,
  mtdReturn: 0.08,
  drawdown: 0.08,
  closingStreak: 3,
  recentNegativeShare: 0.3,
  lossAcceleration: 0.01,
  downsideDaySize: 0.015,
  dailyVol: 0.015,
  vsMarket: 0.06,
  vsSector: 0.06,
  marketAbove200: 1,
  marketVol: 0.006,
  stockAbove50: 1,
  stockAbove200: 1,
  earningsKnown: 1,
  provenance: 'proposed',
};

export interface CohortFilters {
  /** Inclusive bounds. Each is optional. Down counts and shares use the chosen classification basis. */
  minDownSessions?: number;
  maxDownSessions?: number;
  minDownShare?: number;
  maxDownShare?: number;
  minUpSessions?: number;
  maxUpSessions?: number;
  /** Minimum current down streak length. */
  minDownStreak?: number;
  /** Drawdown bounds as negative fractions, for example [-0.3, -0.1]. */
  drawdownRange?: readonly [number, number];
  mtdRange?: readonly [number, number];
  /** Restrict to one calendar month number, 1 to 12. */
  calendarMonth?: number;
}

export interface MonthlyReversalOptions {
  basis: ClassBasis;
  lookbackYears: number;
  /** Fixed horizon in completed sessions, 1 to 90. */
  horizon: number;
  /** Bounce target above the anchor close. */
  bounce: number;
  /** Further decline below the anchor close. */
  downside: number;
  /** Consecutive closes at or above the bounce target that count as holding it. */
  holdSessions: number;
  minMonths: number;
  minYears: number;
  level: number;
  position: AnchorPosition;
  /** Largest match distance that still counts as a similar setup. */
  tolerance: number;
  /** Minimum features present on both sides for a match score. */
  minSharedFeatures: number;
  /** Sessions in the recent window for recent share, acceleration and new low frequency. */
  recentWindow: number;
  /** A retest is a later low within this fraction above the month low through the anchor. */
  retestTolerance: number;
  /** Window for days to rebound and days to recovery. */
  recoveryHorizon: number;
  /** Sessions before the anchor and after it (the horizon) that define the earnings window. */
  earningsLookbackSessions: number;
  /** Compare the recent order of down and up sessions as an extra match dimension. */
  sequenceMatch: boolean;
  sequenceLength: number;
  filters: CohortFilters;
  weights: Readonly<Record<FeatureKey, number>>;
  scales: Readonly<Record<FeatureKey, number>>;
}

export const HORIZON_CHOICES: readonly number[] = [1, 2, 3, 5, 10];
export const MAX_HORIZON = 90;

/** Defaults. `provenance` says which come from the owner specification and which are proposed. */
export const DEFAULTS: MonthlyReversalOptions & { readonly provenance: Readonly<Record<string, 'spec' | 'proposed'>> } = {
  basis: 'prior-close',
  lookbackYears: 10,
  horizon: 5,
  bounce: 0.03,
  downside: 0.05,
  holdSessions: 3,
  minMonths: 10,
  minYears: 3,
  level: 0.95,
  position: 'ordinal',
  tolerance: 1,
  minSharedFeatures: 6,
  recentWindow: 5,
  retestTolerance: 0.01,
  recoveryHorizon: 60,
  earningsLookbackSessions: 5,
  sequenceMatch: false,
  sequenceLength: 5,
  filters: {},
  weights: DEFAULT_WEIGHTS,
  scales: DEFAULT_SCALES,
  provenance: {
    lookbackYears: 'spec',
    horizon: 'spec',
    bounce: 'spec',
    downside: 'spec',
    holdSessions: 'spec',
    minMonths: 'spec',
    minYears: 'spec',
    level: 'spec',
    basis: 'proposed',
    position: 'spec',
    tolerance: 'proposed',
    minSharedFeatures: 'proposed',
    recentWindow: 'proposed',
    retestTolerance: 'proposed',
    recoveryHorizon: 'proposed',
    earningsLookbackSessions: 'proposed',
    sequenceLength: 'proposed',
    weights: 'proposed',
    scales: 'proposed',
  },
};

export const resolveOptions = (o?: Partial<MonthlyReversalOptions>): MonthlyReversalOptions => {
  const merged: MonthlyReversalOptions = { ...DEFAULTS, ...(o ?? {}) };
  merged.horizon = Math.max(1, Math.min(MAX_HORIZON, Math.round(merged.horizon)));
  merged.holdSessions = Math.max(1, Math.round(merged.holdSessions));
  merged.recentWindow = Math.max(1, Math.round(merged.recentWindow));
  return merged;
};

export interface MonthlyContext {
  /** Broad market series, for example SPY. Used for regime and relative features. */
  market?: readonly Bar[];
  /** Sector series for sector relative features. */
  sector?: readonly Bar[];
  /** Earnings events with knownAt where available. Without this, earnings context is unknown. */
  earnings?: readonly EarningsEvent[];
}

// ---------------------------------------------------------------------------------------------
// Monthly state
// ---------------------------------------------------------------------------------------------

export interface MonthDay {
  date: ISODate;
  index: number;
  /** 1 based session number inside the month. */
  ordinal: number;
  close: number;
  /** Close vs previous close. */
  ret: number;
  /** Move on the classification basis. */
  classMove: number;
  cls: DayClass;
  /** Close vs prior month close. */
  mtd: number;
}

export interface DatedLevel {
  value: number;
  date: ISODate;
}

export interface MonthlyState {
  anchorIndex: number;
  anchorDate: ISODate;
  anchorClose: number;
  /** 'YYYY-MM'. */
  monthKey: string;
  year: number;
  month: number;
  basis: ClassBasis;
  priorMonthClose: number;
  priorMonthCloseDate: ISODate;
  /** Sessions of the month through the anchor. */
  elapsed: number;
  /** Sessions the exchange calendar plans for the whole month. */
  plannedSessions: number;
  remaining: number;
  remainingDates: ISODate[];
  elapsedFraction: number;
  up: number;
  down: number;
  flat: number;
  negativeShare: number;
  positiveShare: number;
  streak: { direction: DayClass; length: number };
  longestDownStreak: number;
  longestUpStreak: number;
  recentWindow: number;
  recentDown: number;
  recentUp: number;
  recentNegativeShare: number;
  meanGain: Maybe<number>;
  medianGain: Maybe<number>;
  meanLoss: Maybe<number>;
  medianLoss: Maybe<number>;
  /** Best and worst sessions by close vs previous close. */
  bestDay: { date: ISODate; ret: number };
  worstDay: { date: ISODate; ret: number };
  monthOpen: number;
  intradayHigh: DatedLevel;
  intradayLow: DatedLevel;
  closingHigh: DatedLevel;
  closingLow: DatedLevel;
  mtdReturn: number;
  /** (close - month intraday low) / (month intraday high - low). */
  rangePosition: Maybe<number>;
  drawdown: number;
  peak: DatedLevel & { inMonth: boolean };
  /** Sessions since the peak. The prior month close counts as session 0. */
  peakAge: number;
  lowAfterPeak: DatedLevel;
  lowAge: number;
  /** Sample standard deviation of the month's close vs previous close returns. */
  dailyVol: Maybe<number>;
  /** Mean return of the recent window minus the mean of earlier sessions. Negative means selling sped up. */
  sellingAcceleration: Maybe<number>;
  /** Sessions in the recent window that closed below every earlier reference of the month. */
  newLowCount: number;
  newLowFrequency: number;
  days: MonthDay[];
  /** One letter per session. D down, U up, F flat. */
  sequence: string;
}

const calCache = new Map<string, ISODate[]>();
/** Planned exchange sessions of a 'YYYY-MM' month. */
export const plannedSessionsOf = (monthKey: string): ISODate[] => {
  const hit = calCache.get(monthKey);
  if (hit) return hit;
  const s = sessionsOfMonth(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)));
  calCache.set(monthKey, s);
  return s;
};

const classify = (move: number): DayClass => (move > 0 ? 'up' : move < 0 ? 'down' : 'flat');

const longestRun = (days: readonly MonthDay[], cls: DayClass): number => {
  let best = 0;
  let run = 0;
  for (const d of days) {
    run = d.cls === cls ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
};

const statOrNa = (xs: readonly number[], f: (v: readonly number[]) => number, what: string): Maybe<number> =>
  xs.length === 0 ? na('sample-too-small', `No ${what} sessions this month`) : f(xs);

/**
 * Monthly state at completed session i. Uses rows 0..i only.
 * Unavailable when the prior month final close is missing or a session through the anchor is missing.
 */
export const monthlyState = (
  bars: readonly Bar[],
  i: number,
  opts?: { basis?: ClassBasis; recentWindow?: number },
): Maybe<MonthlyState> => {
  const anchor = bars[i];
  if (!anchor) return na('invalid-input', 'Anchor index outside the series');
  const basis = opts?.basis ?? DEFAULTS.basis;
  const window = Math.max(1, opts?.recentWindow ?? DEFAULTS.recentWindow);
  const monthKey = anchor.date.slice(0, 7);
  const baseIdx = periodBaseIndex(bars, i, 'M');
  if (typeof baseIdx !== 'number') return baseIdx;
  const start = baseIdx + 1;
  const planned = plannedSessionsOf(monthKey);
  const elapsed = i - start + 1;
  for (let k = 0; k < elapsed; k++) {
    if (bars[start + k]!.date !== planned[k]) {
      return na('missing-session', `Expected session ${planned[k] ?? 'none'} at position ${k + 1} of ${monthKey}, series has ${bars[start + k]!.date}`);
    }
  }
  const base = bars[baseIdx]!;
  const days: MonthDay[] = [];
  let prevClose = base.close;
  let hi: DatedLevel = { value: -Infinity, date: anchor.date };
  let lo: DatedLevel = { value: Infinity, date: anchor.date };
  let cHi: DatedLevel = { value: -Infinity, date: anchor.date };
  let cLo: DatedLevel = { value: Infinity, date: anchor.date };
  let peak = { value: base.close, date: base.date, inMonth: false, ordinal: 0 };
  let runningLow = base.close;
  const newLowFlags: boolean[] = [];
  for (let k = 0; k < elapsed; k++) {
    const b = bars[start + k]!;
    const ret = b.close / prevClose - 1;
    const classMove = basis === 'open' ? b.close / b.open - 1 : ret;
    days.push({ date: b.date, index: start + k, ordinal: k + 1, close: b.close, ret, classMove, cls: classify(classMove), mtd: b.close / base.close - 1 });
    if (b.high > hi.value) hi = { value: b.high, date: b.date };
    if (b.low < lo.value) lo = { value: b.low, date: b.date };
    if (b.close > cHi.value) cHi = { value: b.close, date: b.date };
    if (b.close < cLo.value) cLo = { value: b.close, date: b.date };
    if (b.close > peak.value) peak = { value: b.close, date: b.date, inMonth: true, ordinal: k + 1 };
    newLowFlags.push(b.close < runningLow);
    if (b.close < runningLow) runningLow = b.close;
    prevClose = b.close;
  }
  // Lowest close after the peak, through the anchor. The peak session itself when nothing follows.
  let lowAfter: DatedLevel = { value: peak.value, date: peak.date };
  let lowOrdinal = peak.ordinal;
  let first = true;
  for (const d of days) {
    if (d.ordinal <= peak.ordinal) continue;
    if (first || d.close < lowAfter.value) {
      lowAfter = { value: d.close, date: d.date };
      lowOrdinal = d.ordinal;
      first = false;
    }
  }
  const up = days.filter((d) => d.cls === 'up').length;
  const down = days.filter((d) => d.cls === 'down').length;
  const last = days[days.length - 1]!;
  let streakLen = 0;
  for (let k = days.length - 1; k >= 0 && days[k]!.cls === last.cls; k--) streakLen++;
  const w = Math.min(window, elapsed);
  const recent = days.slice(elapsed - w);
  const earlier = days.slice(0, elapsed - w);
  const gains = days.filter((d) => d.cls === 'up').map((d) => d.classMove);
  const losses = days.filter((d) => d.cls === 'down').map((d) => d.classMove);
  let best = days[0]!;
  let worst = days[0]!;
  for (const d of days) {
    if (d.ret > best.ret) best = d;
    if (d.ret < worst.ret) worst = d;
  }
  const rets = days.map((d) => d.ret);
  const recentDown = recent.filter((d) => d.cls === 'down').length;
  const newLowCount = newLowFlags.slice(elapsed - w).filter(Boolean).length;
  return {
    anchorIndex: i,
    anchorDate: anchor.date,
    anchorClose: anchor.close,
    monthKey,
    year: yearOf(anchor.date),
    month: monthOf(anchor.date),
    basis,
    priorMonthClose: base.close,
    priorMonthCloseDate: base.date,
    elapsed,
    plannedSessions: planned.length,
    remaining: planned.length - elapsed,
    remainingDates: planned.slice(elapsed),
    elapsedFraction: elapsed / planned.length,
    up,
    down,
    flat: elapsed - up - down,
    negativeShare: down / elapsed,
    positiveShare: up / elapsed,
    streak: { direction: last.cls, length: streakLen },
    longestDownStreak: longestRun(days, 'down'),
    longestUpStreak: longestRun(days, 'up'),
    recentWindow: w,
    recentDown,
    recentUp: recent.filter((d) => d.cls === 'up').length,
    recentNegativeShare: recentDown / w,
    meanGain: statOrNa(gains, mean, 'up'),
    medianGain: statOrNa(gains, median, 'up'),
    meanLoss: statOrNa(losses, mean, 'down'),
    medianLoss: statOrNa(losses, median, 'down'),
    bestDay: { date: best.date, ret: best.ret },
    worstDay: { date: worst.date, ret: worst.ret },
    monthOpen: bars[start]!.open,
    intradayHigh: hi,
    intradayLow: lo,
    closingHigh: cHi,
    closingLow: cLo,
    mtdReturn: anchor.close / base.close - 1,
    rangePosition: hi.value === lo.value ? na('flat-range', 'Month high equals month low') : (anchor.close - lo.value) / (hi.value - lo.value),
    drawdown: anchor.close / peak.value - 1,
    peak: { value: peak.value, date: peak.date, inMonth: peak.inMonth },
    peakAge: elapsed - peak.ordinal,
    lowAfterPeak: lowAfter,
    lowAge: elapsed - lowOrdinal,
    dailyVol: rets.length < 2 ? na('insufficient-history', 'Needs two sessions in the month') : sampleStd(rets),
    sellingAcceleration:
      earlier.length === 0
        ? na('insufficient-history', 'No sessions before the recent window')
        : mean(recent.map((d) => d.ret)) - mean(earlier.map((d) => d.ret)),
    newLowCount,
    newLowFrequency: newLowCount / w,
    days,
    sequence: days.map((d) => (d.cls === 'down' ? 'D' : d.cls === 'up' ? 'U' : 'F')).join(''),
  };
};

// ---------------------------------------------------------------------------------------------
// Context, features and matching
// ---------------------------------------------------------------------------------------------

export type EarningsContext = 'in-window' | 'none' | 'unknown';

interface SideSeries {
  bars: Bar[];
  index: Map<ISODate, number>;
  sma200: Series;
  vol20: Series;
}

/** Precomputed, as-of cut inputs shared by every candidate month. */
export interface StudyContext {
  bars: Bar[];
  anchorIndex: number;
  sma50: Series;
  sma200: Series;
  market: SideSeries | null;
  sector: SideSeries | null;
  earnings: EarningsEvent[] | null;
  options: MonthlyReversalOptions;
}

const sideSeries = (bars: readonly Bar[] | undefined, asOf: ISODate): SideSeries | null => {
  if (!bars || bars.length === 0) return null;
  const cut = sliceAsOf(bars, asOf);
  const closes = cut.map((b) => b.close);
  return { bars: cut, index: new Map(cut.map((b, k) => [b.date, k])), sma200: sma(closes, 200), vol20: rollingReturnStd(closes, 20) };
};

/** Cut every input at the anchor so nothing later can leak into a feature or an outcome. */
export const buildContext = (
  bars: readonly Bar[],
  i: number,
  options: MonthlyReversalOptions,
  context?: MonthlyContext,
): Maybe<StudyContext> => {
  const a = bars[i];
  if (!a) return na('invalid-input', 'Anchor index outside the series');
  const cut = bars.slice(0, i + 1);
  const closes = cut.map((b) => b.close);
  return {
    bars: cut,
    anchorIndex: i,
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    market: sideSeries(context?.market, a.date),
    sector: sideSeries(context?.sector, a.date),
    earnings: context?.earnings ? [...context.earnings] : null,
    options,
  };
};

/**
 * Earnings context at an anchor using only what was knowable then.
 * A release on or before the anchor is known. A later release counts only when its `knownAt` is
 * on or before the anchor date. A later release without `knownAt` makes the context unknown.
 */
export const earningsContextAt = (
  events: readonly EarningsEvent[] | null,
  bars: readonly Bar[],
  i: number,
  lookbackSessions: number,
  horizon: number,
): EarningsContext => {
  const a = bars[i];
  if (!events || !a) return 'unknown';
  const from = bars[Math.max(0, i - lookbackSessions)]!.date;
  // The forward edge uses planned exchange sessions so it never reads a later bar.
  let to = a.date;
  const plannedAhead: ISODate[] = [];
  let key = a.date.slice(0, 7);
  while (plannedAhead.length < horizon) {
    for (const d of plannedSessionsOf(key)) if (d > a.date && plannedAhead.length < horizon) plannedAhead.push(d);
    const y = Number(key.slice(0, 4));
    const m = Number(key.slice(5, 7));
    key = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }
  to = plannedAhead[plannedAhead.length - 1] ?? a.date;
  let unknown = false;
  for (const e of events) {
    if (e.date < from || e.date > to) continue;
    if (e.date <= a.date) return 'in-window';
    if (e.knownAt === undefined) unknown = true;
    else if (e.knownAt.slice(0, 10) <= a.date) return 'in-window';
  }
  return unknown ? 'unknown' : 'none';
};

export type FeatureVector = Partial<Record<FeatureKey, number>>;

const numOr = (v: Maybe<number>): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Match features of a state. A feature without coverage is absent. It is never zero filled. */
export const featuresOf = (ctx: StudyContext, state: MonthlyState, earnings: EarningsContext): FeatureVector => {
  const f: FeatureVector = {
    negativeShare: state.negativeShare,
    mtdReturn: state.mtdReturn,
    drawdown: state.drawdown,
    closingStreak: state.streak.direction === 'down' ? -state.streak.length : state.streak.direction === 'up' ? state.streak.length : 0,
    recentNegativeShare: state.recentNegativeShare,
  };
  const set = (k: FeatureKey, v: number | undefined) => {
    if (v !== undefined) f[k] = v;
  };
  set('lossAcceleration', numOr(state.sellingAcceleration));
  set('downsideDaySize', numOr(state.meanLoss));
  set('dailyVol', numOr(state.dailyVol));
  const i = state.anchorIndex;
  const s50 = ctx.sma50[i];
  const s200 = ctx.sma200[i];
  if (s50 !== null && s50 !== undefined) f.stockAbove50 = state.anchorClose > s50 ? 1 : 0;
  if (s200 !== null && s200 !== undefined) f.stockAbove200 = state.anchorClose > s200 ? 1 : 0;
  const rel = (side: SideSeries | null): number | undefined => {
    const k = side?.index.get(state.anchorDate);
    if (!side || k === undefined) return undefined;
    const p = periodToDate(side.bars, k, 'M');
    return isNa(p) ? undefined : state.mtdReturn - p.ret;
  };
  set('vsMarket', rel(ctx.market));
  set('vsSector', rel(ctx.sector));
  const mk = ctx.market?.index.get(state.anchorDate);
  if (ctx.market && mk !== undefined) {
    const m200 = ctx.market.sma200[mk];
    const mv = ctx.market.vol20[mk];
    if (m200 !== null && m200 !== undefined) f.marketAbove200 = ctx.market.bars[mk]!.close > m200 ? 1 : 0;
    if (mv !== null && mv !== undefined) f.marketVol = mv;
  }
  if (earnings !== 'unknown') f.earningsKnown = earnings === 'in-window' ? 1 : 0;
  return f;
};

export interface MatchComponent {
  key: FeatureKey | 'sequence';
  label: string;
  query: number;
  candidate: number;
  /** Candidate minus query, signed, in the feature's own unit. */
  diff: number;
  /** Absolute difference divided by the feature scale. */
  normalized: number;
  weight: number;
  /** Share of the total distance this feature explains. */
  contribution: number;
}

export interface MatchResult {
  /** Weighted mean of normalized differences over shared features. Zero is identical. */
  distance: number;
  shared: number;
  components: MatchComponent[];
  missing: FeatureKey[];
}

const sequenceMismatch = (a: string, b: string, len: number): number | null => {
  const x = a.slice(-len);
  const y = b.slice(-len);
  const n = Math.min(x.length, y.length);
  if (n === 0) return null;
  let diff = 0;
  for (let k = 1; k <= n; k++) if (x[x.length - k] !== y[y.length - k]) diff++;
  return diff / n;
};

/**
 * Weighted mean normalized difference between a query and a candidate over the features both have.
 * Unavailable when fewer than `minSharedFeatures` are shared.
 */
export const matchDistance = (
  query: FeatureVector,
  candidate: FeatureVector,
  options: Pick<MonthlyReversalOptions, 'weights' | 'scales' | 'minSharedFeatures' | 'sequenceMatch' | 'sequenceLength'>,
  sequences?: { query: string; candidate: string },
): Maybe<MatchResult> => {
  const components: MatchComponent[] = [];
  const missing: FeatureKey[] = [];
  let wSum = 0;
  let dSum = 0;
  for (const key of Object.keys(FEATURE_LABELS) as FeatureKey[]) {
    const q = query[key];
    const c = candidate[key];
    const weight = options.weights[key];
    if (q === undefined || c === undefined) {
      missing.push(key);
      continue;
    }
    if (!(weight > 0)) continue;
    const scale = BINARY_FEATURES.has(key) ? 1 : options.scales[key];
    const normalized = Math.abs(c - q) / scale;
    components.push({ key, label: FEATURE_LABELS[key], query: q, candidate: c, diff: c - q, normalized, weight, contribution: 0 });
    wSum += weight;
    dSum += weight * normalized;
  }
  if (options.sequenceMatch && sequences) {
    const mm = sequenceMismatch(sequences.query, sequences.candidate, options.sequenceLength);
    if (mm !== null) {
      components.push({ key: 'sequence', label: 'Recent order of down and up sessions', query: 0, candidate: mm, diff: mm, normalized: mm, weight: 1, contribution: 0 });
      wSum += 1;
      dSum += mm;
    }
  }
  if (components.length < options.minSharedFeatures || wSum === 0) {
    return na('no-coverage', `Only ${components.length} shared features, needs ${options.minSharedFeatures}`);
  }
  for (const c of components) c.contribution = dSum === 0 ? 0 : (c.weight * c.normalized) / dSum;
  components.sort((a, b) => b.contribution - a.contribution);
  return { distance: dSum / wSum, shared: components.length, components, missing };
};

// ---------------------------------------------------------------------------------------------
// Candidates and cohorts
// ---------------------------------------------------------------------------------------------

export interface CohortMember {
  monthKey: string;
  anchorIndex: number;
  anchorDate: ISODate;
  state: MonthlyState;
  features: FeatureVector;
  earnings: EarningsContext;
  /** Null when the market series does not cover the anchor. */
  marketAbove200: boolean | null;
  /** Match against the query. Unavailable when too few features are shared. */
  match: Maybe<MatchResult>;
}

export type ExclusionReason = 'no-prior-month-close' | 'incomplete-through-anchor' | 'too-few-sessions' | 'filtered';

export interface Exclusion {
  monthKey: string;
  reason: ExclusionReason;
  detail: string;
}

export interface CandidateSet {
  query: CohortMember;
  /** Eligible earlier months inside the lookback, oldest first. One anchor per month. */
  members: CohortMember[];
  exclusions: Exclusion[];
  /** Earlier calendar months inspected inside the lookback. */
  inspectedMonths: number;
  lookbackFrom: ISODate;
  historyFirst: ISODate;
  historyLast: ISODate;
  position: AnchorPosition;
}

const passesFilters = (s: MonthlyState, f: CohortFilters): boolean => {
  if (f.minDownSessions !== undefined && s.down < f.minDownSessions) return false;
  if (f.maxDownSessions !== undefined && s.down > f.maxDownSessions) return false;
  if (f.minUpSessions !== undefined && s.up < f.minUpSessions) return false;
  if (f.maxUpSessions !== undefined && s.up > f.maxUpSessions) return false;
  if (f.minDownShare !== undefined && s.negativeShare < f.minDownShare) return false;
  if (f.maxDownShare !== undefined && s.negativeShare > f.maxDownShare) return false;
  if (f.minDownStreak !== undefined && !(s.streak.direction === 'down' && s.streak.length >= f.minDownStreak)) return false;
  if (f.drawdownRange && (s.drawdown < f.drawdownRange[0] || s.drawdown > f.drawdownRange[1])) return false;
  if (f.mtdRange && (s.mtdReturn < f.mtdRange[0] || s.mtdReturn > f.mtdRange[1])) return false;
  if (f.calendarMonth !== undefined && s.month !== f.calendarMonth) return false;
  return true;
};

const describeFilters = (f: CohortFilters): string[] => {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const out: string[] = [];
  if (f.minDownSessions !== undefined) out.push(`At least ${f.minDownSessions} down sessions`);
  if (f.maxDownSessions !== undefined) out.push(`At most ${f.maxDownSessions} down sessions`);
  if (f.minUpSessions !== undefined) out.push(`At least ${f.minUpSessions} up sessions`);
  if (f.maxUpSessions !== undefined) out.push(`At most ${f.maxUpSessions} up sessions`);
  if (f.minDownShare !== undefined) out.push(`Down share at least ${pct(f.minDownShare)}`);
  if (f.maxDownShare !== undefined) out.push(`Down share at most ${pct(f.maxDownShare)}`);
  if (f.minDownStreak !== undefined) out.push(`Down streak of at least ${f.minDownStreak}`);
  if (f.drawdownRange) out.push(`Drawdown between ${pct(f.drawdownRange[0])} and ${pct(f.drawdownRange[1])}`);
  if (f.mtdRange) out.push(`Month to date between ${pct(f.mtdRange[0])} and ${pct(f.mtdRange[1])}`);
  if (f.calendarMonth !== undefined) out.push(`Calendar month ${f.calendarMonth}`);
  return out;
};

const memberAt = (ctx: StudyContext, state: MonthlyState): Omit<CohortMember, 'match'> => {
  const o = ctx.options;
  const earnings = earningsContextAt(ctx.earnings, ctx.bars, state.anchorIndex, o.earningsLookbackSessions, o.horizon);
  const features = featuresOf(ctx, state, earnings);
  return {
    monthKey: state.monthKey,
    anchorIndex: state.anchorIndex,
    anchorDate: state.anchorDate,
    state,
    features,
    earnings,
    marketAbove200: features.marketAbove200 === undefined ? null : features.marketAbove200 === 1,
  };
};

/**
 * One candidate anchor per earlier month inside the lookback, at the query's ordinal session (or
 * the same elapsed fraction). Months that cannot supply a clean anchor are listed with a reason.
 */
export const buildCandidates = (ctx: StudyContext, queryState: MonthlyState): CandidateSet => {
  const o = ctx.options;
  const bars = ctx.bars;
  const queryBase = memberAt(ctx, queryState);
  const query: CohortMember = { ...queryBase, match: { distance: 0, shared: Object.keys(queryBase.features).length, components: [], missing: [] } };
  // The lookback is counted in whole calendar months so it always holds 12 x years earlier months,
  // whatever the anchor's day of month.
  const lookbackFrom = minusMonths(`${queryState.monthKey}-01`, 12 * o.lookbackYears);
  const members: CohortMember[] = [];
  const exclusions: Exclusion[] = [];
  let inspected = 0;
  // Walk month starts from the first bar to the month before the query month.
  let s = 0;
  while (s < bars.length) {
    const key = bars[s]!.date.slice(0, 7);
    let e = s;
    while (e + 1 < bars.length && bars[e + 1]!.date.slice(0, 7) === key) e++;
    const next = e + 1;
    if (key >= queryState.monthKey) break;
    const planned = plannedSessionsOf(key);
    const ordinal = o.position === 'fraction' ? Math.max(1, Math.round(queryState.elapsedFraction * planned.length)) : queryState.elapsed;
    const anchorDate = planned[ordinal - 1];
    if (`${key}-01` < lookbackFrom) {
      s = next;
      continue;
    }
    inspected++;
    if (anchorDate === undefined) {
      exclusions.push({ monthKey: key, reason: 'too-few-sessions', detail: `${key} has ${planned.length} sessions, the anchor is session ${ordinal}` });
      s = next;
      continue;
    }
    const idx = s + ordinal - 1;
    if (idx > e || bars[idx]!.date !== anchorDate) {
      // Either the series starts inside the month or a session is missing before the anchor.
      const startsInside = bars[s]!.date !== planned[0] && s === 0;
      exclusions.push({
        monthKey: key,
        reason: startsInside ? 'no-prior-month-close' : 'incomplete-through-anchor',
        detail: startsInside ? `History starts inside ${key}` : `A session through ${anchorDate} is missing`,
      });
      s = next;
      continue;
    }
    const st = monthlyState(bars, idx, { basis: o.basis, recentWindow: o.recentWindow });
    if (isNa(st)) {
      exclusions.push({
        monthKey: key,
        reason: st.code === 'missing-base-close' || (st.code === 'missing-session' && (st.detail ?? '').startsWith('Expected base')) ? 'no-prior-month-close' : 'incomplete-through-anchor',
        detail: st.detail ?? st.code,
      });
      s = next;
      continue;
    }
    if (!passesFilters(st, o.filters)) {
      exclusions.push({ monthKey: key, reason: 'filtered', detail: 'Outside the chosen filters' });
      s = next;
      continue;
    }
    const base = memberAt(ctx, st);
    members.push({
      ...base,
      match: matchDistance(query.features, base.features, o, { query: queryState.sequence, candidate: st.sequence }),
    });
    s = next;
  }
  return {
    query,
    members,
    exclusions,
    inspectedMonths: inspected,
    lookbackFrom,
    historyFirst: bars[0]!.date,
    historyLast: bars[bars.length - 1]!.date,
    position: o.position,
  };
};

export type CohortKind = 'all-months' | 'same-calendar-month' | 'similar-setup' | 'regime' | 'same-earnings';

export interface Cohort {
  kind: CohortKind;
  label: string;
  /** Exact filters that define the cohort, in plain words. */
  filters: string[];
  members: CohortMember[];
  /** Set when the cohort cannot be formed, for example no market series for the regime cohort. */
  unavailable?: Unavailable;
  summary: OutcomeSummary;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The separate cohorts. Each keeps its own members, filters and outcome denominators. */
export const buildCohorts = (ctx: StudyContext, set: CandidateSet): Cohort[] => {
  const o = ctx.options;
  const q = set.query;
  const common = [
    `Session ${q.state.elapsed} of the month${o.position === 'fraction' ? ', matched by elapsed fraction' : ''}`,
    `Lookback from ${set.lookbackFrom}`,
    `Day classification by ${o.basis === 'open' ? 'close vs same session open' : 'close vs previous close'}`,
    ...describeFilters(o.filters),
  ];
  const make = (kind: CohortKind, label: string, filters: string[], members: CohortMember[], unavailable?: Unavailable): Cohort => {
    const c: Cohort = { kind, label, filters: [...common, ...filters], members, summary: summarizeOutcomes(ctx, members.map((m) => caseOutcome(ctx, m))) };
    if (unavailable) c.unavailable = unavailable;
    return c;
  };
  const similar = set.members
    .filter((m) => !isNa(m.match) && m.match.distance <= o.tolerance)
    .sort((a, b) => (a.match as MatchResult).distance - (b.match as MatchResult).distance);
  const regimeNa = q.marketAbove200 === null ? na('no-coverage', 'No market series with a 200 session average at the anchor') : undefined;
  const earnNa = q.earnings === 'unknown' ? na('no-coverage', 'Earnings timing at the anchor is not known point in time') : undefined;
  return [
    make('all-months', 'All earlier months', [], set.members),
    make('same-calendar-month', `Earlier ${MONTH_NAMES[q.state.month - 1]} months`, [`Calendar month is ${MONTH_NAMES[q.state.month - 1]}`], set.members.filter((m) => m.state.month === q.state.month)),
    make('similar-setup', 'Similar selling setup', [`Match distance at most ${o.tolerance}`, `At least ${o.minSharedFeatures} shared features`], similar),
    make(
      'regime',
      q.marketAbove200 === null ? 'Same market regime' : `Market ${q.marketAbove200 ? 'above' : 'below'} its 200 session average`,
      ['Market side of its 200 session average matches the anchor'],
      regimeNa ? [] : set.members.filter((m) => m.marketAbove200 === q.marketAbove200),
      regimeNa,
    ),
    make(
      'same-earnings',
      q.earnings === 'in-window' ? 'Earnings inside the window' : 'No earnings inside the window',
      [`Earnings known by the anchor within ${o.earningsLookbackSessions} sessions before or ${o.horizon} sessions after`],
      earnNa ? [] : set.members.filter((m) => m.earnings === q.earnings),
      earnNa,
    ),
  ];
};

// ---------------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------------

export type CloseRace = 'new-low-first' | 'regain-first' | 'neither';
export type IntradayRace = 'bounce-first' | 'downside-first' | 'neither' | 'indeterminate';

export interface CaseOutcome {
  monthKey: string;
  anchorDate: ISODate;
  anchorIndex: number;
  /** The fixed horizon has every session. */
  matured: boolean;
  endDate?: ISODate;
  ret?: number;
  /** Closes of the window relative to the anchor close, offsets 1..h. */
  path?: number[];
  mfeClose?: number;
  maeClose?: number;
  /** Every bar of the window has consistent OHLC. Intraday outcomes need this. */
  ohlcValid?: boolean;
  mfeIntraday?: number;
  maeIntraday?: number;
  /** Offset of the first intraday high at or above the bounce target, or null. */
  targetTouchOffset?: number | null;
  /** Offset of the first close at or above the bounce target, or null. */
  targetCloseOffset?: number | null;
  /**
   * Held target. `eventOffset` is the first close of a run of `holdSessions` closes at or above
   * the target. `confirmOffset` is the session the hold was complete, the first date it is known.
   * Null when no run started inside the horizon. Undefined when the data ends before it can be judged.
   */
  targetHold?: { eventOffset: number; confirmOffset: number } | null;
  /** Reached the closing target and later closed below the anchor close inside the horizon. */
  failedBounce?: boolean;
  retestNearLow?: boolean;
  furtherDeclineClose?: boolean;
  furtherDeclineTouch?: boolean;
  /** Only for anchors below the prior month close. Close based. */
  closeRace?: CloseRace;
  /** First intraday touch of the bounce target or the downside level. Same bar is indeterminate. */
  intradayRace?: IntradayRace;
  excessMarket?: number;
  excessSector?: number;
  /** The month has every session through its last one. */
  monthComplete: boolean;
  remainingCount: number;
  monthEndRet?: number;
  restOfMonthRet?: number;
  remainingUp?: number;
  anotherClosingLow?: boolean;
  nextMonthEndRet?: number;
  /** First close at or above the bounce target inside the recovery window. */
  rebound: { offset: number | null; censored: boolean };
  /** First close at or above the prior month close. Only for anchors below it. */
  recovery: { offset: number | null; censored: boolean } | null;
}

const ohlcOk = (b: Bar): boolean =>
  [b.open, b.high, b.low, b.close].every((v) => Number.isFinite(v) && v > 0) && b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close);

/** Outcomes of one cohort member. Uses only rows inside the as-of cut of the context. */
export const caseOutcome = (ctx: StudyContext, m: CohortMember): CaseOutcome => {
  const o = ctx.options;
  const bars = ctx.bars;
  const i = m.anchorIndex;
  const h = o.horizon;
  const st = m.state;
  const c0 = st.anchorClose;
  const target = c0 * (1 + o.bounce);
  const downLevel = c0 * (1 - o.downside);
  const classOf = (k: number): DayClass => {
    const b = bars[k]!;
    return classify(o.basis === 'open' ? b.close - b.open : b.close - bars[k - 1]!.close);
  };
  const out: CaseOutcome = {
    monthKey: m.monthKey,
    anchorDate: m.anchorDate,
    anchorIndex: i,
    matured: i + h < bars.length,
    monthComplete: false,
    remainingCount: st.remaining,
    rebound: firstTouch(bars, i, o.recoveryHorizon, target, 'above', 'close'),
    recovery: st.mtdReturn < 0 ? firstTouch(bars, i, o.recoveryHorizon, st.priorMonthClose, 'above', 'close') : null,
  };

  if (out.matured) {
    const end = bars[i + h]!;
    out.endDate = end.date;
    out.ret = end.close / c0 - 1;
    const path: number[] = [];
    let valid = true;
    let maxC = -Infinity;
    let minC = Infinity;
    let maxH = -Infinity;
    let minL = Infinity;
    let touch: number | null = null;
    let closeHit: number | null = null;
    let declineClose = false;
    let declineTouch = false;
    let failed = false;
    let race: IntradayRace = 'neither';
    let closeRace: CloseRace = 'neither';
    for (let k = 1; k <= h; k++) {
      const b = bars[i + k]!;
      path.push(b.close / c0 - 1);
      if (!ohlcOk(b)) valid = false;
      if (b.close > maxC) maxC = b.close;
      if (b.close < minC) minC = b.close;
      if (b.high > maxH) maxH = b.high;
      if (b.low < minL) minL = b.low;
      if (touch === null && b.high >= target) touch = k;
      if (closeHit !== null && b.close < c0) failed = true;
      if (closeHit === null && b.close >= target) closeHit = k;
      if (b.close <= downLevel) declineClose = true;
      if (b.low <= downLevel) declineTouch = true;
      if (race === 'neither') {
        const upHit = b.high >= target;
        const dnHit = b.low <= downLevel;
        if (upHit && dnHit) race = 'indeterminate';
        else if (upHit) race = 'bounce-first';
        else if (dnHit) race = 'downside-first';
      }
      if (closeRace === 'neither') {
        if (b.close < st.closingLow.value) closeRace = 'new-low-first';
        else if (b.close >= st.priorMonthClose) closeRace = 'regain-first';
      }
    }
    out.path = path;
    out.mfeClose = maxC / c0 - 1;
    out.maeClose = minC / c0 - 1;
    out.ohlcValid = valid;
    out.targetCloseOffset = closeHit;
    out.failedBounce = closeHit !== null && failed;
    out.furtherDeclineClose = declineClose;
    if (st.mtdReturn < 0) out.closeRace = closeRace;
    if (valid) {
      out.mfeIntraday = maxH / c0 - 1;
      out.maeIntraday = minL / c0 - 1;
      out.targetTouchOffset = touch;
      out.furtherDeclineTouch = declineTouch;
      out.retestNearLow = minL <= st.intradayLow.value * (1 + o.retestTolerance);
      out.intradayRace = race;
    }
    const rel = (side: SideSeries | null): number | undefined => {
      const a = side?.index.get(m.anchorDate);
      const e = side?.index.get(end.date);
      if (!side || a === undefined || e === undefined) return undefined;
      return out.ret! - (side.bars[e]!.close / side.bars[a]!.close - 1);
    };
    const xm = rel(ctx.market);
    const xs = rel(ctx.sector);
    if (xm !== undefined) out.excessMarket = xm;
    if (xs !== undefined) out.excessSector = xs;
  }

  // Held target: a run of holdSessions closes at or above the target that starts inside the horizon.
  {
    let found: { eventOffset: number; confirmOffset: number } | null = null;
    let undecided = false;
    for (let k = 1; k <= h && !found; k++) {
      if (i + k + o.holdSessions - 1 >= bars.length) {
        undecided = true;
        break;
      }
      let ok = true;
      for (let j = 0; j < o.holdSessions; j++) if (bars[i + k + j]!.close < target) { ok = false; break; }
      if (ok) found = { eventOffset: k, confirmOffset: k + o.holdSessions - 1 };
    }
    if (found) out.targetHold = found;
    else if (!undecided) out.targetHold = null;
  }

  // Rest of month outcomes need every remaining session of the month.
  const remainingDates = st.remainingDates;
  const endIdx = i + remainingDates.length;
  let complete = endIdx < bars.length;
  for (let k = 0; complete && k < remainingDates.length; k++) if (bars[i + 1 + k]!.date !== remainingDates[k]) complete = false;
  out.monthComplete = complete;
  if (complete) {
    const end = bars[endIdx]!;
    out.monthEndRet = end.close / st.priorMonthClose - 1;
    if (remainingDates.length > 0) {
      out.restOfMonthRet = end.close / c0 - 1;
      let upDays = 0;
      let newLow = false;
      for (let k = i + 1; k <= endIdx; k++) {
        if (classOf(k) === 'up') upDays++;
        if (bars[k]!.close < st.closingLow.value) newLow = true;
      }
      out.remainingUp = upDays;
      out.anotherClosingLow = newLow;
    }
    // Next month end: the final session of the following calendar month must be present.
    const nextKey = st.month === 12 ? `${st.year + 1}-01` : `${st.year}-${String(st.month + 1).padStart(2, '0')}`;
    const nextPlanned = plannedSessionsOf(nextKey);
    const nIdx = endIdx + nextPlanned.length;
    if (nIdx < bars.length && bars[nIdx]!.date === nextPlanned[nextPlanned.length - 1]) out.nextMonthEndRet = bars[nIdx]!.close / c0 - 1;
  }
  return out;
};

export interface OutcomeStat {
  key: string;
  label: string;
  /** Which prices decide the outcome. */
  basis: 'close' | 'intraday';
  hits: number;
  /** Outcome specific denominator. */
  n: number;
  /** Cohort members left out of this denominator, with the reason in `excludedNote`. */
  excluded: number;
  excludedNote: string;
  years: number;
  /** Shown only when the months and years gate passes. The counts above stay available. */
  display: Maybe<Proportion>;
}

export interface TimeToStat {
  label: string;
  /** Cases the question applies to. */
  eligible: number;
  reached: number;
  /** Not reached and the data ended before the window did. Neither a hit nor a miss. */
  censored: number;
  notReached: number;
  days: Distribution | null;
}

export interface OutcomeSummary {
  horizon: number;
  members: number;
  matured: number;
  notMatured: number;
  years: number;
  stats: OutcomeStat[];
  returns: Distribution | null;
  favorableClose: Distribution | null;
  adverseClose: Distribution | null;
  favorableIntraday: Distribution | null;
  adverseIntraday: Distribution | null;
  excessMarket: Distribution | null;
  excessSector: Distribution | null;
  /** Indeterminate same bar cases removed from the intraday race denominator. */
  indeterminateRace: number;
  rebound: TimeToStat;
  recovery: TimeToStat;
  /** Anchor dates of matured cases, oldest first. */
  anchorDates: ISODate[];
  cases: CaseOutcome[];
}

/** A frequency with its gate: at least `minMonths` cases across at least `minYears` distinct years. */
export const gatedProportion = (
  hits: number,
  dates: readonly ISODate[],
  o: Pick<MonthlyReversalOptions, 'minMonths' | 'minYears' | 'level'>,
): { years: number; display: Maybe<Proportion> } => {
  const n = dates.length;
  const years = distinctYears(dates);
  if (n < o.minMonths) return { years, display: na('sample-too-small', `${n} eligible months, needs ${o.minMonths}`) };
  if (years < o.minYears) return { years, display: na('sample-too-small', `${years} distinct years, needs ${o.minYears}`) };
  const p = wilson(hits, n, o.level, yearClusterEffectiveN(dates));
  return { years, display: p ?? na('sample-too-small', 'No eligible months') };
};

const timeTo = (label: string, xs: readonly ({ offset: number | null; censored: boolean } | null)[]): TimeToStat => {
  const eligible = xs.filter((x): x is { offset: number | null; censored: boolean } => x !== null);
  const reached = eligible.filter((x) => x.offset !== null).map((x) => x.offset as number);
  const censored = eligible.filter((x) => x.offset === null && x.censored).length;
  return { label, eligible: eligible.length, reached: reached.length, censored, notReached: eligible.length - reached.length - censored, days: distribution(reached) };
};

/** Summarize a cohort. Each stat states its own hits, denominator and what it left out. */
export const summarizeOutcomes = (ctx: StudyContext, cases: readonly CaseOutcome[]): OutcomeSummary => {
  const o = ctx.options;
  const pct = (x: number) => `${+(x * 100).toFixed(2)}%`;
  const matured = cases.filter((c) => c.matured);
  const stats: OutcomeStat[] = [];
  const add = (key: string, label: string, basis: 'close' | 'intraday', eligible: readonly CaseOutcome[], hit: (c: CaseOutcome) => boolean, excludedNote: string) => {
    const dates = eligible.map((c) => c.anchorDate);
    const hits = eligible.filter(hit).length;
    const g = gatedProportion(hits, dates, o);
    stats.push({ key, label, basis, hits, n: eligible.length, excluded: cases.length - eligible.length, excludedNote, years: g.years, display: g.display });
  };
  const h = o.horizon;
  const intraday = matured.filter((c) => c.ohlcValid);
  const monthDone = cases.filter((c) => c.monthComplete);
  const rest = monthDone.filter((c) => c.remainingCount > 0);
  const below = matured.filter((c) => c.closeRace !== undefined);
  const holdKnown = cases.filter((c) => c.targetHold !== undefined);
  const reached = matured.filter((c) => c.targetCloseOffset !== null && c.targetCloseOffset !== undefined);
  const raced = intraday.filter((c) => c.intradayRace !== 'indeterminate');
  const notMaturedNote = `Horizon of ${h} sessions not complete`;
  const ohlcNote = 'Horizon not complete or a bar without consistent open, high, low, close';
  add('positive-close', `Close above the anchor close after ${h} sessions`, 'close', matured, (c) => c.ret! > 0, notMaturedNote);
  add('positive-month-end', 'Month ends above the prior month close', 'close', monthDone, (c) => c.monthEndRet! > 0, 'Month not complete in the data');
  add('positive-rest-of-month', 'Month ends above the anchor close', 'close', rest, (c) => c.restOfMonthRet! > 0, 'No sessions remain or the month is not complete');
  add('majority-green-remaining', 'More than half of the remaining sessions close up', 'close', rest, (c) => c.remainingUp! * 2 > c.remainingCount, 'No sessions remain or the month is not complete');
  add('another-closing-low', 'Another monthly closing low before month end', 'close', rest, (c) => c.anotherClosingLow === true, 'No sessions remain or the month is not complete');
  add('new-low-before-regain', `New monthly closing low before a close back at the prior month close, within ${h} sessions`, 'close', below, (c) => c.closeRace === 'new-low-first', 'Anchor at or above the prior month close, or horizon not complete');
  add('target-touch', `Traded up ${pct(o.bounce)} from the anchor close within ${h} sessions`, 'intraday', intraday, (c) => c.targetTouchOffset !== null, ohlcNote);
  add('target-close', `Closed up ${pct(o.bounce)} from the anchor close within ${h} sessions`, 'close', matured, (c) => c.targetCloseOffset !== null, notMaturedNote);
  add('target-hold', `Closed up ${pct(o.bounce)} and held it for ${o.holdSessions} closes, starting within ${h} sessions`, 'close', holdKnown, (c) => c.targetHold !== null, 'Data ends before the hold can be judged');
  add('failed-bounce', `Closed up ${pct(o.bounce)} then closed below the anchor close within ${h} sessions`, 'close', reached, (c) => c.failedBounce === true, 'Closing target not reached or horizon not complete');
  add('retest-near-low', `Traded within ${pct(o.retestTolerance)} of the month low or below it within ${h} sessions`, 'intraday', intraday, (c) => c.retestNearLow === true, ohlcNote);
  add('further-decline-close', `Closed down ${pct(o.downside)} from the anchor close within ${h} sessions`, 'close', matured, (c) => c.furtherDeclineClose === true, notMaturedNote);
  add('further-decline-touch', `Traded down ${pct(o.downside)} from the anchor close within ${h} sessions`, 'intraday', intraday, (c) => c.furtherDeclineTouch === true, ohlcNote);
  add('bounce-before-downside', `Traded up ${pct(o.bounce)} before trading down ${pct(o.downside)}, within ${h} sessions`, 'intraday', raced, (c) => c.intradayRace === 'bounce-first', 'Horizon not complete, inconsistent bars, or both levels inside one daily bar');
  add('positive-next-month-end', 'Next month ends above the anchor close', 'close', cases.filter((c) => c.nextMonthEndRet !== undefined), (c) => c.nextMonthEndRet! > 0, 'Next month not complete in the data');
  const withMarket = matured.filter((c) => c.excessMarket !== undefined);
  const withSector = matured.filter((c) => c.excessSector !== undefined);
  add('beat-market', `Return above the market over ${h} sessions`, 'close', withMarket, (c) => c.excessMarket! > 0, 'No aligned market closes or horizon not complete');
  add('beat-sector', `Return above the sector over ${h} sessions`, 'close', withSector, (c) => c.excessSector! > 0, 'No aligned sector closes or horizon not complete');
  const nums = (xs: readonly (number | undefined)[]): number[] => xs.filter((x): x is number => x !== undefined);
  return {
    horizon: h,
    members: cases.length,
    matured: matured.length,
    notMatured: cases.length - matured.length,
    years: distinctYears(matured.map((c) => c.anchorDate)),
    stats,
    returns: distribution(nums(matured.map((c) => c.ret))),
    favorableClose: distribution(nums(matured.map((c) => c.mfeClose))),
    adverseClose: distribution(nums(matured.map((c) => c.maeClose))),
    favorableIntraday: distribution(nums(intraday.map((c) => c.mfeIntraday))),
    adverseIntraday: distribution(nums(intraday.map((c) => c.maeIntraday))),
    excessMarket: distribution(nums(withMarket.map((c) => c.excessMarket))),
    excessSector: distribution(nums(withSector.map((c) => c.excessSector))),
    indeterminateRace: intraday.length - raced.length,
    rebound: timeTo(`Sessions to a close up ${pct(o.bounce)}, within ${o.recoveryHorizon}`, cases.map((c) => c.rebound)),
    recovery: timeTo(`Sessions to a close back at the prior month close, within ${o.recoveryHorizon}`, cases.map((c) => c.recovery)),
    anchorDates: matured.map((c) => c.anchorDate),
    cases: [...cases],
  };
};

export const statOf = (summary: OutcomeSummary, key: string): OutcomeStat | undefined => summary.stats.find((s) => s.key === key);

// ---------------------------------------------------------------------------------------------
// Recovery feasibility
// ---------------------------------------------------------------------------------------------

export interface UpShareFeasibility {
  target: number;
  totalSessions: number;
  currentUp: number;
  /** max(0, ceil((elapsed + R) x s) - up count). */
  requiredUpDays: number;
  alreadyMet: boolean;
  /** False when the required up days exceed the remaining sessions. */
  feasible: boolean;
}

export interface CloseFeasibility {
  target: number;
  anchorClose: number;
  /** T / C - 1. */
  requiredTotal: number;
  /** (T / C)^(1 / R) - 1. Unavailable when no sessions remain. */
  requiredDaily: Maybe<number>;
  alreadyAtTarget: boolean;
  feasible: boolean;
}

export interface Feasibility {
  /** Planned exchange sessions left in the month. */
  remaining: number;
  noFutureSessions: boolean;
  upShare: UpShareFeasibility | null;
  close: CloseFeasibility | null;
}

/**
 * Arithmetic feasibility only. It says what the calendar still allows. It says nothing about how
 * often such a recovery happened. Use `remainingUpDayOdds` for the empirical side.
 */
export const recoveryFeasibility = (state: MonthlyState, input: { targetUpShare?: number; targetClose?: number }): Feasibility => {
  const R = state.remaining;
  const out: Feasibility = { remaining: R, noFutureSessions: R === 0, upShare: null, close: null };
  if (input.targetUpShare !== undefined) {
    const total = state.elapsed + R;
    const required = Math.max(0, Math.ceil(total * input.targetUpShare - 1e-9) - state.up);
    out.upShare = { target: input.targetUpShare, totalSessions: total, currentUp: state.up, requiredUpDays: required, alreadyMet: required === 0, feasible: required <= R };
  }
  if (input.targetClose !== undefined) {
    const T = input.targetClose;
    const C = state.anchorClose;
    const at = C >= T;
    out.close = {
      target: T,
      anchorClose: C,
      requiredTotal: T / C - 1,
      requiredDaily: R > 0 ? Math.pow(T / C, 1 / R) - 1 : na('not-applicable', 'No sessions remain this month'),
      alreadyAtTarget: at,
      feasible: at || R > 0,
    };
  }
  return out;
};

export interface UpDayOdds {
  /** Sessions ahead that every eligible case is measured over. */
  sessions: number;
  /** Cases with all `sessions` rows after their anchor. */
  eligible: number;
  /** Cases left out because their path is shorter than `sessions`. */
  insufficientPath: number;
  /** Count of cases with exactly N up sessions, N from 0 to `sessions`. */
  exact: { upDays: number; count: number; share: number }[];
  atLeast: { k: number; hits: number; n: number; display: Maybe<Proportion> } | null;
  /** Each complete month's own share of up sessions over its own remainder. */
  proportionView: Distribution | null;
  proportionCases: number;
  note: string;
}

/**
 * Empirical up day counts over the same number of sessions for every case, so raw counts are
 * comparable. The proportion view uses each month's own full remainder instead.
 */
export const remainingUpDayOdds = (ctx: StudyContext, members: readonly CohortMember[], sessions: number, atLeastK?: number): Maybe<UpDayOdds> => {
  if (sessions <= 0) return na('not-applicable', 'No sessions remain this month');
  if (members.length === 0) return na('sample-too-small', 'No eligible months');
  const o = ctx.options;
  const bars = ctx.bars;
  const counts: number[] = [];
  const dates: ISODate[] = [];
  let short = 0;
  const shares: number[] = [];
  for (const m of members) {
    const i = m.anchorIndex;
    if (i + sessions >= bars.length) short++;
    else {
      let up = 0;
      for (let k = i + 1; k <= i + sessions; k++) {
        const b = bars[k]!;
        if ((o.basis === 'open' ? b.close - b.open : b.close - bars[k - 1]!.close) > 0) up++;
      }
      counts.push(up);
      dates.push(m.anchorDate);
    }
    const c = caseOutcome(ctx, m);
    if (c.monthComplete && c.remainingCount > 0 && c.remainingUp !== undefined) shares.push(c.remainingUp / c.remainingCount);
  }
  const exact = Array.from({ length: sessions + 1 }, (_, n) => {
    const count = counts.filter((c) => c === n).length;
    return { upDays: n, count, share: counts.length ? count / counts.length : 0 };
  });
  let atLeast: UpDayOdds['atLeast'] = null;
  if (atLeastK !== undefined) {
    const hitDates = counts.filter((c) => c >= atLeastK).length;
    atLeast = { k: atLeastK, hits: hitDates, n: counts.length, display: gatedProportion(hitDates, dates, o).display };
  }
  return {
    sessions,
    eligible: counts.length,
    insufficientPath: short,
    exact,
    atLeast,
    proportionView: distribution(shares),
    proportionCases: shares.length,
    note: `Up sessions over the ${sessions} sessions after each anchor. Shorter months continue into the next month so every case has the same length.`,
  };
};

/** Last planned session of the anchor's month. Convenience for views. */
export const monthEndSession = (state: MonthlyState): ISODate => lastSessionOfMonth(state.anchorDate);

/** Previous session helper re-exported so views can label the base date without another import. */
export const baseSessionOf = (monthKey: string): ISODate => prevSession(`${monthKey}-01`);
