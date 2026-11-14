/**
 * Signal Score input features (owner specification section 16).
 *
 * Every input is a discrete state per completed session, computed from rows 0..i only. A state is
 * either a fixed band (for example "below the 50 day average for 6 to 20 sessions") or a fifth of
 * the trailing percentile of a continuous value among earlier sessions (midrank, past only).
 * A session with no valid state has bucket -1 and a plain reason in `context`.
 *
 * Input families, numbered as in the specification:
 *  1 Moving average side and run age for the 5, 10, 20, 50, 100, 200 session SMAs
 *  2 200 day cross state and excursion inside the run
 *  3 Selloff depth from the running closing high
 *  4 Count of 10% drawdown episodes this year against the own norm at the same point of the year
 *  5 Year to date placement inside the year to date closing range
 *  6 Recency of a big one session decline
 *  7 RSI14 rank
 *  8 Relative volume against the preceding 20 sessions, by day direction
 *  9 Month, week of month, and month to date path against prior months at the same session count
 * 10 Sessions until the next earnings report known at the anchor
 * 11 SPY against its 200 day average, group distance from its 252 session closing high,
 *    stock against group month to date and quarter to date
 * 12 Shared setup matches (built in signal.ts from the percentile dimensions exported here)
 *
 * Compact private versions of the moving average run and drawdown episode logic live here because
 * the sibling engines were still being written. They follow the same definitions.
 */
import { addDays, dayOf, fridayOf, monthOf, nextSession, periodKey, prevSession, sessionsBetween } from './core/calendar';
import { relativeVolume, rollingReturnStd, rsiWilder, sma } from './core/indicators';
import { periodStart, type Period } from './core/series';
import type { Bar, EarningsEvent, ISODate } from './core/types';
import type { Provenance } from './validation';

export const SIGNAL_FEATURE_DEFAULTS = {
  /** Spec: the six study averages. */
  maWindows: { value: [5, 10, 20, 50, 100, 200] as const, provenance: 'spec' as Provenance },
  /** Spec: drawdown episode threshold for the yearly count. */
  episodeThreshold: { value: 0.1, provenance: 'spec' as Provenance },
  /** Spec: the earnings input stays inactive below this many valid prior reports. */
  minEarningsReports: { value: 10, provenance: 'spec' as Provenance },
  /** Spec: volume of at least twice the prior 20 session average is its own state. */
  volumeSpike: { value: 2, provenance: 'spec' as Provenance },
  /** Proposed: elevated volume cut. */
  volumeElevated: { value: 1.3, provenance: 'proposed' as Provenance },
  /** Proposed: quiet volume cut. */
  volumeQuiet: { value: 0.7, provenance: 'proposed' as Provenance },
  /** Proposed: one session close to close decline that counts as big. */
  bigDecline: { value: 0.05, provenance: 'proposed' as Provenance },
  /** Proposed: earlier observations needed before a trailing percentile is used. */
  minPercentileHistory: { value: 60, provenance: 'proposed' as Provenance },
  /** Proposed: prior full years needed for the drawdown episode norm. */
  minNormYears: { value: 3, provenance: 'proposed' as Provenance },
  /** Proposed: a run counts as near its extreme when distance is at least this share of the run extreme. */
  nearExtremeShare: { value: 0.8, provenance: 'proposed' as Provenance },
};

export interface SignalInputSeries {
  id: string;
  /** Family number 1 to 12 from the specification. */
  family: number;
  label: string;
  /** Calendar seasonality inputs carry a prior mass of at least 100. */
  seasonal: boolean;
  /** State index per session. -1 when unavailable. */
  buckets: Int16Array;
  bucketLabels: string[];
  /** Raw context at session i in short plain language. States why the input is unavailable when it is. */
  context(i: number): string;
}

export interface SetupDimension {
  id: string;
  label: string;
  /** Trailing midrank percentile per session, NaN when unavailable. */
  pct: Float64Array;
}

export interface SignalFeatureSet {
  n: number;
  dates: ISODate[];
  closes: Float64Array;
  inputs: SignalInputSeries[];
  setupDims: SetupDimension[];
}

export interface SignalFeatureArgs {
  bars: readonly Bar[];
  spyBars?: readonly Bar[];
  /** Group reference series, for example a sector ETF or a group index. */
  groupBars?: readonly Bar[];
  groupLabel?: string;
  /** Earnings events. Only events with `knownAt` before the anchor date count as known. */
  earnings?: readonly EarningsEvent[];
}

const pct1 = (x: number): string => `${(Math.abs(x) * 100).toFixed(1)}%`;
const signed1 = (x: number): string => `${x >= 0 ? '+' : '-'}${(Math.abs(x) * 100).toFixed(1)}%`;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Trailing midrank percentile of values[i] among earlier non missing values:
 * (count lower + half the count equal) / count. NaN below `minPrior` earlier values.
 * Fenwick tree over value ranks, O(n log n). Ranks only encode order, so later rows cannot leak.
 */
export const trailingPercentile = (values: Float64Array, minPrior: number): Float64Array => {
  const n = values.length;
  const out = new Float64Array(n).fill(NaN);
  const uniq = Array.from(new Set(Array.from(values).filter((v) => !Number.isNaN(v)))).sort((a, b) => a - b);
  const rank = new Map<number, number>();
  uniq.forEach((v, k) => rank.set(v, k + 1));
  const tree = new Int32Array(uniq.length + 2);
  const add = (r: number) => {
    for (let x = r; x <= uniq.length; x += x & -x) tree[x]!++;
  };
  const query = (r: number): number => {
    let s = 0;
    for (let x = r; x > 0; x -= x & -x) s += tree[x]!;
    return s;
  };
  let count = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    if (Number.isNaN(v)) continue;
    const r = rank.get(v)!;
    if (count >= minPrior) {
      const lower = query(r - 1);
      const equal = query(r) - lower;
      out[i] = (lower + 0.5 * equal) / count;
    }
    add(r);
    count++;
  }
  return out;
};

const FIFTHS = ['Lowest fifth', 'Second fifth', 'Middle fifth', 'Fourth fifth', 'Highest fifth'];
const fifthOf = (p: number): number => (Number.isNaN(p) ? -1 : Math.min(4, Math.floor(p * 5)));

interface PeriodArrays {
  ret: Float64Array;
  /** 1-based count of sessions present in the period through i. */
  ordinal: Int32Array;
  baseIdx: Int32Array;
}

/** Period to date return with the preceding period's final close as base. NaN without a valid base. */
const periodArrays = (bars: readonly Bar[], period: Period): PeriodArrays => {
  const n = bars.length;
  const ret = new Float64Array(n).fill(NaN);
  const ordinal = new Int32Array(n);
  const baseIdx = new Int32Array(n).fill(-1);
  let key = '';
  let base = -1;
  let ord = 0;
  for (let i = 0; i < n; i++) {
    const b = bars[i]!;
    const k = periodKey(b.date, period);
    if (k !== key) {
      key = k;
      ord = 0;
      base = -1;
      if (i > 0 && bars[i - 1]!.date === prevSession(periodStart(b.date, period))) base = i - 1;
    }
    ord++;
    ordinal[i] = ord;
    baseIdx[i] = base;
    if (base >= 0) ret[i] = b.close / bars[base]!.close - 1;
  }
  return { ret, ordinal, baseIdx };
};

const dateIndex = (bars: readonly Bar[]): Map<ISODate, number> => new Map(bars.map((b, i) => [b.date, i]));

/** Build every input state series and the setup percentile dimensions for one instrument. */
export const buildSignalFeatures = (args: SignalFeatureArgs): SignalFeatureSet => {
  const { bars } = args;
  const D = SIGNAL_FEATURE_DEFAULTS;
  const n = bars.length;
  const dates = bars.map((b) => b.date);
  const closesArr = bars.map((b) => b.close);
  const closes = Float64Array.from(closesArr);
  const inputs: SignalInputSeries[] = [];
  const minP = D.minPercentileHistory.value;

  // A session that does not directly follow the previous row's session breaks run continuity.
  const gapBefore = new Uint8Array(n);
  for (let i = 1; i < n; i++) if (nextSession(dates[i - 1]!) !== dates[i]) gapBefore[i] = 1;

  // ---- Families 1 and 2: moving average side, run age, distance, excursion ----
  const distByWindow = new Map<number, Float64Array>();
  for (const w of D.maWindows.value) {
    const s = sma(closesArr, w);
    const buckets = new Int16Array(n).fill(-1);
    const age = new Int32Array(n);
    const dist = new Float64Array(n).fill(NaN);
    const confirmedArr = new Uint8Array(n);
    const extreme = new Float64Array(n).fill(NaN);
    let side = 0;
    let run = 0;
    let confirmed = false;
    let seen = false;
    let ext = 0;
    for (let i = 0; i < n; i++) {
      const m = s[i];
      if (m === null || m === undefined) continue;
      const d = closes[i]! / m - 1;
      dist[i] = d;
      const cur = closes[i]! > m ? 1 : closes[i]! < m ? -1 : 0;
      if (gapBefore[i]) {
        // Continuity is unverified after a missing session. The run restarts unconfirmed.
        side = cur;
        run = cur === 0 ? 0 : 1;
        confirmed = false;
        ext = d;
      } else if (cur === 0) {
        side = 0;
        run = 0;
        confirmed = true; // an exact touch is an observed boundary
        ext = 0;
      } else if (cur === side) {
        run++;
        if (cur > 0 ? d > ext : d < ext) ext = d;
      } else {
        confirmed = seen; // the first observable day is a leading run, not an observed cross
        side = cur;
        run = 1;
        ext = d;
      }
      seen = true;
      age[i] = run;
      confirmedArr[i] = confirmed ? 1 : 0;
      extreme[i] = ext;
      if (cur !== 0 && confirmed) buckets[i] = (cur > 0 ? 0 : 3) + (run <= 5 ? 0 : run <= 20 ? 1 : 2);
    }
    distByWindow.set(w, dist);
    inputs.push({
      id: `ma${w}`,
      family: 1,
      label: `${w} day average side and run age`,
      seasonal: false,
      buckets,
      bucketLabels: [
        `Above the ${w} day average for 1 to 5 sessions`,
        `Above the ${w} day average for 6 to 20 sessions`,
        `Above the ${w} day average for 21 or more sessions`,
        `Below the ${w} day average for 1 to 5 sessions`,
        `Below the ${w} day average for 6 to 20 sessions`,
        `Below the ${w} day average for 21 or more sessions`,
      ],
      context: (i) => {
        const d = dist[i]!;
        if (Number.isNaN(d)) return `The ${w} day average needs ${w} completed sessions`;
        if (d === 0) return `Close equals the ${w} day average`;
        const where = d > 0 ? 'Above' : 'Below';
        const tail = confirmedArr[i] ? '' : '. The run began before an observed crossing, so its true age is unknown';
        return `${where} the ${w} day average for ${plural(age[i]!, 'session')}, ${pct1(d)} ${d > 0 ? 'over' : 'under'}${tail}`;
      },
    });
    if (w === 200) {
      const share = D.nearExtremeShare.value;
      const b2 = new Int16Array(n).fill(-1);
      for (let i = 0; i < n; i++) {
        if (buckets[i]! < 0) continue;
        const d = dist[i]!;
        const near = Math.abs(d) >= share * Math.abs(extreme[i]!);
        b2[i] = d > 0 ? (near ? 0 : 1) : near ? 2 : 3;
      }
      inputs.push({
        id: 'cross200',
        family: 2,
        label: '200 day cross state and run excursion',
        seasonal: false,
        buckets: b2,
        bucketLabels: [
          'Above the 200 day average, near the farthest distance of the run',
          'Above the 200 day average, pulled back from the farthest distance of the run',
          'Below the 200 day average, near the farthest distance of the run',
          'Below the 200 day average, recovered from the farthest distance of the run',
        ],
        context: (i) => {
          const d = dist[i]!;
          if (Number.isNaN(d)) return 'The 200 day average needs 200 completed sessions';
          if (b2[i]! < 0) return 'No observed 200 day crossing yet for the current run';
          return `${signed1(d)} from the 200 day average, farthest in this run ${signed1(extreme[i]!)}, run age ${plural(age[i]!, 'session')}`;
        },
      });
    }
  }

  // ---- Family 3: selloff depth from the running closing high ----
  const dd = new Float64Array(n);
  const peakIdx = new Int32Array(n);
  {
    let p = 0;
    for (let i = 0; i < n; i++) {
      if (closes[i]! >= closes[p]!) p = i;
      peakIdx[i] = p;
      dd[i] = closes[i]! / closes[p]! - 1;
    }
    const buckets = new Int16Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const d = -dd[i]!;
      buckets[i] = d < 0.02 ? 0 : d < 0.05 ? 1 : d < 0.1 ? 2 : d < 0.2 ? 3 : d < 0.35 ? 4 : 5;
    }
    inputs.push({
      id: 'selloffDepth',
      family: 3,
      label: 'Depth below the closing high in available history',
      seasonal: false,
      buckets,
      bucketLabels: ['Within 2% of the closing high', '2% to 5% below', '5% to 10% below', '10% to 20% below', '20% to 35% below', '35% or more below'],
      context: (i) =>
        dd[i] === 0
          ? `At the closing high in available history, set ${dates[peakIdx[i]!]}`
          : `${pct1(dd[i]!)} below the closing high of ${dates[peakIdx[i]!]}, ${plural(i - peakIdx[i]!, 'session')} since that high`,
    });
  }

  // ---- Family 4: 10% drawdown episodes this year against the own norm ----
  const yr = periodArrays(bars, 'Y');
  {
    const thr = D.episodeThreshold.value;
    const countSoFar = new Int32Array(n);
    const byYear = new Map<string, number[]>(); // per year: cumulative count by 0-based session ordinal
    let inEpisode = false;
    let c = 0;
    let key = '';
    for (let i = 0; i < n; i++) {
      const y = dates[i]!.slice(0, 4);
      if (y !== key) {
        key = y;
        c = 0;
        byYear.set(y, []);
      }
      if (dd[i] === 0) inEpisode = false;
      else if (!inEpisode && dd[i]! <= -thr) {
        inEpisode = true;
        c++;
      }
      countSoFar[i] = c;
      byYear.get(y)!.push(c);
    }
    const years = [...byYear.keys()];
    const buckets = new Int16Array(n).fill(-1);
    const refN = new Int32Array(n);
    const refMedian = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      const y = dates[i]!.slice(0, 4);
      const ord = yr.ordinal[i]! - 1;
      const ref: number[] = [];
      for (const py of years) {
        if (py >= y) break;
        const arr = byYear.get(py)!;
        if (arr.length < 200) continue; // partial listing year
        ref.push(arr[Math.min(ord, arr.length - 1)]!);
      }
      refN[i] = ref.length;
      if (ref.length < D.minNormYears.value) continue;
      const x = countSoFar[i]!;
      let lower = 0;
      let equal = 0;
      for (const r of ref) {
        if (r < x) lower++;
        else if (r === x) equal++;
      }
      const p = (lower + 0.5 * equal) / ref.length;
      buckets[i] = p < 1 / 3 ? 0 : p > 2 / 3 ? 2 : 1;
      const srt = [...ref].sort((a, b) => a - b);
      refMedian[i] = srt.length % 2 ? srt[(srt.length - 1) / 2]! : (srt[srt.length / 2 - 1]! + srt[srt.length / 2]!) / 2;
    }
    inputs.push({
      id: 'ddEpisodes',
      family: 4,
      label: '10% drawdown episodes this year against the own norm',
      seasonal: false,
      buckets,
      bucketLabels: ['Fewer 10% drawdown episodes than usual by this point of the year', 'A typical number by this point of the year', 'More 10% drawdown episodes than usual by this point of the year'],
      context: (i) =>
        buckets[i]! < 0
          ? `${plural(countSoFar[i]!, 'episode')} of 10% or more so far this year. Only ${plural(refN[i]!, 'prior full year')} for a norm, needs ${D.minNormYears.value}`
          : `${plural(countSoFar[i]!, 'episode')} of 10% or more so far this year. Prior years had a median of ${refMedian[i]} by this point, ${plural(refN[i]!, 'year')}`,
    });
  }

  // ---- Family 5: year to date placement inside the year to date closing range ----
  {
    const buckets = new Int16Array(n).fill(-1);
    const pos = new Float64Array(n).fill(NaN);
    let hi = NaN;
    let lo = NaN;
    for (let i = 0; i < n; i++) {
      const base = yr.baseIdx[i]!;
      // The first row of a year in this series resets the range to the prior year end close.
      if (yr.ordinal[i] === 1) {
        hi = base >= 0 ? closes[base]! : NaN;
        lo = hi;
      }
      if (base < 0) continue;
      hi = Math.max(hi, closes[i]!);
      lo = Math.min(lo, closes[i]!);
      if (yr.ordinal[i]! < 5 || hi === lo) continue;
      pos[i] = (closes[i]! - lo) / (hi - lo);
      buckets[i] = Math.min(4, Math.floor(pos[i]! * 5));
    }
    inputs.push({
      id: 'ytdPlacement',
      family: 5,
      label: 'Placement inside the year to date closing range',
      seasonal: false,
      buckets,
      bucketLabels: FIFTHS.map((f) => `${f} of the year to date closing range`),
      context: (i) => {
        if (yr.baseIdx[i]! < 0) return 'No prior year end close in this history, so year to date is unavailable';
        if (buckets[i]! < 0) return `Year to date ${signed1(yr.ret[i]!)}. The year to date range is too young or flat`;
        return `Year to date ${signed1(yr.ret[i]!)} from the ${dates[yr.baseIdx[i]!]} close, at ${Math.round(pos[i]! * 100)}% of the year to date closing range`;
      },
    });
  }

  // ---- Family 6: recency of a big one session decline ----
  {
    const thr = D.bigDecline.value;
    const buckets = new Int16Array(n).fill(-1);
    const lastIdx = new Int32Array(n).fill(-1);
    let last = -1;
    for (let i = 1; i < n; i++) {
      if (closes[i]! / closes[i - 1]! - 1 <= -thr) last = i;
      lastIdx[i] = last;
      const since = last < 0 ? Infinity : i - last;
      buckets[i] = since <= 5 ? 0 : since <= 20 ? 1 : since <= 60 ? 2 : 3;
    }
    const t = `${Math.round(thr * 100)}%`;
    inputs.push({
      id: 'bigDecline',
      family: 6,
      label: `Recency of a one session decline of ${t} or more`,
      seasonal: false,
      buckets,
      bucketLabels: [`Decline of ${t} or more within 5 sessions`, `Decline of ${t} or more 6 to 20 sessions ago`, `Decline of ${t} or more 21 to 60 sessions ago`, `No decline of ${t} or more in 60 sessions`],
      context: (i) => {
        if (i === 0) return 'No prior close';
        const j = lastIdx[i]!;
        if (j < 0) return `No close to close decline of ${t} or more in available history`;
        return `Last close to close decline of ${t} or more was ${pct1(closes[j]! / closes[j - 1]! - 1)} on ${dates[j]}, ${plural(i - j, 'session')} ago`;
      },
    });
  }

  // ---- Family 7: RSI14 rank ----
  const rsiRaw = rsiWilder(closesArr, 14);
  const rsi = Float64Array.from(rsiRaw.map((v) => (v === null ? NaN : v)));
  const rsiPct = trailingPercentile(rsi, minP);
  inputs.push({
    id: 'rsiRank',
    family: 7,
    label: 'RSI14 rank against earlier sessions',
    seasonal: false,
    buckets: Int16Array.from(rsiPct, fifthOf),
    bucketLabels: FIFTHS.map((f) => `${f} of earlier RSI14 readings`),
    context: (i) =>
      Number.isNaN(rsi[i]!)
        ? 'RSI14 needs 15 completed sessions'
        : Number.isNaN(rsiPct[i]!)
          ? `RSI14 ${rsi[i]!.toFixed(1)}. Fewer than ${minP} earlier readings to rank against`
          : `RSI14 ${rsi[i]!.toFixed(1)}, higher than ${Math.round(rsiPct[i]! * 100)}% of earlier sessions`,
  });

  // ---- Family 8: relative volume by day direction ----
  {
    const rv = relativeVolume(bars, 20);
    const buckets = new Int16Array(n).fill(-1);
    for (let i = 1; i < n; i++) {
      const v = rv[i];
      if (v === null || v === undefined) continue;
      const down = closes[i]! < closes[i - 1]!;
      buckets[i] = v >= D.volumeSpike.value ? (down ? 5 : 4) : v >= D.volumeElevated.value ? (down ? 3 : 2) : v < D.volumeQuiet.value ? 0 : 1;
    }
    inputs.push({
      id: 'relVolume',
      family: 8,
      label: 'Volume against the prior 20 session average',
      seasonal: false,
      buckets,
      bucketLabels: [
        `Quiet volume, under ${D.volumeQuiet.value}x`,
        'Normal volume',
        `Elevated volume, ${D.volumeElevated.value}x or more, close not lower`,
        `Elevated volume, ${D.volumeElevated.value}x or more, lower close`,
        `Volume ${D.volumeSpike.value}x or more, close not lower`,
        `Volume ${D.volumeSpike.value}x or more, lower close`,
      ],
      context: (i) => {
        const v = rv[i];
        if (v === null || v === undefined) return 'Relative volume needs 20 prior sessions with verified volume';
        return `Volume ${v.toFixed(2)}x the prior 20 session average on a ${closes[i]! < closes[i - 1]! ? 'lower' : closes[i]! > closes[i - 1]! ? 'higher' : 'flat'} close`;
      },
    });
  }

  // ---- Family 9: seasonality ----
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  inputs.push({
    id: 'month',
    family: 9,
    label: 'Calendar month',
    seasonal: true,
    buckets: Int16Array.from(dates, (d) => monthOf(d) - 1),
    bucketLabels: MONTHS,
    context: (i) => `Session in ${MONTHS[monthOf(dates[i]!) - 1]}`,
  });
  const weekOrd = (d: ISODate): number => Math.min(5, Math.ceil(dayOf(fridayOf(d)) / 7));
  inputs.push({
    id: 'weekOfMonth',
    family: 9,
    label: 'Week of the month by its Friday',
    seasonal: true,
    buckets: Int16Array.from(dates, (d) => weekOrd(d) - 1),
    bucketLabels: ['Week 1', 'Week 2', 'Week 3', 'Week 4', 'Week 5'],
    context: (i) => `Week ${weekOrd(dates[i]!)} of ${MONTHS[monthOf(fridayOf(dates[i]!)) - 1]} by its Friday, ${fridayOf(dates[i]!)}`,
  });
  const mo = periodArrays(bars, 'M');
  {
    // Month to date return against prior months at the same session count. Past only.
    const byOrd = new Map<number, number[]>();
    const buckets = new Int16Array(n).fill(-1);
    const pctArr = new Float64Array(n).fill(NaN);
    const refN = new Int32Array(n);
    const pending: { ord: number; v: number }[] = [];
    let key = '';
    for (let i = 0; i < n; i++) {
      const k = dates[i]!.slice(0, 7);
      if (k !== key) {
        // The finished month's readings join the reference only after the month changes.
        for (const p of pending) {
          const arr = byOrd.get(p.ord) ?? [];
          arr.push(p.v);
          byOrd.set(p.ord, arr);
        }
        pending.length = 0;
        key = k;
      }
      const v = mo.ret[i]!;
      if (Number.isNaN(v)) continue;
      const ord = mo.ordinal[i]!;
      const ref = byOrd.get(ord) ?? [];
      refN[i] = ref.length;
      if (ref.length >= 24) {
        let lower = 0;
        let equal = 0;
        for (const r of ref) {
          if (r < v) lower++;
          else if (r === v) equal++;
        }
        pctArr[i] = (lower + 0.5 * equal) / ref.length;
        buckets[i] = fifthOf(pctArr[i]!);
      }
      pending.push({ ord, v });
    }
    inputs.push({
      id: 'mtdPath',
      family: 9,
      label: 'Month to date return against prior months at the same session count',
      seasonal: false,
      buckets,
      bucketLabels: FIFTHS.map((f) => `${f} of prior months at the same session count`),
      context: (i) => {
        if (Number.isNaN(mo.ret[i]!)) return 'No prior month final close, so month to date is unavailable';
        if (buckets[i]! < 0) return `Month to date ${signed1(mo.ret[i]!)} after ${plural(mo.ordinal[i]!, 'session')}. Only ${plural(refN[i]!, 'prior month')} to compare, needs 24`;
        return `Month to date ${signed1(mo.ret[i]!)} after ${plural(mo.ordinal[i]!, 'session')}, higher than ${Math.round(pctArr[i]! * 100)}% of ${refN[i]} prior months at the same session count`;
      },
    });
  }

  // ---- Family 10: sessions until the next earnings report known at the anchor ----
  {
    const buckets = new Int16Array(n).fill(-1);
    const until = new Int32Array(n).fill(-1);
    const sinceLast = new Int32Array(n).fill(-1);
    const validPrior = new Int32Array(n);
    const ev = [...(args.earnings ?? [])].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (ev.length) {
      // First bar index on or after each event date, or -1 when the event is after the last bar.
      const evIdx = ev.map((e) => {
        let lo = 0;
        let hi = n;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (dates[mid]! < e.date) lo = mid + 1;
          else hi = mid;
        }
        return lo < n ? lo : -1;
      });
      const isPastAt = (k: number, d: ISODate): boolean => {
        const e = ev[k]!;
        return e.date < d || (e.date === d && (e.time === 'bmo' || e.time === 'during'));
      };
      let p = 0; // first event not yet past
      let valid = 0;
      let counted = 0; // events with date < d already inspected for the valid count
      const futureCache = new Map<string, number>();
      for (let i = 0; i < n; i++) {
        const d = dates[i]!;
        while (counted < ev.length && ev[counted]!.date < d) {
          if (ev[counted]!.knownAt) valid++;
          counted++;
        }
        while (p < ev.length && isPastAt(p, d)) p++;
        validPrior[i] = valid;
        if (p > 0) {
          const j = evIdx[p - 1]!;
          if (j >= 0) sinceLast[i] = i - j;
        }
        // Next event that was already known before this session date. Look at most three ahead.
        for (let k = p; k < Math.min(ev.length, p + 3); k++) {
          const e = ev[k]!;
          if (!e.knownAt || e.knownAt.slice(0, 10) >= d) continue;
          const j = evIdx[k]!;
          if (j >= 0) until[i] = j - i;
          else {
            const ck = `${d}|${e.date}`;
            let s = futureCache.get(ck);
            if (s === undefined) {
              s = sessionsBetween(addDays(d, 1), e.date).length;
              futureCache.set(ck, s);
            }
            until[i] = s;
          }
          break;
        }
        if (valid < D.minEarningsReports.value) continue;
        const u = until[i]!;
        if (u >= 0 && u <= 5) buckets[i] = 0;
        else if (u >= 0 && u <= 10) buckets[i] = 1;
        else if (u >= 0 && u <= 20) buckets[i] = 2;
        else if (sinceLast[i]! >= 0 && sinceLast[i]! <= 5) buckets[i] = 4;
        else buckets[i] = 3;
      }
    }
    inputs.push({
      id: 'earnings',
      family: 10,
      label: 'Sessions until the next earnings report known at the anchor',
      seasonal: false,
      buckets,
      bucketLabels: ['Report within 5 sessions', 'Report in 6 to 10 sessions', 'Report in 11 to 20 sessions', 'No report known within 20 sessions', 'Reported within the past 5 sessions'],
      context: (i) => {
        if (!ev.length) return 'No earnings history supplied';
        const need = D.minEarningsReports.value;
        const lead = until[i]! >= 0 ? `Next known report in ${plural(until[i]!, 'session')}` : 'No upcoming report was known at this date';
        if (validPrior[i]! < need) return `${lead}. Inactive, ${plural(validPrior[i]!, 'prior report')} with a point in time schedule, needs ${need}`;
        return `${lead}, ${plural(validPrior[i]!, 'prior report')} with a point in time schedule`;
      },
    });
  }

  // ---- Family 11: market regime and group context ----
  {
    const spy = args.spyBars;
    const buckets = new Int16Array(n).fill(-1);
    const dist = new Float64Array(n).fill(NaN);
    if (spy && spy.length) {
      const idx = dateIndex(spy);
      const s200 = sma(spy.map((b) => b.close), 200);
      for (let i = 0; i < n; i++) {
        const j = idx.get(dates[i]!);
        if (j === undefined) continue;
        const m = s200[j];
        if (m === null || m === undefined) continue;
        dist[i] = spy[j]!.close / m - 1;
        buckets[i] = dist[i]! > 0 ? 0 : 1;
      }
    }
    inputs.push({
      id: 'spyRegime',
      family: 11,
      label: 'SPY against its 200 day average',
      seasonal: false,
      buckets,
      bucketLabels: ['SPY above its 200 day average', 'SPY at or below its 200 day average'],
      context: (i) => (!spy || !spy.length ? 'No SPY series supplied' : Number.isNaN(dist[i]!) ? 'No SPY close with a 200 day average on this date' : `SPY ${signed1(dist[i]!)} from its 200 day average`),
    });
  }
  {
    const grp = args.groupBars;
    const name = args.groupLabel ?? 'Group';
    const offHigh = new Float64Array(n).fill(NaN);
    const relM = new Float64Array(n).fill(NaN);
    const relQ = new Float64Array(n).fill(NaN);
    const bHigh = new Int16Array(n).fill(-1);
    if (grp && grp.length) {
      const idx = dateIndex(grp);
      const gm = periodArrays(grp, 'M');
      const gq = periodArrays(grp, 'Q');
      const sq = periodArrays(bars, 'Q');
      // 252 session closing high of the group, including the current session.
      const gHigh = new Float64Array(grp.length).fill(NaN);
      const dq: number[] = [];
      for (let j = 0; j < grp.length; j++) {
        while (dq.length && grp[dq[dq.length - 1]!]!.close <= grp[j]!.close) dq.pop();
        dq.push(j);
        while (dq[0]! < j - 251) dq.shift();
        if (j >= 251) gHigh[j] = grp[dq[0]!]!.close;
      }
      for (let i = 0; i < n; i++) {
        const j = idx.get(dates[i]!);
        if (j === undefined) continue;
        if (!Number.isNaN(gHigh[j]!)) {
          offHigh[i] = grp[j]!.close / gHigh[j]! - 1;
          const d = -offHigh[i]!;
          bHigh[i] = d < 0.05 ? 0 : d < 0.1 ? 1 : d < 0.2 ? 2 : 3;
        }
        // Both legs need a valid base on the same completed dates.
        if (mo.baseIdx[i]! >= 0 && gm.baseIdx[j]! >= 0 && dates[mo.baseIdx[i]!] === grp[gm.baseIdx[j]!]!.date) relM[i] = mo.ret[i]! - gm.ret[j]!;
        if (sq.baseIdx[i]! >= 0 && gq.baseIdx[j]! >= 0 && dates[sq.baseIdx[i]!] === grp[gq.baseIdx[j]!]!.date) relQ[i] = sq.ret[i]! - gq.ret[j]!;
      }
    }
    const none = `No ${name} series supplied`;
    inputs.push({
      id: 'groupOffHigh',
      family: 11,
      label: `${name} distance from its 252 session closing high`,
      seasonal: false,
      buckets: bHigh,
      bucketLabels: [`${name} within 5% of its 252 session closing high`, `${name} 5% to 10% below`, `${name} 10% to 20% below`, `${name} 20% or more below`],
      context: (i) => (!grp || !grp.length ? none : Number.isNaN(offHigh[i]!) ? `${name} has no 252 session closing high on this date` : `${name} ${pct1(offHigh[i]!)} below its 252 session closing high`),
    });
    const relMp = trailingPercentile(relM, minP);
    const relQp = trailingPercentile(relQ, minP);
    const rel = (id: string, span: string, raw: Float64Array, p: Float64Array): SignalInputSeries => ({
      id,
      family: 11,
      label: `Stock against ${name}, ${span}`,
      seasonal: false,
      buckets: Int16Array.from(p, fifthOf),
      bucketLabels: FIFTHS.map((f) => `${f} of earlier ${span} gaps to ${name}`),
      context: (i) =>
        !grp || !grp.length
          ? none
          : Number.isNaN(raw[i]!)
            ? `No comparable ${span} base on the same completed dates`
            : Number.isNaN(p[i]!)
              ? `${span} gap to ${name} ${signed1(raw[i]!).replace('%', ' pp')}. Fewer than ${minP} earlier readings to rank against`
              : `${span} gap to ${name} ${signed1(raw[i]!).replace('%', ' pp')}, higher than ${Math.round(p[i]! * 100)}% of earlier sessions`,
    });
    inputs.push(rel('relMtd', 'month to date', relM, relMp));
    inputs.push(rel('relQtd', 'quarter to date', relQ, relQp));
  }

  // ---- Family 12 dimensions: trailing percentiles of a compact setup vector ----
  const ret5 = new Float64Array(n).fill(NaN);
  for (let i = 5; i < n; i++) ret5[i] = closes[i]! / closes[i - 5]! - 1;
  const vol20 = Float64Array.from(rollingReturnStd(closesArr, 20).map((v) => (v === null ? NaN : v)));
  const setupDims: SetupDimension[] = [
    { id: 'depth', label: 'Depth below the closing high', pct: trailingPercentile(dd, minP) },
    { id: 'rsi', label: 'RSI14', pct: rsiPct },
    { id: 'dist50', label: 'Distance from the 50 day average', pct: trailingPercentile(distByWindow.get(50)!, minP) },
    { id: 'dist200', label: 'Distance from the 200 day average', pct: trailingPercentile(distByWindow.get(200)!, minP) },
    { id: 'vol20', label: '20 session daily volatility', pct: trailingPercentile(vol20, minP) },
    { id: 'ret5', label: '5 session return', pct: trailingPercentile(ret5, minP) },
  ];

  return { n, dates, closes, inputs, setupDims };
};
