/**
 * Breakout intelligence: dated breakout and breakdown records, episodes, lifecycle facts,
 * forward outcomes, a gated conditional estimate, filters and a market stress helper.
 *
 * Definitions
 * - The reference level of a signal is the extreme of the PRIOR window, strictly excluding the
 *   signal bar. Session windows use the N sessions before the bar. Calendar windows use the
 *   declared trailing window of the signal bar minus the bar itself.
 * - Up side. Confirmed close: close above the level. Intraday failed attempt: the high traded
 *   through the level and the close finished at or below it. A close equal to the level is not
 *   a breakout. The down side mirrors every comparison.
 * - A new window high is not a year high and not a closing high within history. Those are
 *   separate flags on each signal.
 * - Signals on the same side and window cluster into one episode. A new independent episode
 *   needs more than five sessions since the last signal (specification).
 * - Lifecycle facts after the confirm close are separate dated facts: retest (traded back to
 *   within the retest distance of the level), hold (the retest session closed beyond the level),
 *   rebound (a later close beyond the best close before the retest), failure (first close back
 *   at or inside the level) and false breakout (a failure within a short window).
 * - Outcomes are measured from the confirm close on matured, non overlapping episodes. No later
 *   success is ever required for an episode to count in a denominator.
 * - The conditional estimate is shown only when it beats the earlier all days baseline out of
 *   sample. Otherwise the result is a description with exact counts and no percentage.
 */
import { rollingExtreme, sma, type Series } from './core/indicators';
import { firstTouch, forwardOutcome, selectNonOverlapping, type TouchMode } from './core/outcomes';
import { alignBars } from './core/series';
import { brier, distribution, median, wilson, yearClusterEffectiveN } from './core/stats';
import { isNa, na, type Bar, type Distribution, type ISODate, type Maybe, type ModelStatus, type Proportion } from './core/types';
import { compressionRatioAt, STATE_THRESHOLDS, WINDOW_SPECS, windowBaseSeries, windowExtremeSeries, type RangeBasis, type WindowKey } from './relativeStrength';

export type BreakWindowKey = '5D' | '10D' | '20D' | '1M' | '3M' | '6M' | '1Y';
export type BreakSide = 'up' | 'down';

export const BREAK_WINDOWS: readonly BreakWindowKey[] = ['5D', '10D', '20D', '1M', '3M', '6M', '1Y'];
export const BREAK_HORIZONS: readonly number[] = [1, 3, 5, 10, 20, 60];

/**
 * Study settings. `provenance: 'spec'` values come from the owner specification. `proposed`
 * values are choices the specification leaves to the reference source, which was not available.
 */
export const BREAKOUT_DEFAULTS = {
  episodeGapSessions: { value: 5, provenance: 'spec' as const },
  retestPct: { value: 0.01, min: 0.0025, max: 0.05, provenance: 'spec' as const },
  adversePct: { value: 0.03, min: 0.01, max: 0.15, provenance: 'spec' as const },
  targetPct: { value: 0.02, provenance: 'spec' as const },
  horizons: { value: BREAK_HORIZONS, provenance: 'spec' as const },
  /** Sessions after the confirm close inside which lifecycle facts are collected. */
  followSessions: { value: 20, provenance: 'proposed' as const },
  /** A failure this many sessions or fewer after the confirm close is a false breakout. */
  falseBreakSessions: { value: 5, provenance: 'proposed' as const },
  /** Episodes are thinned so anchors sit at least horizon + 1 sessions apart. */
  spacing: { value: 'horizon + 1', provenance: 'proposed' as const },
  /** Smoothing of the conditional rate toward the earlier all days rate: (hits + m x base) / (n + m). */
  pseudoCases: { value: 4, provenance: 'proposed' as const },
  minTrainingCases: { value: 10, provenance: 'proposed' as const },
  minScoredForecasts: { value: 24, provenance: 'proposed' as const },
  /** A descriptive conditional frequency needs at least this many matured episodes. */
  minCases: { value: 10, provenance: 'proposed' as const },
};

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

// ---------------------------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------------------------

export type SignalKind = 'confirmed-close' | 'intraday-failed';

export interface BreakoutSignal {
  index: number;
  date: ISODate;
  side: BreakSide;
  window: BreakWindowKey;
  basis: RangeBasis;
  kind: SignalKind;
  /** Extreme of the prior window, excluding the signal bar. */
  level: number;
  levelDate: ISODate;
  levelIndex: number;
  /** Sessions between the reference extreme and the signal. */
  levelAge: number;
  close: number;
  /** The bar's high (up) or low (down). */
  extreme: number;
  /** close / level - 1. */
  closeVsLevel: number;
  /** Volume divided by the mean of the prior 20 sessions. Null when volume is not verified. */
  relativeVolume: number | null;
  /** close / prior 1Y closing high - 1, capped at zero. Null when the 1Y window is not covered. */
  distanceBelowYearHigh: number | null;
  /** Close above the prior 1Y closing high (up) or below the prior 1Y closing low (down). */
  yearExtreme: boolean | null;
  /** Close above every earlier close in the series (up) or below every earlier close (down). */
  historyClosingExtreme: boolean;
}

export interface SignalOptions {
  /** Basis of the reference level: prior closes (default) or prior traded highs and lows. */
  basis?: RangeBasis;
  /** Only signals at or before this index. Default the last bar. */
  asOfIndex?: number;
}

interface LevelSeries {
  value: Series;
  index: (number | null)[];
}

const priorLevel = (bars: readonly Bar[], window: BreakWindowKey, side: BreakSide, basis: RangeBasis): LevelSeries => {
  const field = basis === 'close' ? 'close' : side === 'up' ? 'high' : 'low';
  const values = bars.map((b) => b[field]);
  const kind = side === 'up' ? 'max' : 'min';
  const spec = WINDOW_SPECS[window as WindowKey];
  if (spec.kind === 'sessions') return rollingExtreme(values, spec.n, kind, true);
  return windowExtremeSeries(values, windowBaseSeries(bars, window as WindowKey), kind, true);
};

const relVolSeries = (bars: readonly Bar[], n = 20): (number | null)[] => {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  let sum = 0;
  let nulls = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i >= n) {
      const v = bars[i]!.volume;
      if (v !== null && nulls === 0 && sum > 0) out[i] = v / (sum / n);
    }
    const add = bars[i]!.volume;
    if (add === null) nulls++;
    else sum += add;
    if (i >= n) {
      const drop = bars[i - n]!.volume;
      if (drop === null) nulls--;
      else sum -= drop;
    }
  }
  return out;
};

/** Every breakout (up) or breakdown (down) signal for one window, in date order. */
export const breakoutSignals = (bars: readonly Bar[], window: BreakWindowKey, side: BreakSide, opts: SignalOptions = {}): BreakoutSignal[] => {
  const basis = opts.basis ?? 'close';
  const last = Math.min(opts.asOfIndex ?? bars.length - 1, bars.length - 1);
  const level = priorLevel(bars, window, side, basis);
  const closes = bars.map((b) => b.close);
  const yearBase = windowBaseSeries(bars, '1Y');
  const yearLevel = windowExtremeSeries(closes, yearBase, side === 'up' ? 'max' : 'min', true).value;
  const yearHigh = side === 'up' ? yearLevel : windowExtremeSeries(closes, yearBase, 'max', true).value;
  const rv = relVolSeries(bars);
  const out: BreakoutSignal[] = [];
  let runExtreme = side === 'up' ? -Infinity : Infinity;
  for (let i = 0; i <= last; i++) {
    const b = bars[i]!;
    const lv = level.value[i];
    const li = level.index[i];
    const historyExtreme = i > 0 && (side === 'up' ? b.close > runExtreme : b.close < runExtreme);
    runExtreme = side === 'up' ? Math.max(runExtreme, b.close) : Math.min(runExtreme, b.close);
    if (lv === null || lv === undefined || li === null || li === undefined) continue;
    const confirmed = side === 'up' ? b.close > lv : b.close < lv;
    const traded = side === 'up' ? b.high > lv : b.low < lv;
    if (!confirmed && !traded) continue;
    const yl = yearLevel[i];
    const yh = yearHigh[i];
    out.push({
      index: i,
      date: b.date,
      side,
      window,
      basis,
      kind: confirmed ? 'confirmed-close' : 'intraday-failed',
      level: lv,
      levelDate: bars[li]!.date,
      levelIndex: li,
      levelAge: i - li,
      close: b.close,
      extreme: side === 'up' ? b.high : b.low,
      closeVsLevel: b.close / lv - 1,
      relativeVolume: rv[i] ?? null,
      distanceBelowYearHigh: yh === null || yh === undefined ? null : Math.min(0, b.close / yh - 1),
      yearExtreme: yl === null || yl === undefined ? null : side === 'up' ? b.close > yl : b.close < yl,
      historyClosingExtreme: historyExtreme,
    });
  }
  return out;
};

// ---------------------------------------------------------------------------------------------
// Episodes and lifecycle
// ---------------------------------------------------------------------------------------------

export type EpisodeStatus = 'unconfirmed' | 'active' | 'held' | 'failed' | 'false-breakout';

export interface EpisodeContext {
  distanceBelowYearHigh: number | null;
  relativeVolume: number | null;
  /** 1M width at most 45% of 3M width on the session before the first signal. */
  compressed: boolean | null;
  /** Market close above its own 200 session average on the confirm date. */
  marketAbove200: boolean | null;
}

export interface Lifecycle {
  /** Sessions examined after the confirm close. */
  followSessions: number;
  /** True when the full follow window has completed. */
  matured: boolean;
  /** First session that traded back to within the retest distance of the level. */
  retestIndex: number | null;
  retestDate: ISODate | null;
  /** The retest session closed beyond the level. Null without a retest. */
  retestHeld: boolean | null;
  /** First close after the retest beyond the best close before it. */
  reboundIndex: number | null;
  reboundDate: ISODate | null;
  /** First close back at or inside the level. */
  failureIndex: number | null;
  failureDate: ISODate | null;
  /** True for a failure inside the false break window. Null while that window is still open. */
  falseBreakout: boolean | null;
}

export interface BreakoutEpisode {
  id: string;
  side: BreakSide;
  window: BreakWindowKey;
  basis: RangeBasis;
  signals: BreakoutSignal[];
  /** First session of the episode that traded through or closed beyond its level. */
  firstAttemptIndex: number;
  firstAttemptDate: ISODate;
  /** Reference level of the first attempt: the old high or low the episode is measured against. */
  level: number;
  levelDate: ISODate;
  levelAge: number;
  /** Intraday failed attempts before the confirm close. */
  failedAttempts: number;
  /** Number of signal sessions in the episode. */
  attempts: number;
  /** First close beyond the level. Null when the episode never confirmed. */
  confirmIndex: number | null;
  confirmDate: ISODate | null;
  confirmClose: number | null;
  lifecycle: Lifecycle | null;
  status: EpisodeStatus;
  context: EpisodeContext;
}

export interface EpisodeOptions extends SignalOptions {
  /** A new episode needs more than this many sessions since the last signal. */
  episodeGapSessions?: number;
  /** Retest distance from the level, 0.0025 to 0.05. */
  retestPct?: number;
  followSessions?: number;
  falseBreakSessions?: number;
  /** Market series for the trend context. */
  market?: readonly Bar[];
}

const lifecycleOf = (
  bars: readonly Bar[],
  side: BreakSide,
  level: number,
  confirm: number,
  last: number,
  retestPct: number,
  follow: number,
  falseWindow: number,
): Lifecycle => {
  const end = Math.min(last, confirm + follow);
  const beyond = (c: number) => (side === 'up' ? c > level : c < level);
  let retest: number | null = null;
  let rebound: number | null = null;
  let failure: number | null = null;
  let best = bars[confirm]!.close;
  let bestAtRetest = best;
  for (let k = confirm + 1; k <= end; k++) {
    const b = bars[k]!;
    if (retest === null) {
      const touched = side === 'up' ? b.low <= level * (1 + retestPct) : b.high >= level * (1 - retestPct);
      if (touched) {
        retest = k;
        bestAtRetest = best;
      }
    } else if (rebound === null && (side === 'up' ? b.close > bestAtRetest : b.close < bestAtRetest)) rebound = k;
    if (failure === null && !beyond(b.close)) failure = k;
    best = side === 'up' ? Math.max(best, b.close) : Math.min(best, b.close);
  }
  const falseOpen = last < confirm + falseWindow;
  return {
    followSessions: end - confirm,
    matured: last >= confirm + follow,
    retestIndex: retest,
    retestDate: retest === null ? null : bars[retest]!.date,
    retestHeld: retest === null ? null : beyond(bars[retest]!.close),
    reboundIndex: rebound,
    reboundDate: rebound === null ? null : bars[rebound]!.date,
    failureIndex: failure,
    failureDate: failure === null ? null : bars[failure]!.date,
    falseBreakout: failure !== null && failure - confirm <= falseWindow ? true : falseOpen ? null : false,
  };
};

/** Cluster signals into episodes and attach the dated lifecycle facts known as of the last bar used. */
export const breakoutEpisodes = (bars: readonly Bar[], window: BreakWindowKey, side: BreakSide, opts: EpisodeOptions = {}): BreakoutEpisode[] => {
  const d = BREAKOUT_DEFAULTS;
  const last = Math.min(opts.asOfIndex ?? bars.length - 1, bars.length - 1);
  const gap = opts.episodeGapSessions ?? d.episodeGapSessions.value;
  const retestPct = clamp(opts.retestPct ?? d.retestPct.value, d.retestPct.min, d.retestPct.max);
  const follow = opts.followSessions ?? d.followSessions.value;
  const falseWindow = opts.falseBreakSessions ?? d.falseBreakSessions.value;
  const basis = opts.basis ?? 'close';
  const signals = breakoutSignals(bars, window, side, { basis, asOfIndex: last });
  const groups: BreakoutSignal[][] = [];
  for (const s of signals) {
    const g = groups[groups.length - 1];
    if (g && s.index - g[g.length - 1]!.index <= gap) g.push(s);
    else groups.push([s]);
  }
  // Market trend by date, from past only data.
  let marketAbove: Map<ISODate, boolean> | null = null;
  if (opts.market) {
    marketAbove = new Map();
    const ma = sma(opts.market.map((b) => b.close), 200);
    opts.market.forEach((b, k) => {
      const m = ma[k];
      if (m !== null && m !== undefined) marketAbove!.set(b.date, b.close > m);
    });
  }
  return groups.map((g) => {
    const first = g[0]!;
    const conf = g.find((s) => s.kind === 'confirmed-close') ?? null;
    const lc = conf ? lifecycleOf(bars, side, first.level, conf.index, last, retestPct, follow, falseWindow) : null;
    let status: EpisodeStatus = 'unconfirmed';
    if (conf && lc) {
      if (lc.falseBreakout === true) status = 'false-breakout';
      else if (lc.failureIndex !== null) status = 'failed';
      else status = lc.matured ? 'held' : 'active';
    }
    const ctxSignal = conf ?? first;
    const ratio = first.index >= 1 ? compressionRatioAt(bars, first.index - 1, basis) : na('insufficient-history');
    return {
      id: `${window}:${side}:${first.date}`,
      side,
      window,
      basis,
      signals: g,
      firstAttemptIndex: first.index,
      firstAttemptDate: first.date,
      level: first.level,
      levelDate: first.levelDate,
      levelAge: first.levelAge,
      failedAttempts: conf ? g.filter((s) => s.kind === 'intraday-failed' && s.index < conf.index).length : g.length,
      attempts: g.length,
      confirmIndex: conf ? conf.index : null,
      confirmDate: conf ? conf.date : null,
      confirmClose: conf ? conf.close : null,
      lifecycle: lc,
      status,
      context: {
        distanceBelowYearHigh: ctxSignal.distanceBelowYearHigh,
        relativeVolume: ctxSignal.relativeVolume,
        compressed: isNa(ratio) ? null : ratio <= STATE_THRESHOLDS.compressionRatio,
        marketAbove200: marketAbove ? marketAbove.get(ctxSignal.date) ?? null : null,
      },
    };
  });
};

// ---------------------------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------------------------

export interface EpisodeFilter {
  /** Keep episodes whose confirm close was at least this far below the prior 1Y closing high (0.15 = 15% or more below). */
  minBelowYearHigh?: number;
  /** Keep episodes no farther than this below the prior 1Y closing high. */
  maxBelowYearHigh?: number;
  minRelativeVolume?: number;
  compressed?: boolean;
  marketTrend?: 'above-200' | 'below-200';
  /** Keep only episodes that confirmed with a close. */
  confirmedOnly?: boolean;
  /** Keep only episodes whose follow window has matured. */
  maturedOnly?: boolean;
  /** Minimum age in sessions of the level that was broken. */
  minLevelAge?: number;
}

export interface FilterResult {
  kept: BreakoutEpisode[];
  /** Episodes removed by a filter. */
  removed: number;
  /** Removed because a field the filter needs is unavailable. Missing data never passes a filter. */
  removedForMissingData: number;
}

/** Apply filters. An episode missing a field that an active filter reads does not pass. */
export const filterEpisodes = (episodes: readonly BreakoutEpisode[], f: EpisodeFilter): FilterResult => {
  const kept: BreakoutEpisode[] = [];
  let removed = 0;
  let missing = 0;
  for (const e of episodes) {
    let ok = true;
    let miss = false;
    const c = e.context;
    if (f.minBelowYearHigh !== undefined || f.maxBelowYearHigh !== undefined) {
      if (c.distanceBelowYearHigh === null) miss = true;
      else {
        const below = -c.distanceBelowYearHigh;
        if (f.minBelowYearHigh !== undefined && below < f.minBelowYearHigh) ok = false;
        if (f.maxBelowYearHigh !== undefined && below > f.maxBelowYearHigh) ok = false;
      }
    }
    if (f.minRelativeVolume !== undefined) {
      if (c.relativeVolume === null) miss = true;
      else if (c.relativeVolume < f.minRelativeVolume) ok = false;
    }
    if (f.compressed !== undefined) {
      if (c.compressed === null) miss = true;
      else if (c.compressed !== f.compressed) ok = false;
    }
    if (f.marketTrend !== undefined) {
      if (c.marketAbove200 === null) miss = true;
      else if (c.marketAbove200 !== (f.marketTrend === 'above-200')) ok = false;
    }
    if (f.confirmedOnly && e.confirmIndex === null) ok = false;
    if (f.maturedOnly && !(e.lifecycle && e.lifecycle.matured)) ok = false;
    if (f.minLevelAge !== undefined && e.levelAge < f.minLevelAge) ok = false;
    if (miss) missing++;
    else if (!ok) removed++;
    else kept.push(e);
  }
  return { kept, removed, removedForMissingData: missing };
};

// ---------------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------------

export interface BreakoutCase {
  episodeId: string;
  anchorIndex: number;
  anchorDate: ISODate;
  anchorClose: number;
  level: number;
  endDate: ISODate;
  /** Endpoint price return C(anchor + h) / C(anchor) - 1. Not sign flipped. */
  ret: number;
  /** Endpoint close continued in the direction of the break (up: higher close, down: lower close). */
  continued: boolean;
  /** Target level: 2% beyond the old level in the direction of the break. */
  target: number;
  /** The confirm close was already at or beyond the target, so a later reach is not defined. */
  alreadyBeyondTarget: boolean;
  /** Sessions ahead of the first reach of the target, or null. */
  targetOffset: number | null;
  /** Largest move against the break inside the window, as a positive fraction of the anchor close. */
  adverseMove: number;
  /** Largest move with the break inside the window, as a positive fraction of the anchor close. */
  favorableMove: number;
  adverseHit: boolean;
  /** Endpoint close beyond the old level. */
  closeBeyondLevel: boolean;
  /** Some close inside the window finished back at or inside the old level. */
  closedBackInside: boolean;
  /** Lowest and highest later close relative to the anchor close. */
  minCloseRet: number;
  maxCloseRet: number;
}

export interface Validation {
  status: ModelStatus;
  /** Forecasts scored out of sample. */
  scored: number;
  brier: number | null;
  baselineBrier: number | null;
  firstHalf: { brier: number; baselineBrier: number } | null;
  secondHalf: { brier: number; baselineBrier: number } | null;
  reason: string;
}

export interface BreakoutHorizon {
  horizon: number;
  side: BreakSide;
  mode: TouchMode;
  /** Confirmed episodes before spacing. */
  episodes: number;
  /** Removed so that anchors sit at least horizon + 1 sessions apart. */
  droppedOverlap: number;
  /** Spaced episodes whose horizon has not completed. */
  notMatured: number;
  /** Matured, spaced episodes: the denominator of every rate below unless stated. */
  n: number;
  cases: BreakoutCase[];
  /** False when fewer matured episodes than the minimum exist. Counts stay visible with a small sample warning. */
  sampleSufficient: boolean;
  /** Endpoint close continued in the direction of the break. */
  continued: Proportion | null;
  /** Reached 2% beyond the old level, among cases not already beyond it at the confirm close. */
  reachedTarget: Proportion | null;
  alreadyBeyondTarget: number;
  /** Median sessions to the first reach, among cases that reached. */
  medianSessionsToTarget: number | null;
  /** Adverse excursion of at least the adverse threshold. */
  adverse: Proportion | null;
  adverseThreshold: number;
  closeBeyondLevel: Proportion | null;
  /** A close back at or inside the old level within the horizon. */
  closedBackInside: Proportion | null;
  returns: Distribution | null;
  adverseMoves: Distribution | null;
  favorableMoves: Distribution | null;
  lowestLaterClose: Distribution | null;
  highestLaterClose: Distribution | null;
  /** Same target on every eligible session: descriptive all days rate and a spaced interval. */
  baseline: { hits: number; n: number; rate: number | null; spaced: Proportion | null; from: ISODate | null; to: ISODate | null };
  /** continued rate minus the all days rate, in pp. Descriptive, not a validated edge. */
  differenceVsBaselinePp: number | null;
  validation: Validation;
  /** Smoothed conditional estimate for a new confirmed signal. Present only when validation passes. */
  probability: Maybe<number>;
}

export interface OutcomeOptions {
  horizons?: readonly number[];
  /** Intraday uses highs and lows for touches and excursions. Close uses closes only. */
  mode?: TouchMode;
  targetPct?: number;
  adversePct?: number;
  level?: number;
  asOfIndex?: number;
  pseudoCases?: number;
  minTrainingCases?: number;
  minScoredForecasts?: number;
  minCases?: number;
}

const prop = (hits: number, n: number, dates: readonly ISODate[], level: number): Proportion | null =>
  wilson(hits, n, level, yearClusterEffectiveN(dates));

/** Outcomes after confirmed episodes for each horizon, with a baseline and a gated conditional estimate. */
export const breakoutOutcomes = (bars: readonly Bar[], episodes: readonly BreakoutEpisode[], opts: OutcomeOptions = {}): BreakoutHorizon[] => {
  const d = BREAKOUT_DEFAULTS;
  const last = Math.min(opts.asOfIndex ?? bars.length - 1, bars.length - 1);
  const view = bars.slice(0, last + 1);
  const mode = opts.mode ?? 'intraday';
  const targetPct = opts.targetPct ?? d.targetPct.value;
  const adversePct = clamp(opts.adversePct ?? d.adversePct.value, d.adversePct.min, d.adversePct.max);
  const level = opts.level ?? 0.95;
  const m = opts.pseudoCases ?? d.pseudoCases.value;
  const minTrain = opts.minTrainingCases ?? d.minTrainingCases.value;
  const minScored = opts.minScoredForecasts ?? d.minScoredForecasts.value;
  const minCases = opts.minCases ?? d.minCases.value;
  const confirmed = episodes.filter((e) => e.confirmIndex !== null && e.confirmIndex <= last);
  const side: BreakSide = confirmed[0]?.side ?? episodes[0]?.side ?? 'up';
  const byAnchor = new Map(confirmed.map((e) => [e.confirmIndex!, e]));
  // The baseline covers every session of the history provided, from the first bar.
  const firstEligible = 0;

  return (opts.horizons ?? d.horizons.value).map((h) => {
    const { kept, dropped } = selectNonOverlapping([...byAnchor.keys()], h + 1);
    const cases: BreakoutCase[] = [];
    let notMatured = 0;
    for (const i of kept) {
      const e = byAnchor.get(i)!;
      const o = forwardOutcome(view, i, h);
      if (isNa(o)) {
        notMatured++;
        continue;
      }
      const target = side === 'up' ? e.level * (1 + targetPct) : e.level * (1 - targetPct);
      const already = side === 'up' ? o.anchorClose >= target : o.anchorClose <= target;
      const touch = already ? { offset: null } : firstTouch(view, i, h, target, side === 'up' ? 'above' : 'below', mode);
      const down = mode === 'intraday' ? o.minLowRet : o.minCloseRet;
      const up = mode === 'intraday' ? o.maxHighRet : o.maxCloseRet;
      const adverseMove = Math.max(0, side === 'up' ? -down : up);
      const favorableMove = Math.max(0, side === 'up' ? up : -down);
      let back = false;
      for (let k = i + 1; k <= i + h; k++) {
        const c = view[k]!.close;
        if (side === 'up' ? c <= e.level : c >= e.level) {
          back = true;
          break;
        }
      }
      const endClose = view[i + h]!.close;
      cases.push({
        episodeId: e.id,
        anchorIndex: i,
        anchorDate: o.anchorDate,
        anchorClose: o.anchorClose,
        level: e.level,
        endDate: o.endDate,
        ret: o.ret,
        continued: side === 'up' ? o.ret > 0 : o.ret < 0,
        target,
        alreadyBeyondTarget: already,
        targetOffset: touch.offset,
        adverseMove,
        favorableMove,
        adverseHit: adverseMove >= adversePct,
        closeBeyondLevel: side === 'up' ? endClose > e.level : endClose < e.level,
        closedBackInside: back,
        minCloseRet: o.minCloseRet,
        maxCloseRet: o.maxCloseRet,
      });
    }
    const n = cases.length;
    const dates = cases.map((c) => c.anchorDate);
    const count = (f: (c: BreakoutCase) => boolean) => cases.filter(f).length;
    const reachable = cases.filter((c) => !c.alreadyBeyondTarget);
    const reached = reachable.filter((c) => c.targetOffset !== null);

    // Baseline: the same endpoint target on every eligible session of the same history.
    const y: number[] = [];
    for (let t = 0; t + h <= last; t++) {
      const r = view[t + h]!.close / view[t]!.close - 1;
      y.push((side === 'up' ? r > 0 : r < 0) ? 1 : 0);
    }
    const prefix: number[] = [0];
    for (const v of y) prefix.push(prefix[prefix.length - 1]! + v);
    const baseHits = prefix[y.length]! - prefix[Math.min(firstEligible, y.length)]!;
    const baseN = Math.max(0, y.length - firstEligible);
    const spacedIdx: number[] = [];
    for (let t = firstEligible; t < y.length; t += h) spacedIdx.push(t);
    const spacedHits = spacedIdx.filter((t) => y[t] === 1).length;
    const baseRate = baseN > 0 ? baseHits / baseN : null;

    // Chronological out of sample check. Each forecast uses only cases and sessions whose
    // outcome matured before the forecast anchor.
    const pModel: number[] = [];
    const pBase: number[] = [];
    const yy: (0 | 1)[] = [];
    for (let k = 0; k < n; k++) {
      const a = cases[k]!.anchorIndex;
      const knownSessions = a - h; // sessions t with t + h < a, counted from 0
      if (knownSessions <= 0) continue;
      const base = prefix[knownSessions]! / knownSessions;
      let hits = 0;
      let seen = 0;
      for (let j = 0; j < k; j++) {
        if (cases[j]!.anchorIndex + h < a) {
          seen++;
          if (cases[j]!.continued) hits++;
        }
      }
      if (seen < minTrain) continue;
      pModel.push((hits + m * base) / (seen + m));
      pBase.push(base);
      yy.push(cases[k]!.continued ? 1 : 0);
    }
    const scored = pModel.length;
    const halves = (from: number, to: number) => ({ brier: brier(pModel.slice(from, to), yy.slice(from, to)), baselineBrier: brier(pBase.slice(from, to), yy.slice(from, to)) });
    let validation: Validation;
    if (scored < minScored) {
      validation = {
        status: 'insufficient-evidence',
        scored,
        brier: scored ? brier(pModel, yy) : null,
        baselineBrier: scored ? brier(pBase, yy) : null,
        firstHalf: null,
        secondHalf: null,
        reason: `${scored} out of sample forecasts. ${minScored} are required.`,
      };
    } else {
      const mid = Math.floor(scored / 2);
      const all = halves(0, scored);
      const h1 = halves(0, mid);
      const h2 = halves(mid, scored);
      const pass = all.brier < all.baselineBrier && h1.brier < h1.baselineBrier && h2.brier < h2.baselineBrier;
      validation = {
        status: pass ? 'valid' : 'not-reliable',
        scored,
        brier: all.brier,
        baselineBrier: all.baselineBrier,
        firstHalf: h1,
        secondHalf: h2,
        reason: pass
          ? 'The conditional estimate beat the earlier all days baseline overall and in both chronological halves.'
          : 'The conditional estimate did not beat the earlier all days baseline in every test. No validated edge.',
      };
    }
    const contHits = count((c) => c.continued);
    let probability: Maybe<number>;
    if (validation.status === 'valid' && baseRate !== null) probability = (contHits + m * baseRate) / (n + m);
    else if (validation.status === 'insufficient-evidence') probability = na('sample-too-small', validation.reason);
    else probability = na('gate-failed', validation.reason);

    return {
      horizon: h,
      side,
      mode,
      episodes: confirmed.length,
      droppedOverlap: dropped.length,
      notMatured,
      n,
      cases,
      sampleSufficient: n >= minCases,
      continued: prop(contHits, n, dates, level),
      reachedTarget: prop(reached.length, reachable.length, reachable.map((c) => c.anchorDate), level),
      alreadyBeyondTarget: n - reachable.length,
      medianSessionsToTarget: reached.length ? median(reached.map((c) => c.targetOffset!)) : null,
      adverse: prop(count((c) => c.adverseHit), n, dates, level),
      adverseThreshold: adversePct,
      closeBeyondLevel: prop(count((c) => c.closeBeyondLevel), n, dates, level),
      closedBackInside: prop(count((c) => c.closedBackInside), n, dates, level),
      returns: distribution(cases.map((c) => c.ret)),
      adverseMoves: distribution(cases.map((c) => c.adverseMove)),
      favorableMoves: distribution(cases.map((c) => c.favorableMove)),
      lowestLaterClose: distribution(cases.map((c) => c.minCloseRet)),
      highestLaterClose: distribution(cases.map((c) => c.maxCloseRet)),
      baseline: {
        hits: baseHits,
        n: baseN,
        rate: baseRate,
        spaced: wilson(spacedHits, spacedIdx.length, level),
        from: baseN > 0 ? view[firstEligible]!.date : null,
        to: baseN > 0 ? view[y.length - 1]!.date : null,
      },
      differenceVsBaselinePp: n > 0 && baseRate !== null ? contHits / n - baseRate : null,
      validation,
      probability,
    };
  });
};

export interface BreakoutStudy {
  window: BreakWindowKey;
  side: BreakSide;
  basis: RangeBasis;
  asOfDate: ISODate;
  signals: number;
  confirmedSignals: number;
  intradayFailedSignals: number;
  episodes: BreakoutEpisode[];
  confirmedEpisodes: number;
  /** Among confirmed episodes with a closed false break window. */
  falseBreakouts: Proportion | null;
  /** Sessions since the most recent signal, and the most recent episode. */
  sessionsSinceLastSignal: number | null;
  latest: BreakoutEpisode | null;
  filter: FilterResult | null;
  horizons: BreakoutHorizon[];
}

/** Full study for one window and side: signals, episodes, optional filters and outcomes. */
export const breakoutStudy = (
  bars: readonly Bar[],
  window: BreakWindowKey,
  side: BreakSide,
  opts: EpisodeOptions & OutcomeOptions & { filter?: EpisodeFilter } = {},
): Maybe<BreakoutStudy> => {
  const last = Math.min(opts.asOfIndex ?? bars.length - 1, bars.length - 1);
  if (last < 0) return na('no-coverage', 'No completed session');
  const episodes = breakoutEpisodes(bars, window, side, opts);
  const filter = opts.filter ? filterEpisodes(episodes, opts.filter) : null;
  const used = filter ? filter.kept : episodes;
  const signals = episodes.flatMap((e) => e.signals);
  const conf = episodes.filter((e) => e.confirmIndex !== null);
  const decided = conf.filter((e) => e.lifecycle && e.lifecycle.falseBreakout !== null);
  const lastSignal = signals[signals.length - 1];
  return {
    window,
    side,
    basis: opts.basis ?? 'close',
    asOfDate: bars[last]!.date,
    signals: signals.length,
    confirmedSignals: signals.filter((s) => s.kind === 'confirmed-close').length,
    intradayFailedSignals: signals.filter((s) => s.kind === 'intraday-failed').length,
    episodes,
    confirmedEpisodes: conf.length,
    falseBreakouts: wilson(decided.filter((e) => e.lifecycle!.falseBreakout === true).length, decided.length),
    sessionsSinceLastSignal: lastSignal ? last - lastSignal.index : null,
    latest: episodes[episodes.length - 1] ?? null,
    filter,
    horizons: breakoutOutcomes(bars, used, { ...opts, asOfIndex: last }),
  };
};

// ---------------------------------------------------------------------------------------------
// Market stress
// ---------------------------------------------------------------------------------------------

export interface StressEpisode {
  threshold: number;
  /** Benchmark closing peak before the decline. */
  peakDate: ISODate;
  /** First close at or beyond the threshold. */
  breachDate: ISODate;
  /** Deepest benchmark close of the episode as known at the as-of date. */
  troughDate: ISODate;
  /** Benchmark close back at or above the peak. Null while the episode is active. */
  recoveryDate: ISODate | null;
  active: boolean;
  benchmarkDrawdown: number;
  /**
   * A trough is a posterior label. It is confirmed only once `confirmSessions` later sessions
   * have completed without a lower close, and it is knowable from `troughConfirmDate`.
   */
  troughConfirmed: boolean;
  troughConfirmDate: ISODate | null;
  /** Stock price return from the benchmark peak date to the benchmark trough date. */
  stockReturn: number;
  /** stockReturn - benchmarkDrawdown, in pp. */
  excessPp: number;
  /** (1 + stockReturn) / (1 + benchmarkDrawdown). */
  relativeWealth: number;
  /** Deepest stock close versus its own running closing peak inside the span. */
  stockMaxDrawdown: number;
  /** The stock fell less than the benchmark over the span. */
  resilient: boolean;
  /** Stock and benchmark returns over the `confirmSessions` sessions after the trough. Posterior. */
  stockAfterTrough: number | null;
  benchmarkAfterTrough: number | null;
}

export interface MarketStress {
  benchmark: string;
  alignedSessions: number;
  commonFrom: ISODate;
  commonTo: ISODate;
  droppedRows: number;
  confirmSessions: number;
  byThreshold: { threshold: number; episodes: StressEpisode[]; resilient: Proportion | null; medianExcessPp: number | null }[];
}

/**
 * Benchmark closing drawdown episodes of each threshold with the stock's exactly aligned
 * behaviour during each. Episodes are measured on sessions both series share.
 */
export const marketStress = (
  stock: readonly Bar[],
  benchmark: { symbol: string; bars: readonly Bar[] },
  opts: { thresholds?: readonly number[]; confirmSessions?: number } = {},
): Maybe<MarketStress> => {
  const al = alignBars(stock, benchmark.bars);
  if (al.dates.length === 0) return na('no-coverage', `No session shared with ${benchmark.symbol}`);
  const s = al.ia.map((k) => stock[k]!.close);
  const b = al.ib.map((k) => benchmark.bars[k]!.close);
  const dates = al.dates;
  const n = dates.length;
  const confirm = opts.confirmSessions ?? 10;
  const byThreshold = (opts.thresholds ?? [0.02, 0.05, 0.1]).map((threshold) => {
    const episodes: StressEpisode[] = [];
    let peak = 0;
    let k = 1;
    while (k < n) {
      if (b[k]! >= b[peak]!) {
        peak = k;
        k++;
        continue;
      }
      if (b[k]! / b[peak]! - 1 > -threshold) {
        k++;
        continue;
      }
      const breach = k;
      let trough = k;
      let end = k;
      while (end < n && b[end]! < b[peak]!) {
        if (b[end]! < b[trough]!) trough = end;
        end++;
      }
      const recovered = end < n;
      let sPeak = s[peak]!;
      let sDd = 0;
      for (let j = peak; j <= trough; j++) {
        sPeak = Math.max(sPeak, s[j]!);
        sDd = Math.min(sDd, s[j]! / sPeak - 1);
      }
      const bDd = b[trough]! / b[peak]! - 1;
      const sRet = s[trough]! / s[peak]! - 1;
      const confirmed = trough + confirm < n;
      episodes.push({
        threshold,
        peakDate: dates[peak]!,
        breachDate: dates[breach]!,
        troughDate: dates[trough]!,
        recoveryDate: recovered ? dates[end]! : null,
        active: !recovered,
        benchmarkDrawdown: bDd,
        troughConfirmed: confirmed,
        troughConfirmDate: confirmed ? dates[trough + confirm]! : null,
        stockReturn: sRet,
        excessPp: sRet - bDd,
        relativeWealth: (1 + sRet) / (1 + bDd),
        stockMaxDrawdown: sDd,
        resilient: sRet > bDd,
        stockAfterTrough: confirmed ? s[trough + confirm]! / s[trough]! - 1 : null,
        benchmarkAfterTrough: confirmed ? b[trough + confirm]! / b[trough]! - 1 : null,
      });
      if (!recovered) break;
      peak = end;
      k = end + 1;
    }
    return {
      threshold,
      episodes,
      resilient: wilson(episodes.filter((e) => e.resilient).length, episodes.length),
      medianExcessPp: episodes.length ? median(episodes.map((e) => e.excessPp)) : null,
    };
  });
  return { benchmark: benchmark.symbol, alignedSessions: n, commonFrom: dates[0]!, commonTo: dates[n - 1]!, droppedRows: al.dropped, confirmSessions: confirm, byThreshold };
};
