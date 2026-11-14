/**
 * Signal Score (owner specification section 16).
 *
 * Target. For N = 5, 10 and 20 completed sessions, Buy percent estimates P(C(t+N) > C(t)) where t
 * is the latest completed session. Sell percent is 1 - Buy and includes flat closes, so it reads
 * "no higher close". These are directional price outcome names. Nothing here places a trade.
 *
 * Evidence. Each input (signalFeatures.ts) is a discrete state known at the anchor. Its estimate
 * is the share of higher closes among earlier matured cases in the same state. Cases sit on a
 * fixed 21 session grid and a case at anchor j is usable for an issue at t only when
 * j + N + 21 < t. Stock evidence shrinks to dated group evidence, group shrinks to the pooled or
 * baseline rate, with weights n / (n + m). A level with fewer than ten usable cases has zero
 * direct weight. Peers contribute at most one case per calendar date.
 *
 * Combination. A regularized logistic model with the earlier all days baseline log odds as offset
 * and each input's log odds difference from that baseline as a feature. Weights are fitted on the
 * earlier part of the usable grid cases and calibrated on a distinct later slice that still ends
 * before the issue. A calibrator must have a positive slope.
 *
 * Gate. Chronological blocks of 252 sessions after a 1,260 session burn in, at least three blocks.
 * A block with fewer than ten spaced forecasts or without a fitted calibrator gives Insufficient
 * evidence. A ready block that does not strictly beat the earlier all days baseline Brier gives
 * Not reliable. A valid score also needs two usable inputs, ten matches and calibration band
 * support. The data gate runs first: a failed source, an overdue owner check (120 minutes) or
 * lagging completed history gives Stale and no number. A cached score never bypasses it.
 */
import { sessionsBetween } from './core/calendar';
import { forwardOutcome } from './core/outcomes';
import { distribution, median } from './core/stats';
import type { Bar, EarningsEvent, ISODate, ModelStatus, Proportion } from './core/types';
import { buildSignalFeatures, type SignalFeatureSet } from './signalFeatures';
import {
  GATE_DEFAULTS, applyCalibrator, bandOf, binaryUpLabels, evaluateChronological, fitCalibrator, fitLogistic, gateModel, hierarchicalShrink,
  logisticLinear, logit, makeEarlierBaseline, smoothedRate,
  type BaselineAt, type BlockResult, type Calibrator, type CalibrationBin, type EvidenceOrigin, type ForecastRegistration, type ForecastRow,
  type Label, type LevelCount, type LogisticFit, type Provenance,
} from './validation';

export const SIGNAL_MODEL_VERSION = 'signal-score-v1';

export interface SignalConfig {
  horizons: readonly number[];
  spacing: number;
  embargo: number;
  burnIn: number;
  blockSize: number;
  minBlocks: number;
  minForecastsPerBlock: number;
  minDirectCases: number;
  minUsableInputs: number;
  minMatches: number;
  seasonalPriorMass: number;
  freshnessLimitMinutes: number;
  priorMass: number;
  l2: number;
  trainShare: number;
  minTrainRows: number;
  minCalibrationRows: number;
  setupNeighbors: number;
  setupMinDims: number;
  minBandSupport: number;
  maxPeers: number;
  /** Issued and held out probabilities are clamped to [floor, 1 - floor]. No false certainty. */
  probabilityFloor: number;
  level: number;
}

export const SIGNAL_DEFAULTS: SignalConfig = {
  horizons: [5, 10, 20],
  spacing: 21,
  embargo: 21,
  burnIn: 1260,
  blockSize: 252,
  minBlocks: 3,
  minForecastsPerBlock: 10,
  minDirectCases: 10,
  minUsableInputs: 2,
  minMatches: 10,
  seasonalPriorMass: 100,
  freshnessLimitMinutes: 120,
  priorMass: 20,
  l2: 2,
  trainShare: 0.7,
  minTrainRows: 30,
  minCalibrationRows: 15,
  setupNeighbors: 15,
  setupMinDims: 4,
  minBandSupport: GATE_DEFAULTS.minBandSupport,
  maxPeers: 12,
  probabilityFloor: 0.01,
  level: 0.95,
};

/** Where each default comes from. Proposed values need reconciling with the reference source. */
export const SIGNAL_PROVENANCE: Record<keyof SignalConfig, Provenance> = {
  horizons: 'spec',
  spacing: 'spec',
  embargo: 'spec',
  burnIn: 'spec',
  blockSize: 'spec',
  minBlocks: 'spec',
  minForecastsPerBlock: 'spec',
  minDirectCases: 'spec',
  minUsableInputs: 'spec',
  minMatches: 'spec',
  seasonalPriorMass: 'spec',
  freshnessLimitMinutes: 'spec',
  priorMass: 'proposed',
  l2: 'proposed',
  trainShare: 'proposed',
  minTrainRows: 'proposed',
  minCalibrationRows: 'proposed',
  setupNeighbors: 'proposed',
  setupMinDims: 'proposed',
  minBandSupport: 'proposed',
  maxPeers: 'proposed',
  probabilityFloor: 'proposed',
  level: 'spec',
};

// ---------------------------------------------------------------------------------------------
// Data gate
// ---------------------------------------------------------------------------------------------

export interface SignalDataHealth {
  /** True when any source the score depends on failed its latest check. */
  sourceFailed: boolean;
  failure?: string;
  /** ISO timestamp of the last validated owner data check, or null when there has been none. */
  lastGoodCheckAt: string | null;
  /** Latest completed session the exchange calendar expects. */
  expectedLatestSession: ISODate;
  /** Latest completed session actually present in the required history. */
  presentLatestSession: ISODate | null;
}

export interface SignalDataGate {
  status: 'ok' | 'stale' | 'unavailable';
  reason?: string;
  lastGoodCheckAt: string | null;
  ageMinutes: number | null;
  limitMinutes: number;
}

/**
 * Pure function of (health, now). Fails closed. Any failure disables the score and reports the
 * last good check time so the view can show "Stale, last good check ...".
 */
export const signalDataGate = (health: SignalDataHealth, now: string, limitMinutes = SIGNAL_DEFAULTS.freshnessLimitMinutes): SignalDataGate => {
  const last = health.lastGoodCheckAt;
  const lastMs = last ? Date.parse(last) : NaN;
  const nowMs = Date.parse(now);
  const base = { lastGoodCheckAt: last, limitMinutes };
  if (!last || Number.isNaN(lastMs) || Number.isNaN(nowMs)) {
    return { ...base, status: 'unavailable', ageMinutes: null, reason: 'No validated data check on record' };
  }
  const age = (nowMs - lastMs) / 60000;
  if (health.sourceFailed) {
    return { ...base, status: 'stale', ageMinutes: age, reason: `A required source failed its latest check${health.failure ? `. ${health.failure}` : ''}. Last good check ${last}` };
  }
  if (!health.presentLatestSession || health.presentLatestSession < health.expectedLatestSession) {
    return {
      ...base,
      status: 'stale',
      ageMinutes: age,
      reason: `Completed history ends ${health.presentLatestSession ?? 'nowhere'}, expected ${health.expectedLatestSession}. Last good check ${last}`,
    };
  }
  if (age < 0 || age > limitMinutes) {
    return { ...base, status: 'stale', ageMinutes: age, reason: `The data check is overdue. Limit ${limitMinutes} minutes. Last good check ${last}` };
  }
  return { ...base, status: 'ok', ageMinutes: age };
};

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

export interface SignalPeer {
  symbol: string;
  bars: readonly Bar[];
  /** 'group' is a dated trading group member. 'pool' is the wider available stock pool. */
  origin: 'group' | 'pool';
  /** First date the instrument is known to belong to the group. Cases before it are not used. */
  memberSince?: ISODate | null;
}

export interface SignalInput {
  symbol: string;
  bars: readonly Bar[];
  spyBars?: readonly Bar[];
  groupBars?: readonly Bar[];
  groupLabel?: string;
  earnings?: readonly EarningsEvent[];
  peers?: readonly SignalPeer[];
  health: SignalDataHealth;
  /** Current instant, ISO timestamp. */
  now: string;
  /** Identifier of the price data revision the score was computed from. */
  dataVersion?: string;
  config?: Partial<SignalConfig>;
}

export interface SignalInputEvidence {
  id: string;
  family: number;
  label: string;
  /** True when the input has a state at the anchor and at least one level with direct weight. */
  active: boolean;
  /** Why the input does not contribute, when it does not. */
  inactiveReason?: string;
  /** Observed state at the anchor. */
  state: string | null;
  /** Raw context in short plain language. */
  context: string;
  own: LevelCount;
  group: LevelCount | null;
  pool: LevelCount | null;
  /** Most specific level with direct weight. */
  origin: EvidenceOrigin;
  /** True when group cases were used without a dated membership start. */
  retrospectiveGroup: boolean;
  /** Shrunken estimate of the target rate for this state. Null when inactive. */
  estimate: number | null;
  /** Effective shrinkage weights on stock, group and global. */
  weights: { stock: number; group: number; global: number } | null;
  /** Fitted coefficient on this input. Null when no model was fitted. */
  coefficient: number | null;
  /** Signed contribution to the uncalibrated log odds. Zero when inactive. */
  contribution: number;
  /** First and last matching own stock case dates. */
  matchRange: { first: ISODate; last: ISODate } | null;
}

export interface SignalComparable {
  /** Which cases these are. */
  source: string;
  n: number;
  median: number;
  p10: number;
  p90: number;
  /** Median of the lowest close inside the horizon relative to the anchor close, floored at zero. */
  medianWorstCloseDrawdown: number;
  /** Same with intraday lows. Daily bars do not order highs and lows inside a session. */
  medianWorstLowDrawdown: number;
  basis: string;
  dates: ISODate[];
}

export interface SignalBlock extends BlockResult {
  /** Exchange sessions inside the block's date span that the series does not contain. */
  calendarSessionsMissing: number;
}

export interface SignalEvaluation {
  forecasts: number;
  blocks: SignalBlock[];
  brier: number | null;
  baselineBrier: number | null;
  /** Share of held out forecasts where the side with probability of at least one half matched. */
  hitRate: Proportion | null;
  hitRateDefinition: string;
  observedRate: number | null;
  calibration: CalibrationBin[];
  rows: ForecastRow[];
  coverage: { historyFrom: ISODate | null; firstForecast: ISODate | null; lastForecast: ISODate | null; trailingSessions: number };
}

export interface SignalHorizonScore {
  horizon: number;
  target: string;
  sellDefinition: string;
  status: ModelStatus;
  reasons: string[];
  /** Buy percent as a fraction. Present only when the status is valid. */
  buy: number | null;
  /** Sell percent as a fraction, 1 - buy. Includes flat closes. */
  sell: number | null;
  /** Observed frequency and Wilson interval of the calibration band that contains the score. */
  interval: Proportion | null;
  /** Earlier all days rate at the anchor. */
  baseline: BaselineAt | null;
  usableInputs: number;
  /** Distinct historical cases behind the active inputs. One case is counted once. */
  matches: number;
  comparable: SignalComparable | null;
  evaluation: SignalEvaluation | null;
  evidence: SignalInputEvidence[];
  registration: ForecastRegistration;
}

export interface SignalScore {
  symbol: string;
  asOf: ISODate | null;
  modelVersion: string;
  dataVersion: string | null;
  gate: SignalDataGate;
  horizons: SignalHorizonScore[];
}

const targetText = (h: number): string => `Close after ${h} completed sessions above the anchor close`;
const sellText = (h: number): string => `No higher close after ${h} completed sessions. Includes flat closes`;

export const signalRegistration = (horizon: number, cfg: SignalConfig = SIGNAL_DEFAULTS): ForecastRegistration => ({
  id: `signal-score-${horizon}`,
  target: `C(t+${horizon}) > C(t) on completed regular session closes, split consistent quote basis`,
  horizonSessions: horizon,
  observation: 'After the regular close of the latest completed session t',
  eligibility: `History of at least ${cfg.burnIn + cfg.minBlocks * cfg.blockSize} completed sessions and a passing data gate`,
  samplingCadence: `Cases and held out forecasts on a fixed ${cfg.spacing} session grid`,
  split: { burnIn: cfg.burnIn, blockSize: cfg.blockSize, spacing: cfg.spacing, embargo: cfg.embargo, minBlocks: cfg.minBlocks, minForecastsPerBlock: cfg.minForecastsPerBlock },
  inputs: ['Moving average runs', '200 day cross', 'Selloff depth', 'Drawdown episode count', 'Year to date placement', 'Big decline recency', 'RSI14 rank', 'Relative volume', 'Seasonality', 'Earnings proximity', 'Market and group context', 'Setup matches'],
  coverage: 'Own completed daily history. Optional SPY, group reference, dated peers and point in time earnings',
  fallback: 'No number. Status and the descriptive evidence are shown',
  calibration: 'Logistic calibration on a distinct earlier slice, positive slope required',
  baseline: 'Earlier all days rate of the same target on the same dates',
  thresholds: {
    minDirectCases: cfg.minDirectCases,
    minUsableInputs: cfg.minUsableInputs,
    minMatches: cfg.minMatches,
    minBandSupport: cfg.minBandSupport,
    freshnessLimitMinutes: cfg.freshnessLimitMinutes,
  },
  version: SIGNAL_MODEL_VERSION,
});

// ---------------------------------------------------------------------------------------------
// Evidence engine
// ---------------------------------------------------------------------------------------------

interface PeerCase {
  usableDate: ISODate;
  date: ISODate;
  peer: number;
  j: number;
  y: 0 | 1;
}

interface LevelState {
  hits: Int32Array;
  n: Int32Array;
  keys: string[][];
  seen: Set<ISODate>;
  ptr: number;
}

interface LiveDetail {
  bucket: number;
  own: LevelCount;
  group: LevelCount | null;
  pool: LevelCount | null;
  origin: EvidenceOrigin;
  direct: boolean;
  estimate: number | null;
  weights: { stock: number; group: number; global: number } | null;
  ownCases: number[];
  caseKeys: string[];
  retrospectiveGroup: boolean;
  context?: string;
  state?: string | null;
}

interface PeerSet {
  peers: readonly SignalPeer[];
  features: SignalFeatureSet[];
}

const peerCases = (set: PeerSet, origin: 'group' | 'pool', h: number, cfg: SignalConfig): PeerCase[] => {
  const out: PeerCase[] = [];
  set.peers.forEach((p, pi) => {
    if (p.origin !== origin) return;
    const f = set.features[pi]!;
    for (let j = 0; j + h + cfg.embargo + 1 < f.n; j += cfg.spacing) {
      const date = f.dates[j]!;
      if (origin === 'group' && p.memberSince && date < p.memberSince) continue;
      out.push({ usableDate: f.dates[j + h + cfg.embargo + 1]!, date, peer: pi, j, y: f.closes[j + h]! > f.closes[j]! ? 1 : 0 });
    }
  });
  return out.sort((a, b) => (a.usableDate < b.usableDate ? -1 : a.usableDate > b.usableDate ? 1 : a.peer - b.peer));
};

interface HorizonEvidence {
  issues: number[];
  /** x[k][q]: log odds difference from the baseline for input k at issue q. Zero when inactive. */
  x: Float64Array[];
  baseline: (BaselineAt | null)[];
  live: LiveDetail[];
  setupNeighbors: number[];
}

const buildEvidence = (
  f: SignalFeatureSet,
  labels: readonly Label[],
  h: number,
  cfg: SignalConfig,
  peers: PeerSet,
): HorizonEvidence => {
  const n = f.n;
  const grid: number[] = [];
  for (let i = 0; i < n; i += cfg.spacing) grid.push(i);
  const issues = grid[grid.length - 1] === n - 1 ? [...grid] : [...grid, n - 1];
  const Q = issues.length;
  const baselineAt = makeEarlierBaseline(labels, h, cfg.embargo);
  const baseline = issues.map((t) => baselineAt(t));
  const groupCases = peerCases(peers, 'group', h, cfg);
  const poolCases = peerCases(peers, 'pool', h, cfg);
  const retrospective = peers.peers.some((p) => p.origin === 'group' && !p.memberSince);
  const x: Float64Array[] = [];
  const live: LiveDetail[] = [];

  f.inputs.forEach((inp, k) => {
    const B = inp.bucketLabels.length;
    const xs = new Float64Array(Q);
    const ownHits = new Int32Array(B);
    const ownN = new Int32Array(B);
    const ownCases: number[][] = Array.from({ length: B }, () => []);
    const mk = (): LevelState => ({ hits: new Int32Array(B), n: new Int32Array(B), keys: Array.from({ length: B }, () => []), seen: new Set(), ptr: 0 });
    const gs = mk();
    const ps = mk();
    const advance = (st: LevelState, cases: PeerCase[], D: ISODate) => {
      while (st.ptr < cases.length && cases[st.ptr]!.usableDate <= D) {
        const c = cases[st.ptr++]!;
        if (st.seen.has(c.date)) continue; // one representative per calendar date
        const b = peers.features[c.peer]!.inputs[k]!.buckets[c.j]!;
        if (b < 0) continue;
        st.seen.add(c.date);
        st.n[b]!++;
        st.hits[b]! += c.y;
        st.keys[b]!.push(`${peers.peers[c.peer]!.symbol}|${c.date}`);
      }
    };
    const m = inp.seasonal ? Math.max(cfg.seasonalPriorMass, cfg.priorMass) : cfg.priorMass;
    let gp = 0;
    let detail: LiveDetail = { bucket: -1, own: { hits: 0, n: 0 }, group: null, pool: null, origin: 'baseline', direct: false, estimate: null, weights: null, ownCases: [], caseKeys: [], retrospectiveGroup: false };
    for (let q = 0; q < Q; q++) {
      const t = issues[q]!;
      while (gp < grid.length && grid[gp]! + h + cfg.embargo < t) {
        const j = grid[gp++]!;
        const b = inp.buckets[j]!;
        const y = labels[j];
        if (b >= 0 && y !== null && y !== undefined) {
          ownN[b]!++;
          ownHits[b]! += y;
          ownCases[b]!.push(j);
        }
      }
      const D = f.dates[t]!;
      if (groupCases.length) advance(gs, groupCases, D);
      if (poolCases.length) advance(ps, poolCases, D);
      const base = baseline[q];
      const b = inp.buckets[t]!;
      if (!base || b < 0) continue;
      const own = { hits: ownHits[b]!, n: ownN[b]! };
      const group = groupCases.length ? { hits: gs.hits[b]!, n: gs.n[b]! } : null;
      const pool = poolCases.length ? { hits: ps.hits[b]!, n: ps.n[b]! } : null;
      const est = hierarchicalShrink({ stock: own, group, pool, baseline: base.rate, priorMass: m, minDirect: cfg.minDirectCases });
      if (est.direct) xs[q] = logit(est.rate) - logit(base.rate);
      if (q === Q - 1) {
        const keys = ownCases[b]!.map((j) => `own|${f.dates[j]}`);
        if (group && est.weights.group > 0) keys.push(...gs.keys[b]!);
        if (pool && pool.n >= cfg.minDirectCases) keys.push(...ps.keys[b]!);
        detail = {
          bucket: b,
          own,
          group,
          pool,
          origin: est.origin,
          direct: est.direct,
          estimate: est.direct ? est.rate : null,
          weights: est.direct ? est.weights : null,
          ownCases: [...ownCases[b]!],
          caseKeys: est.direct ? keys : [],
          retrospectiveGroup: retrospective && est.weights.group > 0,
        };
      }
    }
    x.push(xs);
    live.push(detail);
  });

  // Input 12: closest earlier setups on the trailing percentile dimensions. Own stock only.
  const dims = f.setupDims;
  const xs = new Float64Array(Q);
  let setupNeighbors: number[] = [];
  let setupDetail: LiveDetail = { bucket: -1, own: { hits: 0, n: 0 }, group: null, pool: null, origin: 'baseline', direct: false, estimate: null, weights: null, ownCases: [], caseKeys: [], retrospectiveGroup: false };
  for (let q = 0; q < Q; q++) {
    const t = issues[q]!;
    const base = baseline[q];
    if (!base) continue;
    const cand: { j: number; d: number }[] = [];
    for (const j of grid) {
      if (j + h + cfg.embargo >= t) break;
      let s = 0;
      let c = 0;
      for (const dim of dims) {
        const a = dim.pct[t]!;
        const b = dim.pct[j]!;
        if (Number.isNaN(a) || Number.isNaN(b)) continue;
        s += Math.abs(a - b);
        c++;
      }
      if (c >= cfg.setupMinDims) cand.push({ j, d: s / c });
    }
    cand.sort((a, b) => a.d - b.d || a.j - b.j);
    const top = cand.slice(0, cfg.setupNeighbors);
    if (top.length < cfg.minDirectCases) {
      if (q === Q - 1) setupDetail = { ...setupDetail, context: `Only ${top.length} earlier setups with at least ${cfg.setupMinDims} shared dimensions, needs ${cfg.minDirectCases}` };
      continue;
    }
    let hits = 0;
    for (const c of top) hits += labels[c.j] === 1 ? 1 : 0;
    const rate = smoothedRate(hits, top.length, base.rate, cfg.priorMass);
    xs[q] = logit(rate) - logit(base.rate);
    if (q === Q - 1) {
      setupNeighbors = top.map((c) => c.j).sort((a, b) => a - b);
      const w = top.length / (top.length + cfg.priorMass);
      setupDetail = {
        bucket: 0,
        own: { hits, n: top.length },
        group: null,
        pool: null,
        origin: 'stock',
        direct: true,
        estimate: rate,
        weights: { stock: w, group: 0, global: 1 - w },
        ownCases: setupNeighbors,
        caseKeys: setupNeighbors.map((j) => `own|${f.dates[j]}`),
        retrospectiveGroup: false,
        state: `Closest ${top.length} earlier setups`,
        context: `Closest ${top.length} earlier setups on ${dims.length} trailing percentile dimensions, mean distance ${(top.reduce((a, c) => a + c.d, 0) / top.length).toFixed(3)}`,
      };
    }
  }
  x.push(xs);
  live.push(setupDetail);
  return { issues, x, baseline, live, setupNeighbors };
};

// ---------------------------------------------------------------------------------------------
// Model fitting
// ---------------------------------------------------------------------------------------------

interface FittedModel {
  fit: LogisticFit;
  calibrator: Calibrator;
  trainRows: number;
  calibrationRows: number;
}

type FitOutcome = { model: FittedModel } | { model: null; reason: string };

const makeFitter = (ev: HorizonEvidence, labels: readonly Label[], h: number, cfg: SignalConfig) => {
  const K = ev.x.length;
  const row = (q: number): number[] => {
    const r = new Array<number>(K);
    for (let k = 0; k < K; k++) r[k] = ev.x[k]![q]!;
    return r;
  };
  const offset = (q: number): number => logit(ev.baseline[q]!.rate);
  const indexToQ = new Map<number, number>(ev.issues.map((t, q) => [t, q]));
  /** Fit weights and calibrator from grid rows whose labels are usable at issue index tIssue. */
  const fitAt = (tIssue: number): FitOutcome => {
    const qs: number[] = [];
    for (let q = 0; q < ev.issues.length; q++) {
      const j = ev.issues[q]!;
      if (j + h + cfg.embargo >= tIssue) break;
      if (j % cfg.spacing !== 0) continue;
      if (labels[j] === null || labels[j] === undefined || !ev.baseline[q]) continue;
      qs.push(q);
    }
    const split = Math.floor(qs.length * cfg.trainShare);
    const train = qs.slice(0, split);
    const calib = qs.slice(split);
    if (train.length < cfg.minTrainRows || calib.length < cfg.minCalibrationRows) {
      return { model: null, reason: `Only ${train.length} training and ${calib.length} calibration cases, needs ${cfg.minTrainRows} and ${cfg.minCalibrationRows}` };
    }
    const fit = fitLogistic(train.map(row), train.map((q) => labels[ev.issues[q]!] as 0 | 1), { l2: cfg.l2, offset: train.map(offset) });
    if (!fit) return { model: null, reason: 'The weight fit did not complete' };
    const z = calib.map((q) => logisticLinear(fit, row(q), offset(q)));
    const calibrator = fitCalibrator(z, calib.map((q) => labels[ev.issues[q]!] as 0 | 1), { minSamples: cfg.minCalibrationRows });
    if (!calibrator) return { model: null, reason: 'No calibrator with a positive slope on the earlier calibration slice' };
    return { model: { fit, calibrator, trainRows: train.length, calibrationRows: calib.length } };
  };
  const predict = (m: FittedModel, q: number): number =>
    Math.min(1 - cfg.probabilityFloor, Math.max(cfg.probabilityFloor, applyCalibrator(m.calibrator, logisticLinear(m.fit, row(q), offset(q)))));
  return { fitAt, predict, indexToQ, row };
};

// ---------------------------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------------------------

const withheld = (h: number, cfg: SignalConfig, status: ModelStatus, reasons: string[]): SignalHorizonScore => ({
  horizon: h,
  target: targetText(h),
  sellDefinition: sellText(h),
  status,
  reasons,
  buy: null,
  sell: null,
  interval: null,
  baseline: null,
  usableInputs: 0,
  matches: 0,
  comparable: null,
  evaluation: null,
  evidence: [],
  registration: signalRegistration(h, cfg),
});

const scoreHorizon = (input: SignalInput, f: SignalFeatureSet, peers: PeerSet, h: number, cfg: SignalConfig): SignalHorizonScore => {
  const n = f.n;
  const labels = binaryUpLabels(Array.from(f.closes), h);
  const ev = buildEvidence(f, labels, h, cfg, peers);
  const fitter = makeFitter(ev, labels, h, cfg);
  const liveQ = ev.issues.length - 1;

  const result = evaluateChronological({
    dates: f.dates,
    labels,
    config: { burnIn: cfg.burnIn, blockSize: cfg.blockSize, spacing: cfg.spacing, horizon: h, embargo: cfg.embargo, minForecastsPerBlock: cfg.minForecastsPerBlock, minBlocks: cfg.minBlocks, level: cfg.level },
    makePredictor: (ctx) => {
      const out = fitter.fitAt(ctx.blockStart);
      if (!out.model) return { ready: false, reason: out.reason, predict: () => null };
      const m = out.model;
      return { ready: true, predict: (t) => { const q = fitter.indexToQ.get(t); return q === undefined ? null : fitter.predict(m, q); } };
    },
  });

  const liveFit = n > 0 && ev.baseline[liveQ] ? fitter.fitAt(n - 1) : ({ model: null, reason: 'No earlier matured cases at the anchor' } as FitOutcome);
  const model = liveFit.model;
  const p = model ? fitter.predict(model, liveQ) : null;

  // Evidence rows at the anchor.
  const inputMeta = [
    ...f.inputs.map((inp) => ({ id: inp.id, family: inp.family, label: inp.label })),
    { id: 'setupMatches', family: 12, label: 'Closest earlier setups' },
  ];
  const evidence: SignalInputEvidence[] = ev.live.map((d, k) => {
    const meta = inputMeta[k]!;
    const inp = f.inputs[k];
    const xk = ev.x[k]![liveQ]!;
    const coef = model ? (model.fit.weights[k] ?? 0) : null;
    const state = inp ? (d.bucket >= 0 ? (inp.bucketLabels[d.bucket] ?? null) : null) : (d.state ?? null);
    const context = inp ? (n > 0 ? inp.context(n - 1) : 'No completed sessions') : (d.context ?? 'No earlier setups to compare');
    let inactiveReason: string | undefined;
    if (!d.direct) {
      inactiveReason =
        d.bucket < 0
          ? 'No valid state at the anchor'
          : `Only ${d.own.n} own stock cases in this state${d.group ? `, ${d.group.n} group cases` : ''}${d.pool ? `, ${d.pool.n} pooled cases` : ''}. Needs ${cfg.minDirectCases} at one level`;
    }
    return {
      id: meta.id,
      family: meta.family,
      label: meta.label,
      active: d.direct,
      inactiveReason,
      state,
      context,
      own: d.own,
      group: d.group,
      pool: d.pool,
      origin: d.origin,
      retrospectiveGroup: d.retrospectiveGroup,
      estimate: d.estimate,
      weights: d.weights,
      coefficient: coef,
      contribution: d.direct && coef !== null ? coef * xk : 0,
      matchRange: d.ownCases.length ? { first: f.dates[d.ownCases[0]!]!, last: f.dates[d.ownCases[d.ownCases.length - 1]!]! } : null,
    };
  });
  const order = evidence.map((e, k) => ({ e, k })).sort((a, b) => Number(b.e.active) - Number(a.e.active) || Math.abs(b.e.contribution) - Math.abs(a.e.contribution) || a.k - b.k);
  const usableInputs = evidence.filter((e) => e.active).length;
  const matchKeys = new Set<string>();
  for (const d of ev.live) if (d.direct) for (const key of d.caseKeys) matchKeys.add(key);

  // Comparable cases for the return distribution.
  let comparable: SignalComparable | null = null;
  const setup = ev.live[ev.live.length - 1]!;
  let compIdx: number[] = [];
  let compSource = '';
  if (setup.direct) {
    compIdx = ev.setupNeighbors;
    compSource = 'Closest earlier setups of this stock';
  } else {
    const top = order.find((o) => o.e.active && ev.live[o.k]!.ownCases.length >= cfg.minDirectCases);
    if (top) {
      compIdx = ev.live[top.k]!.ownCases;
      compSource = `Earlier sessions of this stock in the same state. ${top.e.state ?? top.e.label}`;
    }
  }
  if (compIdx.length) {
    const outs = compIdx.map((j) => forwardOutcome(input.bars, j, h)).filter((o): o is Exclude<typeof o, { unavailable: true }> => !('unavailable' in o));
    const dist = distribution(outs.map((o) => o.ret));
    if (dist) {
      comparable = {
        source: compSource,
        n: dist.n,
        median: dist.median,
        p10: dist.p10,
        p90: dist.p90,
        medianWorstCloseDrawdown: median(outs.map((o) => Math.min(0, o.minCloseRet))),
        medianWorstLowDrawdown: median(outs.map((o) => Math.min(0, o.minLowRet))),
        basis: `Entry at the anchor close, sessions 1 to ${h} after it, split consistent quote prices`,
        dates: outs.map((o) => o.anchorDate),
      };
    }
  }

  const gate = gateModel({
    result,
    minBlocks: cfg.minBlocks,
    issuedProbability: p,
    minBandSupport: cfg.minBandSupport,
    checks: [
      { ok: model !== null, status: 'insufficient-evidence', reason: liveFit.model ? '' : liveFit.reason },
      { ok: usableInputs >= cfg.minUsableInputs, status: 'insufficient-evidence', reason: `Only ${usableInputs} usable inputs at the anchor, needs ${cfg.minUsableInputs}` },
      { ok: matchKeys.size >= cfg.minMatches, status: 'insufficient-evidence', reason: `Only ${matchKeys.size} matching cases at the anchor, needs ${cfg.minMatches}` },
    ],
  });
  const valid = gate.status === 'valid' && p !== null;
  const band = p !== null ? result.calibration[bandOf(p)] : undefined;

  return {
    horizon: h,
    target: targetText(h),
    sellDefinition: sellText(h),
    status: gate.status,
    reasons: gate.reasons,
    buy: valid ? p : null,
    sell: valid ? 1 - p : null,
    interval: valid && band ? band.observed : null,
    baseline: ev.baseline[liveQ] ?? null,
    usableInputs,
    matches: matchKeys.size,
    comparable,
    evaluation: {
      forecasts: result.n,
      blocks: result.blocks.map((b) => ({ ...b, calendarSessionsMissing: Math.max(0, sessionsBetween(b.startDate, b.endDate).length - (b.endIndex - b.startIndex + 1)) })),
      brier: result.brier,
      baselineBrier: result.baselineBrier,
      hitRate: result.directionalHits,
      hitRateDefinition: 'Share of held out forecasts where the side with a probability of at least one half matched the outcome, higher close against no higher close',
      observedRate: result.observedRate,
      calibration: result.calibration,
      rows: result.forecasts,
      coverage: { historyFrom: f.dates[0] ?? null, firstForecast: result.coverage.firstForecast, lastForecast: result.coverage.lastForecast, trailingSessions: result.trailingSessions },
    },
    evidence: order.map((o) => o.e),
    registration: signalRegistration(h, cfg),
  };
};

/**
 * Compute the Signal Score for the latest completed session of `bars`.
 * Withholding every horizon is a normal result.
 */
export const computeSignalScore = (input: SignalInput): SignalScore => {
  const cfg: SignalConfig = { ...SIGNAL_DEFAULTS, ...input.config };
  const last = input.bars.length ? input.bars[input.bars.length - 1]!.date : null;
  let gate = signalDataGate(input.health, input.now, cfg.freshnessLimitMinutes);
  // The series passed in must itself reach the expected session. Health metadata alone is not enough.
  if (gate.status === 'ok' && (!last || last < input.health.expectedLatestSession)) {
    gate = { ...gate, status: 'stale', reason: `Completed history ends ${last ?? 'nowhere'}, expected ${input.health.expectedLatestSession}. Last good check ${gate.lastGoodCheckAt}` };
  }
  const head = { symbol: input.symbol, asOf: last, modelVersion: SIGNAL_MODEL_VERSION, dataVersion: input.dataVersion ?? null, gate };
  if (gate.status !== 'ok') {
    return { ...head, horizons: cfg.horizons.map((h) => withheld(h, cfg, gate.status === 'stale' ? 'stale' : 'unavailable', [gate.reason ?? 'Data gate failed'])) };
  }
  const f = buildSignalFeatures({ bars: input.bars, spyBars: input.spyBars, groupBars: input.groupBars, groupLabel: input.groupLabel, earnings: input.earnings });
  const peerList = (input.peers ?? []).filter((p) => p.symbol !== input.symbol && p.bars.length > 0).slice(0, cfg.maxPeers);
  const peers: PeerSet = {
    peers: peerList,
    features: peerList.map((p) => buildSignalFeatures({ bars: p.bars, spyBars: input.spyBars, groupBars: input.groupBars, groupLabel: input.groupLabel })),
  };
  return { ...head, horizons: cfg.horizons.map((h) => scoreHorizon(input, f, peers, h, cfg)) };
};
