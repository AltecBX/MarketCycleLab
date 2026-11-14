/**
 * Shared statistics. Every engine uses these so a proportion, percentile or interval means the
 * same thing everywhere.
 */
import type { Distribution, ISODate, Proportion } from './types';

export const sum = (xs: readonly number[]): number => {
  let s = 0;
  for (const x of xs) s += x;
  return s;
};

export const mean = (xs: readonly number[]): number => (xs.length === 0 ? NaN : sum(xs) / xs.length);

/** Sample standard deviation (n - 1). NaN below two observations. */
export const sampleStd = (xs: readonly number[]): number => {
  const n = xs.length;
  if (n < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (n - 1));
};

/** Population standard deviation (n). */
export const popStd = (xs: readonly number[]): number => {
  const n = xs.length;
  if (n < 1) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / n);
};

export const sortedCopy = (xs: readonly number[]): number[] => [...xs].sort((a, b) => a - b);

/**
 * Empirical quantile with linear interpolation between order statistics (Hyndman and Fan type 7,
 * the spreadsheet PERCENTILE.INC convention). `q` in [0, 1]. NaN for an empty sample.
 */
export const quantile = (xs: readonly number[], q: number, alreadySorted = false): number => {
  const s = alreadySorted ? xs : sortedCopy(xs);
  const n = s.length;
  if (n === 0) return NaN;
  if (n === 1) return s[0]!;
  const h = (n - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  const a = s[lo]!;
  const b = s[hi]!;
  return a + (b - a) * (h - lo);
};

export const median = (xs: readonly number[]): number => quantile(xs, 0.5);

export const distribution = (xs: readonly number[]): Distribution | null => {
  if (xs.length === 0) return null;
  const s = sortedCopy(xs);
  return {
    n: s.length,
    mean: mean(s),
    median: quantile(s, 0.5, true),
    p10: quantile(s, 0.1, true),
    p25: quantile(s, 0.25, true),
    p75: quantile(s, 0.75, true),
    p90: quantile(s, 0.9, true),
    min: s[0]!,
    max: s[s.length - 1]!,
  };
};

/**
 * Midrank percentile of `x` within prior comparable observations:
 * (count lower + half the count equal) / n. NaN for an empty reference sample.
 */
export const midrankPercentile = (reference: readonly number[], x: number): number => {
  const n = reference.length;
  if (n === 0) return NaN;
  let lower = 0;
  let equal = 0;
  for (const r of reference) {
    if (r < x) lower++;
    else if (r === x) equal++;
  }
  return (lower + 0.5 * equal) / n;
};

/** Standard normal CDF. Hart rational approximation as given by West (2005), double precision. */
export const normCdf = (z: number): number => {
  const x = Math.abs(z);
  let c: number;
  if (x > 37) c = 0;
  else {
    const e = Math.exp((-x * x) / 2);
    if (x < 7.07106781186547) {
      let num = 3.52624965998911e-2 * x + 0.700383064443688;
      num = num * x + 6.37396220353165;
      num = num * x + 33.912866078383;
      num = num * x + 112.079291497871;
      num = num * x + 221.213596169931;
      num = num * x + 220.206867912376;
      let den = 8.83883476483184e-2 * x + 1.75566716318264;
      den = den * x + 16.064177579207;
      den = den * x + 86.7807322029461;
      den = den * x + 296.564248779674;
      den = den * x + 637.333633378831;
      den = den * x + 793.826512519948;
      den = den * x + 440.413735824752;
      c = (e * num) / den;
    } else {
      let b = x + 0.65;
      b = x + 4 / b;
      b = x + 3 / b;
      b = x + 2 / b;
      b = x + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return z > 0 ? 1 - c : c;
};

/** Inverse standard normal CDF. Acklam's rational approximation, relative error below 1.2e-9. */
export const normInv = (p: number): number => {
  if (!(p > 0 && p < 1)) return p === 0 ? -Infinity : p === 1 ? Infinity : NaN;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let x: number;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  } else if (p <= 1 - pl) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  // One Halley refinement step using the forward CDF.
  const e = normCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
};

/**
 * Wilson score interval for a binomial proportion at confidence `level` (default 0.95).
 * center = (p + z^2/(2n)) / (1 + z^2/n)
 * half   = z * sqrt(p(1-p)/n + z^2/(4n^2)) / (1 + z^2/n)
 * `nEffective` lets a caller pass a conservative clustered sample size for the interval while the
 * displayed hits and n stay exact.
 */
export const wilson = (hits: number, n: number, level = 0.95, nEffective?: number): Proportion | null => {
  if (!(n > 0) || hits < 0 || hits > n) return null;
  const p = hits / n;
  const ne = nEffective !== undefined ? Math.max(1e-9, Math.min(n, nEffective)) : n;
  const z = normInv(1 - (1 - level) / 2);
  const denom = 1 + (z * z) / ne;
  const center = (p + (z * z) / (2 * ne)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / ne + (z * z) / (4 * ne * ne))) / denom;
  return { hits, n, rate: p, lo: Math.max(0, center - half), hi: Math.min(1, center + half), level };
};

/**
 * Conservative effective sample size when observations cluster by calendar year:
 * min(n, (sum of year counts)^2 / sum of squared year counts).
 */
export const yearClusterEffectiveN = (dates: readonly ISODate[]): number => {
  const counts = new Map<string, number>();
  for (const d of dates) counts.set(d.slice(0, 4), (counts.get(d.slice(0, 4)) ?? 0) + 1);
  let s = 0;
  let s2 = 0;
  for (const c of counts.values()) {
    s += c;
    s2 += c * c;
  }
  if (s2 === 0) return 0;
  return Math.min(dates.length, (s * s) / s2);
};

export const distinctYears = (dates: readonly ISODate[]): number => new Set(dates.map((d) => d.slice(0, 4))).size;

/** Brier score: mean((p - y)^2) with y in {0, 1}. NaN for no forecasts. */
export const brier = (probs: readonly number[], outcomes: readonly (0 | 1 | boolean)[]): number => {
  if (probs.length === 0 || probs.length !== outcomes.length) return NaN;
  let s = 0;
  for (let i = 0; i < probs.length; i++) {
    const y = outcomes[i] ? 1 : 0;
    const d = probs[i]! - y;
    s += d * d;
  }
  return s / probs.length;
};

export interface SurvivalObservation {
  /** Observed duration in sessions. For a censored run, the duration observed so far. */
  duration: number;
  /** True when the run ended (event observed). False when right-censored. */
  ended: boolean;
}

export interface SurvivalStep {
  t: number;
  atRisk: number;
  events: number;
  censored: number;
  survival: number;
}

/**
 * Kaplan-Meier product-limit estimator over integer durations.
 * S(t) = product over event times u <= t of (1 - d_u / n_u), where n_u counts runs with duration
 * >= u. Censored observations leave the risk set after their observed duration.
 */
export const kaplanMeier = (obs: readonly SurvivalObservation[]): SurvivalStep[] => {
  const times = [...new Set(obs.map((o) => o.duration))].sort((a, b) => a - b);
  const steps: SurvivalStep[] = [];
  let s = 1;
  for (const t of times) {
    const atRisk = obs.filter((o) => o.duration >= t).length;
    const events = obs.filter((o) => o.duration === t && o.ended).length;
    const censored = obs.filter((o) => o.duration === t && !o.ended).length;
    if (atRisk > 0 && events > 0) s *= 1 - events / atRisk;
    steps.push({ t, atRisk, events, censored, survival: s });
  }
  return steps;
};

/** S(t) from Kaplan-Meier steps. S(t) = 1 before the first step. */
export const survivalAt = (steps: readonly SurvivalStep[], t: number): number => {
  let s = 1;
  for (const st of steps) {
    if (st.t <= t) s = st.survival;
    else break;
  }
  return s;
};

/**
 * Smallest t with S(t) <= 0.5, or null when the curve never reaches one half inside the observed
 * support (median not identified because of censoring).
 */
export const kmMedian = (steps: readonly SurvivalStep[]): number | null => {
  for (const st of steps) if (st.survival <= 0.5) return st.t;
  return null;
};

/** Pearson correlation. NaN below two points or with zero variance. */
export const pearson = (xs: readonly number[], ys: readonly number[]): number => {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return NaN;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return NaN;
  return sxy / Math.sqrt(sxx * syy);
};

/** Deterministic PRNG for fixtures and tests. Never used for anything shown as market data. */
export const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const hashString = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

/** Greedy chronological thinning: keep an index when it is at least `gap` positions after the last kept one. */
export const spacedIndices = (indices: readonly number[], gap: number): number[] => {
  const out: number[] = [];
  let last = -Infinity;
  for (const i of indices) {
    if (i - last >= gap) {
      out.push(i);
      last = i;
    }
  }
  return out;
};
