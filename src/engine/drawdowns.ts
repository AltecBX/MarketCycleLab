/**
 * Closing drawdowns, drawdown episodes and the current selloff study.
 *
 * Definitions
 * - Running closing peak P: the highest completed close so far. The peak DATE is the most recent
 *   session whose close was at the running peak, so "age since peak" counts from the last close
 *   at the high.
 * - Closing drawdown: C / P - 1. Exactly zero at each new or equal peak.
 * - Required gain to regain the peak: P / C - 1.
 * - Episode for a threshold d: starts at the prior running closing peak, is breached on the first
 *   close with drawdown <= -d, has its trough at the deepest close (earliest on ties) and recovers
 *   on the first close at or above the peak close. Later closes beyond the threshold inside the
 *   same excursion are NOT new episodes. An episode without a recovery is active and right-censored.
 * - Everything here is close based. Intraday extremes appear only in `rangeFacts`, labeled traded.
 * - Peaks are computed from the first bar passed in. An episode whose peak is the first bar is
 *   tagged `peakAtHistoryStart` because the true peak may predate the available history.
 */
import { sessionOnOrAfter, sessionOnOrBefore, yearOf, ymd } from './core/calendar';
import { selectNonOverlapping, summarizeHorizon, type HorizonSummary } from './core/outcomes';
import { alignBars } from './core/series';
import { distribution, kaplanMeier, kmMedian, mean, median, quantile, wilson, yearClusterEffectiveN } from './core/stats';
import { isNa, na, type Bar, type Distribution, type ISODate, type Maybe, type Proportion } from './core/types';

/** Guard for threshold and recovery comparisons so an exact 10% decline counts as a 10% breach. */
const EPS = 1e-9;

/** Values stated in the owner specification. */
export const DRAWDOWN_SPEC = {
  provenance: 'spec',
  /** Forward horizons, in completed sessions, for matching episodes. */
  horizons: [5, 10, 20, 60],
  /** "Further decline" level measured from the anchor close. */
  furtherDecline: 0.05,
  /** Fixed episode threshold shown by default. */
  defaultThreshold: 0.1,
  /** Rolling window for the traded and closing 52 week range. */
  rangeWindow: 252,
} as const;

/** Values the specification leaves to the reference source, which was not available. */
export const DRAWDOWN_DEFAULTS = {
  provenance: 'proposed',
  /** Minimum matured, non-overlapping analog cases before an inferential frequency is shown. */
  minMaturedCases: 10,
  /** Analog anchors must be at least horizon + this many sessions apart. Mirrors the decline studies. */
  overlapGapExtra: 1,
  /** Wilson confidence level. */
  level: 0.95,
  /** Sessions after the anchor kept in each normalized analog path. */
  maxPathSessions: 120,
  /** Thresholds offered by the per-year incidence table. */
  thresholds: [0.05, 0.1, 0.15, 0.2, 0.3],
} as const;

export interface DrawdownPoint {
  index: number;
  date: ISODate;
  close: number;
  peakIndex: number;
  peakDate: ISODate;
  peakClose: number;
  /** C / P - 1. Zero or negative. */
  drawdown: number;
  /** P / C - 1. Zero or positive. */
  requiredGain: number;
}

/** Closing drawdown from the running closing peak for every bar. */
export const drawdownSeries = (bars: readonly Bar[]): DrawdownPoint[] => {
  const out: DrawdownPoint[] = [];
  let pi = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.close >= bars[pi]!.close) pi = i;
    const p = bars[pi]!;
    out.push({
      index: i,
      date: b.date,
      close: b.close,
      peakIndex: pi,
      peakDate: p.date,
      peakClose: p.close,
      drawdown: pi === i ? 0 : b.close / p.close - 1,
      requiredGain: pi === i ? 0 : p.close / b.close - 1,
    });
  }
  return out;
};

/** Drawdown at the last bar, or a reason when the series is empty. */
export const currentDrawdown = (bars: readonly Bar[]): Maybe<DrawdownPoint> => {
  const s = drawdownSeries(bars);
  return s[s.length - 1] ?? na('no-coverage', 'No completed sessions');
};

export interface DrawdownEpisode {
  threshold: number;
  peakIndex: number;
  peakDate: ISODate;
  peakClose: number;
  breachIndex: number;
  breachDate: ISODate;
  breachClose: number;
  /** Drawdown on the breach close. */
  breachDrawdown: number;
  troughIndex: number;
  troughDate: ISODate;
  troughClose: number;
  /** Deepest closing drawdown of the episode, troughClose / peakClose - 1. For an active episode, deepest so far. */
  depth: number;
  recoveryIndex: number | null;
  recoveryDate: ISODate | null;
  /** True when no close has returned to the peak yet. Right-censored. */
  active: boolean;
  sessionsPeakToBreach: number;
  sessionsPeakToTrough: number;
  /** Null while active. */
  sessionsTroughToRecovery: number | null;
  /** Null while active. */
  sessionsPeakToRecovery: number | null;
  /** Sessions from the peak to the recovery, or to the last bar when active. */
  sessionsObserved: number;
  /** Peak year differs from the recovery year, or from the last observed year when active. */
  crossesYear: boolean;
  /** Peak predates the display window while the episode was still open inside it. */
  startedBeforeWindow: boolean;
  /** Peak is the first bar of the history, so the true peak may be earlier and higher. */
  peakAtHistoryStart: boolean;
}

export interface EpisodeOptions {
  /** Only episodes still open on or after this date are returned, tagged when the peak is earlier. */
  windowStart?: ISODate;
}

/**
 * Drawdown episodes for a threshold given as a positive fraction (0.10 for 10%).
 * Peaks always use the full series passed in, so earlier bars act as legitimate warm-up.
 */
export const findDrawdownEpisodes = (bars: readonly Bar[], threshold: number, opts: EpisodeOptions = {}): DrawdownEpisode[] => {
  const out: DrawdownEpisode[] = [];
  if (!(threshold > 0) || bars.length === 0) return out;
  const last = bars.length - 1;
  const lastDate = bars[last]!.date;
  let pi = 0;
  let breach = -1;
  let trough = -1;

  const finalize = (recovery: number | null) => {
    const p = bars[pi]!;
    const br = bars[breach]!;
    const tr = bars[trough]!;
    const endIdx = recovery ?? last;
    const endDate = bars[endIdx]!.date;
    const stillOpenInWindow = opts.windowStart === undefined || endDate >= opts.windowStart;
    if (!stillOpenInWindow) return;
    out.push({
      threshold,
      peakIndex: pi,
      peakDate: p.date,
      peakClose: p.close,
      breachIndex: breach,
      breachDate: br.date,
      breachClose: br.close,
      breachDrawdown: br.close / p.close - 1,
      troughIndex: trough,
      troughDate: tr.date,
      troughClose: tr.close,
      depth: tr.close / p.close - 1,
      recoveryIndex: recovery,
      recoveryDate: recovery === null ? null : bars[recovery]!.date,
      active: recovery === null,
      sessionsPeakToBreach: breach - pi,
      sessionsPeakToTrough: trough - pi,
      sessionsTroughToRecovery: recovery === null ? null : recovery - trough,
      sessionsPeakToRecovery: recovery === null ? null : recovery - pi,
      sessionsObserved: endIdx - pi,
      crossesYear: yearOf(p.date) !== yearOf(recovery === null ? lastDate : endDate),
      startedBeforeWindow: opts.windowStart !== undefined && p.date < opts.windowStart,
      peakAtHistoryStart: pi === 0,
    });
  };

  for (let i = 0; i < bars.length; i++) {
    const c = bars[i]!.close;
    const peak = bars[pi]!.close;
    if (breach < 0) {
      if (c >= peak) {
        pi = i;
        continue;
      }
      if (c / peak - 1 <= -threshold + EPS) {
        breach = i;
        trough = i;
      }
    } else if (c >= peak * (1 - EPS)) {
      finalize(i);
      breach = -1;
      trough = -1;
      pi = i;
    } else if (c < bars[trough]!.close) {
      trough = i;
    }
  }
  if (breach >= 0) finalize(null);
  return out;
};

export interface EpisodeAges {
  asOf: ISODate;
  sessionsSincePeak: number;
  sessionsSinceBreach: number;
  sessionsSinceTrough: number;
  /** Null while the episode is active. */
  sessionsSinceRecovery: number | null;
}

/** Separate ages of one episode measured at the last bar of the series. */
export const episodeAges = (bars: readonly Bar[], e: DrawdownEpisode): Maybe<EpisodeAges> => {
  const last = bars.length - 1;
  if (last < 0 || e.peakIndex > last) return na('invalid-input', 'Episode is outside the series');
  return {
    asOf: bars[last]!.date,
    sessionsSincePeak: last - e.peakIndex,
    sessionsSinceBreach: last - e.breachIndex,
    sessionsSinceTrough: last - e.troughIndex,
    sessionsSinceRecovery: e.recoveryIndex === null ? null : last - e.recoveryIndex,
  };
};

/** Deepest episodes first. Ties keep the earlier episode first. */
export const deepestEpisodes = (episodes: readonly DrawdownEpisode[], count = 10): DrawdownEpisode[] =>
  [...episodes].sort((a, b) => a.depth - b.depth || a.peakIndex - b.peakIndex).slice(0, count);

export interface YearIncidenceRow {
  year: number;
  /** Episodes whose first threshold breach fell in this year. */
  count: number;
  /** True when the series covers the first through the last exchange session of the year. */
  complete: boolean;
  /** Why the year is not complete. */
  partialReason: 'current-year' | 'history-starts-inside-year' | null;
}

export interface YearIncidence {
  threshold: number;
  rows: YearIncidenceRow[];
  /** Typical count over completed calendar years only. */
  typical: Maybe<{ median: number; mean: number; years: number }>;
  /** The latest year when it is incomplete, shown against the typical count with a caveat. */
  current: { year: number; count: number; asOf: ISODate; versusMedian: Maybe<number> } | null;
  /** Count of episodes whose peak is the first bar of the history. */
  truncatedPeaks: number;
}

/** Episode counts per calendar year, by breach date, with the historical typical count. */
export const episodeYearIncidence = (bars: readonly Bar[], threshold: number): YearIncidence => {
  const episodes = findDrawdownEpisodes(bars, threshold);
  const rows: YearIncidenceRow[] = [];
  let current: YearIncidence['current'] = null;
  if (bars.length > 0) {
    const first = bars[0]!.date;
    const lastDate = bars[bars.length - 1]!.date;
    const counts = new Map<number, number>();
    for (const e of episodes) counts.set(yearOf(e.breachDate), (counts.get(yearOf(e.breachDate)) ?? 0) + 1);
    for (let y = yearOf(first); y <= yearOf(lastDate); y++) {
      const startsOk = first <= sessionOnOrAfter(ymd(y, 1, 1));
      const endsOk = lastDate >= sessionOnOrBefore(ymd(y, 12, 31));
      rows.push({
        year: y,
        count: counts.get(y) ?? 0,
        complete: startsOk && endsOk,
        partialReason: !endsOk ? 'current-year' : !startsOk ? 'history-starts-inside-year' : null,
      });
    }
    const lastRow = rows[rows.length - 1];
    if (lastRow && !lastRow.complete && lastRow.partialReason === 'current-year') {
      current = { year: lastRow.year, count: lastRow.count, asOf: lastDate, versusMedian: na('sample-too-small', 'No completed calendar year') };
    }
  }
  const completeCounts = rows.filter((r) => r.complete).map((r) => r.count);
  const typical: YearIncidence['typical'] =
    completeCounts.length > 0
      ? { median: median(completeCounts), mean: mean(completeCounts), years: completeCounts.length }
      : na('sample-too-small', 'No completed calendar year in the history');
  if (current && !isNa(typical)) current.versusMedian = current.count - typical.median;
  return { threshold, rows, typical, current, truncatedPeaks: episodes.filter((e) => e.peakAtHistoryStart).length };
};

/** Per-year incidence for several thresholds at once. */
export const episodeIncidenceByThreshold = (
  bars: readonly Bar[],
  thresholds: readonly number[] = DRAWDOWN_DEFAULTS.thresholds,
): YearIncidence[] => thresholds.map((t) => episodeYearIncidence(bars, t));

export interface DurationStats {
  n: number;
  median: number;
  p25: number;
  p75: number;
  mean: number;
  max: number;
}

const durationStats = (xs: readonly number[], what: string): Maybe<DurationStats> => {
  if (xs.length === 0) return na('sample-too-small', `No completed episode to measure ${what}`);
  return { n: xs.length, median: median(xs), p25: quantile(xs, 0.25), p75: quantile(xs, 0.75), mean: mean(xs), max: Math.max(...xs) };
};

export interface EpisodeDurationSummary {
  completed: number;
  /** Active episodes. Excluded from the three completed-episode statistics and censored in the survival median. */
  active: number;
  /** Sessions from peak to trough, completed episodes only, because an active trough is not final. */
  toTrough: Maybe<DurationStats>;
  /** Sessions from peak to recovery, completed episodes only. */
  toRecovery: Maybe<DurationStats>;
  /** Sessions from trough to recovery, completed episodes only. */
  troughToRecovery: Maybe<DurationStats>;
  /**
   * Kaplan Meier median sessions from peak to recovery with active episodes right-censored.
   * Unavailable when censoring keeps the survival curve above one half.
   */
  recoverySurvivalMedian: Maybe<number>;
  note: string;
}

/** Median, IQR and survival median of episode durations. Says exactly what is excluded. */
export const episodeDurationSummary = (episodes: readonly DrawdownEpisode[]): EpisodeDurationSummary => {
  const done = episodes.filter((e) => !e.active);
  const active = episodes.length - done.length;
  const steps = kaplanMeier(episodes.map((e) => ({ duration: e.sessionsObserved, ended: !e.active })));
  const km = episodes.length === 0 ? null : kmMedian(steps);
  return {
    completed: done.length,
    active,
    toTrough: durationStats(done.map((e) => e.sessionsPeakToTrough), 'time to trough'),
    toRecovery: durationStats(done.map((e) => e.sessionsPeakToRecovery!), 'time to recovery'),
    troughToRecovery: durationStats(done.map((e) => e.sessionsTroughToRecovery!), 'time from trough to recovery'),
    recoverySurvivalMedian: km === null ? na('sample-too-small', 'Survival median is not identified with the available episodes') : km,
    note:
      active > 0
        ? `${done.length} completed, ${active} active. Completed statistics exclude the active episode. The survival median treats it as right-censored.`
        : `${done.length} completed episodes.`,
  };
};

/** A frequency that is shown only when its sample gate passes. Hits and n are always visible. */
export interface GatedFrequency {
  hits: number;
  n: number;
  minCases: number;
  value: Maybe<Proportion>;
}

const gatedFrequency = (hits: number, dates: readonly ISODate[], minCases: number, level: number): GatedFrequency => {
  const n = dates.length;
  if (n < minCases) return { hits, n, minCases, value: na('sample-too-small', `${n} matured cases, needs ${minCases}`) };
  return { hits, n, minCases, value: wilson(hits, n, level, yearClusterEffectiveN(dates)) ?? na('sample-too-small', 'No matured cases') };
};

export interface PathPoint {
  /** Sessions relative to the anchor. Negative before it. */
  offset: number;
  date: ISODate;
  /** Close divided by the episode peak close. 1 at the peak. */
  value: number;
}

export interface SelloffAnalog {
  episode: DrawdownEpisode;
  /** First session of the episode whose closing drawdown reached the current depth. */
  anchorIndex: number;
  anchorDate: ISODate;
  anchorClose: number;
  drawdownAtAnchor: number;
  /** Trough close relative to the anchor close. Ex post description of what followed. */
  additionalDecline: number;
  sessionsAnchorToTrough: number;
  sessionsAnchorToRecovery: number | null;
  path: PathPoint[];
}

export interface SelloffHorizonResult {
  horizon: number;
  /** Historical episodes that reached the current depth. */
  candidates: number;
  /** Anchors dropped because their forward window overlaps an earlier kept anchor. */
  overlapExcluded: number;
  /** Kept anchors whose horizon has not completed. */
  notMatured: number;
  summary: HorizonSummary;
  /** Lowest close inside the horizon at or below the anchor close less the further-decline level. */
  furtherDeclineClose: GatedFrequency;
  /** Same test on intraday lows. */
  furtherDeclineIntraday: GatedFrequency;
  /** Distribution of the worst close inside the horizon relative to the anchor close. Gated. */
  additionalAdverse: Maybe<Distribution>;
  /** Share of matured cases with a higher endpoint close. Gated. */
  higherClose: GatedFrequency;
}

export interface CurrentSelloffStudy {
  asOf: ISODate;
  current: DrawdownPoint;
  /** The active excursion matched at the current depth. */
  active: DrawdownEpisode;
  ages: EpisodeAges;
  /** First session of the active excursion at the current depth. Equal to asOf on a new low. */
  activeAnchorDate: ISODate;
  sessionsSinceActiveAnchor: number;
  furtherDeclineLevel: number;
  minMaturedCases: number;
  analogs: SelloffAnalog[];
  horizons: SelloffHorizonResult[];
  activePath: PathPoint[];
  definition: string;
}

export interface SelloffStudyOptions {
  horizons?: readonly number[];
  furtherDecline?: number;
  minMaturedCases?: number;
  overlapGapExtra?: number;
  level?: number;
  maxPathSessions?: number;
}

const episodePath = (bars: readonly Bar[], e: DrawdownEpisode, anchor: number, maxAfter: number): PathPoint[] => {
  const end = Math.min(e.recoveryIndex ?? bars.length - 1, anchor + maxAfter);
  const out: PathPoint[] = [];
  for (let i = e.peakIndex; i <= end; i++) out.push({ offset: i - anchor, date: bars[i]!.date, value: bars[i]!.close / e.peakClose });
  return out;
};

/**
 * What followed earlier selloffs of the same stock at the point each first reached today's depth.
 *
 * Each historical excursion is matched once, at the first close whose drawdown from that
 * excursion's own peak was at least as deep as the current drawdown. The anchor uses only data
 * through that close. The active excursion is the query and is never its own analog.
 */
export const currentSelloffStudy = (bars: readonly Bar[], opts: SelloffStudyOptions = {}): Maybe<CurrentSelloffStudy> => {
  const cur = currentDrawdown(bars);
  if (isNa(cur)) return cur;
  if (cur.drawdown > -EPS) return na('not-applicable', `Close on ${cur.date} is at the closing high of the available history`);
  const horizons = opts.horizons ?? DRAWDOWN_SPEC.horizons;
  const further = opts.furtherDecline ?? DRAWDOWN_SPEC.furtherDecline;
  const minCases = opts.minMaturedCases ?? DRAWDOWN_DEFAULTS.minMaturedCases;
  const gapExtra = opts.overlapGapExtra ?? DRAWDOWN_DEFAULTS.overlapGapExtra;
  const level = opts.level ?? DRAWDOWN_DEFAULTS.level;
  const maxPath = opts.maxPathSessions ?? DRAWDOWN_DEFAULTS.maxPathSessions;

  const episodes = findDrawdownEpisodes(bars, -cur.drawdown);
  const active = episodes[episodes.length - 1];
  if (!active || !active.active) return na('invalid-input', 'Active excursion could not be identified');
  const ages = episodeAges(bars, active);
  if (isNa(ages)) return ages;
  const past = episodes.slice(0, -1);

  const analogs: SelloffAnalog[] = past.map((e) => ({
    episode: e,
    anchorIndex: e.breachIndex,
    anchorDate: e.breachDate,
    anchorClose: e.breachClose,
    drawdownAtAnchor: e.breachDrawdown,
    additionalDecline: e.troughClose / e.breachClose - 1,
    sessionsAnchorToTrough: e.troughIndex - e.breachIndex,
    sessionsAnchorToRecovery: e.recoveryIndex === null ? null : e.recoveryIndex - e.breachIndex,
    path: episodePath(bars, e, e.breachIndex, maxPath),
  }));

  const anchors = past.map((e) => e.breachIndex);
  const results: SelloffHorizonResult[] = horizons.map((h) => {
    const { kept, dropped } = selectNonOverlapping(anchors, h + gapExtra);
    const summary = summarizeHorizon(bars, kept, h, level);
    const dates = summary.anchorDates;
    const closeHits = summary.outcomes.filter((o) => o.minCloseRet <= -further + EPS).length;
    const lowHits = summary.outcomes.filter((o) => o.minLowRet <= -further + EPS).length;
    return {
      horizon: h,
      candidates: anchors.length,
      overlapExcluded: dropped.length,
      notMatured: summary.notMatured,
      summary,
      furtherDeclineClose: gatedFrequency(closeHits, dates, minCases, level),
      furtherDeclineIntraday: gatedFrequency(lowHits, dates, minCases, level),
      additionalAdverse:
        summary.n >= minCases
          ? distribution(summary.outcomes.map((o) => o.minCloseRet)) ?? na('sample-too-small', 'No matured cases')
          : na('sample-too-small', `${summary.n} matured cases, needs ${minCases}`),
      higherClose: gatedFrequency(summary.up, dates, minCases, level),
    };
  });

  return {
    asOf: cur.date,
    current: cur,
    active,
    ages,
    activeAnchorDate: active.breachDate,
    sessionsSinceActiveAnchor: bars.length - 1 - active.breachIndex,
    furtherDeclineLevel: further,
    minMaturedCases: minCases,
    analogs,
    horizons: results,
    activePath: episodePath(bars, active, active.breachIndex, Infinity),
    definition:
      'Each earlier selloff is matched once, on the first close whose drawdown from its own closing peak was at least as deep as the current one. ' +
      'Outcomes count completed sessions after that close. Paths show close divided by the peak close.',
  };
};

export interface DatedLevel {
  value: number;
  date: ISODate;
  index: number;
}

export interface RangeFacts {
  asOf: ISODate;
  close: number;
  /** Sessions in the rolling window, including the as-of session. */
  window: number;
  /** Highest and lowest intraday trade in the rolling window. Unavailable without a full window. */
  tradedHigh: Maybe<DatedLevel>;
  tradedLow: Maybe<DatedLevel>;
  /** Highest and lowest close in the rolling window. */
  closingHigh: Maybe<DatedLevel>;
  closingLow: Maybe<DatedLevel>;
  /** C / rolling traded high - 1. */
  fromTradedHigh: Maybe<number>;
  /** Rolling traded high / C - 1. */
  gainToTradedHigh: Maybe<number>;
  /** C / rolling closing high - 1. */
  fromClosingHigh: Maybe<number>;
  /** Highest close in the history passed in. Not a verified all time high. */
  historyClosingHigh: DatedLevel;
  fromHistoryClosingHigh: number;
  gainToHistoryClosingHigh: number;
  historyFirst: ISODate;
  historyLabel: string;
  year: number;
  /** Highest and lowest close and trade of the as-of calendar year through the as-of date. */
  yearClosingHigh: DatedLevel;
  yearClosingLow: DatedLevel;
  yearTradedHigh: DatedLevel;
  yearTradedLow: DatedLevel;
  /** True when the series starts inside the as-of year, so the year extremes cover a partial year. */
  yearStartsInsideHistory: boolean;
}

const extreme = (bars: readonly Bar[], from: number, to: number, pick: (b: Bar) => number, kind: 'max' | 'min'): DatedLevel => {
  let idx = from;
  for (let i = from + 1; i <= to; i++) {
    const v = pick(bars[i]!);
    const best = pick(bars[idx]!);
    // Strict comparison keeps the earliest session on ties.
    if (kind === 'max' ? v > best : v < best) idx = i;
  }
  return { value: pick(bars[idx]!), date: bars[idx]!.date, index: idx };
};

/**
 * Range facts at bar i (default: last bar). Separates the rolling traded range, the rolling closing
 * range, the closing high within the available history and the calendar-year extremes.
 */
export const rangeFacts = (bars: readonly Bar[], i = bars.length - 1, window: number = DRAWDOWN_SPEC.rangeWindow): Maybe<RangeFacts> => {
  const b = bars[i];
  if (!b) return na('no-coverage', 'No completed sessions');
  const full = i + 1 >= window;
  const from = i - window + 1;
  const short = na('insufficient-history', `Needs ${window} sessions, history has ${i + 1}`);
  const tradedHigh = full ? extreme(bars, from, i, (x) => x.high, 'max') : short;
  const tradedLow = full ? extreme(bars, from, i, (x) => x.low, 'min') : short;
  const closingHigh = full ? extreme(bars, from, i, (x) => x.close, 'max') : short;
  const closingLow = full ? extreme(bars, from, i, (x) => x.close, 'min') : short;
  const hist = extreme(bars, 0, i, (x) => x.close, 'max');
  const y = yearOf(b.date);
  let ys = i;
  while (ys > 0 && yearOf(bars[ys - 1]!.date) === y) ys--;
  return {
    asOf: b.date,
    close: b.close,
    window,
    tradedHigh,
    tradedLow,
    closingHigh,
    closingLow,
    fromTradedHigh: isNa(tradedHigh) ? tradedHigh : b.close / tradedHigh.value - 1,
    gainToTradedHigh: isNa(tradedHigh) ? tradedHigh : tradedHigh.value / b.close - 1,
    fromClosingHigh: isNa(closingHigh) ? closingHigh : b.close / closingHigh.value - 1,
    historyClosingHigh: hist,
    fromHistoryClosingHigh: b.close / hist.value - 1,
    gainToHistoryClosingHigh: hist.value / b.close - 1,
    historyFirst: bars[0]!.date,
    historyLabel: `Closing high within available history since ${bars[0]!.date}. Not a verified all time high.`,
    year: y,
    yearClosingHigh: extreme(bars, ys, i, (x) => x.close, 'max'),
    yearClosingLow: extreme(bars, ys, i, (x) => x.close, 'min'),
    yearTradedHigh: extreme(bars, ys, i, (x) => x.high, 'max'),
    yearTradedLow: extreme(bars, ys, i, (x) => x.low, 'min'),
    yearStartsInsideHistory: ys === 0 && bars[0]!.date > sessionOnOrAfter(ymd(y, 1, 1)),
  };
};

export interface DrawdownComparison {
  dates: ISODate[];
  /** Closing drawdowns of each series, with peaks measured inside the common date range only. */
  a: number[];
  b: number[];
  from: ISODate;
  to: ISODate;
  /** Sessions inside the overlap that only one series has. They are left out of both paths. */
  dropped: number;
  currentA: number;
  currentB: number;
  /** currentA - currentB as a fraction, labeled pp by the view. */
  differencePp: number;
}

/** Closing drawdown paths of two series on their common sessions. */
export const compareDrawdowns = (a: readonly Bar[], b: readonly Bar[]): Maybe<DrawdownComparison> => {
  const al = alignBars(a, b);
  if (al.dates.length === 0) return na('no-coverage', 'The two series share no session');
  const dd = (bars: readonly Bar[], idx: readonly number[]): number[] => {
    let peak = -Infinity;
    return idx.map((i) => {
      const c = bars[i]!.close;
      if (c >= peak) {
        peak = c;
        return 0;
      }
      return c / peak - 1;
    });
  };
  const da = dd(a, al.ia);
  const db = dd(b, al.ib);
  const ca = da[da.length - 1]!;
  const cb = db[db.length - 1]!;
  return { dates: al.dates, a: da, b: db, from: al.dates[0]!, to: al.dates[al.dates.length - 1]!, dropped: al.dropped, currentA: ca, currentB: cb, differencePp: ca - cb };
};

export interface BenchmarkDrawdownRow {
  symbol: string;
  /** Drawdown facts on the common as-of date, or why the row cannot be compared. */
  point: Maybe<DrawdownPoint>;
  sessionsSincePeak: number | null;
  historyFirst: ISODate | null;
}

/**
 * Current closing drawdown of several instruments (sector funds, benchmarks, peers) on one common
 * date. The common date is the latest session every non-empty series can be cut to. A series that
 * lacks that session is reported as missing rather than compared on a different date.
 */
export const benchmarkDrawdownTable = (
  series: readonly { symbol: string; bars: readonly Bar[] }[],
  asOf?: ISODate,
): { asOf: ISODate | null; rows: BenchmarkDrawdownRow[] } => {
  const lasts = series.filter((s) => s.bars.length > 0).map((s) => s.bars[s.bars.length - 1]!.date);
  const common = asOf ?? (lasts.length ? lasts.reduce((m, d) => (d < m ? d : m)) : null);
  const rows = series.map((s): BenchmarkDrawdownRow => {
    if (s.bars.length === 0 || common === null) return { symbol: s.symbol, point: na('no-coverage', 'No completed sessions'), sessionsSincePeak: null, historyFirst: null };
    const cut = s.bars.filter((b) => b.date <= common);
    const lastBar = cut[cut.length - 1];
    if (!lastBar || lastBar.date !== common) {
      return { symbol: s.symbol, point: na('missing-session', `No close on ${common}`), sessionsSincePeak: null, historyFirst: s.bars[0]!.date };
    }
    const dd = drawdownSeries(cut);
    const p = dd[dd.length - 1]!;
    return { symbol: s.symbol, point: p, sessionsSincePeak: p.index - p.peakIndex, historyFirst: s.bars[0]!.date };
  });
  return { asOf: common, rows };
};
