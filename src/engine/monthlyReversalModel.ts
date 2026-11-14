/**
 * Monthly Reversal study orchestration: baselines, the calibrated candidate and its gate, what if
 * scenarios, chart paths and the cross stock scanner. Primitives live in monthlyReversal.ts.
 *
 * Normal odds versus conditional odds
 * - Daily baseline: share of ordinary sessions in the lookback whose close h sessions later was
 *   higher. The count is descriptive. The interval uses the spaced (non overlapping) sample size.
 * - Monthly baseline: the all months cohort at the equivalent anchor and the same horizon.
 * - Conditional: a cohort frequency, shown only with 10 eligible months across 3 distinct years.
 *
 * Calibrated candidate (owner specification)
 *   p = (hits + 4 x baseline) / (n + 4)
 *   hits and n come from similar setup matches, baseline is the rate over all earlier cases.
 *   Walk forward: each test month trains only on cases whose outcome ended before the test anchor,
 *   needs 24 earlier observations, and overlapping evaluation paths are skipped. The candidate must
 *   have 24 scored predictions and a lower Brier score than the earlier baseline over the whole
 *   record and in both chronological halves. Otherwise no modeled percentage is returned.
 *
 * "Seven sessions down" creates no obligation for compensating up sessions. Nothing here assumes it.
 */
import { nextSession } from './core/calendar';
import { sliceAsOf } from './core/series';
import { brier, distribution, spacedIndices, wilson, yearClusterEffectiveN } from './core/stats';
import { isNa, na, type Bar, type ISODate, type Maybe, type ModelStatus, type Proportion, type Unavailable } from './core/types';
import {
  buildCandidates, buildCohorts, buildContext, matchDistance, monthlyState, recoveryFeasibility, resolveOptions, statOf,
  type CandidateSet, type Cohort, type CohortKind, type CohortMember, type Exclusion, type MatchResult, type MonthlyContext,
  type MonthlyReversalOptions, type MonthlyState, type OutcomeStat, type StudyContext,
} from './monthlyReversal';

// ---------------------------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------------------------

export interface DailyBaseline {
  horizon: number;
  /** Every eligible session in the lookback. Descriptive. */
  hits: number;
  n: number;
  rate: number;
  /** Non overlapping anchors, one every `horizon` sessions. Used for the interval. */
  spacedN: number;
  interval: Proportion | null;
  from: ISODate;
  to: ISODate;
  note: string;
}

/** Ordinary sessions: how often the close h sessions later was higher. As of the context anchor. */
export const dailyBaseline = (ctx: StudyContext, lookbackFrom: ISODate): Maybe<DailyBaseline> => {
  const bars = ctx.bars;
  const h = ctx.options.horizon;
  const idx: number[] = [];
  for (let t = 0; t + h < bars.length; t++) if (bars[t]!.date >= lookbackFrom) idx.push(t);
  if (idx.length === 0) return na('insufficient-history', `No session with a completed ${h} session outcome inside the lookback`);
  let hits = 0;
  for (const t of idx) if (bars[t + h]!.close > bars[t]!.close) hits++;
  const spaced = spacedIndices(idx, h);
  const nEff = Math.min(spaced.length, yearClusterEffectiveN(spaced.map((t) => bars[t]!.date)));
  return {
    horizon: h,
    hits,
    n: idx.length,
    rate: hits / idx.length,
    spacedN: spaced.length,
    interval: wilson(hits, idx.length, ctx.options.level, nEff),
    from: bars[idx[0]!]!.date,
    to: bars[idx[idx.length - 1]!]!.date,
    note: 'All ordinary sessions. Windows overlap, so the interval uses the spaced sample size.',
  };
};

// ---------------------------------------------------------------------------------------------
// Calibrated candidate
// ---------------------------------------------------------------------------------------------

export interface ModelOptions {
  /** Pseudo cases at the earlier all case rate. */
  pseudoCases: number;
  /** Earlier matured observations required before a test month is scored. */
  minTraining: number;
  /** Scored predictions required before the gate can pass. */
  minScored: number;
  /** Lookback for the walk forward record. Null uses the whole trusted history. */
  modelLookbackYears: number | null;
}

export const MODEL_DEFAULTS: ModelOptions & { readonly provenance: Readonly<Record<string, 'spec' | 'proposed'>> } = {
  pseudoCases: 4,
  minTraining: 24,
  minScored: 24,
  modelLookbackYears: null,
  provenance: { pseudoCases: 'spec', minTraining: 'spec', minScored: 'spec', twoHalfGate: 'spec', modelLookbackYears: 'proposed' },
};

export interface ScoredPrediction {
  monthKey: string;
  anchorDate: ISODate;
  /** Candidate probability issued from earlier matured cases only. */
  p: number;
  /** Earlier all case rate, the comparison forecast. */
  baseline: number;
  outcome: 0 | 1;
  matchHits: number;
  matchN: number;
  trainingN: number;
}

export interface BrierBlock {
  label: string;
  from: ISODate | null;
  to: ISODate | null;
  scored: number;
  brier: number | null;
  baselineBrier: number | null;
  beatsBaseline: boolean | null;
}

export interface CalibrationResult {
  status: ModelStatus;
  /** Plain reasons for the status. */
  reasons: string[];
  target: string;
  formula: string;
  horizon: number;
  scored: number;
  brier: number | null;
  baselineBrier: number | null;
  halves: [BrierBlock, BrierBlock];
  skippedTraining: number;
  skippedOverlap: number;
  notMatured: number;
  predictions: ScoredPrediction[];
  /** Realized counts for the current anchor. Always available as description. */
  current: { matchHits: number; matchN: number; baselineHits: number; baselineN: number } | null;
  /** The modeled probability. Present only when the gate passes. */
  probability: Maybe<number>;
}

const upAfter = (bars: readonly Bar[], i: number, h: number): 0 | 1 => (bars[i + h]!.close > bars[i]!.close ? 1 : 0);

const block = (label: string, preds: readonly ScoredPrediction[]): BrierBlock => {
  if (preds.length === 0) return { label, from: null, to: null, scored: 0, brier: null, baselineBrier: null, beatsBaseline: null };
  const y = preds.map((p) => p.outcome);
  const b = brier(preds.map((p) => p.p), y);
  const bb = brier(preds.map((p) => p.baseline), y);
  return { label, from: preds[0]!.anchorDate, to: preds[preds.length - 1]!.anchorDate, scored: preds.length, brier: b, baselineBrier: bb, beatsBaseline: b < bb };
};

/**
 * Walk forward evaluation of the smoothed match rate against the earlier all case rate, then the
 * current estimate. `set.members` must be in chronological order (buildCandidates guarantees it).
 */
export const calibrateCandidate = (ctx: StudyContext, set: CandidateSet, model: ModelOptions = MODEL_DEFAULTS): CalibrationResult => {
  const o = ctx.options;
  const bars = ctx.bars;
  const h = o.horizon;
  const members = set.members;
  const predictions: ScoredPrediction[] = [];
  let skippedTraining = 0;
  let skippedOverlap = 0;
  let notMatured = 0;
  let lastScored = -Infinity;
  const similar = (q: CohortMember, c: CohortMember): boolean => {
    const m = matchDistance(q.features, c.features, o, { query: q.state.sequence, candidate: c.state.sequence });
    return !isNa(m) && m.distance <= o.tolerance;
  };
  for (let j = 0; j < members.length; j++) {
    const test = members[j]!;
    if (test.anchorIndex + h >= bars.length) {
      notMatured++;
      continue;
    }
    // Training labels must have ended strictly before the test anchor.
    const training: CohortMember[] = [];
    for (let k = 0; k < j; k++) if (members[k]!.anchorIndex + h < test.anchorIndex) training.push(members[k]!);
    if (training.length < model.minTraining) {
      skippedTraining++;
      continue;
    }
    if (test.anchorIndex - lastScored < h) {
      skippedOverlap++;
      continue;
    }
    let baseHits = 0;
    let mHits = 0;
    let mN = 0;
    for (const t of training) {
      const y = upAfter(bars, t.anchorIndex, h);
      baseHits += y;
      if (similar(test, t)) {
        mN++;
        mHits += y;
      }
    }
    const baseline = baseHits / training.length;
    predictions.push({
      monthKey: test.monthKey,
      anchorDate: test.anchorDate,
      p: (mHits + model.pseudoCases * baseline) / (mN + model.pseudoCases),
      baseline,
      outcome: upAfter(bars, test.anchorIndex, h),
      matchHits: mHits,
      matchN: mN,
      trainingN: training.length,
    });
    lastScored = test.anchorIndex;
  }
  const half = Math.floor(predictions.length / 2);
  const halves: [BrierBlock, BrierBlock] = [block('Earlier half', predictions.slice(0, half)), block('Later half', predictions.slice(half))];
  const all = block('All scored predictions', predictions);

  // Current anchor: the same rule as the walk forward, applied at the query.
  const qi = set.query.anchorIndex;
  const training = members.filter((m) => m.anchorIndex + h < qi);
  let current: CalibrationResult['current'] = null;
  let currentP: number | null = null;
  if (training.length > 0) {
    let baseHits = 0;
    let mHits = 0;
    let mN = 0;
    for (const t of training) {
      const y = upAfter(bars, t.anchorIndex, h);
      baseHits += y;
      if (!isNa(t.match) && (t.match as MatchResult).distance <= o.tolerance) {
        mN++;
        mHits += y;
      }
    }
    current = { matchHits: mHits, matchN: mN, baselineHits: baseHits, baselineN: training.length };
    if (training.length >= model.minTraining) currentP = (mHits + model.pseudoCases * (baseHits / training.length)) / (mN + model.pseudoCases);
  }

  const reasons: string[] = [];
  let status: ModelStatus;
  if (predictions.length < model.minScored) {
    status = 'insufficient-evidence';
    reasons.push(`${predictions.length} scored predictions, needs ${model.minScored}`);
  } else if (all.beatsBaseline && halves[0].beatsBaseline && halves[1].beatsBaseline) {
    status = 'valid';
  } else {
    status = 'not-reliable';
    if (!all.beatsBaseline) reasons.push('Brier score is not below the earlier baseline over the whole record');
    if (!halves[0].beatsBaseline) reasons.push('Brier score is not below the baseline in the earlier half');
    if (!halves[1].beatsBaseline) reasons.push('Brier score is not below the baseline in the later half');
  }
  let probability: Maybe<number>;
  if (status === 'valid' && currentP !== null) probability = currentP;
  else if (status === 'valid') {
    status = 'insufficient-evidence';
    reasons.push(`${training.length} earlier matured months at the current anchor, needs ${model.minTraining}`);
    probability = na('sample-too-small', reasons[reasons.length - 1]);
  } else probability = na(status === 'insufficient-evidence' ? 'sample-too-small' : 'gate-failed', reasons.join('. '));
  return {
    status,
    reasons,
    target: `Close above the anchor close after ${h} sessions`,
    formula: `(match hits + ${model.pseudoCases} x earlier all case rate) / (matches + ${model.pseudoCases})`,
    horizon: h,
    scored: predictions.length,
    brier: all.brier,
    baselineBrier: all.baselineBrier,
    halves,
    skippedTraining,
    skippedOverlap,
    notMatured,
    predictions,
    current,
    probability,
  };
};

// ---------------------------------------------------------------------------------------------
// Study
// ---------------------------------------------------------------------------------------------

export interface MonthlyReversalStudy {
  asOf: ISODate;
  options: MonthlyReversalOptions;
  state: MonthlyState;
  query: CohortMember;
  candidates: {
    inspectedMonths: number;
    eligible: number;
    exclusions: Exclusion[];
    lookbackFrom: ISODate;
    historyFirst: ISODate;
    historyLast: ISODate;
  };
  cohorts: Cohort[];
  baselines: {
    daily: Maybe<DailyBaseline>;
    /** The all months cohort at the same anchor and horizon. */
    monthly: OutcomeStat | null;
  };
  /** Null when the caller asked for description only. */
  model: CalibrationResult | null;
  /** The as-of cut context, for follow up calls (paths, up day odds). */
  ctx: StudyContext;
}

export interface StudyRunOptions {
  includeModel?: boolean;
  model?: Partial<ModelOptions>;
}

/**
 * The full Monthly Reversal study at completed session i. Every dependent result is computed from
 * the same as-of cut, so changing one input recomputes all of them consistently.
 */
export const monthlyReversalStudy = (
  bars: readonly Bar[],
  i: number,
  options?: Partial<MonthlyReversalOptions>,
  context?: MonthlyContext,
  run?: StudyRunOptions,
): Maybe<MonthlyReversalStudy> => {
  const o = resolveOptions(options);
  const ctx = buildContext(bars, i, o, context);
  if (isNa(ctx)) return ctx;
  const state = monthlyState(ctx.bars, i, { basis: o.basis, recentWindow: o.recentWindow });
  if (isNa(state)) return state;
  const set = buildCandidates(ctx, state);
  const cohorts = buildCohorts(ctx, set);
  const all = cohorts.find((c) => c.kind === 'all-months');
  let model: CalibrationResult | null = null;
  if (run?.includeModel !== false) {
    const mo: ModelOptions = { ...MODEL_DEFAULTS, ...(run?.model ?? {}) };
    const years = mo.modelLookbackYears ?? 500;
    const modelSet = years === o.lookbackYears ? set : buildCandidates({ ...ctx, options: { ...o, lookbackYears: years, filters: {} } }, state);
    model = calibrateCandidate(ctx, modelSet, mo);
  }
  return {
    asOf: state.anchorDate,
    options: o,
    state,
    query: set.query,
    candidates: {
      inspectedMonths: set.inspectedMonths,
      eligible: set.members.length,
      exclusions: set.exclusions,
      lookbackFrom: set.lookbackFrom,
      historyFirst: set.historyFirst,
      historyLast: set.historyLast,
    },
    cohorts,
    baselines: { daily: dailyBaseline(ctx, set.lookbackFrom), monthly: all ? statOf(all.summary, 'positive-close') ?? null : null },
    model,
    ctx,
  };
};

export const cohortOf = (study: MonthlyReversalStudy, kind: CohortKind): Cohort | undefined => study.cohorts.find((c) => c.kind === kind);

// ---------------------------------------------------------------------------------------------
// What if scenarios
// ---------------------------------------------------------------------------------------------

export interface ScenarioStep {
  /** Hypothetical close to close return of the stock for one added session. */
  stockRet: number;
  marketRet?: number;
  sectorRet?: number;
}

export interface Scenario {
  id: string;
  label: string;
  steps: ScenarioStep[];
}

/** The standard scenarios, sized from the month's own typical moves where it has them. */
export const standardScenarios = (state: MonthlyState): Scenario[] => {
  const loss = typeof state.medianLoss === 'number' ? state.medianLoss : -0.01;
  const gain = typeof state.medianGain === 'number' ? state.medianGain : 0.01;
  const lowClose = Math.min(state.closingLow.value, state.anchorClose) * 0.999;
  return [
    { id: 'down-day', label: 'Another down session', steps: [{ stockRet: loss }] },
    { id: 'three-green', label: 'Three up sessions', steps: [{ stockRet: gain }, { stockRet: gain }, { stockRet: gain }] },
    { id: 'minus-3', label: 'Down 3% next session', steps: [{ stockRet: -0.03 }] },
    { id: 'plus-2', label: 'Up 2% next session', steps: [{ stockRet: 0.02 }] },
    { id: 'new-low', label: 'New monthly closing low', steps: [{ stockRet: lowClose / state.anchorClose - 1 }] },
    { id: 'market-up-stock-down', label: 'Market up 1% while the stock falls 1%', steps: [{ stockRet: -0.01, marketRet: 0.01, sectorRet: 0.01 }] },
  ];
};

const extend = (bars: readonly Bar[], dates: readonly ISODate[], rets: readonly number[]): Bar[] => {
  const out = [...bars];
  let prev = out[out.length - 1]!.close;
  for (let k = 0; k < dates.length; k++) {
    const close = prev * (1 + rets[k]!);
    out.push({ date: dates[k]!, open: prev, high: Math.max(prev, close), low: Math.min(prev, close), close, volume: null });
    prev = close;
  }
  return out;
};

export interface ScenarioChange {
  key: string;
  label: string;
  base: number;
  scenario: number;
}

export interface ScenarioCohortChange {
  kind: CohortKind;
  label: string;
  base: { members: number; hits: number; n: number };
  scenario: { members: number; hits: number; n: number };
}

export interface WhatIfResult {
  /** Always true. Nothing here is a completed fact, a training row or an alert. */
  hypothetical: true;
  scenario: Scenario;
  /** Planned sessions the hypothetical closes were placed on. */
  appendedDates: ISODate[];
  crossesMonthEnd: boolean;
  base: MonthlyReversalStudy;
  result: Maybe<MonthlyReversalStudy>;
  changes: ScenarioChange[];
  cohortChanges: ScenarioCohortChange[];
  note: string;
}

/**
 * Apply hypothetical sessions to a frozen cut at session i and rerun the description on it.
 * Inputs are never mutated. History before the anchor is unchanged, so every cohort still consists
 * of real earlier months. Only the query state moves.
 */
export const whatIf = (
  bars: readonly Bar[],
  i: number,
  scenario: Scenario,
  options?: Partial<MonthlyReversalOptions>,
  context?: MonthlyContext,
): Maybe<WhatIfResult> => {
  const base = monthlyReversalStudy(bars, i, options, context, { includeModel: false });
  if (isNa(base)) return base;
  if (scenario.steps.length === 0) return na('invalid-input', 'Scenario has no sessions');
  const anchor = bars[i]!;
  const dates: ISODate[] = [];
  let d = anchor.date;
  for (let k = 0; k < scenario.steps.length; k++) {
    d = nextSession(d);
    dates.push(d);
  }
  const hypo = extend(bars.slice(0, i + 1), dates, scenario.steps.map((s) => s.stockRet));
  const side = (src: readonly Bar[] | undefined, pick: (s: ScenarioStep) => number | undefined): Bar[] | undefined => {
    if (!src) return undefined;
    const cut = sliceAsOf(src, anchor.date);
    if (cut.length === 0 || cut[cut.length - 1]!.date !== anchor.date) return cut;
    return extend(cut, dates, scenario.steps.map((s) => pick(s) ?? 0));
  };
  const hypoContext: MonthlyContext = {};
  const mk = side(context?.market, (s) => s.marketRet);
  const sc = side(context?.sector, (s) => s.sectorRet);
  if (mk) hypoContext.market = mk;
  if (sc) hypoContext.sector = sc;
  if (context?.earnings) hypoContext.earnings = context.earnings;
  const result = monthlyReversalStudy(hypo, hypo.length - 1, options, hypoContext, { includeModel: false });
  const changes: ScenarioChange[] = [];
  const cohortChanges: ScenarioCohortChange[] = [];
  if (!isNa(result)) {
    const a = base.state;
    const b = result.state;
    const push = (key: string, label: string, x: number, y: number) => changes.push({ key, label, base: x, scenario: y });
    push('mtdReturn', 'Month to date return', a.mtdReturn, b.mtdReturn);
    push('down', 'Down sessions', a.down, b.down);
    push('up', 'Up sessions', a.up, b.up);
    push('negativeShare', 'Share of down sessions', a.negativeShare, b.negativeShare);
    push('drawdown', 'Drawdown from the month reference peak', a.drawdown, b.drawdown);
    push('remaining', 'Sessions left in the month', a.remaining, b.remaining);
    const fa = recoveryFeasibility(a, { targetUpShare: 0.5, targetClose: a.priorMonthClose });
    const fb = recoveryFeasibility(b, { targetUpShare: 0.5, targetClose: b.priorMonthClose });
    push('requiredUpDays', 'Up sessions still needed for half the month up', fa.upShare!.requiredUpDays, fb.upShare!.requiredUpDays);
    push('requiredToPriorClose', 'Move needed to regain the prior month close', fa.close!.requiredTotal, fb.close!.requiredTotal);
    for (const c of base.cohorts) {
      const r = result.cohorts.find((x) => x.kind === c.kind);
      const sa = statOf(c.summary, 'positive-close');
      const sb = r ? statOf(r.summary, 'positive-close') : undefined;
      cohortChanges.push({
        kind: c.kind,
        label: c.label,
        base: { members: c.members.length, hits: sa?.hits ?? 0, n: sa?.n ?? 0 },
        scenario: { members: r?.members.length ?? 0, hits: sb?.hits ?? 0, n: sb?.n ?? 0 },
      });
    }
  }
  return {
    hypothetical: true,
    scenario,
    appendedDates: dates,
    crossesMonthEnd: dates[dates.length - 1]!.slice(0, 7) !== anchor.date.slice(0, 7),
    base,
    result,
    changes,
    cohortChanges,
    note: 'Hypothetical closes on planned sessions. Not a completed fact. Not used for training, signals or alerts.',
  };
};

// ---------------------------------------------------------------------------------------------
// Chart paths
// ---------------------------------------------------------------------------------------------

export interface PathBand {
  /** Sessions after the anchor. */
  offset: number;
  n: number;
  median: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  /** The median expressed on the current month's MTD scale: (1 + MTD) x (1 + median) - 1. */
  mtdEquivalentMedian: number;
}

export interface CasePath {
  monthKey: string;
  anchorDate: ISODate;
  /** MTD by ordinal session through the case's own anchor. */
  before: { ordinal: number; date: ISODate; mtd: number }[];
  /** Return versus the case's anchor close for the sessions after it. */
  after: { offset: number; date: ISODate; ret: number }[];
}

export interface MonthPathChart {
  /** Observed path of the current month through the anchor. */
  current: { ordinal: number; date: ISODate; mtd: number }[];
  cases: CasePath[];
  /** Empirical median and bands of earlier months after their anchors. Only offsets with enough cases. */
  bands: PathBand[];
  sessionsAhead: number;
  minBandCases: number;
  /** Fixed marker so a view styles and labels these as history. */
  kind: 'historical-study';
  note: string;
}

/** Proposed. Bands are drawn only where at least this many earlier months have the session. */
export const MIN_BAND_CASES = 5;

/**
 * Current MTD path plus what earlier months did after the equivalent anchor. The forward part is
 * realized history of other months. It is not a projection of this month.
 */
export const monthPathChart = (ctx: StudyContext, state: MonthlyState, members: readonly CohortMember[], sessionsAhead?: number): MonthPathChart => {
  const ahead = Math.max(1, Math.min(90, sessionsAhead ?? Math.max(ctx.options.horizon, state.remaining)));
  const bars = ctx.bars;
  const cases: CasePath[] = members.map((m) => {
    const after: CasePath['after'] = [];
    for (let k = 1; k <= ahead && m.anchorIndex + k < bars.length; k++) {
      const b = bars[m.anchorIndex + k]!;
      after.push({ offset: k, date: b.date, ret: b.close / m.state.anchorClose - 1 });
    }
    return {
      monthKey: m.monthKey,
      anchorDate: m.anchorDate,
      before: m.state.days.map((d) => ({ ordinal: d.ordinal, date: d.date, mtd: d.mtd })),
      after,
    };
  });
  const bands: PathBand[] = [];
  for (let k = 1; k <= ahead; k++) {
    const xs = cases.map((c) => c.after[k - 1]?.ret).filter((x): x is number => x !== undefined);
    if (xs.length < MIN_BAND_CASES) continue;
    const d = distribution(xs)!;
    bands.push({ offset: k, n: d.n, median: d.median, p10: d.p10, p25: d.p25, p75: d.p75, p90: d.p90, mtdEquivalentMedian: (1 + state.mtdReturn) * (1 + d.median) - 1 });
  }
  return {
    current: state.days.map((d) => ({ ordinal: d.ordinal, date: d.date, mtd: d.mtd })),
    cases,
    bands,
    sessionsAhead: ahead,
    minBandCases: MIN_BAND_CASES,
    kind: 'historical-study',
    note: 'Paths after the anchor are what earlier months did. They are history, not a forecast for this month.',
  };
};

// ---------------------------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------------------------

export type SampleQuality = 'adequate' | 'sparse' | 'none';

export interface ScanRow {
  symbol: string;
  anchorDate: ISODate;
  /** Severity: month to date return. More negative is more severe. */
  mtdReturn: number;
  negativeShare: number;
  downSessions: number;
  elapsed: number;
  downStreak: number;
  drawdown: number;
  cohortKind: CohortKind;
  /** Matured months behind the outcome columns. */
  n: number;
  years: number;
  sampleQuality: SampleQuality;
  medianReturn: Maybe<number>;
  /** Median worst close inside the horizon relative to the anchor close. */
  medianAdverse: Maybe<number>;
  /** Share that closed up the bounce target inside the horizon. Gated like every frequency. */
  recoveryRate: Maybe<Proportion>;
  recoveryHits: number;
  positiveRate: Maybe<Proportion>;
  positiveHits: number;
}

export interface ScanResult {
  date: ISODate;
  horizon: number;
  rows: ScanRow[];
  /** Symbols without a completed bar on the common date, or without a valid monthly state. */
  skipped: { symbol: string; reason: Unavailable }[];
  note: string;
}

/**
 * Describe every supplied series on one common completed date. Rows carry separate transparent
 * metrics. There is deliberately no composite opportunity score.
 */
export const scanMonthlyReversal = (
  inputs: readonly { symbol: string; bars: readonly Bar[] }[],
  date: ISODate,
  options?: Partial<MonthlyReversalOptions>,
  context?: MonthlyContext,
  cohortKind: CohortKind = 'all-months',
): ScanResult => {
  const o = resolveOptions(options);
  const rows: ScanRow[] = [];
  const skipped: ScanResult['skipped'] = [];
  for (const input of inputs) {
    const cut = sliceAsOf(input.bars, date);
    const last = cut[cut.length - 1];
    if (!last || last.date !== date) {
      skipped.push({ symbol: input.symbol, reason: na('missing-session', `No completed bar on ${date}`) });
      continue;
    }
    const study = monthlyReversalStudy(cut, cut.length - 1, o, context, { includeModel: false });
    if (isNa(study)) {
      skipped.push({ symbol: input.symbol, reason: study });
      continue;
    }
    const cohort = cohortOf(study, cohortKind)!;
    const s = cohort.summary;
    const small = na('sample-too-small', `${s.matured} matured months`);
    const pos = statOf(s, 'positive-close');
    const rec = statOf(s, 'target-close');
    const gateOk = pos !== undefined && !isNa(pos.display);
    rows.push({
      symbol: input.symbol,
      anchorDate: date,
      mtdReturn: study.state.mtdReturn,
      negativeShare: study.state.negativeShare,
      downSessions: study.state.down,
      elapsed: study.state.elapsed,
      downStreak: study.state.streak.direction === 'down' ? study.state.streak.length : 0,
      drawdown: study.state.drawdown,
      cohortKind,
      n: s.matured,
      years: s.years,
      sampleQuality: s.matured === 0 ? 'none' : gateOk ? 'adequate' : 'sparse',
      medianReturn: s.returns ? s.returns.median : small,
      medianAdverse: s.adverseClose ? s.adverseClose.median : small,
      recoveryRate: rec ? rec.display : small,
      recoveryHits: rec?.hits ?? 0,
      positiveRate: pos ? pos.display : small,
      positiveHits: pos?.hits ?? 0,
    });
  }
  return {
    date,
    horizon: o.horizon,
    rows,
    skipped,
    note: 'Same completed date for every row. Separate metrics, no composite score. A missing value sorts last.',
  };
};

export type ScanMetric = 'mtdReturn' | 'negativeShare' | 'drawdown' | 'downStreak' | 'medianReturn' | 'medianAdverse' | 'recoveryRate' | 'positiveRate' | 'n';

/** Sort scan rows by one metric. Unavailable values are always last, in either direction. */
export const sortScan = (rows: readonly ScanRow[], metric: ScanMetric, direction: 'asc' | 'desc' = 'asc'): ScanRow[] => {
  const value = (r: ScanRow): number | null => {
    const v = r[metric];
    if (typeof v === 'number') return v;
    if (isNa(v)) return null;
    return (v as Proportion).rate;
  };
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x === null && y === null) return a.symbol.localeCompare(b.symbol);
    if (x === null) return 1;
    if (y === null) return -1;
    if (x === y) return a.symbol.localeCompare(b.symbol);
    return direction === 'asc' ? x - y : y - x;
  });
};
