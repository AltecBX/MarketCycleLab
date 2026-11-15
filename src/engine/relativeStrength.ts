/**
 * Multi timeframe relative strength, ranges, trend state, momentum and compression.
 *
 * Definitions
 * - Session windows (5D, 10D, 20D) are true rolling sessions: the window is the last N completed
 *   sessions and the return base is the close N sessions before the anchor.
 * - Calendar windows (1M, 3M, 6M, 9M, 1Y, 2Y, 3Y, 5Y) use the declared boundary from core
 *   `trailingMonthsBaseIndex`: the base is the last close on or before the date N months before
 *   the anchor and the window is (base, anchor]. YTD uses the prior year's final close as base.
 * - Range position is (C - L) / (H - L) on the selected basis. It is Unavailable when H = L.
 * - Historic percentile is the midrank of the current range position among the range positions
 *   of the same window at every EARLIER anchor.
 * - Relative comparisons use only sessions present in both series. The common date range and
 *   the number of dropped rows are disclosed.
 * - A swing pivot has an event date and a confirm date (k sessions later). It is usable only
 *   from its confirm date.
 * - State thresholds and their precedence come from the owner specification (provenance spec).
 *
 * Nothing here is a forecast. States are threshold classifications of observed prices.
 */
import { atrWilder, bollingerWidth, type Series } from './core/indicators';
import { alignBars, periodBaseIndex, sliceAsOf, trailingMonthsBaseIndex } from './core/series';
import { midrankPercentile, sampleStd, wilson } from './core/stats';
import { isNa, na, type Bar, type ISODate, type Maybe, type Proportion } from './core/types';

// ---------------------------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------------------------

export type WindowKey = '5D' | '10D' | '20D' | '1M' | '3M' | '6M' | '9M' | 'YTD' | '1Y' | '2Y' | '3Y' | '5Y';
export type WindowKind = 'sessions' | 'months' | 'ytd';
export type RangeBasis = 'close' | 'traded';

export interface WindowSpec {
  key: WindowKey;
  label: string;
  kind: WindowKind;
  /** Sessions for a session window, months for a calendar window, 0 for YTD. */
  n: number;
}

const spec = (key: WindowKey, label: string, kind: WindowKind, n: number): WindowSpec => ({ key, label, kind, n });

export const WINDOW_SPECS: Readonly<Record<WindowKey, WindowSpec>> = {
  '5D': spec('5D', '5 sessions', 'sessions', 5),
  '10D': spec('10D', '10 sessions', 'sessions', 10),
  '20D': spec('20D', '20 sessions', 'sessions', 20),
  '1M': spec('1M', '1 month', 'months', 1),
  '3M': spec('3M', '3 months', 'months', 3),
  '6M': spec('6M', '6 months', 'months', 6),
  '9M': spec('9M', '9 months', 'months', 9),
  YTD: spec('YTD', 'Year to date', 'ytd', 0),
  '1Y': spec('1Y', '1 year', 'months', 12),
  '2Y': spec('2Y', '2 years', 'months', 24),
  '3Y': spec('3Y', '3 years', 'months', 36),
  '5Y': spec('5Y', '5 years', 'months', 60),
};

export const ALL_WINDOWS: readonly WindowKey[] = ['5D', '10D', '20D', '1M', '3M', '6M', '9M', 'YTD', '1Y', '2Y', '3Y', '5Y'];

/**
 * Index of the base close for a window ending at bar i. The window rows are base + 1 .. i.
 * Unavailable when history does not reach the declared boundary.
 */
export const windowBase = (bars: readonly Bar[], i: number, key: WindowKey): Maybe<number> => {
  const s = WINDOW_SPECS[key];
  if (!bars[i]) return na('invalid-input', 'index outside series');
  if (s.kind === 'sessions') {
    return i - s.n >= 0 ? i - s.n : na('insufficient-history', `Needs ${s.n + 1} completed sessions`);
  }
  if (s.kind === 'months') return trailingMonthsBaseIndex(bars, i, s.n);
  return periodBaseIndex(bars, i, 'Y');
};

/** Base index for every anchor. -1 where the window is unavailable. */
export const windowBaseSeries = (bars: readonly Bar[], key: WindowKey): Int32Array => {
  const out = new Int32Array(bars.length).fill(-1);
  for (let i = 0; i < bars.length; i++) {
    const b = windowBase(bars, i, key);
    if (typeof b === 'number') out[i] = b;
  }
  return out;
};

/**
 * Extreme of `values` over rows base[i] + 1 .. i (or .. i - 1 when `excludeCurrent`).
 * Base indices must be non decreasing where available. Ties keep the earliest index.
 */
export const windowExtremeSeries = (
  values: readonly number[],
  base: Int32Array,
  kind: 'max' | 'min',
  excludeCurrent = false,
): { value: Series; index: (number | null)[] } => {
  const value: Series = new Array(values.length).fill(null);
  const index: (number | null)[] = new Array(values.length).fill(null);
  const dq: number[] = [];
  let head = 0;
  const better = (a: number, b: number) => (kind === 'max' ? a > b : a < b);
  for (let i = 0; i < values.length; i++) {
    const end = excludeCurrent ? i - 1 : i;
    if (end >= 0) {
      while (dq.length > head && better(values[end]!, values[dq[dq.length - 1]!]!)) dq.pop();
      dq.push(end);
    }
    const b = base[i]!;
    if (b < 0) continue;
    const start = b + 1;
    while (dq.length > head && dq[head]! < start) head++;
    if (start <= end && dq.length > head) {
      value[i] = values[dq[head]!]!;
      index[i] = dq[head]!;
    }
  }
  return { value, index };
};

const valuesOf = (bars: readonly Bar[], field: 'close' | 'high' | 'low'): number[] => bars.map((b) => b[field]);

/** Range position at every anchor for one window, null where unavailable or flat. */
export const rangePositionSeries = (bars: readonly Bar[], key: WindowKey, basis: RangeBasis = 'close'): Series => {
  const base = windowBaseSeries(bars, key);
  const hi = windowExtremeSeries(valuesOf(bars, basis === 'close' ? 'close' : 'high'), base, 'max').value;
  const lo = windowExtremeSeries(valuesOf(bars, basis === 'close' ? 'close' : 'low'), base, 'min').value;
  return bars.map((b, i) => {
    const h = hi[i];
    const l = lo[i];
    if (h === null || l === null || h === undefined || l === undefined || h === l) return null;
    return (b.close - l) / (h - l);
  });
};

// ---------------------------------------------------------------------------------------------
// Ranges and gauges
// ---------------------------------------------------------------------------------------------

export interface Extreme {
  value: number;
  date: ISODate;
  index: number;
  sessionsSince: number;
  /** Signed gap of the anchor close to this level: C / level - 1. */
  gap: number;
}

export interface ExtremePair {
  high: Extreme;
  low: Extreme;
}

export interface RangeStats {
  key: WindowKey;
  label: string;
  basis: RangeBasis;
  anchorDate: ISODate;
  close: number;
  baseDate: ISODate;
  baseClose: number;
  startDate: ISODate;
  sessions: number;
  /** Price return C(anchor) / C(base) - 1. */
  ret: number;
  /** Highest and lowest daily close inside the window. */
  closing: ExtremePair;
  /** Highest traded high and lowest traded low inside the window (quote range, intraday). */
  traded: ExtremePair;
  /** (H - L) / C on the selected basis. */
  width: number;
  /** (C - L) / (H - L) on the selected basis. */
  rangePosition: Maybe<number>;
  /** The anchor close sits inside the selected range. Always true for a completed close. A hypothetical price can fall outside. */
  inside: boolean;
  /** Sample standard deviation of the daily close to close returns inside the window. */
  dailyVol: Maybe<number>;
  /** Deepest decline inside the window on the selected basis, as a negative fraction or 0. */
  maxDrawdown: number;
  /** Rows after the first that set a new running high inside the window, on the selected basis. */
  newHighCount: number;
  /** newHighCount / (sessions - 1). */
  newHighFrequency: Maybe<number>;
  /** Midrank percentile of the current range position among earlier anchors of the same window. */
  percentile: Maybe<number>;
  /** Number of earlier anchors behind the percentile. */
  percentileN: number;
}

export interface RangeOptions {
  basis?: RangeBasis;
  /** Compute the historic percentile. It scans the full history. Default true. */
  withPercentile?: boolean;
}

const extremeOver = (bars: readonly Bar[], from: number, to: number, field: 'close' | 'high' | 'low', kind: 'max' | 'min', anchor: number): Extreme => {
  let idx = from;
  let v = bars[from]![field];
  for (let k = from + 1; k <= to; k++) {
    const x = bars[k]![field];
    if (kind === 'max' ? x > v : x < v) {
      v = x;
      idx = k;
    }
  }
  return { value: v, date: bars[idx]!.date, index: idx, sessionsSince: anchor - idx, gap: bars[anchor]!.close / v - 1 };
};

/** Range statistics for one window ending at bar i. */
export const rangeStats = (bars: readonly Bar[], i: number, key: WindowKey, opts: RangeOptions = {}): Maybe<RangeStats> => {
  const basis = opts.basis ?? 'close';
  const base = windowBase(bars, i, key);
  if (typeof base !== 'number') return base;
  const from = base + 1;
  if (from > i) return na('insufficient-history', 'Window holds no completed session');
  const a = bars[i]!;
  const b = bars[base]!;
  const closing: ExtremePair = { high: extremeOver(bars, from, i, 'close', 'max', i), low: extremeOver(bars, from, i, 'close', 'min', i) };
  const traded: ExtremePair = { high: extremeOver(bars, from, i, 'high', 'max', i), low: extremeOver(bars, from, i, 'low', 'min', i) };
  const sel = basis === 'close' ? closing : traded;
  const H = sel.high.value;
  const L = sel.low.value;
  const rets: number[] = [];
  for (let k = from; k <= i; k++) rets.push(bars[k]!.close / bars[k - 1]!.close - 1);
  // Max drawdown. Close basis: close versus the running closing peak inside the window.
  // Traded basis: low versus the highest high of EARLIER rows (order inside one bar is unknown).
  let maxDd = 0;
  let newHighs = 0;
  if (basis === 'close') {
    let peak = bars[from]!.close;
    for (let k = from + 1; k <= i; k++) {
      const c = bars[k]!.close;
      if (c > peak) {
        peak = c;
        newHighs++;
      } else maxDd = Math.min(maxDd, c / peak - 1);
    }
  } else {
    let peak = bars[from]!.high;
    for (let k = from + 1; k <= i; k++) {
      const r = bars[k]!;
      maxDd = Math.min(maxDd, r.low / peak - 1);
      if (r.high > peak) {
        peak = r.high;
        newHighs++;
      }
    }
  }
  const sessions = i - from + 1;
  const pos: Maybe<number> = H === L ? na('flat-range', 'High equals low inside the window') : (a.close - L) / (H - L);
  let percentile: Maybe<number> = na('not-applicable', 'Percentile not requested');
  let percentileN = 0;
  if (opts.withPercentile !== false) {
    if (isNa(pos)) percentile = pos;
    else {
      const hist = rangePositionSeries(bars.slice(0, i), key, basis).filter((v): v is number => v !== null);
      percentileN = hist.length;
      percentile = hist.length === 0 ? na('insufficient-history', 'No earlier comparable anchor') : midrankPercentile(hist, pos);
    }
  }
  const vol = sampleStd(rets);
  return {
    key,
    label: WINDOW_SPECS[key].label,
    basis,
    anchorDate: a.date,
    close: a.close,
    baseDate: b.date,
    baseClose: b.close,
    startDate: bars[from]!.date,
    sessions,
    ret: a.close / b.close - 1,
    closing,
    traded,
    width: (H - L) / a.close,
    rangePosition: pos,
    inside: a.close <= H && a.close >= L,
    dailyVol: Number.isFinite(vol) ? vol : na('insufficient-history', 'Needs at least two daily returns'),
    maxDrawdown: maxDd,
    newHighCount: newHighs,
    newHighFrequency: sessions > 1 ? newHighs / (sessions - 1) : na('insufficient-history', 'Single session window'),
    percentile,
    percentileN,
  };
};

export interface RangeGauge {
  key: WindowKey;
  label: string;
  stats: Maybe<RangeStats>;
}

/** Range statistics for several windows at one anchor. Windows without history carry their reason. */
export const rangeGauges = (bars: readonly Bar[], i: number = bars.length - 1, opts: RangeOptions & { windows?: readonly WindowKey[] } = {}): RangeGauge[] =>
  (opts.windows ?? ALL_WINDOWS).map((key) => ({ key, label: WINDOW_SPECS[key].label, stats: rangeStats(bars, i, key, opts) }));

/** True when the anchor close (or traded high) exceeds the window's prior extreme, excluding the anchor bar. */
export const isNewWindowHigh = (bars: readonly Bar[], i: number, key: WindowKey, basis: RangeBasis = 'close'): Maybe<boolean> => {
  const base = windowBase(bars, i, key);
  if (typeof base !== 'number') return base;
  if (base + 1 > i - 1) return na('insufficient-history', 'No prior row inside the window');
  const field = basis === 'close' ? 'close' : 'high';
  const prior = extremeOver(bars, base + 1, i - 1, field, 'max', i).value;
  return bars[i]![field] > prior;
};

export const isNewWindowLow = (bars: readonly Bar[], i: number, key: WindowKey, basis: RangeBasis = 'close'): Maybe<boolean> => {
  const base = windowBase(bars, i, key);
  if (typeof base !== 'number') return base;
  if (base + 1 > i - 1) return na('insufficient-history', 'No prior row inside the window');
  const field = basis === 'close' ? 'close' : 'low';
  const prior = extremeOver(bars, base + 1, i - 1, field, 'min', i).value;
  return bars[i]![field] < prior;
};

// ---------------------------------------------------------------------------------------------
// Relative matrix
// ---------------------------------------------------------------------------------------------

export type BenchmarkRole = 'market' | 'sector' | 'group' | 'custom';

export interface BenchmarkInput {
  symbol: string;
  bars: readonly Bar[];
  role?: BenchmarkRole;
}

export type RelativeDirection = 'improving' | 'weakening' | 'flat';

export interface RelativeRow {
  key: WindowKey;
  label: string;
  baseDate: ISODate;
  endDate: ISODate;
  /** Own price return over the window. */
  own: number;
  /** Benchmark price return over the same aligned window. */
  benchmark: number;
  /** own - benchmark, in percentage points expressed as a fraction. */
  excessPp: number;
  /** (1 + own) / (1 + benchmark). */
  relativeWealth: number;
  /** Change in this window's excess versus `lag` aligned sessions earlier. */
  excessChange: Maybe<number>;
  direction: Maybe<RelativeDirection>;
  /** Highest and lowest stock to benchmark price ratio inside the window. */
  ratioHigh: { value: number; date: ISODate; sessionsSince: number };
  ratioLow: { value: number; date: ISODate; sessionsSince: number };
}

export interface RelativePoint {
  date: ISODate;
  /** Relative wealth, 100 at the line start. */
  wealth100: number;
  /** Raw stock close divided by benchmark close. A price ratio, not a return. */
  ratio: number;
}

export interface RelativeMatrix {
  benchmark: string;
  role: BenchmarkRole;
  /** Sessions present in both series. */
  alignedSessions: number;
  commonFrom: ISODate;
  commonTo: ISODate;
  /** Rows inside the overlapping range that only one series had. They are excluded from both legs. */
  droppedRows: number;
  anchorDate: ISODate;
  /** True when the benchmark does not reach the stock's as-of date, so the comparison is older. */
  anchorLagsStock: boolean;
  lag: number;
  rows: { key: WindowKey; label: string; row: Maybe<RelativeRow> }[];
  lineFrom: ISODate;
  line: RelativePoint[];
}

export interface RelativeOptions {
  asOf?: ISODate;
  windows?: readonly WindowKey[];
  /** Aligned sessions used for the change in excess. Default 5. */
  lag?: number;
  /** Window whose base starts the normalized line. Falls back to the first common date. */
  lineWindow?: WindowKey;
}

interface Aligned {
  s: Bar[];
  b: Bar[];
  dropped: number;
}

const alignedPair = (stock: readonly Bar[], bench: readonly Bar[], asOf?: ISODate): Aligned => {
  const sCut = asOf ? sliceAsOf(stock, asOf) : stock;
  const bCut = asOf ? sliceAsOf(bench, asOf) : bench;
  const al = alignBars(sCut, bCut);
  return { s: al.ia.map((k) => sCut[k]!), b: al.ib.map((k) => bCut[k]!), dropped: al.dropped };
};

const excessAt = (s: readonly Bar[], b: readonly Bar[], i: number, key: WindowKey): Maybe<{ base: number; own: number; bench: number }> => {
  const base = windowBase(s, i, key);
  if (typeof base !== 'number') return base;
  return { base, own: s[i]!.close / s[base]!.close - 1, bench: b[i]!.close / b[base]!.close - 1 };
};

const FLAT_EPS = 1e-12;

/** Relative performance matrix against one benchmark on aligned sessions only. */
export const relativeMatrix = (stock: readonly Bar[], bench: BenchmarkInput, opts: RelativeOptions = {}): Maybe<RelativeMatrix> => {
  const stockCut = opts.asOf ? sliceAsOf(stock, opts.asOf) : stock;
  if (stockCut.length === 0) return na('no-coverage', 'No completed stock session at the as-of date');
  const { s, b, dropped } = alignedPair(stock, bench.bars, opts.asOf);
  if (s.length === 0) return na('no-coverage', `No session shared with ${bench.symbol}`);
  const a = s.length - 1;
  const lag = opts.lag ?? 5;
  const rows = (opts.windows ?? ALL_WINDOWS).map((key) => {
    const label = WINDOW_SPECS[key].label;
    const now = excessAt(s, b, a, key);
    if (isNa(now)) return { key, label, row: now as Maybe<RelativeRow> };
    const excess = now.own - now.bench;
    let change: Maybe<number> = na('insufficient-history', `Needs ${lag} earlier aligned sessions`);
    if (a - lag >= 0) {
      const prev = excessAt(s, b, a - lag, key);
      change = isNa(prev) ? prev : excess - (prev.own - prev.bench);
    }
    const direction: Maybe<RelativeDirection> = isNa(change) ? change : change > FLAT_EPS ? 'improving' : change < -FLAT_EPS ? 'weakening' : 'flat';
    let hi = now.base + 1;
    let lo = now.base + 1;
    const ratio = (k: number) => s[k]!.close / b[k]!.close;
    for (let k = now.base + 2; k <= a; k++) {
      if (ratio(k) > ratio(hi)) hi = k;
      if (ratio(k) < ratio(lo)) lo = k;
    }
    const row: RelativeRow = {
      key,
      label,
      baseDate: s[now.base]!.date,
      endDate: s[a]!.date,
      own: now.own,
      benchmark: now.bench,
      excessPp: excess,
      relativeWealth: (1 + now.own) / (1 + now.bench),
      excessChange: change,
      direction,
      ratioHigh: { value: ratio(hi), date: s[hi]!.date, sessionsSince: a - hi },
      ratioLow: { value: ratio(lo), date: s[lo]!.date, sessionsSince: a - lo },
    };
    return { key, label, row: row as Maybe<RelativeRow> };
  });
  const lb = windowBase(s, a, opts.lineWindow ?? '1Y');
  const start = typeof lb === 'number' ? lb : 0;
  const s0 = s[start]!.close;
  const b0 = b[start]!.close;
  const line: RelativePoint[] = [];
  for (let k = start; k <= a; k++) {
    line.push({ date: s[k]!.date, wealth100: (100 * (s[k]!.close / s0)) / (b[k]!.close / b0), ratio: s[k]!.close / b[k]!.close });
  }
  return {
    benchmark: bench.symbol,
    role: bench.role ?? 'custom',
    alignedSessions: s.length,
    commonFrom: s[0]!.date,
    commonTo: s[a]!.date,
    droppedRows: dropped,
    anchorDate: s[a]!.date,
    anchorLagsStock: s[a]!.date !== stockCut[stockCut.length - 1]!.date,
    lag,
    rows,
    lineFrom: s[start]!.date,
    line,
  };
};

// ---------------------------------------------------------------------------------------------
// Swing pivots and trend structure
// ---------------------------------------------------------------------------------------------

export const SWING_WINDOWS = [2, 3, 5, 8] as const;

export interface Pivot {
  kind: 'high' | 'low';
  /** Session of the extreme. */
  eventIndex: number;
  eventDate: ISODate;
  /** Session on which the pivot became knowable: k sessions after the event. */
  confirmIndex: number;
  confirmDate: ISODate;
  value: number;
  k: number;
}

/**
 * Confirmed swing pivots as of bar `asOfIndex`. A pivot high is strictly above the k values
 * before it and not below any of the k values after it (the earliest of equal highs wins).
 * A pivot whose confirm session is after `asOfIndex` is not returned.
 */
export const swingPivots = (bars: readonly Bar[], k: number, asOfIndex: number = bars.length - 1, basis: RangeBasis = 'close'): Pivot[] => {
  const out: Pivot[] = [];
  const hi = (j: number) => (basis === 'close' ? bars[j]!.close : bars[j]!.high);
  const lo = (j: number) => (basis === 'close' ? bars[j]!.close : bars[j]!.low);
  const last = Math.min(asOfIndex, bars.length - 1);
  for (let j = k; j + k <= last; j++) {
    let isHigh = true;
    let isLow = true;
    for (let d = 1; d <= k && (isHigh || isLow); d++) {
      if (!(hi(j) > hi(j - d)) || hi(j) < hi(j + d)) isHigh = false;
      if (!(lo(j) < lo(j - d)) || lo(j) > lo(j + d)) isLow = false;
    }
    const mk = (kind: 'high' | 'low', value: number): Pivot => ({
      kind,
      eventIndex: j,
      eventDate: bars[j]!.date,
      confirmIndex: j + k,
      confirmDate: bars[j + k]!.date,
      value,
      k,
    });
    if (isHigh) out.push(mk('high', hi(j)));
    if (isLow) out.push(mk('low', lo(j)));
  }
  return out;
};

export interface TrendStructure {
  date: ISODate;
  sma50: Maybe<number>;
  sma200: Maybe<number>;
  aboveSma50: boolean | null;
  aboveSma200: boolean | null;
  /** SMA now divided by SMA `slopeSessions` earlier, minus 1. */
  slope50: Maybe<number>;
  slope200: Maybe<number>;
  slopeSessions: number;
  swingK: number;
  lastSwingHighs: Pivot[];
  lastSwingLows: Pivot[];
  higherHighs: boolean | null;
  higherLows: boolean | null;
  lowerHighs: boolean | null;
  lowerLows: boolean | null;
  upDays: number;
  downDays: number;
  dayCountWindow: number;
}

const smaAt = (closes: readonly number[], n: number, i: number): Maybe<number> => {
  if (i < n - 1) return na('insufficient-history', `Needs ${n} completed closes`);
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += closes[k]!;
  return s / n;
};

/** Trend structure at bar i from past only data. */
export const trendStructure = (bars: readonly Bar[], i: number = bars.length - 1, opts: { swingK?: number; slopeSessions?: number; dayCountWindow?: number } = {}): Maybe<TrendStructure> => {
  const a = bars[i];
  if (!a) return na('invalid-input', 'index outside series');
  const swingK = opts.swingK ?? 3;
  const slopeSessions = opts.slopeSessions ?? 20;
  const win = opts.dayCountWindow ?? 20;
  const closes = bars.map((b) => b.close);
  const s50 = smaAt(closes, 50, i);
  const s200 = smaAt(closes, 200, i);
  const slope = (n: number, now: Maybe<number>): Maybe<number> => {
    if (isNa(now)) return now;
    const prev = smaAt(closes, n, i - slopeSessions);
    return isNa(prev) ? prev : now / prev - 1;
  };
  const piv = swingPivots(bars, swingK, i);
  const highs = piv.filter((p) => p.kind === 'high').slice(-2);
  const lows = piv.filter((p) => p.kind === 'low').slice(-2);
  const cmp = (ps: Pivot[], f: (a: number, b: number) => boolean): boolean | null => (ps.length < 2 ? null : f(ps[1]!.value, ps[0]!.value));
  let up = 0;
  let down = 0;
  for (let k = Math.max(1, i - win + 1); k <= i; k++) {
    const d = bars[k]!.close - bars[k - 1]!.close;
    if (d > 0) up++;
    else if (d < 0) down++;
  }
  return {
    date: a.date,
    sma50: s50,
    sma200: s200,
    aboveSma50: isNa(s50) ? null : a.close > s50,
    aboveSma200: isNa(s200) ? null : a.close > s200,
    slope50: slope(50, s50),
    slope200: slope(200, s200),
    slopeSessions,
    swingK,
    lastSwingHighs: highs,
    lastSwingLows: lows,
    higherHighs: cmp(highs, (x, y) => x > y),
    higherLows: cmp(lows, (x, y) => x > y),
    lowerHighs: cmp(highs, (x, y) => x < y),
    lowerLows: cmp(lows, (x, y) => x < y),
    upDays: up,
    downDays: down,
    dayCountWindow: win,
  };
};

// ---------------------------------------------------------------------------------------------
// Momentum: distance to the high and low, with attribution
// ---------------------------------------------------------------------------------------------

export interface DistanceAttribution {
  key: WindowKey;
  side: 'high' | 'low';
  lag: number;
  basis: RangeBasis;
  oldDate: ISODate;
  nowDate: ISODate;
  oldClose: number;
  nowClose: number;
  /** Window extreme at the earlier anchor and at the current anchor, with their dates. */
  oldLevel: number;
  oldLevelDate: ISODate;
  nowLevel: number;
  nowLevelDate: ISODate;
  /** C_old / level_old - 1 and C_now / level_now - 1. */
  oldDistance: number;
  nowDistance: number;
  /** nowDistance - oldDistance, in percentage points as a fraction. */
  change: number;
  /** (C_now / level_old - 1) - (C_old / level_old - 1). */
  pricePart: number;
  /** (C_now / level_now - 1) - (C_now / level_old - 1). */
  rolloverPart: number;
  /** The earlier extreme is no longer inside the current window. */
  oldLevelExpired: boolean;
  /** The current extreme was set after the earlier anchor. */
  newLevelSet: boolean;
}

/**
 * Change in the distance to a window's high or low over `lag` sessions, split into the part due
 * to price moving against the OLD level and the part due to the level itself rolling.
 * pricePart + rolloverPart = change, exactly.
 */
export const distanceAttribution = (
  bars: readonly Bar[],
  i: number,
  key: WindowKey,
  side: 'high' | 'low',
  lag = 5,
  basis: RangeBasis = 'close',
): Maybe<DistanceAttribution> => {
  if (i - lag < 0) return na('insufficient-history', `Needs ${lag} earlier sessions`);
  const baseNow = windowBase(bars, i, key);
  if (typeof baseNow !== 'number') return baseNow;
  const baseOld = windowBase(bars, i - lag, key);
  if (typeof baseOld !== 'number') return baseOld;
  const field = basis === 'close' ? 'close' : side === 'high' ? 'high' : 'low';
  const kind = side === 'high' ? 'max' : 'min';
  const old = extremeOver(bars, baseOld + 1, i - lag, field, kind, i - lag);
  const now = extremeOver(bars, baseNow + 1, i, field, kind, i);
  const cOld = bars[i - lag]!.close;
  const cNow = bars[i]!.close;
  const oldDistance = cOld / old.value - 1;
  const nowDistance = cNow / now.value - 1;
  return {
    key,
    side,
    lag,
    basis,
    oldDate: bars[i - lag]!.date,
    nowDate: bars[i]!.date,
    oldClose: cOld,
    nowClose: cNow,
    oldLevel: old.value,
    oldLevelDate: old.date,
    nowLevel: now.value,
    nowLevelDate: now.date,
    oldDistance,
    nowDistance,
    change: nowDistance - oldDistance,
    pricePart: cNow / old.value - 1 - oldDistance,
    rolloverPart: nowDistance - (cNow / old.value - 1),
    oldLevelExpired: old.index < baseNow + 1,
    newLevelSet: now.index > i - lag,
  };
};

export interface RangePositionShift {
  key: WindowKey;
  lag: number;
  now: number;
  before: number;
  change: number;
}

/** Change in range position over `lag` sessions for one window. */
export const rangePositionShift = (bars: readonly Bar[], i: number, key: WindowKey, lag = 5, basis: RangeBasis = 'close'): Maybe<RangePositionShift> => {
  if (i - lag < 0) return na('insufficient-history', `Needs ${lag} earlier sessions`);
  const now = rangeStats(bars, i, key, { basis, withPercentile: false });
  if (isNa(now)) return now;
  const before = rangeStats(bars, i - lag, key, { basis, withPercentile: false });
  if (isNa(before)) return before;
  if (isNa(now.rangePosition)) return now.rangePosition;
  if (isNa(before.rangePosition)) return before.rangePosition;
  return { key, lag, now: now.rangePosition, before: before.rangePosition, change: now.rangePosition - before.rangePosition };
};

// ---------------------------------------------------------------------------------------------
// State classification
// ---------------------------------------------------------------------------------------------

export type StrengthState =
  | 'Coverage limited'
  | 'Established uptrend'
  | 'Emerging strength'
  | 'Persistent weakness'
  | 'Trend deterioration'
  | 'Weakening momentum'
  | 'Early stabilization'
  | 'Mixed trend';

/** Thresholds and precedence from the owner specification. */
export const STATE_THRESHOLDS = {
  provenance: 'spec' as const,
  strong1M: 0.72,
  established1Y: 0.8,
  emerging1YBelow: 0.65,
  weak1M: 0.35,
  persistent1Y: 0.4,
  deterioration1Y: 0.65,
  /** Five session change in the distance to the 3M high, in percentage points as a fraction. */
  momentumPp: 0.06,
  momentumLag: 5,
  earlyLeadershipBelowYearHigh: 0.15,
  relativeLeadingPriceGap: 0.01,
  compressionRatio: 0.45,
};

export interface StateInput {
  pos1M: Maybe<number> | null;
  pos1Y: Maybe<number> | null;
  aboveSma200: boolean | null;
  /** Five session change in the distance to the 3M high. */
  highDistanceChange3M: Maybe<number> | null;
}

export interface StateResult {
  state: StrengthState;
  /** Plain statement of the rule that matched. */
  rule: string;
}

const num = (v: Maybe<number> | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Observed trend state. The first matching rule wins, in the order of the owner specification.
 * This is a threshold classification of range positions. It is not a validated signal.
 */
export const stateFor = (input: StateInput): StateResult => {
  const t = STATE_THRESHOLDS;
  const m = num(input.pos1M);
  const y = num(input.pos1Y);
  if (m === null || y === null) return { state: 'Coverage limited', rule: 'The 1 month or 1 year range position is unavailable.' };
  if (m >= t.strong1M && y >= t.established1Y && input.aboveSma200 === true) {
    return { state: 'Established uptrend', rule: '1 month position at least 0.72, 1 year position at least 0.80, close above the 200 session average.' };
  }
  if (m >= t.strong1M && y < t.emerging1YBelow) return { state: 'Emerging strength', rule: '1 month position at least 0.72 while the 1 year position is below 0.65.' };
  if (m <= t.weak1M && y <= t.persistent1Y) return { state: 'Persistent weakness', rule: '1 month position at most 0.35 and 1 year position at most 0.40.' };
  if (m <= t.weak1M && y >= t.deterioration1Y) return { state: 'Trend deterioration', rule: '1 month position at most 0.35 while the 1 year position is at least 0.65.' };
  const d = num(input.highDistanceChange3M);
  if (d !== null && d <= -t.momentumPp) return { state: 'Weakening momentum', rule: 'Distance to the 3 month high fell by 6 pp or more in five sessions.' };
  if (d !== null && d >= t.momentumPp) return { state: 'Early stabilization', rule: 'Distance to the 3 month high improved by 6 pp or more in five sessions.' };
  return { state: 'Mixed trend', rule: 'No other rule matched.' };
};

export interface EarlyLeadership {
  active: boolean;
  /** Windows whose prior high the anchor close exceeded. */
  newHighWindows: WindowKey[];
  /** C / 1Y high - 1 on the selected basis. */
  distanceToYearHigh: number;
  yearHigh: number;
  yearHighDate: ISODate;
}

/**
 * Early leadership: a confirmed close above the prior 1M, 3M or 6M closing high while the close
 * is still at least 15% below the 1Y high. Unavailable when the 1Y window is not covered.
 */
export const earlyLeadership = (bars: readonly Bar[], i: number, basis: RangeBasis = 'close'): Maybe<EarlyLeadership> => {
  const yr = rangeStats(bars, i, '1Y', { basis, withPercentile: false });
  if (isNa(yr)) return yr;
  const high = basis === 'close' ? yr.closing.high : yr.traded.high;
  const wins: WindowKey[] = [];
  for (const k of ['1M', '3M', '6M'] as const) if (isNewWindowHigh(bars, i, k, 'close') === true) wins.push(k);
  const dist = bars[i]!.close / high.value - 1;
  return {
    active: wins.length > 0 && dist <= -STATE_THRESHOLDS.earlyLeadershipBelowYearHigh,
    newHighWindows: wins,
    distanceToYearHigh: dist,
    yearHigh: high.value,
    yearHighDate: high.date,
  };
};

export interface StrengthProfile {
  date: ISODate;
  close: number;
  basis: RangeBasis;
  pos1M: Maybe<number>;
  pos1Y: Maybe<number>;
  aboveSma200: boolean | null;
  highDistance3M: Maybe<DistanceAttribution>;
  state: StrengthState;
  rule: string;
  earlyLeadership: Maybe<EarlyLeadership>;
  newHigh: Record<'1M' | '3M' | '6M', Maybe<boolean>>;
  trend: Maybe<TrendStructure>;
}

/** Observed state and its inputs at bar i. */
export const strengthProfile = (bars: readonly Bar[], i: number = bars.length - 1, opts: { basis?: RangeBasis; swingK?: number } = {}): Maybe<StrengthProfile> => {
  const a = bars[i];
  if (!a) return na('invalid-input', 'index outside series');
  const basis = opts.basis ?? 'close';
  const pos = (k: WindowKey): Maybe<number> => {
    const r = rangeStats(bars, i, k, { basis, withPercentile: false });
    return isNa(r) ? r : r.rangePosition;
  };
  const pos1M = pos('1M');
  const pos1Y = pos('1Y');
  const trend = trendStructure(bars, i, { swingK: opts.swingK });
  const aboveSma200 = isNa(trend) ? null : trend.aboveSma200;
  const dist = distanceAttribution(bars, i, '3M', 'high', STATE_THRESHOLDS.momentumLag, basis);
  const st = stateFor({ pos1M, pos1Y, aboveSma200, highDistanceChange3M: isNa(dist) ? dist : dist.change });
  return {
    date: a.date,
    close: a.close,
    basis,
    pos1M,
    pos1Y,
    aboveSma200,
    highDistance3M: dist,
    state: st.state,
    rule: st.rule,
    earlyLeadership: earlyLeadership(bars, i, basis),
    newHigh: { '1M': isNewWindowHigh(bars, i, '1M'), '3M': isNewWindowHigh(bars, i, '3M'), '6M': isNewWindowHigh(bars, i, '6M') },
    trend,
  };
};

// ---------------------------------------------------------------------------------------------
// Divergences
// ---------------------------------------------------------------------------------------------

export interface RelativeLeading {
  active: boolean;
  date: ISODate;
  /** The ratio at the anchor exceeds every earlier ratio inside the 3M window. */
  ratioAtNewHigh: boolean;
  /** C / 3M closing high - 1. */
  priceGapToHigh: number;
}

export interface PivotDivergence {
  active: boolean;
  /** Earlier and later confirmed pivots of the price. */
  first: Pivot;
  second: Pivot;
  priceChange: number;
  /** Ratio at the later pivot divided by the ratio at the earlier pivot, minus 1. */
  ratioChange: number;
  /** The divergence is knowable from this date (confirm date of the later pivot). */
  confirmDate: ISODate;
}

export interface Divergences {
  benchmark: string;
  anchorDate: ISODate;
  swingK: number;
  /** Ratio at a new 3M high while price is more than 1% below its 3M closing high. */
  relativeLeading: Maybe<RelativeLeading>;
  /** Price made a lower swing low while the ratio was higher at that low. */
  lowerLowRatioImproving: Maybe<PivotDivergence>;
  /** Price made a higher swing high while the ratio was lower at that high. */
  higherHighRatioWeaker: Maybe<PivotDivergence>;
}

/** Divergence tests between price and the stock to benchmark ratio, on aligned sessions. */
export const relativeDivergences = (stock: readonly Bar[], bench: BenchmarkInput, opts: { asOf?: ISODate; swingK?: number } = {}): Maybe<Divergences> => {
  const { s, b } = alignedPair(stock, bench.bars, opts.asOf);
  if (s.length === 0) return na('no-coverage', `No session shared with ${bench.symbol}`);
  const a = s.length - 1;
  const k = opts.swingK ?? 3;
  const ratio = (j: number) => s[j]!.close / b[j]!.close;
  let leading: Maybe<RelativeLeading>;
  const base = windowBase(s, a, '3M');
  if (typeof base !== 'number') leading = base;
  else if (base + 1 > a - 1) leading = na('insufficient-history', 'No prior row inside the 3 month window');
  else {
    let priorRatioHigh = -Infinity;
    let closeHigh = -Infinity;
    for (let j = base + 1; j <= a; j++) {
      if (j < a) priorRatioHigh = Math.max(priorRatioHigh, ratio(j));
      closeHigh = Math.max(closeHigh, s[j]!.close);
    }
    const atHigh = ratio(a) > priorRatioHigh;
    const gap = s[a]!.close / closeHigh - 1;
    leading = { active: atHigh && gap < -STATE_THRESHOLDS.relativeLeadingPriceGap, date: s[a]!.date, ratioAtNewHigh: atHigh, priceGapToHigh: gap };
  }
  const piv = swingPivots(s, k, a);
  const pair = (kind: 'high' | 'low'): Maybe<PivotDivergence> => {
    const ps = piv.filter((p) => p.kind === kind).slice(-2);
    if (ps.length < 2) return na('insufficient-history', `Fewer than two confirmed swing ${kind}s`);
    const [p1, p2] = [ps[0]!, ps[1]!];
    const priceChange = p2.value / p1.value - 1;
    const ratioChange = ratio(p2.eventIndex) / ratio(p1.eventIndex) - 1;
    const active = kind === 'low' ? priceChange < 0 && ratioChange > 0 : priceChange > 0 && ratioChange < 0;
    return { active, first: p1, second: p2, priceChange, ratioChange, confirmDate: p2.confirmDate };
  };
  return {
    benchmark: bench.symbol,
    anchorDate: s[a]!.date,
    swingK: k,
    relativeLeading: leading,
    lowerLowRatioImproving: pair('low'),
    higherHighRatioWeaker: pair('high'),
  };
};

// ---------------------------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------------------------

/** 1M range width divided by 3M range width at bar i, without history scans. */
export const compressionRatioAt = (bars: readonly Bar[], i: number, basis: RangeBasis = 'close'): Maybe<number> => {
  const m1 = rangeStats(bars, i, '1M', { basis, withPercentile: false });
  if (isNa(m1)) return m1;
  const m3 = rangeStats(bars, i, '3M', { basis, withPercentile: false });
  if (isNa(m3)) return m3;
  if (m3.width === 0) return na('flat-range', '3 month range has no width');
  return m1.width / m3.width;
};

export interface Compression {
  date: ISODate;
  basis: RangeBasis;
  width1M: number;
  width3M: number;
  /** width1M / width3M. */
  ratio: number;
  threshold: number;
  /** ratio <= threshold. */
  compressed: boolean;
  /** Consecutive sessions through the anchor on the current side of the threshold. */
  elapsedSessions: number;
  /** Midrank percentile of the ratio among earlier anchors. Low means unusually tight. */
  percentile: Maybe<number>;
  percentileN: number;
  /** Sensitivity: the state at thresholds 0.35, 0.45 and 0.55. */
  sensitivity: { threshold: number; compressed: boolean }[];
  atrPct: Maybe<number>;
  bollingerWidth: Maybe<number>;
  /** Sample std of the last 20 daily returns, and of the 20 before those. */
  volNow: Maybe<number>;
  volPrior: Maybe<number>;
}

const widthSeries = (bars: readonly Bar[], key: WindowKey, basis: RangeBasis): Series => {
  const base = windowBaseSeries(bars, key);
  const hi = windowExtremeSeries(valuesOf(bars, basis === 'close' ? 'close' : 'high'), base, 'max').value;
  const lo = windowExtremeSeries(valuesOf(bars, basis === 'close' ? 'close' : 'low'), base, 'min').value;
  return bars.map((b, i) => (hi[i] === null || lo[i] === null || hi[i] === undefined || lo[i] === undefined ? null : (hi[i]! - lo[i]!) / b.close));
};

/** 1M to 3M width ratio at every anchor. Null where either window is unavailable or the 3M range is flat. */
export const compressionRatioSeries = (bars: readonly Bar[], basis: RangeBasis = 'close'): Series => {
  const w1 = widthSeries(bars, '1M', basis);
  const w3 = widthSeries(bars, '3M', basis);
  return bars.map((_, i) => (w1[i] === null || w3[i] === null || w3[i] === 0 || w1[i] === undefined || w3[i] === undefined ? null : w1[i]! / w3[i]!));
};

const stdOfReturns = (bars: readonly Bar[], from: number, to: number): Maybe<number> => {
  if (from < 1) return na('insufficient-history', 'Needs a prior close for each return');
  const r: number[] = [];
  for (let k = from; k <= to; k++) r.push(bars[k]!.close / bars[k - 1]!.close - 1);
  const v = sampleStd(r);
  return Number.isFinite(v) ? v : na('insufficient-history', 'Needs at least two daily returns');
};

/** Range compression at bar i: one month width at most 45% of three month width. */
export const compressionAt = (bars: readonly Bar[], i: number = bars.length - 1, opts: { basis?: RangeBasis; threshold?: number } = {}): Maybe<Compression> => {
  const basis = opts.basis ?? 'close';
  const threshold = opts.threshold ?? STATE_THRESHOLDS.compressionRatio;
  const m1 = rangeStats(bars, i, '1M', { basis, withPercentile: false });
  if (isNa(m1)) return m1;
  const m3 = rangeStats(bars, i, '3M', { basis, withPercentile: false });
  if (isNa(m3)) return m3;
  if (m3.width === 0) return na('flat-range', '3 month range has no width');
  const ratio = m1.width / m3.width;
  const series = compressionRatioSeries(bars.slice(0, i + 1), basis);
  const compressed = ratio <= threshold;
  let elapsed = 1;
  for (let j = i - 1; j >= 0; j--) {
    const r = series[j];
    if (r === null || r === undefined || r <= threshold !== compressed) break;
    elapsed++;
  }
  const hist = series.slice(0, i).filter((v): v is number => v !== null);
  const atr = atrWilder(bars.slice(0, i + 1))[i];
  const boll = bollingerWidth(bars.slice(Math.max(0, i - 19), i + 1).map((b) => b.close))[Math.min(19, i)];
  return {
    date: bars[i]!.date,
    basis,
    width1M: m1.width,
    width3M: m3.width,
    ratio,
    threshold,
    compressed,
    elapsedSessions: elapsed,
    percentile: hist.length === 0 ? na('insufficient-history', 'No earlier comparable anchor') : midrankPercentile(hist, ratio),
    percentileN: hist.length,
    sensitivity: [0.35, 0.45, 0.55].map((t) => ({ threshold: t, compressed: ratio <= t })),
    atrPct: atr === null || atr === undefined ? na('insufficient-history', 'Needs 15 completed sessions') : atr / bars[i]!.close,
    bollingerWidth: boll === null || boll === undefined ? na('insufficient-history', 'Needs 20 completed closes') : boll,
    volNow: i >= 20 ? stdOfReturns(bars, i - 19, i) : na('insufficient-history', 'Needs 21 completed closes'),
    volPrior: i >= 40 ? stdOfReturns(bars, i - 39, i - 20) : na('insufficient-history', 'Needs 41 completed closes'),
  };
};

// ---------------------------------------------------------------------------------------------
// Emergent transitions, graded against the stock's own history
// ---------------------------------------------------------------------------------------------

export type TransitionId = 'range-position-surge' | 'outperformance-gained' | 'outperformance-lost' | 'fresh-3m-high' | 'relative-weakening-run';

/** Spec thresholds, plus the two choices the specification leaves open (tagged proposed). */
export const TRANSITION_DEFAULTS = {
  surgeFrom: { value: 0.35, provenance: 'spec' as const },
  surgeTo: { value: 0.8, provenance: 'spec' as const },
  surgeSessions: { value: 10, provenance: 'spec' as const },
  freshHighQuietSessions: { value: 80, provenance: 'spec' as const },
  /** Window whose range position the surge rule reads. The specification does not name one. */
  surgeWindow: { value: '3M' as WindowKey, provenance: 'proposed' as const },
  /** Consecutive sessions of falling 3M excess that count as a weakening run. */
  weakeningRun: { value: 3, provenance: 'proposed' as const },
  /** Window of the excess used for outperformance gain, loss and weakening. */
  excessWindow: { value: '3M' as WindowKey, provenance: 'proposed' as const },
};

export interface Transition {
  id: TransitionId;
  label: string;
  /** True when the transition fired on the anchor session. */
  active: boolean;
  date: ISODate;
  detail: string;
  /** How often this transition fired on eligible earlier sessions. Rarer is more notable. */
  ownHistory: Proportion | null;
}

export interface TransitionOptions {
  asOf?: ISODate;
  benchmark?: BenchmarkInput;
  basis?: RangeBasis;
}

const grade = (flags: readonly (boolean | null)[], upTo: number): Proportion | null => {
  let hits = 0;
  let n = 0;
  for (let j = 0; j < upTo; j++) {
    const f = flags[j];
    if (f === null || f === undefined) continue;
    n++;
    if (f) hits++;
  }
  return wilson(hits, n);
};

/** Observable transitions at the anchor, each with its historical frequency for this stock. */
export const emergentTransitions = (stock: readonly Bar[], opts: TransitionOptions = {}): Maybe<Transition[]> => {
  const bars = opts.asOf ? sliceAsOf(stock, opts.asOf) : stock;
  if (bars.length === 0) return na('no-coverage', 'No completed session at the as-of date');
  const basis = opts.basis ?? 'close';
  const d = TRANSITION_DEFAULTS;
  const i = bars.length - 1;
  const out: Transition[] = [];
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

  // 1. Range position from 35% or lower to 80% or higher within ten sessions.
  const pos = rangePositionSeries(bars, d.surgeWindow.value, basis);
  const n = d.surgeSessions.value;
  const surge: (boolean | null)[] = pos.map((p, j) => {
    const q = j - n >= 0 ? pos[j - n] : null;
    if (p === null || q === null || q === undefined) return null;
    return q <= d.surgeFrom.value && p >= d.surgeTo.value;
  });
  out.push({
    id: 'range-position-surge',
    label: `Range position from ${pct(d.surgeFrom.value)} or lower to ${pct(d.surgeTo.value)} or higher in ${n} sessions`,
    active: surge[i] === true,
    date: bars[i]!.date,
    detail: surge[i] === null ? 'Range position unavailable at one of the two anchors.' : `${WINDOW_SPECS[d.surgeWindow.value].label} range position ${pos[i - n]!.toFixed(2)} then ${pos[i]!.toFixed(2)}.`,
    ownHistory: grade(surge, i),
  });

  // 2. First fresh 3M closing high in 80 sessions.
  const base3 = windowBaseSeries(bars, '3M');
  const closes = valuesOf(bars, 'close');
  const prior = windowExtremeSeries(closes, base3, 'max', true).value;
  const newHigh: (boolean | null)[] = bars.map((b, j) => (prior[j] === null || prior[j] === undefined ? null : b.close > prior[j]!));
  const quiet = d.freshHighQuietSessions.value;
  let sinceLast = Infinity;
  let eligibleRun = 0;
  const fresh: (boolean | null)[] = newHigh.map((f) => {
    if (f === null) {
      eligibleRun = 0;
      sinceLast = Infinity;
      return null;
    }
    const enoughHistory = eligibleRun >= quiet;
    const fired = f && sinceLast > quiet;
    sinceLast = f ? 1 : sinceLast + 1;
    eligibleRun++;
    if (!enoughHistory) return null;
    return fired;
  });
  out.push({
    id: 'fresh-3m-high',
    label: `First new 3 month closing high in ${quiet} sessions`,
    active: fresh[i] === true,
    date: bars[i]!.date,
    detail: fresh[i] === null ? `Needs ${quiet} earlier sessions with a covered 3 month window.` : newHigh[i] ? 'Close above the prior 3 month closing high.' : 'No new 3 month closing high on this session.',
    ownHistory: grade(fresh, i),
  });

  // 3 to 5. Benchmark based transitions on aligned sessions.
  if (opts.benchmark) {
    const { s, b } = alignedPair(bars, opts.benchmark.bars);
    const a = s.length - 1;
    const onAnchor = a >= 0 && s[a]!.date === bars[i]!.date;
    const w = d.excessWindow.value;
    const baseS = windowBaseSeries(s, w);
    const excess: (number | null)[] = s.map((row, j) => {
      const k = baseS[j]!;
      return k < 0 ? null : row.close / s[k]!.close - 1 - (b[j]!.close / b[k]!.close - 1);
    });
    const gained: (boolean | null)[] = excess.map((e, j) => (j < 1 || e === null || excess[j - 1] === null ? null : excess[j - 1]! <= 0 && e > 0));
    const lost: (boolean | null)[] = excess.map((e, j) => (j < 1 || e === null || excess[j - 1] === null ? null : excess[j - 1]! > 0 && e <= 0));
    let run = 0;
    const runLen: (number | null)[] = excess.map((e, j) => {
      const p = j - 5 >= 0 ? excess[j - 5] : null;
      if (e === null || p === null || p === undefined) {
        run = 0;
        return null;
      }
      run = e - p < 0 ? run + 1 : 0;
      return run;
    });
    const need = d.weakeningRun.value;
    const weak: (boolean | null)[] = runLen.map((r) => (r === null ? null : r >= need));
    const sym = opts.benchmark.symbol;
    const lbl = WINDOW_SPECS[w].label;
    const missing = `No session shared with ${sym} on the anchor date.`;
    const fmt = (x: number | null | undefined) => (x === null || x === undefined ? 'unavailable' : `${(x * 100).toFixed(1)} pp`);
    out.push({
      id: 'outperformance-gained',
      label: `${lbl} excess versus ${sym} turned positive`,
      active: onAnchor && gained[a] === true,
      date: bars[i]!.date,
      detail: onAnchor ? `Excess ${fmt(excess[a - 1])} then ${fmt(excess[a])}.` : missing,
      ownHistory: grade(gained, onAnchor ? a : s.length),
    });
    out.push({
      id: 'outperformance-lost',
      label: `${lbl} excess versus ${sym} turned non positive`,
      active: onAnchor && lost[a] === true,
      date: bars[i]!.date,
      detail: onAnchor ? `Excess ${fmt(excess[a - 1])} then ${fmt(excess[a])}.` : missing,
      ownHistory: grade(lost, onAnchor ? a : s.length),
    });
    out.push({
      id: 'relative-weakening-run',
      label: `${lbl} excess versus ${sym} lower than five sessions earlier for ${need} or more sessions in a row`,
      active: onAnchor && weak[a] === true,
      date: bars[i]!.date,
      detail: onAnchor ? `Current run ${runLen[a] ?? 0} sessions.` : missing,
      ownHistory: grade(weak, onAnchor ? a : s.length),
    });
  }
  return out;
};

// ---------------------------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------------------------

export interface ScannerInput {
  instrumentId: string;
  symbol: string;
  bars: readonly Bar[];
}

export interface ScannerOptions {
  /** Common completed date. Default: the most common last date across inputs, latest on ties. */
  date?: ISODate;
  market?: BenchmarkInput;
  /** Sector reference per symbol. */
  sectorOf?: (symbol: string) => BenchmarkInput | null;
  /** Proximity to a high that counts as near. 0.01, 0.02 or 0.05. Default 0.02. */
  proximity?: number;
  basis?: RangeBasis;
}

/** Scanner choices the specification leaves open. */
export const SCANNER_DEFAULTS = {
  provenance: 'proposed' as const,
  /** Market 20 session return at or below this counts as a falling market. */
  marketDown: -0.02,
  /** Sessions before the anchor inside which compression must have held for a breakout after compression. */
  compressionLookback: 5,
};

export interface ScannerRow {
  instrumentId: string;
  symbol: string;
  date: ISODate;
  close: number;
  state: StrengthState;
  /** Signed gap of the close to each window's high on the selected basis. */
  gapToHigh: Record<'1M' | '3M' | '6M' | '1Y', number | null>;
  sessionsSinceHigh: Record<'1M' | '3M' | '6M' | '1Y', number | null>;
  rangePosition: Record<'1M' | '3M' | '6M' | '1Y', number | null>;
  ret1M: number | null;
  ret3M: number | null;
  ret20D: number | null;
  /** Excess versus the market and sector references in pp. Null means not comparable, never zero. */
  excessMarket1M: number | null;
  excessMarket3M: number | null;
  excessSector1M: number | null;
  excessSector3M: number | null;
  relativeVolume: number | null;
  nearHigh: Record<'1M' | '3M' | '6M' | '1Y', boolean | null>;
  newHigh: Record<'1M' | '3M' | '6M', boolean | null>;
  earlyStrength: boolean | null;
  fallingRatioRisingStock: boolean | null;
  breakoutAfterCompression: boolean | null;
  holdingUpInDownMarket: boolean | null;
  /** Outcome validation is computed on demand elsewhere. An unscored row is not a zero score. */
  validation: { status: 'unscored' } | { status: 'scored'; value: number; n: number; state: string };
}

export interface ScannerResult {
  date: ISODate;
  proximity: number;
  basis: RangeBasis;
  rows: ScannerRow[];
  /** Inputs that have no completed session on the common date. */
  excluded: { symbol: string; reason: string }[];
}

const KEYS4 = ['1M', '3M', '6M', '1Y'] as const;

const relVolAt = (bars: readonly Bar[], i: number, n = 20): number | null => {
  const v = bars[i]?.volume;
  if (v === null || v === undefined || i < n) return null;
  let s = 0;
  for (let j = i - n; j < i; j++) {
    const pv = bars[j]!.volume;
    if (pv === null) return null;
    s += pv;
  }
  return s > 0 ? v / (s / n) : null;
};

const boolOrNull = (v: Maybe<boolean>): boolean | null => (typeof v === 'boolean' ? v : null);

const excessFor = (stock: readonly Bar[], bench: BenchmarkInput | null | undefined, date: ISODate, key: WindowKey): number | null => {
  if (!bench) return null;
  const { s, b } = alignedPair(stock, bench.bars, date);
  const a = s.length - 1;
  if (a < 0 || s[a]!.date !== date) return null;
  const e = excessAt(s, b, a, key);
  return isNa(e) ? null : e.own - e.bench;
};

/** One scanner row at the given date. Unavailable when the series has no session on that date. */
export const scannerRow = (input: ScannerInput, date: ISODate, opts: ScannerOptions = {}): Maybe<ScannerRow> => {
  const bars = sliceAsOf(input.bars, date);
  const i = bars.length - 1;
  if (i < 0 || bars[i]!.date !== date) return na('missing-session', `No completed session on ${date}`);
  const basis = opts.basis ?? 'close';
  const proximity = opts.proximity ?? 0.02;
  const gap = {} as ScannerRow['gapToHigh'];
  const since = {} as ScannerRow['sessionsSinceHigh'];
  const posn = {} as ScannerRow['rangePosition'];
  const near = {} as ScannerRow['nearHigh'];
  const rets: Partial<Record<WindowKey, number | null>> = {};
  for (const k of KEYS4) {
    const r = rangeStats(bars, i, k, { basis, withPercentile: false });
    if (isNa(r)) {
      gap[k] = since[k] = posn[k] = near[k] = null;
      rets[k] = null;
      continue;
    }
    const h = basis === 'close' ? r.closing.high : r.traded.high;
    gap[k] = h.gap;
    since[k] = h.sessionsSince;
    posn[k] = isNa(r.rangePosition) ? null : r.rangePosition;
    near[k] = h.gap >= -proximity;
    rets[k] = r.ret;
  }
  const ret20 = i >= 20 ? bars[i]!.close / bars[i - 20]!.close - 1 : null;
  const profile = strengthProfile(bars, i, { basis });
  const lead = earlyLeadership(bars, i, basis);
  const newHigh = {
    '1M': boolOrNull(isNewWindowHigh(bars, i, '1M')),
    '3M': boolOrNull(isNewWindowHigh(bars, i, '3M')),
    '6M': boolOrNull(isNewWindowHigh(bars, i, '6M')),
  };
  // Falling ratio on a rising stock: 20 session return positive while the 20 session excess is negative.
  let fallingRatio: boolean | null = null;
  let holdingUp: boolean | null = null;
  if (opts.market && ret20 !== null) {
    const { s, b } = alignedPair(bars, opts.market.bars);
    const a = s.length - 1;
    if (a >= 20 && s[a]!.date === date) {
      const own = s[a]!.close / s[a - 20]!.close - 1;
      const mk = b[a]!.close / b[a - 20]!.close - 1;
      fallingRatio = own > 0 && own - mk < 0;
      holdingUp = mk <= SCANNER_DEFAULTS.marketDown && own >= 0;
    }
  }
  let afterCompression: boolean | null = null;
  if (newHigh['1M'] !== null) {
    if (!newHigh['1M']) afterCompression = false;
    else {
      let seen: boolean | null = null;
      for (let j = i - 1; j >= Math.max(0, i - SCANNER_DEFAULTS.compressionLookback); j--) {
        const r = compressionRatioAt(bars, j, basis);
        if (isNa(r)) continue;
        seen = seen === true || r <= STATE_THRESHOLDS.compressionRatio;
      }
      afterCompression = seen;
    }
  }
  const sector = opts.sectorOf ? opts.sectorOf(input.symbol) : null;
  return {
    instrumentId: input.instrumentId,
    symbol: input.symbol,
    date,
    close: bars[i]!.close,
    state: isNa(profile) ? 'Coverage limited' : profile.state,
    gapToHigh: gap,
    sessionsSinceHigh: since,
    rangePosition: posn,
    ret1M: rets['1M'] ?? null,
    ret3M: rets['3M'] ?? null,
    ret20D: ret20,
    excessMarket1M: excessFor(bars, opts.market, date, '1M'),
    excessMarket3M: excessFor(bars, opts.market, date, '3M'),
    excessSector1M: excessFor(bars, sector, date, '1M'),
    excessSector3M: excessFor(bars, sector, date, '3M'),
    relativeVolume: relVolAt(bars, i),
    nearHigh: near,
    newHigh,
    earlyStrength: isNa(lead) ? null : lead.active,
    fallingRatioRisingStock: fallingRatio,
    breakoutAfterCompression: afterCompression,
    holdingUpInDownMarket: holdingUp,
    validation: { status: 'unscored' },
  };
};

/** Scanner over the loaded universe on one common completed date. */
export const buildScanner = (inputs: readonly ScannerInput[], opts: ScannerOptions = {}): Maybe<ScannerResult> => {
  let date = opts.date;
  if (!date) {
    const counts = new Map<ISODate, number>();
    for (const inp of inputs) {
      const last = inp.bars[inp.bars.length - 1]?.date;
      if (last) counts.set(last, (counts.get(last) ?? 0) + 1);
    }
    let best = 0;
    for (const [d, c] of counts) {
      if (c > best || (c === best && date !== undefined && d > date)) {
        best = c;
        date = d;
      }
    }
  }
  if (!date) return na('no-coverage', 'No series has a completed session');
  const rows: ScannerRow[] = [];
  const excluded: { symbol: string; reason: string }[] = [];
  for (const inp of inputs) {
    const r = scannerRow(inp, date, opts);
    if (isNa(r)) excluded.push({ symbol: inp.symbol, reason: r.detail ?? r.code });
    else rows.push(r);
  }
  return { date, proximity: opts.proximity ?? 0.02, basis: opts.basis ?? 'close', rows, excluded };
};

export interface ScannerSort {
  /** Accessor for the metric. Return null for an unavailable value. */
  value: (row: ScannerRow) => number | string | null;
  dir: 'asc' | 'desc';
}

/** Stable multi metric sort. Unavailable values sort last in either direction. */
export const sortScanner = (rows: readonly ScannerRow[], sorts: readonly ScannerSort[]): ScannerRow[] =>
  rows
    .map((row, idx) => ({ row, idx }))
    .sort((x, y) => {
      for (const s of sorts) {
        const a = s.value(x.row);
        const b = s.value(y.row);
        const an = a === null || (typeof a === 'number' && !Number.isFinite(a));
        const bn = b === null || (typeof b === 'number' && !Number.isFinite(b));
        if (an && bn) continue;
        if (an) return 1;
        if (bn) return -1;
        const c = typeof a === 'string' || typeof b === 'string' ? String(a).localeCompare(String(b)) : (a as number) - (b as number);
        if (c !== 0) return s.dir === 'asc' ? c : -c;
      }
      return x.idx - y.idx;
    })
    .map((x) => x.row);

/** Rows matching the scanner presets the specification lists. */
export const scannerPresets = {
  nearHigh: (rows: readonly ScannerRow[], key: '1M' | '3M' | '6M' | '1Y') => rows.filter((r) => r.nearHigh[key] === true),
  newIntermediateHigh: (rows: readonly ScannerRow[]) => rows.filter((r) => r.newHigh['1M'] === true || r.newHigh['3M'] === true || r.newHigh['6M'] === true),
  earlyStrength: (rows: readonly ScannerRow[]) => rows.filter((r) => r.earlyStrength === true),
  fallingRatioRisingStock: (rows: readonly ScannerRow[]) => rows.filter((r) => r.fallingRatioRisingStock === true),
  breakoutAfterCompression: (rows: readonly ScannerRow[]) => rows.filter((r) => r.breakoutAfterCompression === true),
  holdingUpInDownMarket: (rows: readonly ScannerRow[]) => rows.filter((r) => r.holdingUpInDownMarket === true),
};

// ---------------------------------------------------------------------------------------------
// Simulations (hypothetical)
// ---------------------------------------------------------------------------------------------

export interface ShockInput {
  /** Hypothetical one step price change of the stock, as a fraction. */
  stockShock: number;
  /** Hypothetical change of the benchmark over the same step. */
  benchmarkShock?: number;
  /** Verified share count for position dollars. */
  shares?: number;
  windows?: readonly WindowKey[];
  basis?: RangeBasis;
}

export interface ShockWindow {
  key: WindowKey;
  label: string;
  high: number;
  low: number;
  /** Move from the current close needed to exceed the window high, and to reach the window low. */
  moveToBreakHigh: number;
  moveToTestLow: number;
  positionNow: Maybe<number>;
  /** Range position of the shocked close inside the same window widened to include it. */
  positionAfter: Maybe<number>;
  breaksHigh: boolean;
  breaksLow: boolean;
}

export interface ShockResult {
  hypothetical: true;
  note: string;
  anchorDate: ISODate;
  close: number;
  shockedClose: number;
  /** shares x close x stockShock. */
  positionDollars: Maybe<number>;
  /** (1 + r_stock) / (1 + r_benchmark). */
  relativeWealthFactor: Maybe<number>;
  /** r_stock - r_benchmark in pp. */
  relativeEffectPp: Maybe<number>;
  atrBands: Maybe<{ atr: number; upper1: number; lower1: number; upper2: number; lower2: number }>;
  windows: { key: WindowKey; label: string; result: Maybe<ShockWindow> }[];
}

/**
 * Hypothetical price or benchmark shock from the anchor close. The window is the current window
 * plus the shocked close. No completed fact is changed and the result can never trigger an alert.
 */
export const simulateShock = (bars: readonly Bar[], i: number, input: ShockInput): Maybe<ShockResult> => {
  const a = bars[i];
  if (!a) return na('invalid-input', 'index outside series');
  if (!(input.stockShock > -1)) return na('invalid-input', 'Shock must be greater than minus 100 percent');
  const basis = input.basis ?? 'close';
  const shocked = a.close * (1 + input.stockShock);
  const atr = atrWilder(bars.slice(0, i + 1))[i];
  const bm = input.benchmarkShock;
  const windows = (input.windows ?? ['1M', '3M', '6M', '1Y']).map((key) => {
    const label = WINDOW_SPECS[key].label;
    const r = rangeStats(bars, i, key, { basis, withPercentile: false });
    if (isNa(r)) return { key, label, result: r as Maybe<ShockWindow> };
    const H = basis === 'close' ? r.closing.high.value : r.traded.high.value;
    const L = basis === 'close' ? r.closing.low.value : r.traded.low.value;
    const H2 = Math.max(H, shocked);
    const L2 = Math.min(L, shocked);
    const result: ShockWindow = {
      key,
      label,
      high: H,
      low: L,
      moveToBreakHigh: H / a.close - 1,
      moveToTestLow: L / a.close - 1,
      positionNow: r.rangePosition,
      positionAfter: H2 === L2 ? na('flat-range', 'High equals low') : (shocked - L2) / (H2 - L2),
      breaksHigh: shocked > H,
      breaksLow: shocked < L,
    };
    return { key, label, result: result as Maybe<ShockWindow> };
  });
  return {
    hypothetical: true,
    note: 'Hypothetical input. Not an observed price and not a forecast.',
    anchorDate: a.date,
    close: a.close,
    shockedClose: shocked,
    positionDollars: input.shares === undefined ? na('no-coverage', 'No verified share count supplied') : input.shares * a.close * input.stockShock,
    relativeWealthFactor: bm === undefined ? na('not-applicable', 'No benchmark shock supplied') : bm > -1 ? (1 + input.stockShock) / (1 + bm) : na('invalid-input', 'Benchmark shock must be greater than minus 100 percent'),
    relativeEffectPp: bm === undefined ? na('not-applicable', 'No benchmark shock supplied') : input.stockShock - bm,
    atrBands:
      atr === null || atr === undefined
        ? na('insufficient-history', 'Needs 15 completed sessions')
        : { atr, upper1: a.close + atr, lower1: a.close - atr, upper2: a.close + 2 * atr, lower2: a.close - 2 * atr },
    windows,
  };
};

// ---------------------------------------------------------------------------------------------
// Watchlist transition events
// ---------------------------------------------------------------------------------------------

export interface StrengthSnapshot {
  instrumentId: string;
  /** Completed session the snapshot describes. */
  date: ISODate;
  state: StrengthState;
  newHigh: Record<'1M' | '3M' | '6M', boolean | null>;
  earlyLeadership: boolean | null;
  relativeLeading: boolean | null;
  /** True for intraday or otherwise unconfirmed inputs. Provisional snapshots never emit events. */
  provisional?: boolean;
  /** True for what-if inputs. Hypothetical snapshots never emit events. */
  hypothetical?: boolean;
}

/** Snapshot of the confirmed close state for one instrument at bar i. */
export const strengthSnapshot = (instrumentId: string, bars: readonly Bar[], i: number = bars.length - 1, benchmark?: BenchmarkInput): Maybe<StrengthSnapshot> => {
  const p = strengthProfile(bars, i);
  if (isNa(p)) return p;
  let leading: boolean | null = null;
  if (benchmark) {
    const d = relativeDivergences(bars, benchmark, { asOf: p.date });
    if (!isNa(d) && d.anchorDate === p.date && !isNa(d.relativeLeading)) leading = d.relativeLeading.active;
  }
  return {
    instrumentId,
    date: p.date,
    state: p.state,
    newHigh: { '1M': boolOrNull(p.newHigh['1M']), '3M': boolOrNull(p.newHigh['3M']), '6M': boolOrNull(p.newHigh['6M']) },
    earlyLeadership: isNa(p.earlyLeadership) ? null : p.earlyLeadership.active,
    relativeLeading: leading,
  };
};

export type WatchEventType = 'state-change' | 'new-1m-high' | 'new-3m-high' | 'new-6m-high' | 'early-leadership' | 'relative-leading';

export interface WatchEvent {
  /** Dedup key: instrument, date, event, new state. */
  key: string;
  instrumentId: string;
  date: ISODate;
  event: WatchEventType;
  previous: string;
  current: string;
  newState: StrengthState;
}

/**
 * Events between two consecutive confirmed close snapshots of the SAME instrument.
 * Nothing is emitted for a first observation, a different instrument (a ticker switch),
 * a non advancing date, or a provisional or hypothetical snapshot. This function only
 * produces events. Delivery is outside the engine.
 */
export const transitionEvents = (prev: StrengthSnapshot | null, curr: StrengthSnapshot): WatchEvent[] => {
  if (!prev || prev.instrumentId !== curr.instrumentId) return [];
  if (prev.provisional || curr.provisional || prev.hypothetical || curr.hypothetical) return [];
  if (!(curr.date > prev.date)) return [];
  const out: WatchEvent[] = [];
  const push = (event: WatchEventType, previous: string, current: string) =>
    out.push({ key: `${curr.instrumentId}|${curr.date}|${event}|${curr.state}`, instrumentId: curr.instrumentId, date: curr.date, event, previous, current, newState: curr.state });
  if (prev.state !== curr.state && curr.state !== 'Coverage limited' && prev.state !== 'Coverage limited') push('state-change', prev.state, curr.state);
  const flag = (event: WatchEventType, was: boolean | null, now: boolean | null) => {
    if (now === true && was === false) push(event, 'no', 'yes');
  };
  flag('new-1m-high', prev.newHigh['1M'], curr.newHigh['1M']);
  flag('new-3m-high', prev.newHigh['3M'], curr.newHigh['3M']);
  flag('new-6m-high', prev.newHigh['6M'], curr.newHigh['6M']);
  flag('early-leadership', prev.earlyLeadership, curr.earlyLeadership);
  flag('relative-leading', prev.relativeLeading, curr.relativeLeading);
  return out;
};

/** Drop events whose key was already seen. Returns the fresh events and the updated key set. */
export const dedupeEvents = (events: readonly WatchEvent[], seen: ReadonlySet<string>): { fresh: WatchEvent[]; seen: Set<string> } => {
  const next = new Set(seen);
  const fresh: WatchEvent[] = [];
  for (const e of events) {
    if (next.has(e.key)) continue;
    next.add(e.key);
    fresh.push(e);
  }
  return { fresh, seen: next };
};
