import { describe, expect, it } from 'vitest';
import * as cal from './calendar';
import { atrWilder, rollingExtreme, rsiWilder, sma, relativeVolume } from './indicators';
import { alignBars, buildCoverage, minusMonths, periodBaseIndex, periodToDate, sliceAsOf, validateBars } from './series';
import { brier, kaplanMeier, kmMedian, midrankPercentile, normCdf, normInv, quantile, wilson, yearClusterEffectiveN } from './stats';
import { isNa, type Bar } from './types';
import { INSTRUMENTS } from '../../data/fixtures/universe';
import { seriesFromCloses, syntheticDaily, syntheticEarnings } from '../../data/fixtures/synthetic';

const bar = (date: string, c: number, o = c, h = Math.max(o, c), l = Math.min(o, c), v: number | null = 100): Bar => ({ date, open: o, high: h, low: l, close: c, volume: v });

describe('exchange calendar', () => {
  it('closes on dated unscheduled closures', () => {
    expect(cal.isSession('2025-01-09')).toBe(false);
    expect(cal.holidayName('2025-01-09')).toMatch(/Carter/);
    expect(cal.isSession('2012-10-29')).toBe(false);
    expect(cal.isSession('2012-10-30')).toBe(false);
    expect(cal.isSession('2012-10-31')).toBe(true);
    expect(cal.sessionsBetween('2001-09-10', '2001-09-17')).toEqual(['2001-09-10', '2001-09-17']);
  });
  it('applies observed holiday rules', () => {
    expect(cal.isSession('2021-12-31')).toBe(true); // New Year on Saturday is not observed on Friday
    expect(cal.isSession('2021-12-24')).toBe(false); // Christmas on Saturday observed Friday
    expect(cal.isSession('2026-07-03')).toBe(false); // July 4 2026 is a Saturday
    expect(cal.isSession('2022-06-20')).toBe(false); // Juneteenth observed
    expect(cal.isSession('2021-06-18')).toBe(true); // before Juneteenth became a market holiday
    expect(cal.isSession('2026-04-03')).toBe(false); // Good Friday 2026
    expect(cal.isSession('2024-03-29')).toBe(false); // Good Friday 2024
    expect(cal.isSession('2026-11-26')).toBe(false); // Thanksgiving 2026
  });
  it('knows early closes', () => {
    expect(cal.isEarlyClose('2026-11-27')).toBe(true);
    expect(cal.isEarlyClose('2026-12-24')).toBe(true);
    expect(cal.isEarlyClose('2025-07-03')).toBe(true);
    expect(cal.isEarlyClose('2026-07-02')).toBe(false);
    expect(cal.closeTimeET('2026-11-27')).toBe('13:00');
  });
  it('counts 2026 sessions and weeks', () => {
    expect(cal.sessionsBetween('2026-01-01', '2026-12-31').length).toBe(251);
    expect(cal.mondayOf('2026-11-13')).toBe('2026-11-09');
    expect(cal.fridayOf('2026-11-09')).toBe('2026-11-13');
    expect(cal.sessionsOfWeek('2026-11-26').length).toBe(4);
    expect(cal.isoWeek('2026-01-01')).toEqual({ year: 2026, week: 1 });
    expect(cal.isoWeek('2021-01-01')).toEqual({ year: 2020, week: 53 });
  });
  it('finds the latest completed session from an instant', () => {
    expect(cal.latestCompletedSession('2026-11-14T15:00:00Z')).toBe('2026-11-13'); // Saturday
    expect(cal.latestCompletedSession('2026-11-13T20:30:00Z')).toBe('2026-11-12'); // 3:30pm ET Friday
    expect(cal.latestCompletedSession('2026-11-13T21:01:00Z')).toBe('2026-11-13'); // after the close
    expect(cal.latestCompletedSession('2026-11-27T18:30:00Z')).toBe('2026-11-27'); // early close done at 1:30pm ET
  });
});

describe('statistics', () => {
  it('wilson matches the closed form', () => {
    const w = wilson(27, 45)!;
    expect(w.rate).toBeCloseTo(0.6, 10);
    expect(w.lo).toBeCloseTo(0.4545, 3);
    expect(w.hi).toBeCloseTo(0.7295, 3);
    expect(wilson(0, 0)).toBeNull();
    const wide = wilson(27, 45, 0.95, 10)!;
    expect(wide.hi - wide.lo).toBeGreaterThan(w.hi - w.lo);
  });
  it('normal functions invert', () => {
    expect(normInv(0.975)).toBeCloseTo(1.959964, 5);
    expect(normInv(0.75)).toBeCloseTo(0.67448975, 6);
    expect(normInv(0.9)).toBeCloseTo(1.28155157, 6);
    expect(normInv(0.95)).toBeCloseTo(1.64485363, 6);
    expect(normCdf(0)).toBeCloseTo(0.5, 14);
    expect(normCdf(1)).toBeCloseTo(0.8413447460685429, 13);
    expect(normCdf(1.96)).toBeCloseTo(0.9750021048517795, 13);
    expect(normCdf(-2.5)).toBeCloseTo(0.006209665325776132, 13);
    expect(normInv(0.8)).toBeCloseTo(0.8416212335729143, 10);
    expect(normInv(0.975)).toBeCloseTo(1.959963984540054, 10);
  });
  it('quantile, midrank and brier', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(midrankPercentile([1, 2, 2, 3], 2)).toBe(0.5);
    expect(brier([0.5, 0.5], [1, 0])).toBe(0.25);
    expect(yearClusterEffectiveN(['2020-01-01', '2020-02-01', '2021-01-01'])).toBeCloseTo(9 / 5, 10);
  });
  it('kaplan-meier handles censoring', () => {
    const steps = kaplanMeier([
      { duration: 2, ended: true },
      { duration: 3, ended: false },
      { duration: 4, ended: true },
      { duration: 6, ended: true },
    ]);
    expect(steps.map((s) => +s.survival.toFixed(4))).toEqual([0.75, 0.75, 0.375, 0]);
    expect(kmMedian(steps)).toBe(4);
  });
});

describe('indicators', () => {
  it('sma needs a full window', () => {
    const s = sma([1, 2, 3, 4, 5], 3);
    expect(s).toEqual([null, null, 2, 3, 4]);
    expect(sma(new Array(199).fill(1), 200).every((v) => v === null)).toBe(true);
  });
  it('rsi zero cases and Wilder seed', () => {
    const up = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(rsiWilder(up)[19]).toBe(100);
    expect(rsiWilder(new Array(20).fill(50))[19]).toBe(50);
    expect(rsiWilder(up)[13]).toBeNull();
    // Reference series from Wilder-style worked example.
    const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64];
    const r = rsiWilder(closes);
    expect(r[14]!).toBeCloseTo(70.46, 1);
    expect(r[15]!).toBeCloseTo(66.25, 1);
  });
  it('atr uses true range with gaps', () => {
    const bars: Bar[] = [bar('2024-01-02', 10, 10, 11, 9)];
    for (let i = 1; i < 16; i++) bars.push(bar(cal.addSessions('2024-01-02', i), 10, 10, 11, 9));
    bars.push({ date: cal.addSessions('2024-01-02', 16), open: 14, high: 15, low: 14, close: 15, volume: 1 });
    const atr = atrWilder(bars);
    expect(atr[14]).toBe(2);
    expect(atr[16]!).toBeCloseTo((2 * 13 + 5) / 14, 10);
  });
  it('rolling extreme excludes the signal bar and keeps the earliest tie', () => {
    const r = rollingExtreme([1, 5, 5, 2, 7], 3, 'max', true);
    expect(r.value).toEqual([null, null, null, 5, 5]);
    expect(r.index).toEqual([null, null, null, 1, 1]);
  });
  it('relative volume excludes the target session', () => {
    const bars = Array.from({ length: 21 }, (_, i) => bar(cal.addSessions('2024-01-02', i), 10, 10, 10, 10, i === 20 ? 300 : 100));
    expect(relativeVolume(bars)[20]).toBe(3);
  });
});

describe('series', () => {
  it('validates structure', () => {
    const bad: Bar[] = [bar('2024-01-03', 10), bar('2024-01-02', 10), bar('2024-01-02', 10), { date: '2024-01-04', open: 10, high: 9, low: 8, close: 10, volume: 1 }, bar('2024-01-06', 10)];
    const codes = validateBars(bad).map((i) => i.code);
    expect(codes).toContain('out-of-order');
    expect(codes).toContain('duplicate-date');
    expect(codes).toContain('ohlc-containment');
    expect(codes).toContain('non-session-date');
  });
  it('reports a missing session instead of hiding it', () => {
    const bars = [bar('2026-11-09', 10), bar('2026-11-10', 10), bar('2026-11-12', 10)];
    expect(buildCoverage(bars).missingSessions).toEqual(['2026-11-11']);
    expect(buildCoverage(bars).complete).toBe(false);
  });
  it('uses the prior period final close as the YTD base', () => {
    const bars = [bar('2025-12-30', 90), bar('2025-12-31', 100), bar('2026-01-02', 104), bar('2026-01-05', 110)];
    const ytd = periodToDate(bars, 3, 'Y');
    expect(isNa(ytd)).toBe(false);
    if (!isNa(ytd)) {
      expect(ytd.baseDate).toBe('2025-12-31');
      expect(ytd.ret).toBeCloseTo(0.1, 12);
    }
    // A series that starts inside the year has no base. It must not use the first close of the year.
    expect(isNa(periodBaseIndex(bars.slice(2), 1, 'Y'))).toBe(true);
    // A missing final session of the prior year is reported, not bridged.
    const gap = [bar('2025-12-30', 90), bar('2026-01-02', 104)];
    const r = periodBaseIndex(gap, 1, 'Y');
    expect(isNa(r) && r.code).toBe('missing-session');
  });
  it('future rows never change an as-of slice', () => {
    const bars = seriesFromCloses([1, 2, 3, 4, 5]);
    const cut = sliceAsOf(bars, bars[2]!.date);
    expect(cut.length).toBe(3);
    expect(minusMonths('2026-03-31', 1)).toBe('2026-02-28');
    const al = alignBars(bars, [bars[0]!, bars[2]!, bars[4]!]);
    expect(al.dates.length).toBe(3);
    expect(al.dropped).toBe(2);
  });
});

describe('synthetic fixture', () => {
  it('is deterministic, valid and complete on the exchange calendar', () => {
    for (const sym of ['NVDA', 'SPY', 'SNDK', 'AAOI']) {
      const inst = INSTRUMENTS.find((i) => i.symbol === sym)!;
      const s = syntheticDaily(inst);
      expect(validateBars(s.bars)).toEqual([]);
      expect(s.coverage.missingSessions).toEqual([]);
      expect(s.coverage.last).toBe('2026-11-13');
      expect(s.source.kind).toBe('synthetic-fixture');
    }
    const nvda = syntheticDaily(INSTRUMENTS.find((i) => i.symbol === 'NVDA')!);
    expect(nvda.coverage.first).toBe('1999-01-22');
    const sndk = syntheticDaily(INSTRUMENTS.find((i) => i.symbol === 'SNDK')!);
    expect(sndk.coverage.first).toBe('2025-02-24');
  });
  it('gives stocks a next earnings date and funds a not-applicable reason', () => {
    const e = syntheticEarnings(INSTRUMENTS.find((i) => i.symbol === 'MU')!);
    expect(Array.isArray(e) && e.filter((x) => x.date > '2026-11-13').length).toBe(1);
    const spy = syntheticEarnings(INSTRUMENTS.find((i) => i.symbol === 'SPY')!);
    expect(isNa(spy) && spy.code).toBe('not-applicable');
  });
});
