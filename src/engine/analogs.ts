/**
 * Shared historical analog service (owner specification section 9).
 *
 * One service, two entry points:
 * - `findAnalogs`  closest condition matching. Ranks earlier sessions by how close their setup was
 *                  to the query session.
 * - `searchByConditions`  threshold driven search. Keeps earlier sessions that meet explicit rules.
 * Both return the same result shape with dated cases, aligned paths, outcomes and denominators.
 *
 * Definitions
 * - Features at an anchor use rows up to that anchor only.
 * - Continuous features are standardized with the mean and sample standard deviation of the
 *   observations BEFORE the query session (expanding, past only). Each series is standardized by
 *   its own earlier distribution, so a group case is compared by how unusual it was for that stock.
 * - Distance = sqrt( sum(w * d^2) / sum(w) ) over the features both sessions have, where d is the
 *   standardized difference (or 0 or 1 for a binary feature). The share of each feature in the
 *   squared distance is published so a user can see why a case matched.
 * - A candidate needs at least `minSharedFeatures` comparable features (6, specification).
 * - Leakage guard: a candidate is eligible for a forecast at the query session only when its
 *   outcome window matured strictly before the query session: c + horizon + embargo < q. Group
 *   candidates use the same rule on calendar dates.
 * - Accepted cases never share a future path: two cases from one series are more than `horizon`
 *   sessions apart. Group cases are limited to one per calendar date.
 * - When own stock support is under ten, the caller may pass explicitly labeled group cohorts.
 *   Group cases are tagged with their origin and the own stock count is always reported. Applying
 *   today's group membership to history is retrospective, and the result says so.
 */
import { atrWilder, macd, relativeVolume, rollingReturnStd, rsiWilder, sma } from './core/indicators';
import { forwardOutcome, selectNonOverlapping, type ForwardOutcome } from './core/outcomes';
import { indexOnOrBefore } from './core/series';
import { distribution, quantile } from './core/stats';
import { isNa, na, type Bar, type Distribution, type EarningsEvent, type ISODate, type Maybe } from './core/types';
import { earningsCohortResolver, makeFrequency, type Frequency } from './declines';

export type FeatureKey =
  | 'dayReturn'
  | 'rangePosition'
  | 'lowerWick'
  | 'upperWick'
  | 'relVolume'
  | 'dailyVol'
  | 'atrPct'
  | 'rsi14'
  | 'macdHist'
  | 'distSma50'
  | 'distSma200'
  | 'downStreak'
  | 'drawdown'
  | 'marketReturn'
  | 'marketDistSma200'
  | 'sectorReturn'
  | 'sectorDistSma200'
  | 'earnings';

export const FEATURE_KEYS: readonly FeatureKey[] = [
  'dayReturn', 'rangePosition', 'lowerWick', 'upperWick', 'relVolume', 'dailyVol', 'atrPct', 'rsi14', 'macdHist',
  'distSma50', 'distSma200', 'downStreak', 'drawdown', 'marketReturn', 'marketDistSma200', 'sectorReturn', 'sectorDistSma200', 'earnings',
];

export const FEATURE_LABELS: Readonly<Record<FeatureKey, string>> = {
  dayReturn: 'Close vs previous close',
  rangePosition: 'Close position in day range',
  lowerWick: 'Lower wick share of range',
  upperWick: 'Upper wick share of range',
  relVolume: 'Volume vs previous 20 sessions',
  dailyVol: 'Daily volatility, 20 sessions',
  atrPct: 'ATR14 as a share of price',
  rsi14: 'RSI14',
  macdHist: 'MACD histogram as a share of price',
  distSma50: 'Distance from 50 session average',
  distSma200: 'Distance from 200 session average',
  downStreak: 'Consecutive lower closes',
  drawdown: 'Drawdown from closing peak',
  marketReturn: 'Market return that session',
  marketDistSma200: 'Market distance from 200 session average',
  sectorReturn: 'Sector return that session',
  sectorDistSma200: 'Sector distance from 200 session average',
  earnings: 'Earnings reaction session',
};

const BINARY: ReadonlySet<FeatureKey> = new Set<FeatureKey>(['earnings']);

export const ANALOG_DEFAULTS = {
  spec: {
    provenance: 'spec' as const,
    /** Minimum comparable features shared by the query and a case. */
    minSharedFeatures: 6,
    /** Cases ranked and returned. */
    maxCases: 15,
    /** Own stock support under this allows labeled group cohorts. */
    minOwnCases: 10,
  },
  proposed: {
    provenance: 'proposed' as const,
    /** Earlier observations needed before a feature can be standardized. */
    minHistory: 60,
    /** Extra sessions between a candidate's matured outcome and the query. */
    embargo: 0,
    /** Sessions shown before the event in an aligned path. */
    pathBefore: 5,
    /** Below this many cases a frequency keeps its counts and withholds the rate. */
    minCases: 10,
    level: 0.95,
  },
};

export interface FeatureContext {
  market?: readonly Bar[];
  sector?: readonly Bar[];
  earnings?: readonly EarningsEvent[];
}

interface Prefix {
  count: Float64Array;
  sum: Float64Array;
  sq: Float64Array;
}

export interface FeatureMatrix {
  /** Label for the series, used to tag group cases. */
  symbol: string | null;
  bars: readonly Bar[];
  values: Record<FeatureKey, (number | null)[]>;
  /** Prefix sums for past only standardization. Internal. */
  prefix: Record<FeatureKey, Prefix>;
}

const contextFeatures = (bars: readonly Bar[], series: readonly Bar[] | undefined): { ret: (number | null)[]; dist: (number | null)[] } => {
  const ret: (number | null)[] = new Array(bars.length).fill(null);
  const dist: (number | null)[] = new Array(bars.length).fill(null);
  if (!series) return { ret, dist };
  const idx = new Map(series.map((b, i) => [b.date, i]));
  const s200 = sma(series.map((b) => b.close), 200);
  for (let i = 0; i < bars.length; i++) {
    const j = idx.get(bars[i]!.date);
    if (j === undefined) continue;
    const prev = series[j - 1];
    if (prev) ret[i] = series[j]!.close / prev.close - 1;
    const m = s200[j] ?? null;
    if (m !== null) dist[i] = series[j]!.close / m - 1;
  }
  return { ret, dist };
};

/** Past only feature values for every session of a series. Row i uses rows 0..i only. */
export const buildFeatures = (bars: readonly Bar[], ctx: FeatureContext = {}, symbol: string | null = null): FeatureMatrix => {
  const n = bars.length;
  const closes = bars.map((b) => b.close);
  const rsi = rsiWilder(closes, 14);
  const atr = atrWilder(bars, 14);
  const vol = rollingReturnStd(closes, 20);
  const rv = relativeVolume(bars, 20);
  const m = macd(closes).hist;
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  const market = contextFeatures(bars, ctx.market);
  const sector = contextFeatures(bars, ctx.sector);
  const cohort = ctx.earnings && ctx.earnings.length ? earningsCohortResolver(bars, ctx.earnings) : null;
  const empty = (): (number | null)[] => new Array(n).fill(null);
  const values: Record<FeatureKey, (number | null)[]> = {
    dayReturn: empty(), rangePosition: empty(), lowerWick: empty(), upperWick: empty(), relVolume: rv, dailyVol: vol, atrPct: empty(),
    rsi14: rsi, macdHist: empty(), distSma50: empty(), distSma200: empty(), downStreak: empty(), drawdown: empty(),
    marketReturn: market.ret, marketDistSma200: market.dist, sectorReturn: sector.ret, sectorDistSma200: sector.dist, earnings: empty(),
  };
  let peak = -Infinity;
  let streak = 0;
  for (let i = 0; i < n; i++) {
    const b = bars[i]!;
    const prev = bars[i - 1];
    if (prev) {
      values.dayReturn[i] = b.close / prev.close - 1;
      streak = b.close < prev.close ? streak + 1 : 0;
      values.downStreak[i] = streak;
    }
    const range = b.high - b.low;
    if (range > 0) {
      values.rangePosition[i] = (b.close - b.low) / range;
      values.lowerWick[i] = (Math.min(b.open, b.close) - b.low) / range;
      values.upperWick[i] = (b.high - Math.max(b.open, b.close)) / range;
    }
    const a = atr[i] ?? null;
    if (a !== null) values.atrPct[i] = a / b.close;
    const h = m[i] ?? null;
    if (h !== null) values.macdHist[i] = h / b.close;
    const a50 = s50[i] ?? null;
    if (a50 !== null) values.distSma50[i] = b.close / a50 - 1;
    const a200 = s200[i] ?? null;
    if (a200 !== null) values.distSma200[i] = b.close / a200 - 1;
    peak = Math.max(peak, b.close);
    values.drawdown[i] = b.close / peak - 1;
    if (cohort) {
      const c = cohort(b.date);
      values.earnings[i] = c === 'earnings' ? 1 : c === 'ordinary' ? 0 : null;
    }
  }
  const prefix = {} as Record<FeatureKey, Prefix>;
  for (const key of FEATURE_KEYS) {
    const count = new Float64Array(n + 1);
    const sum = new Float64Array(n + 1);
    const sq = new Float64Array(n + 1);
    const col = values[key];
    for (let i = 0; i < n; i++) {
      const v = col[i] ?? null;
      count[i + 1] = count[i]! + (v === null ? 0 : 1);
      sum[i + 1] = sum[i]! + (v ?? 0);
      sq[i + 1] = sq[i]! + (v === null ? 0 : v * v);
    }
    prefix[key] = { count, sum, sq };
  }
  return { symbol, bars, values, prefix };
};

interface Norm {
  mean: number;
  std: number;
  n: number;
}

/** Mean and sample standard deviation of a feature over rows before `endExclusive`. */
const normBefore = (fm: FeatureMatrix, key: FeatureKey, endExclusive: number, minHistory: number): Norm | null => {
  const p = fm.prefix[key];
  const n = p.count[endExclusive] ?? 0;
  if (n < Math.max(2, minHistory)) return null;
  const mean = p.sum[endExclusive]! / n;
  const variance = Math.max(0, (p.sq[endExclusive]! - n * mean * mean) / (n - 1));
  const std = Math.sqrt(variance);
  // Guard against a constant feature and floating point residue.
  if (!(std > 1e-12 * Math.max(1, Math.abs(mean)))) return null;
  return { mean, std, n };
};

/** True when a candidate's outcome window matured strictly before the query session. */
export const isMaturedBefore = (candidateIndex: number, horizon: number, queryIndex: number, embargo = 0): boolean =>
  candidateIndex + horizon + embargo < queryIndex;

/* ------------------------------------------------------------------------------------------------
 * Result shapes
 * ---------------------------------------------------------------------------------------------- */

export interface FeatureContribution {
  key: FeatureKey;
  label: string;
  queryValue: number;
  caseValue: number;
  /** Standardized case value minus standardized query value. 0 or 1 for a binary feature. */
  zDiff: number;
  weight: number;
  /** Share of the squared distance that this feature explains. */
  share: number;
}

export interface PathPoint {
  /** Sessions from the event. Negative before it. */
  offset: number;
  date: ISODate;
  /** Close relative to the baseline close, minus 1. */
  rel: number;
}

export interface AnalogCase {
  origin: 'own' | 'group';
  symbol: string | null;
  index: number;
  date: ISODate;
  /** Null for a rule based search without a comparable query. */
  distance: number | null;
  sharedFeatures: FeatureKey[];
  contributions: FeatureContribution[];
  outcome: ForwardOutcome;
  path: PathPoint[];
  /** Sessions until the first close above the event close inside the horizon, or null. */
  reversalSessions: number | null;
  /** Sessions until the first close at or above the close before the event. Null when it did not happen inside the horizon. */
  recoverySessions: number | null;
  /** False when the event closed at or above the previous close, so there was nothing to recover. */
  recoveryApplicable: boolean;
}

export interface AnalogCounts {
  /** Earlier own sessions examined. */
  scanned: number;
  /** Own sessions excluded because their outcome had not matured before the query. */
  notMaturedBeforeQuery: number;
  tooFewSharedFeatures: number;
  toleranceFailed: number;
  /** Dropped because the future path overlapped a closer accepted case. */
  overlapDropped: number;
  /** Eligible and non overlapping but beyond the case limit. */
  beyondLimit: number;
  ownCases: number;
  groupCases: number;
  /** Group sessions dropped to keep one case per calendar date. */
  groupSameDateDropped: number;
}

export interface MedianPathPoint {
  offset: number;
  n: number;
  median: number;
  p25: number;
  p75: number;
}

export interface AnalogSummary {
  horizon: number;
  n: number;
  up: number;
  flat: number;
  down: number;
  /** Endpoint close above the event close. */
  positive: Frequency;
  returns: Maybe<Distribution>;
  /** Lowest close inside the window vs the event close. */
  worstClose: Maybe<Distribution>;
  /** Highest close inside the window vs the event close. */
  bestClose: Maybe<Distribution>;
  /** Sessions ahead of the lowest close. */
  troughOffset: Maybe<Distribution>;
  reversal: Frequency;
  recovery: Frequency;
  recoverySessions: Maybe<Distribution>;
}

export type AnalogStatus = 'ok' | 'sparse' | 'none' | 'insufficient-features';

export interface AnalogResult {
  entry: 'closest-match' | 'rule-search';
  status: AnalogStatus;
  horizon: number;
  query: {
    index: number;
    date: ISODate;
    values: Partial<Record<FeatureKey, number>>;
    /** Features of the query that could be standardized and compared. */
    usableFeatures: FeatureKey[];
    unusable: { key: FeatureKey; reason: string }[];
  };
  matchedDimensions: FeatureKey[];
  tolerances: Partial<Record<FeatureKey, number>>;
  weights: Partial<Record<FeatureKey, number>>;
  cases: AnalogCase[];
  counts: AnalogCounts;
  summary: AnalogSummary;
  /** Summary of own stock cases only, always reported next to a pooled summary. */
  ownSummary: AnalogSummary;
  medianPath: MedianPathPoint[];
  notes: string[];
}

export interface AnalogCohort {
  symbol: string;
  features: FeatureMatrix;
  /** Why this series is comparable, and as of when the membership was known. */
  membershipNote?: string;
}

export interface AnalogOptions {
  horizon: number;
  keys?: readonly FeatureKey[];
  weights?: Partial<Record<FeatureKey, number>>;
  /** Maximum absolute standardized difference per feature. 0 on a binary feature means it must match. */
  tolerances?: Partial<Record<FeatureKey, number>>;
  minSharedFeatures?: number;
  maxCases?: number;
  embargo?: number;
  minHistory?: number;
  pathBefore?: number;
  /** 'event' baselines paths at the event close. 'before' uses the close before the event. */
  pathBaseline?: 'event' | 'before';
  minOwnCases?: number;
  cohorts?: readonly AnalogCohort[];
  level?: number;
  minCases?: number;
}

/* ------------------------------------------------------------------------------------------------
 * Shared builders
 * ---------------------------------------------------------------------------------------------- */

const buildPath = (bars: readonly Bar[], c: number, h: number, before: number, baseline: 'event' | 'before'): PathPoint[] => {
  const base = baseline === 'before' && bars[c - 1] ? bars[c - 1]!.close : bars[c]!.close;
  const out: PathPoint[] = [];
  for (let k = -before; k <= h; k++) {
    const b = bars[c + k];
    if (b) out.push({ offset: k, date: b.date, rel: b.close / base - 1 });
  }
  return out;
};

const buildCase = (
  fm: FeatureMatrix,
  c: number,
  outcome: ForwardOutcome,
  origin: 'own' | 'group',
  distance: number | null,
  contributions: FeatureContribution[],
  opts: Required<Pick<AnalogOptions, 'horizon' | 'pathBefore' | 'pathBaseline'>>,
): AnalogCase => {
  const bars = fm.bars;
  const a = bars[c]!;
  let reversal: number | null = null;
  for (let k = 1; k <= opts.horizon; k++) {
    if (bars[c + k]!.close > a.close) {
      reversal = k;
      break;
    }
  }
  const prev = bars[c - 1];
  const applicable = prev !== undefined && a.close < prev.close;
  let recovery: number | null = null;
  if (applicable) {
    for (let k = 1; k <= opts.horizon; k++) {
      if (bars[c + k]!.close >= prev.close) {
        recovery = k;
        break;
      }
    }
  }
  return {
    origin,
    symbol: fm.symbol,
    index: c,
    date: a.date,
    distance,
    sharedFeatures: contributions.map((x) => x.key),
    contributions,
    outcome,
    path: buildPath(bars, c, opts.horizon, opts.pathBefore, opts.pathBaseline),
    reversalSessions: reversal,
    recoverySessions: recovery,
    recoveryApplicable: applicable,
  };
};

const dist = (xs: readonly number[]): Maybe<Distribution> => distribution(xs) ?? na('sample-too-small', 'No cases');

const summarize = (cases: readonly AnalogCase[], horizon: number, level: number, minCases: number): AnalogSummary => {
  const dates = cases.map((c) => c.date);
  const n = cases.length;
  const up = cases.filter((c) => c.outcome.ret > 0).length;
  const down = cases.filter((c) => c.outcome.ret < 0).length;
  const rec = cases.filter((c) => c.recoveryApplicable);
  const recHit = rec.filter((c) => c.recoverySessions !== null);
  return {
    horizon,
    n,
    up,
    flat: n - up - down,
    down,
    positive: makeFrequency(up, n, dates, level, minCases),
    returns: dist(cases.map((c) => c.outcome.ret)),
    worstClose: dist(cases.map((c) => c.outcome.minCloseRet)),
    bestClose: dist(cases.map((c) => c.outcome.maxCloseRet)),
    troughOffset: dist(cases.map((c) => c.outcome.minCloseOffset)),
    reversal: makeFrequency(cases.filter((c) => c.reversalSessions !== null).length, n, dates, level, minCases),
    recovery: makeFrequency(recHit.length, rec.length, rec.map((c) => c.date), level, minCases),
    recoverySessions: dist(recHit.map((c) => c.recoverySessions!)),
  };
};

const medianPath = (cases: readonly AnalogCase[]): MedianPathPoint[] => {
  const byOffset = new Map<number, number[]>();
  for (const c of cases) for (const p of c.path) {
    const arr = byOffset.get(p.offset) ?? [];
    arr.push(p.rel);
    byOffset.set(p.offset, arr);
  }
  return [...byOffset.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([offset, xs]) => ({ offset, n: xs.length, median: quantile(xs, 0.5), p25: quantile(xs, 0.25), p75: quantile(xs, 0.75) }));
};

const emptyCounts = (): AnalogCounts => ({
  scanned: 0, notMaturedBeforeQuery: 0, tooFewSharedFeatures: 0, toleranceFailed: 0, overlapDropped: 0, beyondLimit: 0, ownCases: 0, groupCases: 0, groupSameDateDropped: 0,
});

const RETROSPECTIVE_NOTE = 'Group cases use the group as defined today. That is a retrospective comparison, not proof of the historical group.';

interface Scored {
  fm: FeatureMatrix;
  origin: 'own' | 'group';
  index: number;
  distance: number;
  contributions: FeatureContribution[];
}

interface QueryNorm {
  key: FeatureKey;
  value: number;
  /** Standardized query value. The raw value for a binary feature. */
  z: number;
  weight: number;
}

/** Score one candidate row against the standardized query. Returns a reason string when it is not comparable. */
const scoreCandidate = (
  fm: FeatureMatrix,
  c: number,
  query: readonly QueryNorm[],
  norms: ReadonlyMap<FeatureKey, Norm>,
  tolerances: Partial<Record<FeatureKey, number>>,
  minShared: number,
): { distance: number; contributions: FeatureContribution[] } | 'too-few' | 'tolerance' => {
  const parts: { q: QueryNorm; value: number; d: number }[] = [];
  for (const q of query) {
    const v = fm.values[q.key][c] ?? null;
    if (v === null) continue;
    let d: number;
    if (BINARY.has(q.key)) d = v === q.value ? 0 : 1;
    else {
      const nm = norms.get(q.key);
      if (!nm) continue;
      d = (v - nm.mean) / nm.std - q.z;
    }
    parts.push({ q, value: v, d });
  }
  if (parts.length < minShared) return 'too-few';
  for (const p of parts) {
    const tol = tolerances[p.q.key];
    if (tol !== undefined && Math.abs(p.d) > tol) return 'tolerance';
  }
  let ss = 0;
  let sw = 0;
  for (const p of parts) {
    ss += p.q.weight * p.d * p.d;
    sw += p.q.weight;
  }
  const distance = sw > 0 ? Math.sqrt(ss / sw) : 0;
  const contributions: FeatureContribution[] = parts.map((p) => ({
    key: p.q.key,
    label: FEATURE_LABELS[p.q.key],
    queryValue: p.q.value,
    caseValue: p.value,
    zDiff: p.d,
    weight: p.q.weight,
    share: ss > 0 ? (p.q.weight * p.d * p.d) / ss : 0,
  }));
  return { distance, contributions };
};

const resolve = (opts: AnalogOptions) => ({
  horizon: opts.horizon,
  keys: opts.keys ?? FEATURE_KEYS,
  weights: opts.weights ?? {},
  tolerances: opts.tolerances ?? {},
  minShared: opts.minSharedFeatures ?? ANALOG_DEFAULTS.spec.minSharedFeatures,
  maxCases: opts.maxCases ?? ANALOG_DEFAULTS.spec.maxCases,
  embargo: opts.embargo ?? ANALOG_DEFAULTS.proposed.embargo,
  minHistory: opts.minHistory ?? ANALOG_DEFAULTS.proposed.minHistory,
  pathBefore: opts.pathBefore ?? ANALOG_DEFAULTS.proposed.pathBefore,
  pathBaseline: opts.pathBaseline ?? ('event' as const),
  minOwn: opts.minOwnCases ?? ANALOG_DEFAULTS.spec.minOwnCases,
  cohorts: opts.cohorts ?? [],
  level: opts.level ?? ANALOG_DEFAULTS.proposed.level,
  minCases: opts.minCases ?? ANALOG_DEFAULTS.proposed.minCases,
});

/** Standardize the query session with its own earlier distribution. */
const queryNorms = (fm: FeatureMatrix, q: number, keys: readonly FeatureKey[], weights: Partial<Record<FeatureKey, number>>, minHistory: number) => {
  const usable: QueryNorm[] = [];
  const norms = new Map<FeatureKey, Norm>();
  const unusable: { key: FeatureKey; reason: string }[] = [];
  const values: Partial<Record<FeatureKey, number>> = {};
  for (const key of keys) {
    const v = fm.values[key][q] ?? null;
    if (v === null) {
      unusable.push({ key, reason: 'No value at the query session' });
      continue;
    }
    values[key] = v;
    const weight = weights[key] ?? 1;
    if (!(weight > 0)) {
      unusable.push({ key, reason: 'Weight is zero' });
      continue;
    }
    if (BINARY.has(key)) {
      usable.push({ key, value: v, z: v, weight });
      continue;
    }
    const nm = normBefore(fm, key, q, minHistory);
    if (!nm) {
      unusable.push({ key, reason: `Fewer than ${minHistory} earlier observations, or no variation` });
      continue;
    }
    norms.set(key, nm);
    usable.push({ key, value: v, z: (v - nm.mean) / nm.std, weight });
  }
  return { usable, norms, unusable, values };
};

const statusOf = (n: number, minCases: number): AnalogStatus => (n === 0 ? 'none' : n < minCases ? 'sparse' : 'ok');

/* ------------------------------------------------------------------------------------------------
 * Entry point 1: closest condition matching
 * ---------------------------------------------------------------------------------------------- */

/**
 * Rank earlier sessions by similarity to the query session and return the closest non overlapping
 * cases whose outcomes matured before the query.
 */
export const findAnalogs = (fm: FeatureMatrix, queryIndex: number, options: AnalogOptions): Maybe<AnalogResult> => {
  const o = resolve(options);
  const bars = fm.bars;
  const qBar = bars[queryIndex];
  if (!qBar || o.horizon < 1) return na('invalid-input', 'query index or horizon outside series');
  const { usable, norms, unusable, values } = queryNorms(fm, queryIndex, o.keys, o.weights, o.minHistory);
  const counts = emptyCounts();
  const notes: string[] = [];
  const base = {
    entry: 'closest-match' as const,
    horizon: o.horizon,
    query: { index: queryIndex, date: qBar.date, values, usableFeatures: usable.map((u) => u.key), unusable },
    matchedDimensions: usable.map((u) => u.key),
    tolerances: o.tolerances,
    weights: Object.fromEntries(usable.map((u) => [u.key, u.weight])) as Partial<Record<FeatureKey, number>>,
  };
  const empty = summarize([], o.horizon, o.level, o.minCases);
  if (usable.length < o.minShared) {
    notes.push(`The query session has ${usable.length} comparable features. At least ${o.minShared} are needed.`);
    return { ...base, status: 'insufficient-features', cases: [], counts, summary: empty, ownSummary: empty, medianPath: [], notes };
  }

  // Own stock candidates.
  const scored: Scored[] = [];
  for (let c = 0; c < queryIndex; c++) {
    counts.scanned++;
    if (!isMaturedBefore(c, o.horizon, queryIndex, o.embargo)) {
      counts.notMaturedBeforeQuery++;
      continue;
    }
    const s = scoreCandidate(fm, c, usable, norms, o.tolerances, o.minShared);
    if (s === 'too-few') counts.tooFewSharedFeatures++;
    else if (s === 'tolerance') counts.toleranceFailed++;
    else scored.push({ fm, origin: 'own', index: c, distance: s.distance, contributions: s.contributions });
  }
  scored.sort((a, b) => a.distance - b.distance || a.index - b.index);
  const accepted: Scored[] = [];
  for (const s of scored) {
    if (accepted.some((a) => Math.abs(a.index - s.index) <= o.horizon)) {
      counts.overlapDropped++;
      continue;
    }
    if (accepted.length >= o.maxCases) {
      counts.beyondLimit++;
      continue;
    }
    accepted.push(s);
  }
  counts.ownCases = accepted.length;

  // Labeled group cohorts, only when own stock support is thin.
  if (accepted.length < o.minOwn && o.cohorts.length > 0 && accepted.length < o.maxCases) {
    const groupScored: Scored[] = [];
    for (const cohort of o.cohorts) {
      const g = cohort.features;
      const gb = g.bars;
      const last = indexOnOrBefore(gb, qBar.date);
      // Rows strictly before the query date.
      const endExclusive = last >= 0 && gb[last]!.date === qBar.date ? last : last + 1;
      const gNorms = new Map<FeatureKey, Norm>();
      for (const u of usable) {
        if (BINARY.has(u.key)) continue;
        const nm = normBefore(g, u.key, endExclusive, o.minHistory);
        if (nm) gNorms.set(u.key, nm);
      }
      for (let c = 0; c + o.horizon + o.embargo < endExclusive; c++) {
        const s = scoreCandidate(g, c, usable, gNorms, o.tolerances, o.minShared);
        if (s === 'too-few' || s === 'tolerance') continue;
        groupScored.push({ fm: g, origin: 'group', index: c, distance: s.distance, contributions: s.contributions });
      }
      if (cohort.membershipNote) notes.push(`${cohort.symbol}: ${cohort.membershipNote}`);
    }
    groupScored.sort((a, b) => a.distance - b.distance || a.index - b.index);
    const usedDates = new Set(accepted.map((a) => a.fm.bars[a.index]!.date));
    for (const s of groupScored) {
      if (accepted.length >= o.maxCases) break;
      const date = s.fm.bars[s.index]!.date;
      if (usedDates.has(date)) {
        counts.groupSameDateDropped++;
        continue;
      }
      if (accepted.some((a) => a.fm === s.fm && Math.abs(a.index - s.index) <= o.horizon)) continue;
      accepted.push(s);
      usedDates.add(date);
      counts.groupCases++;
    }
    if (counts.groupCases > 0) {
      notes.push(`Own stock support is ${counts.ownCases} cases, under ${o.minOwn}. ${counts.groupCases} labeled group cases were added.`);
      notes.push(RETROSPECTIVE_NOTE);
    }
  } else if (accepted.length < o.minOwn) {
    notes.push(`Own stock support is ${accepted.length} cases, under ${o.minOwn}. No group cohort was supplied.`);
  }

  const cases: AnalogCase[] = [];
  for (const s of accepted) {
    const out = forwardOutcome(s.fm.bars, s.index, o.horizon);
    if (isNa(out)) continue; // cannot happen after the maturity guard, kept as a safety net
    cases.push(buildCase(s.fm, s.index, out, s.origin, s.distance, s.contributions, { horizon: o.horizon, pathBefore: o.pathBefore, pathBaseline: o.pathBaseline }));
  }
  const own = cases.filter((c) => c.origin === 'own');
  return {
    ...base,
    status: statusOf(cases.length, o.minCases),
    cases,
    counts,
    summary: summarize(cases, o.horizon, o.level, o.minCases),
    ownSummary: summarize(own, o.horizon, o.level, o.minCases),
    medianPath: medianPath(cases),
    notes,
  };
};

/* ------------------------------------------------------------------------------------------------
 * Entry point 2: threshold driven search
 * ---------------------------------------------------------------------------------------------- */

export interface FeatureCondition {
  key: FeatureKey;
  op: 'lte' | 'gte' | 'between';
  value: number;
  /** Upper bound for 'between'. */
  value2?: number;
}

const meets = (v: number | null, c: FeatureCondition): boolean => {
  if (v === null) return false; // a missing value never passes a numeric rule
  if (c.op === 'lte') return v <= c.value;
  if (c.op === 'gte') return v >= c.value;
  return v >= Math.min(c.value, c.value2 ?? c.value) && v <= Math.max(c.value, c.value2 ?? c.value);
};

/**
 * Keep earlier sessions that meet every rule, thinned chronologically to horizon plus one spacing,
 * with outcomes matured before the query session. Returns the same shape as `findAnalogs`.
 * When the query session can be standardized, each case also reports its distance to the query.
 */
export const searchByConditions = (fm: FeatureMatrix, queryIndex: number, conditions: readonly FeatureCondition[], options: AnalogOptions): Maybe<AnalogResult> => {
  const o = resolve(options);
  const bars = fm.bars;
  const qBar = bars[queryIndex];
  if (!qBar || o.horizon < 1) return na('invalid-input', 'query index or horizon outside series');
  if (conditions.length === 0) return na('invalid-input', 'At least one rule is needed');
  const { usable, norms, unusable, values } = queryNorms(fm, queryIndex, o.keys, o.weights, o.minHistory);
  const counts = emptyCounts();
  const hits: number[] = [];
  for (let c = 0; c < queryIndex; c++) {
    counts.scanned++;
    if (!conditions.every((cond) => meets(fm.values[cond.key][c] ?? null, cond))) continue;
    if (!isMaturedBefore(c, o.horizon, queryIndex, o.embargo)) {
      counts.notMaturedBeforeQuery++;
      continue;
    }
    hits.push(c);
  }
  const sel = selectNonOverlapping(hits, o.horizon + 1);
  counts.overlapDropped = sel.dropped.length;
  const limit = options.maxCases ?? Infinity;
  const keptIdx = sel.kept.length > limit ? sel.kept.slice(sel.kept.length - limit) : sel.kept;
  counts.beyondLimit = sel.kept.length - keptIdx.length;
  const cases: AnalogCase[] = [];
  for (const c of keptIdx) {
    const out = forwardOutcome(bars, c, o.horizon);
    if (isNa(out)) continue;
    const s = usable.length > 0 ? scoreCandidate(fm, c, usable, norms, {}, 1) : 'too-few';
    const scoredOk = typeof s === 'object';
    cases.push(buildCase(fm, c, out, 'own', scoredOk ? s.distance : null, scoredOk ? s.contributions : [], { horizon: o.horizon, pathBefore: o.pathBefore, pathBaseline: o.pathBaseline }));
  }
  counts.ownCases = cases.length;
  const summary = summarize(cases, o.horizon, o.level, o.minCases);
  const notes = [`Rules: ${conditions.map((c) => `${FEATURE_LABELS[c.key]} ${c.op === 'lte' ? 'at or below' : c.op === 'gte' ? 'at or above' : 'between'} ${c.value}${c.op === 'between' ? ` and ${c.value2 ?? c.value}` : ''}`).join(', ')}.`];
  if (cases.length < o.minOwn) notes.push(`Own stock support is ${cases.length} cases, under ${o.minOwn}.`);
  return {
    entry: 'rule-search',
    status: statusOf(cases.length, o.minCases),
    horizon: o.horizon,
    query: { index: queryIndex, date: qBar.date, values, usableFeatures: usable.map((u) => u.key), unusable },
    matchedDimensions: conditions.map((c) => c.key),
    tolerances: {},
    weights: {},
    cases,
    counts,
    summary,
    ownSummary: summary,
    medianPath: medianPath(cases),
    notes,
  };
};
