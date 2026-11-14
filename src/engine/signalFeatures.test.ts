import { describe, expect, it } from 'vitest';
import { addDays, sessionsBetween } from './core/calendar';
import type { Bar, EarningsEvent, ISODate } from './core/types';
import { INSTRUMENTS } from '../data/fixtures/universe';
import { fixtureSource, seriesFromCloses, syntheticDaily, syntheticEarnings } from '../data/fixtures/synthetic';
import { buildSignalFeatures, trailingPercentile, type SignalFeatureSet } from './signalFeatures';
import { assertNoLookAhead, scaleBars } from './validation';

const input = (f: SignalFeatureSet, id: string) => f.inputs.find((x) => x.id === id)!;
const onDates = (dates: readonly ISODate[], close: (d: ISODate, i: number) => number, volume: (i: number) => number = () => 1000): Bar[] => {
  const bars: Bar[] = [];
  let prev = close(dates[0]!, 0);
  dates.forEach((d, i) => {
    const c = close(d, i);
    bars.push({ date: d, open: prev, high: Math.max(prev, c), low: Math.min(prev, c), close: c, volume: volume(i) });
    prev = c;
  });
  return bars;
};

describe('trailing percentile', () => {
  it('ranks against earlier values only with the midrank rule', () => {
    const p = trailingPercentile(Float64Array.from([5, 1, 3, NaN, 3, 9]), 2);
    expect(Number.isNaN(p[0]!)).toBe(true);
    expect(Number.isNaN(p[1]!)).toBe(true); // one earlier value, needs two
    expect(p[2]).toBe(0.5); // earlier 5, 1: one lower of two
    expect(Number.isNaN(p[3]!)).toBe(true);
    expect(p[4]).toBeCloseTo((1 + 0.5) / 3, 12); // earlier 5, 1, 3: one lower, one equal
    expect(p[5]).toBe(1);
  });
});

describe('moving average runs', () => {
  it('counts from an observed boundary and treats a touch as a boundary', () => {
    const f = buildSignalFeatures({ bars: seriesFromCloses([10, 10, 10, 10, 10, 12, 12, 12, 8, 8]) });
    const ma5 = input(f, 'ma5');
    expect(Array.from(ma5.buckets)).toEqual([-1, -1, -1, -1, -1, 0, 0, 0, 3, 3]);
    expect(ma5.context(4)).toBe('Close equals the 5 day average');
    expect(ma5.context(7)).toBe('Above the 5 day average for 3 sessions, 7.1% over');
    expect(ma5.context(9)).toBe('Below the 5 day average for 2 sessions, 23.1% under');
    expect(ma5.context(2)).toBe('The 5 day average needs 5 completed sessions');
  });
  it('a run that began before the first observable day is not a confirmed crossing', () => {
    const f = buildSignalFeatures({ bars: seriesFromCloses([10, 10, 10, 10, 11, 12, 13, 9, 9]) });
    const ma5 = input(f, 'ma5');
    expect(Array.from(ma5.buckets)).toEqual([-1, -1, -1, -1, -1, -1, -1, 3, 3]);
    expect(ma5.context(5)).toMatch(/true age is unknown/);
    expect(ma5.context(7)).toBe('Below the 5 day average for 1 session, 18.2% under');
  });
  it('a missing session breaks run continuity', () => {
    const bars = seriesFromCloses([10, 10, 10, 10, 10, 12, 12, 12, 12, 12, 12]);
    const gapped = [...bars.slice(0, 8), ...bars.slice(9)]; // drop one session inside the run
    const f = buildSignalFeatures({ bars: gapped });
    const b = Array.from(input(f, 'ma5').buckets);
    expect(b.slice(5, 8)).toEqual([0, 0, 0]);
    expect(b.slice(8)).toEqual([-1, -1]);
  });
  it('the 200 day average is unavailable from 199 sessions', () => {
    const f = buildSignalFeatures({ bars: seriesFromCloses(Array.from({ length: 199 }, (_, i) => 100 + i)) });
    expect(Array.from(input(f, 'ma200').buckets).every((b) => b === -1)).toBe(true);
    expect(input(f, 'cross200').context(198)).toBe('The 200 day average needs 200 completed sessions');
  });
});

describe('drawdown, year to date and decline states', () => {
  it('selloff depth bands and context', () => {
    const f = buildSignalFeatures({ bars: seriesFromCloses([100, 99, 96, 91, 85, 60, 100]) });
    const s = input(f, 'selloffDepth');
    expect(Array.from(s.buckets)).toEqual([0, 0, 1, 2, 3, 5, 0]);
    expect(s.context(4)).toBe(`15.0% below the closing high of ${f.dates[0]}, 4 sessions since that high`);
    expect(s.context(6)).toMatch(/^At the closing high in available history/);
  });
  it('year to date placement uses the prior year end close and never the first close of the year', () => {
    const dates = sessionsBetween('2025-12-29', '2026-01-09');
    const closes = [98, 99, 100, 102, 104, 101, 103, 105, 102.5];
    const f = buildSignalFeatures({ bars: onDates(dates, (_, i) => closes[i]!) });
    const y = input(f, 'ytdPlacement');
    expect(Array.from(y.buckets)).toEqual([-1, -1, -1, -1, -1, -1, -1, 4, 2]);
    expect(y.context(0)).toMatch(/No prior year end close/);
    expect(y.context(8)).toBe('Year to date +2.5% from the 2025-12-31 close, at 50% of the year to date closing range');
    // A history that starts inside the year has no base.
    const late = buildSignalFeatures({ bars: onDates(dates.slice(3), (_, i) => closes[i + 3]!) });
    expect(Array.from(input(late, 'ytdPlacement').buckets).every((b) => b === -1)).toBe(true);
  });
  it('big decline recency', () => {
    const closes = [100, 100, 94, 95, 95, 95, 95, 95, 95, 95];
    const f = buildSignalFeatures({ bars: seriesFromCloses(closes) });
    const d = input(f, 'bigDecline');
    expect(Array.from(d.buckets)).toEqual([-1, 3, 0, 0, 0, 0, 0, 0, 1, 1]);
    expect(d.context(8)).toBe(`Last close to close decline of 5% or more was 6.0% on ${f.dates[2]}, 6 sessions ago`);
    expect(d.context(1)).toMatch(/^No close to close decline/);
  });
  it('counts 10% drawdown episodes against prior years at the same point', () => {
    const dates = sessionsBetween('2019-01-02', '2023-06-30');
    const dip = (d: ISODate) => (d >= '2022-03-01' && d <= '2022-03-10') || (d >= '2023-02-01' && d <= '2023-02-06') || (d >= '2023-05-01' && d <= '2023-05-04');
    const f = buildSignalFeatures({ bars: onDates(dates, (d) => (dip(d) ? 88 : 100)) });
    const e = input(f, 'ddEpisodes');
    const at = (d: ISODate) => e.buckets[f.dates.indexOf(d)]!;
    expect(at('2021-06-01')).toBe(-1); // only two prior full years
    expect(at('2022-02-01')).toBe(1); // zero so far, prior years zero
    expect(at('2022-06-01')).toBe(2); // one so far, prior years zero
    expect(at('2023-06-30')).toBe(2); // two so far against 0, 0, 0, 1
    expect(e.context(f.n - 1)).toBe('2 episodes of 10% or more so far this year. Prior years had a median of 0 by this point, 4 years');
    // Each later day under the threshold is not a new episode.
    expect(at('2022-03-09')).toBe(2);
    expect(e.context(f.dates.indexOf('2022-03-09'))).toMatch(/^1 episode of 10%/);
  });
});

describe('volume, calendar and earnings states', () => {
  it('relative volume excludes the session itself and splits by direction', () => {
    const closes = [...new Array(21).fill(100), 99, 101, 101, 100];
    const vols = [...new Array(21).fill(100), 250, 150, 60, 100];
    const f = buildSignalFeatures({ bars: onDates(sessionsBetween('2024-01-02', '2024-03-01').slice(0, 25), (_, i) => closes[i]!, (i) => vols[i]!) });
    const v = input(f, 'relVolume');
    expect(v.buckets[19]).toBe(-1);
    expect(v.buckets[20]).toBe(1);
    expect(v.buckets[21]).toBe(5); // 2.5x on a lower close
    expect(v.buckets[22]).toBe(2); // 150 against a mean of 107.5, higher close
    expect(v.buckets[23]).toBe(0);
    expect(v.context(21)).toBe('Volume 2.50x the prior 20 session average on a lower close');
  });
  it('month and week of month by the Friday label', () => {
    const dates = sessionsBetween('2026-11-13', '2026-11-30');
    const f = buildSignalFeatures({ bars: onDates(dates, () => 50) });
    expect(input(f, 'month').buckets[0]).toBe(10);
    expect(input(f, 'weekOfMonth').buckets[0]).toBe(1);
    const last = f.n - 1; // Monday November 30 belongs to the week ending Friday December 4
    expect(input(f, 'weekOfMonth').buckets[last]).toBe(0);
    expect(input(f, 'weekOfMonth').context(last)).toBe('Week 1 of December by its Friday, 2026-12-04');
    expect(input(f, 'month').seasonal && input(f, 'weekOfMonth').seasonal).toBe(true);
  });
  const ev = (date: ISODate, time: EarningsEvent['time'], knownAt?: string): EarningsEvent => ({ instrumentId: 'x', symbol: 'X', date, time, status: 'confirmed', knownAt, source: fixtureSource() });
  const quarterly = (count: number, withKnown = true): EarningsEvent[] =>
    Array.from({ length: count }, (_, k) => {
      const date = sessionsBetween(addDays('2026-11-19', -91 * (count - 1 - k)), '2026-12-31')[0]!;
      return ev(date, 'amc', withKnown ? `${addDays(date, -21)}T21:00:00Z` : undefined);
    });
  const bars = onDates(sessionsBetween('2023-01-03', '2026-11-13'), () => 50);
  it('the earnings input is inactive below ten point in time reports', () => {
    const sparse = buildSignalFeatures({ bars, earnings: quarterly(6) });
    const e = input(sparse, 'earnings');
    expect(e.buckets[sparse.n - 1]).toBe(-1);
    expect(e.context(sparse.n - 1)).toBe('Next known report in 4 sessions. Inactive, 5 prior reports with a point in time schedule, needs 10');
    // Reports without a schedule timestamp are not point in time evidence.
    const undated = buildSignalFeatures({ bars, earnings: quarterly(14, false) });
    expect(input(undated, 'earnings').buckets[undated.n - 1]).toBe(-1);
    expect(input(buildSignalFeatures({ bars }), 'earnings').context(0)).toBe('No earnings history supplied');
  });
  it('uses only a report that was already known before the session', () => {
    const f = buildSignalFeatures({ bars, earnings: quarterly(14) });
    const e = input(f, 'earnings');
    const at = (d: ISODate) => e.buckets[f.dates.indexOf(d)]!;
    expect(at('2026-11-13')).toBe(0); // 4 sessions ahead
    expect(at('2026-11-04')).toBe(2); // 11 sessions ahead
    expect(at('2026-10-30')).toBe(2); // known since October 29
    expect(at('2026-10-29')).toBe(3); // the schedule became known that evening, not before the session
    const prior = f.dates.indexOf(sessionsBetween(addDays('2026-11-19', -91), '2026-12-31')[0]!);
    expect(e.buckets[prior]).toBe(0); // after close report on the session itself is still ahead
    expect(e.buckets[prior + 1]).toBe(4); // reported within the past five sessions
    expect(e.buckets[prior + 6]).toBe(3);
  });
});

describe('market and group context', () => {
  const dates = sessionsBetween('2024-01-02', '2025-06-30');
  const stock = onDates(dates, (_, i) => 100 + i * 0.1);
  const group = onDates(dates, (_, i) => 50 + (i % 40) * 0.2);
  it('needs the comparison series on the same completed date', () => {
    const hole = dates[300]!;
    const f = buildSignalFeatures({ bars: stock, spyBars: group.filter((b) => b.date !== hole), groupBars: group.filter((b) => b.date !== hole), groupLabel: 'XLK' });
    expect(input(f, 'spyRegime').buckets[300]).toBe(-1);
    expect(input(f, 'spyRegime').buckets[299]).toBeGreaterThanOrEqual(0);
    expect(input(f, 'groupOffHigh').buckets[300]).toBe(-1);
    expect(input(f, 'relMtd').buckets[300]).toBe(-1);
    expect(input(f, 'relMtd').context(300)).toBe('No comparable month to date base on the same completed dates');
    expect(input(f, 'groupOffHigh').label).toBe('XLK distance from its 252 session closing high');
  });
  it('is unavailable without the series', () => {
    const f = buildSignalFeatures({ bars: stock });
    expect(Array.from(input(f, 'spyRegime').buckets).every((b) => b === -1)).toBe(true);
    expect(input(f, 'relQtd').context(10)).toBe('No Group series supplied');
  });
});

describe('invariants and fixture smoke', () => {
  const inst = (s: string) => INSTRUMENTS.find((i) => i.symbol === s)!;
  const nvda = syntheticDaily(inst('NVDA')).bars.slice(-2600);
  const spy = syntheticDaily(inst('SPY')).bars;
  const xlk = syntheticDaily(inst('XLK')).bars;
  const earn = syntheticEarnings(inst('NVDA')) as EarningsEvent[];
  const compute = (bars: readonly Bar[]) => buildSignalFeatures({ bars, spyBars: spy, groupBars: xlk, groupLabel: 'XLK', earnings: earn });
  const project = (f: SignalFeatureSet, cut: number) => ({
    buckets: f.inputs.map((x) => Array.from(x.buckets.slice(0, cut + 1))),
    context: f.inputs.map((x) => x.context(cut)),
    setup: f.setupDims.map((d) => Array.from(d.pct.slice(0, cut + 1)).map((v) => (Number.isNaN(v) ? null : v))),
  });
  it('appending future rows does not change any earlier state', () => {
    expect(() => assertNoLookAhead(compute, project, nvda, 1900)).not.toThrow();
    expect(() => assertNoLookAhead(compute, project, nvda, 777)).not.toThrow();
  });
  it('scaling every price by one factor does not change any state', () => {
    const a = buildSignalFeatures({ bars: nvda, earnings: earn });
    const b = buildSignalFeatures({ bars: scaleBars(nvda, 4), earnings: earn });
    expect(b.inputs.map((x) => Array.from(x.buckets))).toEqual(a.inputs.map((x) => Array.from(x.buckets)));
    expect(b.inputs.map((x) => x.context(nvda.length - 1))).toEqual(a.inputs.map((x) => x.context(nvda.length - 1)));
  });
  it('builds every input on a long and a short fixture history', () => {
    const long = compute(syntheticDaily(inst('NVDA')).bars);
    expect(long.inputs.map((x) => x.id)).toEqual([
      'ma5', 'ma10', 'ma20', 'ma50', 'ma100', 'ma200', 'cross200', 'selloffDepth', 'ddEpisodes', 'ytdPlacement', 'bigDecline', 'rsiRank', 'relVolume',
      'month', 'weekOfMonth', 'mtdPath', 'earnings', 'spyRegime', 'groupOffHigh', 'relMtd', 'relQtd',
    ]);
    for (const x of long.inputs) {
      expect(x.buckets.length).toBe(long.n);
      expect(Math.max(...x.buckets)).toBeLessThan(x.bucketLabels.length);
      expect(x.context(long.n - 1).length).toBeGreaterThan(5);
      expect(x.context(long.n - 1)).not.toMatch(/NaN|undefined|—|–/);
    }
    expect(input(long, 'earnings').buckets[long.n - 1]).toBeGreaterThanOrEqual(0);
    const short = buildSignalFeatures({ bars: syntheticDaily(inst('SNDK')).bars, spyBars: spy });
    expect(short.n).toBeLessThan(500);
    expect(input(short, 'ddEpisodes').buckets[short.n - 1]).toBe(-1);
    expect(input(short, 'ma200').context(100)).toBe('The 200 day average needs 200 completed sessions');
  });
});
