/**
 * Shared indicators. All are past-only: the value at index i uses rows 0..i and nothing later.
 * Early values are null. They are never backfilled from later data.
 */
import type { Bar } from './types';
import { popStd } from './stats';

export type Series = (number | null)[];

/** Simple moving average of the last n values through i. Null until n valid values exist. */
export const sma = (values: readonly number[], n: number): Series => {
  const out: Series = new Array(values.length).fill(null);
  if (n <= 0) return out;
  let s = 0;
  for (let i = 0; i < values.length; i++) {
    s += values[i]!;
    if (i >= n) s -= values[i - n]!;
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
};

/** Exponential moving average seeded with the simple mean of the first n values. */
export const ema = (values: readonly number[], n: number): Series => {
  const out: Series = new Array(values.length).fill(null);
  if (values.length < n || n <= 0) return out;
  const k = 2 / (n + 1);
  let prev = 0;
  for (let i = 0; i < n; i++) prev += values[i]!;
  prev /= n;
  out[n - 1] = prev;
  for (let i = n; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
};

/** True range. Index 0 has no prior close and is null. */
export const trueRange = (bars: readonly Bar[]): Series => {
  const out: Series = new Array(bars.length).fill(null);
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    const pc = bars[i - 1]!.close;
    out[i] = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  }
  return out;
};

/**
 * Wilder ATR. Seed at index n is the simple mean of TR[1..n]. After that
 * ATR[i] = (ATR[i-1] * (n-1) + TR[i]) / n. Needs n + 1 bars for the first value.
 */
export const atrWilder = (bars: readonly Bar[], n = 14): Series => {
  const tr = trueRange(bars);
  const out: Series = new Array(bars.length).fill(null);
  if (bars.length <= n) return out;
  let s = 0;
  for (let i = 1; i <= n; i++) s += tr[i]!;
  let prev = s / n;
  out[n] = prev;
  for (let i = n + 1; i < bars.length; i++) {
    prev = (prev * (n - 1) + tr[i]!) / n;
    out[i] = prev;
  }
  return out;
};

/**
 * Wilder RSI. Seed at index n uses the simple mean of the first n gains and losses. After that
 * each average is (prev * (n-1) + current) / n.
 * Zero cases: no losses and some gains gives 100, no gains and some losses gives 0, both zero gives 50.
 */
export const rsiWilder = (closes: readonly number[], n = 14): Series => {
  const out: Series = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  let g = 0;
  let l = 0;
  for (let i = 1; i <= n; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    if (ch > 0) g += ch;
    else l -= ch;
  }
  g /= n;
  l /= n;
  const rsi = (ag: number, al: number): number => {
    if (al === 0) return ag === 0 ? 50 : 100;
    return 100 - 100 / (1 + ag / al);
  };
  out[n] = rsi(g, l);
  for (let i = n + 1; i < closes.length; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    g = (g * (n - 1) + (ch > 0 ? ch : 0)) / n;
    l = (l * (n - 1) + (ch < 0 ? -ch : 0)) / n;
    out[i] = rsi(g, l);
  }
  return out;
};

/** Simple daily returns C[i]/C[i-1] - 1. Index 0 is null. */
export const dailyReturns = (closes: readonly number[]): Series => {
  const out: Series = new Array(closes.length).fill(null);
  for (let i = 1; i < closes.length; i++) out[i] = closes[i]! / closes[i - 1]! - 1;
  return out;
};

/**
 * Rolling extreme over the window of `n` values ending at i (inclusive), or ending at i - 1 when
 * `excludeCurrent` is true. Null until the window is full. Returns value and index of the extreme.
 * Ties resolve to the earliest index, the declared convention for dated highs and lows.
 */
export const rollingExtreme = (
  values: readonly number[],
  n: number,
  kind: 'max' | 'min',
  excludeCurrent = false,
): { value: Series; index: (number | null)[] } => {
  const value: Series = new Array(values.length).fill(null);
  const index: (number | null)[] = new Array(values.length).fill(null);
  const dq: number[] = [];
  const better = (a: number, b: number) => (kind === 'max' ? a > b : a < b);
  for (let i = 0; i < values.length; i++) {
    const end = excludeCurrent ? i - 1 : i;
    if (end >= 0) {
      // Strict comparison keeps the earliest index on ties.
      while (dq.length && better(values[end]!, values[dq[dq.length - 1]!]!)) dq.pop();
      dq.push(end);
    }
    const start = end - n + 1;
    while (dq.length && dq[0]! < start) dq.shift();
    if (start >= 0 && dq.length) {
      value[i] = values[dq[0]!]!;
      index[i] = dq[0]!;
    }
  }
  return { value, index };
};

/** Volume divided by the mean volume of the preceding n sessions, excluding the current one. */
export const relativeVolume = (bars: readonly Bar[], n = 20): Series => {
  const out: Series = new Array(bars.length).fill(null);
  for (let i = n; i < bars.length; i++) {
    const v = bars[i]!.volume;
    if (v === null) continue;
    let s = 0;
    let ok = true;
    for (let j = i - n; j < i; j++) {
      const pv = bars[j]!.volume;
      if (pv === null) {
        ok = false;
        break;
      }
      s += pv;
    }
    if (ok && s > 0) out[i] = v / (s / n);
  }
  return out;
};

/** MACD line, signal and histogram with the standard 12, 26, 9 spans. */
export const macd = (closes: readonly number[], fast = 12, slow = 26, signal = 9): { line: Series; signal: Series; hist: Series } => {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line: Series = closes.map((_, i) => (ef[i] !== null && es[i] !== null ? ef[i]! - es[i]! : null));
  const firstIdx = line.findIndex((v) => v !== null);
  const sig: Series = new Array(closes.length).fill(null);
  if (firstIdx >= 0) {
    const tail = line.slice(firstIdx) as number[];
    const s = ema(tail, signal);
    for (let i = 0; i < s.length; i++) sig[firstIdx + i] = s[i]!;
  }
  const hist: Series = line.map((v, i) => (v !== null && sig[i] !== null ? v - sig[i]! : null));
  return { line, signal: sig, hist };
};

/** Bollinger band width: 4 x population standard deviation of the last n closes divided by their mean. */
export const bollingerWidth = (closes: readonly number[], n = 20): Series => {
  const out: Series = new Array(closes.length).fill(null);
  for (let i = n - 1; i < closes.length; i++) {
    const w = closes.slice(i - n + 1, i + 1);
    const m = w.reduce((a, b) => a + b, 0) / n;
    if (m > 0) out[i] = (4 * popStd(w)) / m;
  }
  return out;
};

/** Sample standard deviation of the n daily returns ending at i (inclusive). Needs n + 1 closes. */
export const rollingReturnStd = (closes: readonly number[], n = 20): Series => {
  const r = dailyReturns(closes);
  const out: Series = new Array(closes.length).fill(null);
  for (let i = n; i < closes.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += r[j]!;
    const m = s / n;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (r[j]! - m) ** 2;
    out[i] = Math.sqrt(v / (n - 1));
  }
  return out;
};
