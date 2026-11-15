/**
 * Shared scientific validation used by every engine that shows a modeled probability.
 *
 * Definitions:
 * - A forecast is issued at a completed session index t for a binary target that matures at
 *   t + horizon. A label at anchor j may be used by anything issued at t only when
 *   j + horizon + embargo < t (strict). That is the training embargo.
 * - Evaluation is chronological. After a burn in, complete blocks of `blockSize` sessions are
 *   scored one after another. Anything fitted for a block uses labels usable at the block start.
 *   Test anchors inside a block sit on a fixed grid (`index % spacing === gridPhase`), so the grid
 *   does not move when later rows are appended.
 * - The comparison baseline is the earlier all days rate: the share of positive labels among every
 *   earlier anchor usable at t. Model and baseline are scored on identical dates and targets.
 * - Brier is mean((p - y)^2). A block beats the baseline only when its Brier is strictly lower.
 * - Calibration bands are fixed tenths of probability. Each band carries hits, n, the mean
 *   prediction and a Wilson interval.
 *
 * Nothing here knows about prices. Engines plug in through a predictor factory.
 */
import { wilson } from './core/stats';
import type { Bar, ISODate, ModelStatus, Proportion } from './core/types';

export type Provenance = 'spec' | 'proposed';

/** Registration record every modeled probability carries. */
export interface ForecastRegistration {
  id: string;
  /** Exact target, for example "C(t+10) > C(t), completed regular session closes". */
  target: string;
  horizonSessions: number;
  /** What the observation timestamp is, for example "after the regular close of session t". */
  observation: string;
  eligibility: string;
  samplingCadence: string;
  split: { burnIn: number; blockSize: number; spacing: number; embargo: number; minBlocks: number; minForecastsPerBlock: number };
  inputs: string[];
  coverage: string;
  fallback: string;
  calibration: string;
  baseline: string;
  thresholds: Record<string, number>;
  version: string;
}

const EPS = 1e-4;

export const clampProb = (p: number, eps = EPS): number => Math.min(1 - eps, Math.max(eps, p));
export const logit = (p: number): number => {
  const q = clampProb(p);
  return Math.log(q / (1 - q));
};
export const sigmoid = (z: number): number => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

// ---------------------------------------------------------------------------------------------
// Shrinkage
// ---------------------------------------------------------------------------------------------

/** Sample size weight n / (n + m). Zero below `minDirect` usable cases. */
export const shrinkWeight = (n: number, priorMass: number, minDirect = 0): number => {
  if (!(n > 0) || n < minDirect) return 0;
  return n / (n + Math.max(0, priorMass));
};

/** Smoothed rate (hits + m x prior) / (n + m). Returns the prior when there is nothing to count. */
export const smoothedRate = (hits: number, n: number, prior: number, priorMass: number): number => {
  const d = n + priorMass;
  return d > 0 ? (hits + priorMass * prior) / d : prior;
};

export interface LevelCount {
  hits: number;
  n: number;
}

export type EvidenceOrigin = 'stock' | 'group' | 'pool' | 'baseline';

export interface HierarchicalEstimate {
  /** Shrunken rate. Equals the baseline when no level has direct weight. */
  rate: number;
  /** Effective weights on each level. They sum to one. `global` is the pooled or baseline anchor. */
  weights: { stock: number; group: number; global: number };
  /** True when at least one level has enough usable cases to contribute directly. */
  direct: boolean;
  /** The most specific level that contributes directly. */
  origin: EvidenceOrigin;
}

/**
 * Stock shrinks to group, group shrinks to global.
 * global = smoothed pool rate toward the baseline (or the baseline when no pool is supplied)
 * group  = w_g x groupRate + (1 - w_g) x global, w_g = n_g / (n_g + m), zero below `minDirect`
 * stock  = w_s x stockRate + (1 - w_s) x group,  w_s = n_s / (n_s + m), zero below `minDirect`
 */
export const hierarchicalShrink = (args: {
  stock: LevelCount;
  group?: LevelCount | null;
  pool?: LevelCount | null;
  baseline: number;
  priorMass: number;
  minDirect: number;
}): HierarchicalEstimate => {
  const { stock, group, pool, baseline, priorMass, minDirect } = args;
  const poolDirect = !!pool && pool.n >= minDirect;
  const global = pool && pool.n > 0 ? smoothedRate(pool.hits, pool.n, baseline, priorMass) : baseline;
  const wg = group ? shrinkWeight(group.n, priorMass, minDirect) : 0;
  const groupEst = wg > 0 && group ? wg * (group.hits / group.n) + (1 - wg) * global : global;
  const ws = shrinkWeight(stock.n, priorMass, minDirect);
  const rate = ws > 0 ? ws * (stock.hits / stock.n) + (1 - ws) * groupEst : groupEst;
  const direct = ws > 0 || wg > 0 || poolDirect;
  const origin: EvidenceOrigin = ws > 0 ? 'stock' : wg > 0 ? 'group' : poolDirect ? 'pool' : 'baseline';
  return { rate, weights: { stock: ws, group: (1 - ws) * wg, global: (1 - ws) * (1 - wg) }, direct, origin };
};

// ---------------------------------------------------------------------------------------------
// Regularized logistic regression and calibration
// ---------------------------------------------------------------------------------------------

export interface LogisticFit {
  weights: number[];
  intercept: number;
  iterations: number;
  n: number;
}

export interface LogisticOptions {
  /** L2 penalty on the weights. The intercept is not penalized unless `interceptL2` is set. */
  l2: number;
  /** Fixed per row offset added to the linear predictor, for example the baseline log odds. */
  offset?: readonly number[];
  fitIntercept?: boolean;
  interceptL2?: number;
  /** Fixed number of Newton steps. Deterministic. */
  iterations?: number;
}

/** Solve A x = b by Gaussian elimination with partial pivoting. Null when singular. */
const solve = (A: number[][], b: number[]): number[] | null => {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r;
    if (Math.abs(M[piv]![c]!) < 1e-12) return null;
    if (piv !== c) [M[piv], M[c]] = [M[c]!, M[piv]!];
    const pr = M[c]!;
    for (let r = c + 1; r < n; r++) {
      const row = M[r]!;
      const f = row[c]! / pr[c]!;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) row[k]! -= f * pr[k]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    const row = M[r]!;
    let s = row[n]!;
    for (let k = r + 1; k < n; k++) s -= row[k]! * x[k]!;
    x[r] = s / row[r]!;
  }
  return x;
};

/**
 * L2 regularized logistic regression fitted with a fixed number of damped Newton steps.
 * Model: P(y = 1) = sigmoid(offset + intercept + w . x). Returns null on empty or ragged input.
 */
export const fitLogistic = (X: readonly (readonly number[])[], y: readonly (0 | 1)[], opts: LogisticOptions): LogisticFit | null => {
  const n = X.length;
  if (n === 0 || y.length !== n) return null;
  const k = X[0]!.length;
  if (X.some((r) => r.length !== k)) return null;
  const useB = opts.fitIntercept ?? false;
  const d = k + (useB ? 1 : 0);
  if (d === 0) return { weights: [], intercept: 0, iterations: 0, n };
  const iters = opts.iterations ?? 25;
  const theta = new Array<number>(d).fill(0);
  const pen = (j: number): number => (useB && j === 0 ? (opts.interceptL2 ?? 0) + 1e-9 : opts.l2 + 1e-9);
  const xr = (i: number, j: number): number => (useB ? (j === 0 ? 1 : X[i]![j - 1]!) : X[i]![j]!);
  for (let it = 0; it < iters; it++) {
    const g = new Array<number>(d).fill(0);
    const H: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
    for (let i = 0; i < n; i++) {
      let z = opts.offset ? opts.offset[i]! : 0;
      for (let j = 0; j < d; j++) z += theta[j]! * xr(i, j);
      const p = sigmoid(z);
      const w = Math.max(1e-9, p * (1 - p));
      const r = y[i]! - p;
      for (let j = 0; j < d; j++) {
        const xj = xr(i, j);
        if (xj === 0) continue;
        g[j]! += r * xj;
        const Hj = H[j]!;
        for (let l = j; l < d; l++) Hj[l]! += w * xj * xr(i, l);
      }
    }
    for (let j = 0; j < d; j++) {
      g[j]! -= pen(j) * theta[j]!;
      H[j]![j]! += pen(j);
      for (let l = 0; l < j; l++) H[j]![l] = H[l]![j]!;
    }
    const step = solve(H, g);
    if (!step) break;
    for (let j = 0; j < d; j++) theta[j]! += Math.max(-4, Math.min(4, step[j]!));
  }
  return { weights: useB ? theta.slice(1) : theta, intercept: useB ? theta[0]! : 0, iterations: iters, n };
};

export const logisticLinear = (fit: LogisticFit, x: readonly number[], offset = 0): number => {
  let z = offset + fit.intercept;
  for (let j = 0; j < fit.weights.length; j++) z += fit.weights[j]! * (x[j] ?? 0);
  return z;
};

export const predictLogistic = (fit: LogisticFit, x: readonly number[], offset = 0): number => sigmoid(logisticLinear(fit, x, offset));

export interface Calibrator {
  slope: number;
  intercept: number;
  n: number;
}

export const CALIBRATION_DEFAULTS = {
  provenance: 'proposed' as Provenance,
  /** Minimum rows in the calibration slice. */
  minSamples: 15,
  /** Small ridge on slope and intercept so separable slices stay finite. */
  l2: 0.01,
};

/**
 * One dimensional Platt style calibration: P = sigmoid(intercept + slope x z) where z is the
 * uncalibrated log odds. Returns null when the slice is too small, has a single class, or the
 * fitted slope is not positive. A model without a positive slope is never shown.
 */
export const fitCalibrator = (
  logits: readonly number[],
  y: readonly (0 | 1)[],
  opts: { minSamples?: number; l2?: number } = {},
): Calibrator | null => {
  const n = logits.length;
  if (n !== y.length || n < (opts.minSamples ?? CALIBRATION_DEFAULTS.minSamples)) return null;
  const ones = y.reduce<number>((s, v) => s + v, 0);
  if (ones === 0 || ones === n) return null;
  const l2 = opts.l2 ?? CALIBRATION_DEFAULTS.l2;
  const fit = fitLogistic(logits.map((z) => [z]), y, { l2, fitIntercept: true, interceptL2: l2, iterations: 30 });
  if (!fit) return null;
  const slope = fit.weights[0]!;
  if (!(slope > 0) || !Number.isFinite(slope) || !Number.isFinite(fit.intercept)) return null;
  return { slope, intercept: fit.intercept, n };
};

export const applyCalibrator = (c: Calibrator, z: number): number => sigmoid(c.intercept + c.slope * z);

// ---------------------------------------------------------------------------------------------
// Chronological block evaluation
// ---------------------------------------------------------------------------------------------

export type Label = 0 | 1 | null;

/** Binary target C(i+h) > C(i). Flat counts as 0. Null when the horizon has not matured. */
export const binaryUpLabels = (closes: readonly number[], h: number): Label[] => {
  const out: Label[] = new Array(closes.length).fill(null);
  for (let i = 0; i + h < closes.length; i++) out[i] = closes[i + h]! > closes[i]! ? 1 : 0;
  return out;
};

export interface BaselineAt {
  rate: number;
  hits: number;
  n: number;
}

/**
 * Earlier all days baseline. Returns a function of the issue index t that gives the positive
 * share among every anchor j with j + horizon + embargo < t. Null when no anchor is usable.
 */
export const makeEarlierBaseline = (labels: readonly Label[], horizon: number, embargo: number): ((t: number) => BaselineAt | null) => {
  const ph = new Int32Array(labels.length + 1);
  const pn = new Int32Array(labels.length + 1);
  for (let i = 0; i < labels.length; i++) {
    ph[i + 1] = ph[i]! + (labels[i] === 1 ? 1 : 0);
    pn[i + 1] = pn[i]! + (labels[i] === null ? 0 : 1);
  }
  return (t: number) => {
    // Usable anchors are 0 .. t - horizon - embargo - 1.
    const end = Math.min(labels.length, Math.max(0, t - horizon - embargo));
    const n = pn[end]!;
    if (n === 0) return null;
    const hits = ph[end]!;
    return { rate: hits / n, hits, n };
  };
};

/** True when the label at anchor j may be used by something issued at index t. */
export const labelUsableAt = (j: number, t: number, horizon: number, embargo: number): boolean => j + horizon + embargo < t;

export interface ChronoConfig {
  /** Sessions before the first evaluation block. */
  burnIn: number;
  blockSize: number;
  /** Test anchors satisfy index % spacing === gridPhase. */
  spacing: number;
  gridPhase?: number;
  horizon: number;
  embargo: number;
  minForecastsPerBlock: number;
  minBlocks: number;
  /** Confidence level for calibration band intervals. */
  level?: number;
}

export interface PredictorContext {
  block: number;
  blockStart: number;
  /** Exclusive end index of the block. */
  blockEnd: number;
  /** True when anchor j's label may be used by anything fitted once for this block. */
  labelUsableForBlock(j: number): boolean;
}

export interface BlockPredictor {
  /** False when the block has no fitted model or calibrator. The block then counts as not ready. */
  ready: boolean;
  reason?: string;
  /** Probability issued at index t, or null when no forecast can be issued there. */
  predict(t: number): number | null;
}

export type PredictorFactory = (ctx: PredictorContext) => BlockPredictor;

export interface ForecastRow {
  index: number;
  date: ISODate;
  block: number;
  p: number;
  baseline: number;
  y: 0 | 1;
}

export interface BlockResult {
  block: number;
  startIndex: number;
  /** Inclusive last index of the block. */
  endIndex: number;
  startDate: ISODate;
  endDate: ISODate;
  /** Predictor fitted and at least `minForecastsPerBlock` spaced forecasts scored. */
  ready: boolean;
  reason?: string;
  forecasts: number;
  /** Grid anchors in the block that produced no forecast (no probability, baseline or matured label). */
  skipped: number;
  brier: number | null;
  baselineBrier: number | null;
  /** Strictly lower Brier than the baseline on the same forecasts. */
  beatsBaseline: boolean;
  observedRate: number | null;
  meanPrediction: number | null;
}

export interface CalibrationBin {
  lo: number;
  hi: number;
  n: number;
  hits: number;
  meanPrediction: number | null;
  observed: Proportion | null;
}

export interface ChronoResult {
  config: ChronoConfig;
  blocks: BlockResult[];
  forecasts: ForecastRow[];
  n: number;
  brier: number | null;
  baselineBrier: number | null;
  observedRate: number | null;
  /** Share of forecasts where the side with probability of at least one half matched the outcome. */
  directionalHits: Proportion | null;
  calibration: CalibrationBin[];
  stability: { blocksTotal: number; blocksReady: number; blocksBeating: number; worstMargin: number | null };
  /** Sessions after the last complete block. They are not scored. */
  trailingSessions: number;
  coverage: { firstForecast: ISODate | null; lastForecast: ISODate | null };
}

export const CALIBRATION_BANDS = 10;

/** Index of the fixed tenth band that contains p. */
export const bandOf = (p: number): number => Math.min(CALIBRATION_BANDS - 1, Math.max(0, Math.floor(p * CALIBRATION_BANDS)));

export const calibrationBins = (rows: readonly { p: number; y: 0 | 1 }[], level = 0.95): CalibrationBin[] => {
  const bins: CalibrationBin[] = Array.from({ length: CALIBRATION_BANDS }, (_, k) => ({
    lo: k / CALIBRATION_BANDS,
    hi: (k + 1) / CALIBRATION_BANDS,
    n: 0,
    hits: 0,
    meanPrediction: null,
    observed: null,
  }));
  const sums = new Array<number>(CALIBRATION_BANDS).fill(0);
  for (const r of rows) {
    const b = bandOf(r.p);
    bins[b]!.n++;
    bins[b]!.hits += r.y;
    sums[b]! += r.p;
  }
  for (let k = 0; k < CALIBRATION_BANDS; k++) {
    const bin = bins[k]!;
    if (bin.n > 0) {
      bin.meanPrediction = sums[k]! / bin.n;
      bin.observed = wilson(bin.hits, bin.n, level);
    }
  }
  return bins;
};

const brierOf = (ps: readonly number[], ys: readonly (0 | 1)[]): number | null => {
  if (ps.length === 0) return null;
  let s = 0;
  for (let i = 0; i < ps.length; i++) s += (ps[i]! - ys[i]!) ** 2;
  return s / ps.length;
};

/**
 * Chronological block evaluation. Only complete blocks are scored. A forecast is scored when the
 * predictor issues a probability, an earlier baseline exists and the label has matured.
 */
export const evaluateChronological = (input: {
  dates: readonly ISODate[];
  labels: readonly Label[];
  config: ChronoConfig;
  makePredictor: PredictorFactory;
}): ChronoResult => {
  const { dates, labels, config, makePredictor } = input;
  const n = dates.length;
  const phase = config.gridPhase ?? 0;
  const baselineAt = makeEarlierBaseline(labels, config.horizon, config.embargo);
  const blocks: BlockResult[] = [];
  const forecasts: ForecastRow[] = [];
  let b = 0;
  let s = config.burnIn;
  for (; s + config.blockSize <= n; s += config.blockSize, b++) {
    const e = s + config.blockSize;
    const predictor = makePredictor({
      block: b,
      blockStart: s,
      blockEnd: e,
      labelUsableForBlock: (j) => labelUsableAt(j, s, config.horizon, config.embargo),
    });
    const ps: number[] = [];
    const bs: number[] = [];
    const ys: (0 | 1)[] = [];
    let skipped = 0;
    for (let t = s; t < e; t++) {
      if (((t % config.spacing) + config.spacing) % config.spacing !== phase) continue;
      const y = labels[t];
      const base = baselineAt(t);
      const p = predictor.ready && y !== null && y !== undefined && base ? predictor.predict(t) : null;
      if (p === null || y === null || y === undefined || !base || !Number.isFinite(p)) {
        skipped++;
        continue;
      }
      ps.push(p);
      bs.push(base.rate);
      ys.push(y);
      forecasts.push({ index: t, date: dates[t]!, block: b, p, baseline: base.rate, y });
    }
    const mb = brierOf(ps, ys);
    const bb = brierOf(bs, ys);
    const enough = ps.length >= config.minForecastsPerBlock;
    const ready = predictor.ready && enough;
    blocks.push({
      block: b,
      startIndex: s,
      endIndex: e - 1,
      startDate: dates[s]!,
      endDate: dates[e - 1]!,
      ready,
      reason: !predictor.ready
        ? (predictor.reason ?? 'No fitted model for this block')
        : !enough
          ? `Only ${ps.length} spaced forecasts, needs ${config.minForecastsPerBlock}`
          : undefined,
      forecasts: ps.length,
      skipped,
      brier: mb,
      baselineBrier: bb,
      beatsBaseline: mb !== null && bb !== null && mb < bb,
      observedRate: ys.length ? ys.reduce<number>((a, v) => a + v, 0) / ys.length : null,
      meanPrediction: ps.length ? ps.reduce((a, v) => a + v, 0) / ps.length : null,
    });
  }
  const allP = forecasts.map((f) => f.p);
  const allY = forecasts.map((f) => f.y);
  const dirHits = forecasts.filter((f) => (f.p >= 0.5 ? 1 : 0) === f.y).length;
  const ready = blocks.filter((x) => x.ready);
  const margins = ready.filter((x) => x.brier !== null && x.baselineBrier !== null).map((x) => x.baselineBrier! - x.brier!);
  return {
    config,
    blocks,
    forecasts,
    n: forecasts.length,
    brier: brierOf(allP, allY),
    baselineBrier: brierOf(forecasts.map((f) => f.baseline), allY),
    observedRate: allY.length ? allY.reduce<number>((a, v) => a + v, 0) / allY.length : null,
    directionalHits: wilson(dirHits, forecasts.length, config.level ?? 0.95),
    calibration: calibrationBins(forecasts, config.level ?? 0.95),
    stability: {
      blocksTotal: blocks.length,
      blocksReady: ready.length,
      blocksBeating: ready.filter((x) => x.beatsBaseline).length,
      worstMargin: margins.length ? Math.min(...margins) : null,
    },
    trailingSessions: Math.max(0, n - s),
    coverage: { firstForecast: forecasts[0]?.date ?? null, lastForecast: forecasts[forecasts.length - 1]?.date ?? null },
  };
};

// ---------------------------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------------------------

export interface GateCheck {
  ok: boolean;
  /** Status to return when the check fails. */
  status: Exclude<ModelStatus, 'valid'>;
  reason: string;
}

export interface GateInput {
  /** Data gate result. Anything other than ok disables the model before evidence is read. */
  data?: { status: 'ok' | 'stale' | 'unavailable'; reason?: string };
  result: ChronoResult | null;
  minBlocks: number;
  /** Probability about to be shown. Checked against its calibration band. */
  issuedProbability?: number | null;
  /** Minimum scored forecasts in the calibration band of the issued probability. */
  minBandSupport?: number;
  /** Engine specific checks, evaluated in order after block support. */
  checks?: GateCheck[];
}

export interface GateResult {
  status: ModelStatus;
  reasons: string[];
}

export const GATE_DEFAULTS = { provenance: 'proposed' as Provenance, minBandSupport: 10 };

/**
 * Decide whether a modeled probability may be shown.
 * 1. Data gate: stale or unavailable.
 * 2. Support: fewer than `minBlocks` complete blocks, any block not ready, or a failed
 *    insufficient-evidence check gives insufficient-evidence.
 * 3. Skill: any ready block that does not strictly beat the baseline gives not-reliable.
 * 4. Calibration shape: the band of the issued probability needs support, and its Wilson interval
 *    must contain both the band mean prediction and the issued probability.
 */
export const gateModel = (input: GateInput): GateResult => {
  if (input.data && input.data.status !== 'ok') {
    return { status: input.data.status, reasons: [input.data.reason ?? 'Required data did not pass its freshness gate'] };
  }
  const r = input.result;
  if (!r) return { status: 'insufficient-evidence', reasons: ['No chronological evaluation is available'] };
  const insufficient: string[] = [];
  if (r.blocks.length < input.minBlocks) {
    insufficient.push(`Only ${r.blocks.length} complete evaluation blocks, needs ${input.minBlocks}`);
  }
  for (const b of r.blocks) if (!b.ready) insufficient.push(`Block ${b.startDate} to ${b.endDate}. ${b.reason ?? 'Not ready'}`);
  for (const c of input.checks ?? []) if (!c.ok && c.status === 'insufficient-evidence') insufficient.push(c.reason);
  if (insufficient.length) return { status: 'insufficient-evidence', reasons: insufficient };
  const other = (input.checks ?? []).find((c) => !c.ok);
  if (other) return { status: other.status, reasons: [other.reason] };
  const losing = r.blocks.filter((b) => !b.beatsBaseline);
  if (losing.length) {
    return {
      status: 'not-reliable',
      reasons: losing.map(
        (b) => `Block ${b.startDate} to ${b.endDate} did not beat the earlier all days baseline. Brier ${b.brier?.toFixed(4)} against ${b.baselineBrier?.toFixed(4)}`,
      ),
    };
  }
  const p = input.issuedProbability;
  if (p !== undefined && p !== null) {
    const bin = r.calibration[bandOf(p)]!;
    const minSupport = input.minBandSupport ?? GATE_DEFAULTS.minBandSupport;
    if (bin.n < minSupport || !bin.observed || bin.meanPrediction === null) {
      return {
        status: 'insufficient-evidence',
        reasons: [`Only ${bin.n} held out forecasts in the ${Math.round(bin.lo * 100)}% to ${Math.round(bin.hi * 100)}% band, needs ${minSupport}`],
      };
    }
    const inside = (v: number): boolean => v >= bin.observed!.lo && v <= bin.observed!.hi;
    if (!inside(bin.meanPrediction) || !inside(p)) {
      return {
        status: 'not-reliable',
        reasons: [
          `Calibration band ${Math.round(bin.lo * 100)}% to ${Math.round(bin.hi * 100)}% observed ${bin.hits} of ${bin.n}. ` +
            'Its interval does not contain the band mean prediction and the issued probability',
        ],
      };
    }
  }
  return { status: 'valid', reasons: [] };
};

// ---------------------------------------------------------------------------------------------
// Metamorphic test utilities
// ---------------------------------------------------------------------------------------------

/** Multiply every price by one factor. Volume is unchanged. Use a power of two for exact floats. */
export const scaleBars = (bars: readonly Bar[], factor: number): Bar[] =>
  bars.map((b) => ({ ...b, open: b.open * factor, high: b.high * factor, low: b.low * factor, close: b.close * factor }));

/** Replace every row after `cut` with a deterministic different path. Rows 0..cut are untouched. */
export const perturbFuture = (bars: readonly Bar[], cut: number): Bar[] =>
  bars.map((b, i) => {
    if (i <= cut) return b;
    const f = 1 + 0.35 * Math.sin(i * 1.7) + 0.2 * Math.cos(i * 0.31);
    return { ...b, open: b.open * f, high: b.high * f, low: b.low * f, close: b.close * f };
  });

/**
 * No look ahead check. `compute` runs once on rows 0..cut and once on the full series.
 * `project` extracts the part of a result that describes rows 0..cut. The two projections must be
 * identical. Throws with the first difference otherwise.
 */
export const assertNoLookAhead = <T>(
  compute: (bars: readonly Bar[]) => T,
  project: (result: T, cut: number) => unknown,
  bars: readonly Bar[],
  cut: number,
): void => {
  const a = JSON.stringify(project(compute(bars.slice(0, cut + 1)), cut));
  const b = JSON.stringify(project(compute(bars), cut));
  if (a !== b) {
    let k = 0;
    while (k < a.length && a[k] === b[k]) k++;
    throw new Error(`Look ahead detected at cut ${cut}. Prefix result differs near "${a.slice(Math.max(0, k - 40), k + 40)}" against "${b.slice(Math.max(0, k - 40), k + 40)}"`);
  }
};
