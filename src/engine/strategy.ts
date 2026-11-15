/**
 * Strategy tests: a chronological rule audit and the legacy Lab analog rule.
 *
 * What this is. A rule audit lists what price did after each dated signal of a declared rule.
 * It reports conditional price outcomes. It is not simulated trading performance unless the
 * caller fully specifies exposure, compounding and initial equity, in which case a separate,
 * clearly labeled chained result is added.
 *
 * Definitions:
 * - Every condition at session i uses closes 0..i only.
 * - Signal. With trigger 'first-session' a signal is the first session on which all conditions
 *   hold after a session on which they were evaluable and did not all hold. With 'every-session'
 *   each session on which they hold is a candidate.
 * - Entry. 'signal-close' enters at C(i). 'next-open' enters at O(i+1). Both exit at C(i+h).
 * - Holds never overlap: a signal is kept only when it is at least h sessions after the last kept
 *   signal. Dropped signals are counted.
 * - Cost. `costBps` is charged per side as a fraction of the traded price:
 *   net = exit x (1 - c) / (entry x (1 + c)) - 1 with c = costBps / 10,000.
 * - Baseline. Every session in the same date range with a matured window, same entry, horizon and
 *   cost. The all sessions figures are descriptive. The interval uses sessions spaced h apart.
 * - Selection and holdout. The date range is split chronologically. Signals whose outcome window
 *   crosses the split are embargoed. A rule tuned on the selection period is judged only on the
 *   holdout period.
 */
import { sma } from './core/indicators';
import { selectNonOverlapping, summarizeHorizon, type HorizonSummary } from './core/outcomes';
import { distribution, wilson, yearClusterEffectiveN } from './core/stats';
import { na, type Bar, type Distribution, type ISODate, type Maybe, type ModelStatus, type Proportion } from './core/types';

export type Condition =
  /** Closing drawdown from the running closing peak (or the peak of the last `lookback` sessions) is at least `atLeast`. */
  | { kind: 'drawdown'; atLeast: number; lookback?: number }
  /** Close strictly above or strictly below the n session simple moving average. */
  | { kind: 'sma'; n: number; side: 'above' | 'below' }
  /** Close to close move over `sessions`: C(i) / C(i - sessions) - 1, bounded below and or above. */
  | { kind: 'move'; sessions: number; atLeast?: number; atMost?: number }
  /** Stock move minus benchmark move over `sessions` on the same dates, in percentage points as a fraction. */
  | { kind: 'relative'; sessions: number; atLeast?: number; atMost?: number };

export type EntryConvention = 'signal-close' | 'next-open';

export interface FailureDefinition {
  /** A later close below the lowest close of the `lookback` sessions ending at the signal. */
  kind: 'close-below-prior-low';
  lookback: number;
}

export interface Rule {
  id: string;
  label: string;
  conditions: Condition[];
  trigger: 'first-session' | 'every-session';
  entry: EntryConvention;
  /** Holding horizon in sessions. */
  horizon: number;
  failure?: FailureDefinition;
}

export const STRATEGY_DEFAULTS = {
  /** Per side transaction cost in basis points. The reference default for this control. */
  costBps: 5,
  costProvenance: 'spec' as const,
  /** Share of the date range reserved as holdout. */
  holdoutShare: 0.4,
  /** Minimum holdout signals before any verdict other than insufficient evidence. */
  minHoldout: 20,
  holdoutProvenance: 'proposed' as const,
};

/** The specification's example: a 5% five session bounce while below SMA200, followed for 20 sessions. */
export const BOUNCE_BELOW_SMA200: Rule = {
  id: 'bounce-below-sma200',
  label: 'Up 5% or more over five sessions while the close is below the 200 session average',
  conditions: [
    { kind: 'sma', n: 200, side: 'below' },
    { kind: 'move', sessions: 5, atLeast: 0.05 },
  ],
  trigger: 'first-session',
  entry: 'signal-close',
  horizon: 20,
  failure: { kind: 'close-below-prior-low', lookback: 5 },
};

interface Features {
  closes: number[];
  peak: number[];
  smaCache: Map<number, (number | null)[]>;
  benchByDate: Map<ISODate, number> | null;
  bars: readonly Bar[];
}

const buildFeatures = (bars: readonly Bar[], benchmark?: readonly Bar[]): Features => {
  const closes = bars.map((b) => b.close);
  const peak: number[] = new Array(closes.length);
  let p = -Infinity;
  for (let i = 0; i < closes.length; i++) {
    if (closes[i]! > p) p = closes[i]!;
    peak[i] = p;
  }
  return { closes, peak, smaCache: new Map(), benchByDate: benchmark ? new Map(benchmark.map((b) => [b.date, b.close])) : null, bars };
};

const within = (x: number, atLeast?: number, atMost?: number): boolean =>
  (atLeast === undefined || x >= atLeast) && (atMost === undefined || x <= atMost);

/** True, false, or null when the condition cannot be evaluated at i from past data. */
const evalCondition = (f: Features, c: Condition, i: number): boolean | null => {
  const close = f.closes[i]!;
  switch (c.kind) {
    case 'drawdown': {
      let peak = f.peak[i]!;
      if (c.lookback !== undefined) {
        if (i - c.lookback + 1 < 0) return null;
        peak = -Infinity;
        for (let j = i - c.lookback + 1; j <= i; j++) if (f.closes[j]! > peak) peak = f.closes[j]!;
      }
      return close / peak - 1 <= -c.atLeast;
    }
    case 'sma': {
      if (!f.smaCache.has(c.n)) f.smaCache.set(c.n, sma(f.closes, c.n));
      const s = f.smaCache.get(c.n)![i];
      if (s === null || s === undefined) return null;
      return c.side === 'above' ? close > s : close < s;
    }
    case 'move': {
      if (i - c.sessions < 0) return null;
      return within(close / f.closes[i - c.sessions]! - 1, c.atLeast, c.atMost);
    }
    case 'relative': {
      if (i - c.sessions < 0 || !f.benchByDate) return null;
      const b1 = f.benchByDate.get(f.bars[i]!.date);
      const b0 = f.benchByDate.get(f.bars[i - c.sessions]!.date);
      if (b1 === undefined || b0 === undefined) return null;
      return within(close / f.closes[i - c.sessions]! - 1 - (b1 / b0 - 1), c.atLeast, c.atMost);
    }
  }
};

const evalAll = (f: Features, rule: Rule, i: number): boolean | null => {
  let all = true;
  for (const c of rule.conditions) {
    const r = evalCondition(f, c, i);
    if (r === null) return null;
    if (!r) all = false;
  }
  return all;
};

export interface SignalScan {
  /** Sessions where the rule fires under its trigger, before overlap thinning. */
  signals: number[];
  /** Sessions where the conditions could be evaluated. */
  evaluable: number;
  /** Sessions skipped because a condition had no past data or no aligned benchmark close. */
  unevaluable: number;
  /** First session triggers skipped because the prior session's state is unknown. */
  priorUnknownSkipped: number;
  firstEvaluable: number | null;
}

/** Dated signals of a rule. Past only. */
export const scanSignals = (bars: readonly Bar[], rule: Rule, benchmark?: readonly Bar[]): SignalScan => {
  const f = buildFeatures(bars, benchmark);
  const signals: number[] = [];
  let evaluable = 0;
  let unevaluable = 0;
  let priorUnknownSkipped = 0;
  let firstEvaluable: number | null = null;
  let prev: boolean | null = null;
  for (let i = 0; i < bars.length; i++) {
    const cur = evalAll(f, rule, i);
    if (cur === null) unevaluable++;
    else {
      evaluable++;
      if (firstEvaluable === null) firstEvaluable = i;
      if (cur) {
        if (rule.trigger === 'every-session') signals.push(i);
        else if (prev === false) signals.push(i);
        else if (prev === null) priorUnknownSkipped++;
      }
    }
    prev = cur;
  }
  return { signals, evaluable, unevaluable, priorUnknownSkipped, firstEvaluable };
};

export interface TradeLeg {
  entryDate: ISODate;
  entryPrice: number;
  exitDate: ISODate;
  exitPrice: number;
  /** exit / entry - 1 before costs. */
  gross: number;
  /** After the per side cost on entry and exit. */
  net: number;
  /** Lowest and highest close inside the hold relative to the entry price. */
  minCloseRet: number;
  maxCloseRet: number;
}

/** One hold from a signal at i, or null when the window has not matured. */
const legFor = (bars: readonly Bar[], i: number, h: number, entry: EntryConvention, costBps: number): TradeLeg | null => {
  if (i + h >= bars.length) return null;
  const eb = entry === 'signal-close' ? bars[i]! : bars[i + 1]!;
  const entryPrice = entry === 'signal-close' ? eb.close : eb.open;
  const xb = bars[i + h]!;
  const c = costBps / 10_000;
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = i + 1; k <= i + h; k++) {
    const cl = bars[k]!.close;
    if (cl < lo) lo = cl;
    if (cl > hi) hi = cl;
  }
  return {
    entryDate: eb.date,
    entryPrice,
    exitDate: xb.date,
    exitPrice: xb.close,
    gross: xb.close / entryPrice - 1,
    net: (xb.close * (1 - c)) / (entryPrice * (1 + c)) - 1,
    minCloseRet: lo / entryPrice - 1,
    maxCloseRet: hi / entryPrice - 1,
  };
};

export type Segment = 'selection' | 'holdout';

export interface AuditRow extends TradeLeg {
  signalIndex: number;
  signalDate: ISODate;
  segment: Segment;
  /** Failure outcome when the rule defines one. Null when it does not. */
  failed: boolean | null;
  /** Sessions after the signal of the first failing close. */
  failOffset: number | null;
  /** Level a close had to break for the failure definition. */
  failLevel: number | null;
}

export interface BaselineSummary {
  /** Every matured session in the range. Descriptive only, windows overlap. */
  allSessions: number;
  allWinRate: number | null;
  allMedianNet: number | null;
  /** Sessions spaced one horizon apart, used for the interval. */
  spaced: number;
  spacedWin: Proportion | null;
  spacedNet: Distribution | null;
}

export interface AuditSummary {
  segment: Segment | 'all';
  from: ISODate | null;
  to: ISODate | null;
  n: number;
  /** Share of signals with a positive net endpoint return. */
  win: Proportion | null;
  net: Distribution | null;
  gross: Distribution | null;
  /** Worst close inside the hold, relative to entry, across signals. */
  adverse: Distribution | null;
  failure: Proportion | null;
  baseline: BaselineSummary;
  /** Signal median net minus baseline all sessions median net. */
  medianDiff: Maybe<number>;
  /** Signal win rate minus baseline all sessions win rate, in percentage points as a fraction. */
  winRateDiffPp: Maybe<number>;
}

export interface SimulationSpec {
  initialEquity: number;
  /** Fraction of equity (or of initial equity when not compounding) placed in each hold. */
  exposure: number;
  compounding: boolean;
}

export interface SimulationResult {
  label: 'Specified simulation';
  trades: number;
  finalEquity: number;
  totalReturn: number;
  /** Largest peak to trough decline of equity measured at trade exits. */
  maxDrawdown: number;
  curve: { date: ISODate; equity: number }[];
  assumptions: string;
}

export interface HoldoutVerdict {
  status: ModelStatus;
  statement: string;
}

export interface RuleAudit {
  rule: Rule;
  resultKind: 'conditional-price-outcomes';
  costBps: number;
  costNote: string;
  scan: SignalScan;
  /** Kept signals with matured, non overlapping holds, oldest first. Every figure traces to these rows. */
  rows: AuditRow[];
  overlapDropped: number;
  notMatured: number;
  /** Signals whose outcome window crosses the selection and holdout split. */
  embargoed: number;
  splitDate: ISODate | null;
  all: AuditSummary;
  selection: AuditSummary;
  holdout: AuditSummary;
  verdict: HoldoutVerdict;
  /** Present only when the caller specified exposure, compounding and initial equity. */
  simulation: Maybe<SimulationResult>;
  note: string;
}

export interface AuditOptions {
  costBps?: number;
  benchmark?: readonly Bar[];
  /** First session date of the holdout period. Defaults to a chronological split by `holdoutShare`. */
  holdoutFrom?: ISODate;
  holdoutShare?: number;
  minHoldout?: number;
  level?: number;
  simulation?: SimulationSpec;
}

const baselineFor = (bars: readonly Bar[], from: number, to: number, h: number, entry: EntryConvention, costBps: number, level: number): BaselineSummary => {
  const all: number[] = [];
  const spaced: number[] = [];
  const spacedDates: ISODate[] = [];
  for (let i = from; i <= to; i++) {
    const leg = legFor(bars, i, h, entry, costBps);
    if (!leg) break;
    all.push(leg.net);
    if ((i - from) % h === 0) {
      spaced.push(leg.net);
      spacedDates.push(bars[i]!.date);
    }
  }
  const d = distribution(all);
  return {
    allSessions: all.length,
    allWinRate: all.length ? all.filter((x) => x > 0).length / all.length : null,
    allMedianNet: d ? d.median : null,
    spaced: spaced.length,
    spacedWin: wilson(spaced.filter((x) => x > 0).length, spaced.length, level, yearClusterEffectiveN(spacedDates)),
    spacedNet: distribution(spaced),
  };
};

const summarizeRows = (
  bars: readonly Bar[],
  rows: readonly AuditRow[],
  segment: AuditSummary['segment'],
  from: number,
  to: number,
  rule: Rule,
  costBps: number,
  level: number,
): AuditSummary => {
  const nets = rows.map((r) => r.net);
  const dates = rows.map((r) => r.signalDate);
  const baseline = from <= to ? baselineFor(bars, from, to, rule.horizon, rule.entry, costBps, level) : baselineFor(bars, 0, -1, rule.horizon, rule.entry, costBps, level);
  const net = distribution(nets);
  const win = wilson(nets.filter((x) => x > 0).length, nets.length, level, yearClusterEffectiveN(dates));
  const withFailure = rows.filter((r) => r.failed !== null);
  return {
    segment,
    from: from <= to && bars[from] ? bars[from]!.date : null,
    to: from <= to && bars[to] ? bars[to]!.date : null,
    n: rows.length,
    win,
    net,
    gross: distribution(rows.map((r) => r.gross)),
    adverse: distribution(rows.map((r) => r.minCloseRet)),
    failure: wilson(withFailure.filter((r) => r.failed).length, withFailure.length, level, yearClusterEffectiveN(withFailure.map((r) => r.signalDate))),
    baseline,
    medianDiff: net && baseline.allMedianNet !== null ? net.median - baseline.allMedianNet : na('sample-too-small', 'No signals or no baseline sessions in this period'),
    winRateDiffPp: win && baseline.allWinRate !== null ? win.rate - baseline.allWinRate : na('sample-too-small', 'No signals or no baseline sessions in this period'),
  };
};

const simulate = (rows: readonly AuditRow[], spec: SimulationSpec): Maybe<SimulationResult> => {
  if (!(spec.initialEquity > 0) || !(spec.exposure > 0) || spec.exposure > 1) return na('invalid-input', 'Initial equity must be positive and exposure must be between 0 and 1');
  let equity = spec.initialEquity;
  let peak = equity;
  let maxDd = 0;
  const curve: SimulationResult['curve'] = [];
  for (const r of rows) {
    equity += (spec.compounding ? equity : spec.initialEquity) * spec.exposure * r.net;
    if (equity > peak) peak = equity;
    maxDd = Math.min(maxDd, equity / peak - 1);
    curve.push({ date: r.exitDate, equity });
  }
  return {
    label: 'Specified simulation',
    trades: rows.length,
    finalEquity: equity,
    totalReturn: equity / spec.initialEquity - 1,
    maxDrawdown: maxDd,
    curve,
    assumptions: `${(spec.exposure * 100).toFixed(0)}% of ${spec.compounding ? 'current' : 'initial'} equity per hold, one hold at a time, costs as stated, cash earns nothing, fills at the declared entry and exit prices.`,
  };
};

/**
 * Chronological audit of one rule. `bars` must already be cut at the as-of date.
 * Returns conditional price outcomes with traceable rows, a same period baseline, a selection and
 * holdout split, and a verdict that rests on the holdout only.
 */
export const auditRule = (bars: readonly Bar[], rule: Rule, opts: AuditOptions = {}): Maybe<RuleAudit> => {
  if (!(rule.horizon >= 1) || rule.conditions.length === 0) return na('invalid-input', 'A rule needs at least one condition and a horizon of one session or more');
  const costBps = opts.costBps ?? STRATEGY_DEFAULTS.costBps;
  const level = opts.level ?? 0.95;
  const h = rule.horizon;
  const scan = scanSignals(bars, rule, opts.benchmark);
  const first = scan.firstEvaluable;
  if (first === null) return na('insufficient-history', 'The rule cannot be evaluated on this history');
  const lastMatured = bars.length - 1 - h;
  const matured = scan.signals.filter((i) => i <= lastMatured);
  const notMatured = scan.signals.length - matured.length;
  const { kept, dropped } = selectNonOverlapping(matured, h);

  // Chronological split of the evaluable date range.
  let split: number;
  if (opts.holdoutFrom) {
    split = bars.findIndex((b) => b.date >= opts.holdoutFrom!);
    if (split < 0) split = bars.length;
  } else {
    const share = opts.holdoutShare ?? STRATEGY_DEFAULTS.holdoutShare;
    split = first + Math.floor((bars.length - 1 - first) * (1 - share)) + 1;
  }
  const f = rule.failure ? buildFeatures(bars) : null;
  const rows: AuditRow[] = [];
  let embargoed = 0;
  for (const i of kept) {
    const leg = legFor(bars, i, h, rule.entry, costBps)!;
    const segment: Segment = i >= split ? 'holdout' : 'selection';
    if (segment === 'selection' && i + h >= split) {
      embargoed++;
      continue;
    }
    let failed: boolean | null = null;
    let failOffset: number | null = null;
    let failLevel: number | null = null;
    if (rule.failure && f) {
      const lb = rule.failure.lookback;
      if (i - lb >= 0) {
        let lo = Infinity;
        for (let j = i - lb; j <= i; j++) if (f.closes[j]! < lo) lo = f.closes[j]!;
        failLevel = lo;
        failed = false;
        for (let k = 1; k <= h; k++) {
          if (f.closes[i + k]! < lo) {
            failed = true;
            failOffset = k;
            break;
          }
        }
      }
    }
    rows.push({ ...leg, signalIndex: i, signalDate: bars[i]!.date, segment, failed, failOffset, failLevel });
  }
  const selRows = rows.filter((r) => r.segment === 'selection');
  const holdRows = rows.filter((r) => r.segment === 'holdout');
  const all = summarizeRows(bars, rows, 'all', first, lastMatured, rule, costBps, level);
  const selection = summarizeRows(bars, selRows, 'selection', first, Math.min(lastMatured, split - 1 - h), rule, costBps, level);
  const holdout = summarizeRows(bars, holdRows, 'holdout', Math.max(first, split), lastMatured, rule, costBps, level);

  const minHoldout = opts.minHoldout ?? STRATEGY_DEFAULTS.minHoldout;
  let verdict: HoldoutVerdict;
  if (holdout.n < minHoldout || !holdout.win || holdout.baseline.allWinRate === null || holdout.baseline.allMedianNet === null || !holdout.net) {
    verdict = {
      status: 'insufficient-evidence',
      statement: `Holdout has ${holdout.n} signals. At least ${minHoldout} are needed before the rule can be judged against its baseline.`,
    };
  } else if (holdout.win.lo > holdout.baseline.allWinRate && holdout.net.median > holdout.baseline.allMedianNet) {
    verdict = {
      status: 'valid',
      statement: 'In the holdout period the rule beat the all sessions baseline on win rate, with the interval above the baseline rate, and on median net return.',
    };
  } else {
    verdict = {
      status: 'not-reliable',
      statement: 'In the holdout period the rule did not clearly beat the all sessions baseline. Treat the selection period result as description only.',
    };
  }
  return {
    rule,
    resultKind: 'conditional-price-outcomes',
    costBps,
    costNote: `${costBps} bps charged on entry and again on exit, as a fraction of the traded price.`,
    scan,
    rows,
    overlapDropped: dropped.length,
    notMatured,
    embargoed,
    splitDate: bars[split]?.date ?? null,
    all,
    selection,
    holdout,
    verdict,
    simulation: opts.simulation
      ? simulate(rows, opts.simulation)
      : na('not-applicable', 'Conditional price outcomes only. Exposure, compounding and initial equity were not specified, so no trading performance is reported.'),
    note: 'Conditional price outcomes after dated signals. Not simulated trading performance. A rule chosen on the same data it is judged on proves nothing, so the verdict uses the holdout period only.',
  };
};

/* ----------------------------------------------------------- Lab analog rule */

export const LAB_DEFAULTS = {
  horizons: [1, 5, 10, 15] as const,
  /** Non overlapping matured supports required before a frequency is shown. */
  minSupport: 30,
  provenance: 'spec' as const,
};

export interface LabHorizon {
  horizon: number;
  /** Matured, non overlapping anchors. */
  support: number;
  overlapDropped: number;
  notMatured: number;
  /** Share closing higher after the horizon. Withheld below the support minimum. */
  frequency: Maybe<Proportion>;
  /** Descriptive outcomes. Always available with their exact count. */
  summary: HorizonSummary;
}

export interface LabAnalogResult {
  minSupport: number;
  horizons: LabHorizon[];
}

/**
 * Legacy Lab "what happens next" outcomes for a list of analog anchor indices. Frequencies need 30
 * non overlapping matured supports per horizon. Below that the counts and distribution remain and
 * the frequency is withheld.
 */
export const labAnalogOutcomes = (
  bars: readonly Bar[],
  anchors: readonly number[],
  opts: { horizons?: readonly number[]; minSupport?: number; level?: number } = {},
): LabAnalogResult => {
  const minSupport = opts.minSupport ?? LAB_DEFAULTS.minSupport;
  const horizons = (opts.horizons ?? LAB_DEFAULTS.horizons).map((h): LabHorizon => {
    const { kept, dropped } = selectNonOverlapping(anchors, h);
    const summary = summarizeHorizon(bars, kept, h, opts.level ?? 0.95);
    return {
      horizon: h,
      support: summary.n,
      overlapDropped: dropped.length,
      notMatured: summary.notMatured,
      frequency:
        summary.n >= minSupport && summary.positive
          ? summary.positive
          : na('sample-too-small', `${summary.n} non overlapping matured cases. ${minSupport} are required for a frequency.`),
      summary,
    };
  });
  return { minSupport, horizons };
};
