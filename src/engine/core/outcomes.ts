/**
 * Shared forward-outcome library. Every study that asks "what happened after this anchor" uses
 * these functions so endpoint returns, excursions, touches and maturity mean the same thing.
 *
 * Rules:
 * - The anchor is a completed session i. Outcomes use sessions i+1 .. i+h only.
 * - An outcome is matured only when session i+h exists. Unmatured anchors are excluded from
 *   denominators and counted separately.
 * - An endpoint return is not a touch. Touches declare close-only or intraday.
 * - Intraday highs and lows inside one daily bar have no known order.
 */
import { distribution, wilson, yearClusterEffectiveN } from './stats';
import { na, type Bar, type Distribution, type ISODate, type Maybe, type Proportion } from './types';

export interface ForwardOutcome {
  anchorIndex: number;
  anchorDate: ISODate;
  anchorClose: number;
  horizon: number;
  endDate: ISODate;
  /** Endpoint close-to-close return C(i+h)/C(i) - 1. */
  ret: number;
  /** Highest and lowest close inside the window, relative to the anchor close. */
  maxCloseRet: number;
  minCloseRet: number;
  /** Sessions ahead (1..h) of the lowest and highest close. Earliest on ties. */
  minCloseOffset: number;
  maxCloseOffset: number;
  /** Intraday extremes inside the window relative to the anchor close. */
  maxHighRet: number;
  minLowRet: number;
  minLowOffset: number;
  maxHighOffset: number;
}

/** Forward outcome for anchor i over h sessions, or a not-matured reason. */
export const forwardOutcome = (bars: readonly Bar[], i: number, h: number): Maybe<ForwardOutcome> => {
  const a = bars[i];
  if (!a || h < 1) return na('invalid-input', 'anchor or horizon outside series');
  if (i + h >= bars.length) return na('not-matured', `Needs ${h} completed sessions after ${a.date}`);
  let maxC = -Infinity;
  let minC = Infinity;
  let maxH = -Infinity;
  let minL = Infinity;
  let minCOff = 1;
  let maxCOff = 1;
  let minLOff = 1;
  let maxHOff = 1;
  for (let k = 1; k <= h; k++) {
    const b = bars[i + k]!;
    if (b.close > maxC) { maxC = b.close; maxCOff = k; }
    if (b.close < minC) { minC = b.close; minCOff = k; }
    if (b.high > maxH) { maxH = b.high; maxHOff = k; }
    if (b.low < minL) { minL = b.low; minLOff = k; }
  }
  const end = bars[i + h]!;
  return {
    anchorIndex: i,
    anchorDate: a.date,
    anchorClose: a.close,
    horizon: h,
    endDate: end.date,
    ret: end.close / a.close - 1,
    maxCloseRet: maxC / a.close - 1,
    minCloseRet: minC / a.close - 1,
    minCloseOffset: minCOff,
    maxCloseOffset: maxCOff,
    maxHighRet: maxH / a.close - 1,
    minLowRet: minL / a.close - 1,
    minLowOffset: minLOff,
    maxHighOffset: maxHOff,
  };
};

export type TouchMode = 'close' | 'intraday';

/**
 * Sessions ahead (1..h) until price first reaches `level`, or null when it does not inside the
 * available window. `censored` is true when the window ran out of data before h sessions without
 * a touch, so the anchor cannot count as a miss.
 */
export const firstTouch = (
  bars: readonly Bar[],
  i: number,
  h: number,
  level: number,
  side: 'above' | 'below',
  mode: TouchMode,
): { offset: number | null; censored: boolean } => {
  const last = Math.min(bars.length - 1, i + h);
  for (let k = i + 1; k <= last; k++) {
    const b = bars[k]!;
    const px = mode === 'close' ? b.close : side === 'above' ? b.high : b.low;
    if (side === 'above' ? px >= level : px <= level) return { offset: k - i, censored: false };
  }
  return { offset: null, censored: last < i + h };
};

export interface HorizonSummary {
  horizon: number;
  /** Matured anchors used as the denominator. */
  n: number;
  /** Anchors excluded because the horizon has not completed. */
  notMatured: number;
  up: number;
  flat: number;
  down: number;
  /** Share of matured anchors with a higher endpoint close. */
  positive: Proportion | null;
  returns: Distribution | null;
  /** Distribution of the worst close inside the window relative to the anchor close. */
  adverse: Distribution | null;
  /** Distribution of the best close inside the window relative to the anchor close. */
  favorable: Distribution | null;
  anchorDates: ISODate[];
  outcomes: ForwardOutcome[];
}

/**
 * Summarize one horizon across anchors. The Wilson interval uses the conservative year-cluster
 * effective sample size because anchors inside one year share a market regime.
 */
export const summarizeHorizon = (bars: readonly Bar[], anchors: readonly number[], h: number, level = 0.95): HorizonSummary => {
  const outcomes: ForwardOutcome[] = [];
  let notMatured = 0;
  for (const i of anchors) {
    const o = forwardOutcome(bars, i, h);
    if ('unavailable' in o) notMatured++;
    else outcomes.push(o);
  }
  const rets = outcomes.map((o) => o.ret);
  const up = rets.filter((r) => r > 0).length;
  const down = rets.filter((r) => r < 0).length;
  const dates = outcomes.map((o) => o.anchorDate);
  return {
    horizon: h,
    n: outcomes.length,
    notMatured,
    up,
    flat: outcomes.length - up - down,
    down,
    positive: wilson(up, outcomes.length, level, yearClusterEffectiveN(dates)),
    returns: distribution(rets),
    adverse: distribution(outcomes.map((o) => o.minCloseRet)),
    favorable: distribution(outcomes.map((o) => o.maxCloseRet)),
    anchorDates: dates,
    outcomes,
  };
};

/**
 * Chronological non-overlap selection. Keeps an anchor when it is at least `gap` sessions after
 * the previously kept anchor. Reports what was dropped so the exclusion count can be shown.
 */
export const selectNonOverlapping = (indices: readonly number[], gap: number): { kept: number[]; dropped: number[] } => {
  const kept: number[] = [];
  const dropped: number[] = [];
  let last = -Infinity;
  for (const i of [...indices].sort((a, b) => a - b)) {
    if (i - last >= gap) {
      kept.push(i);
      last = i;
    } else dropped.push(i);
  }
  return { kept, dropped };
};

/** Baseline: every session with a matured h-session outcome, thinned to non-overlapping anchors. */
export const baselineAnchors = (bars: readonly Bar[], h: number, from = 0, to = bars.length - 1): number[] => {
  const out: number[] = [];
  for (let i = from; i <= to && i + h < bars.length; i += h) out.push(i);
  return out;
};
