import { describe, expect, it } from 'vitest';
import { sessionsBetween } from './core/calendar';
import { sliceAsOf } from './core/series';
import { isNa, type Bar } from './core/types';
import { syntheticDaily } from '../data/fixtures/synthetic';
import { INSTRUMENTS } from '../data/fixtures/universe';
import { monthElapsedComparison, monthlyBoard, yearElapsedComparison, ytdSummary, type MonthCell, type YearRow } from './monthlyBoard';

/**
 * Hand-built history, 2023-12-28 through 2026-11-13. Closes are constant inside a month except
 * for two dated extremes, so every expected value can be computed by hand.
 *   2023-12            100
 *   2024-01            110      (+10%)
 *   2024-02             99      (-10%)
 *   2024-03 .. 2024-12 121      (+22.2% in March, then flat)
 *     2024-06-12        90      lowest close of 2024, -10% year to date
 *     2024-09-10       130      highest close of 2024, +30% year to date
 *   2025-01            133.1    (+10%)
 *   2025-02 .. 2025-12 145.2    (+9.09% in February, then flat)
 *   2026-01            145.2    (flat)
 *   2026-02 .. 2026-10 159.72   (+10% in February, then flat)
 *   2026-11            151.734  (-5% month to date, still trading)
 */
const level = (d: string): number => {
  if (d === '2024-06-12') return 90;
  if (d === '2024-09-10') return 130;
  const ym = d.slice(0, 7);
  if (ym <= '2023-12') return 100;
  if (ym === '2024-01') return 110;
  if (ym === '2024-02') return 99;
  if (ym <= '2024-12') return 121;
  if (ym === '2025-01') return 133.1;
  if (ym <= '2026-01') return 145.2;
  if (ym <= '2026-10') return 159.72;
  return 151.734;
};

const build = (from: string, to: string, close: (d: string) => number = level): Bar[] =>
  sessionsBetween(from, to).map((date) => {
    const c = close(date);
    return { date, open: c, high: c * 1.5, low: c * 0.5, close: c, volume: 1000 };
  });

const bars = build('2023-12-28', '2026-11-13');
const board = monthlyBoard(bars);
const row = (y: number): YearRow => board.years.find((r) => r.year === y)!;
const cell = (y: number, m: number): MonthCell => row(y).months[m - 1]!;
const num = (v: unknown): number => {
  if (typeof v !== 'number') throw new Error('expected a number');
  return v;
};
const scale = (xs: readonly Bar[], f: number): Bar[] => xs.map((b) => ({ ...b, open: b.open * f, high: b.high * f, low: b.low * f, close: b.close * f }));
const fixture = (sym: string) => syntheticDaily(INSTRUMENTS.find((i) => i.symbol === sym)!).bars;

describe('monthly returns', () => {
  it('uses the preceding month final close as base, across the year boundary', () => {
    const jan = cell(2024, 1);
    expect(jan.status).toBe('complete');
    expect(jan.baseDate).toBe('2023-12-29');
    expect(jan.endDate).toBe('2024-01-31');
    expect(num(jan.ret)).toBeCloseTo(0.1, 12);
    expect(num(cell(2024, 2).ret)).toBeCloseTo(-0.1, 12);
    expect(num(cell(2024, 3).ret)).toBeCloseTo(121 / 99 - 1, 12);
    expect(num(cell(2025, 1).ret)).toBeCloseTo(0.1, 12);
    expect(cell(2025, 1).baseDate).toBe('2024-12-31');
    expect(num(cell(2024, 6).ret)).toBeCloseTo(0, 12); // the mid-month dip does not change the month return
    expect(cell(2024, 6).sessions).toBe(19);
    expect(cell(2024, 6).expectedSessions).toBe(19);
  });
  it('marks the as-of month as partial and keeps it out of statistics', () => {
    const nov = cell(2026, 11);
    expect(nov.status).toBe('current-partial');
    expect(nov.countsInStats).toBe(false);
    expect(num(nov.ret)).toBeCloseTo(-0.05, 12);
    expect(nov.sessions).toBe(10);
    expect(board.currentMonth).toEqual({ year: 2026, month: 11, partial: true });
    expect(cell(2026, 12).status).toBe('outside-history');
    expect(cell(2023, 11).status).toBe('outside-history');
    const novStats = board.monthStats[10]!;
    expect([novStats.n, novStats.positive, novStats.flat]).toEqual([2, 0, 2]);
  });
  it('treats a month the history starts inside as a listing partial with an illustrative figure', () => {
    const dec = cell(2023, 12);
    expect(dec.status).toBe('listing-partial');
    expect(isNa(dec.ret) && dec.ret.code).toBe('missing-base-close');
    expect(dec.sinceFirst).toEqual({ ret: 0, fromDate: '2023-12-28', toDate: '2023-12-29' });
    expect(board.monthStats[11]!.n).toBe(2); // December 2024 and 2025 only
  });
  it('computes footer statistics from complete months only', () => {
    const jan = board.monthStats[0]!;
    expect([jan.n, jan.positive, jan.negative, jan.flat]).toEqual([3, 2, 0, 1]);
    expect(num(jan.median)).toBeCloseTo(0.1, 12);
    expect(num(jan.mean)).toBeCloseTo(0.2 / 3, 12);
    expect(jan.win!.rate).toBeCloseTo(2 / 3, 12);
    expect(jan.win!.lo).toBeLessThan(2 / 3);
    expect(jan.win!.hi).toBeGreaterThan(2 / 3);
    expect(jan.worst).toEqual({ year: 2026, ret: 0 });
    expect(jan.best!.year).toBe(2024);
    const feb = board.monthStats[1]!;
    expect([feb.n, feb.positive, feb.negative]).toEqual([3, 2, 1]);
  });
});

describe('year column and year to date extremes', () => {
  it('lets a year that ends positive have a negative lowest YTD', () => {
    const y = row(2024);
    expect(y.status).toBe('complete');
    expect(y.baseDate).toBe('2023-12-29');
    expect(num(y.yearReturn)).toBeCloseTo(0.21, 12);
    expect(y.lowestYtd).toEqual({ ret: 90 / 100 - 1, date: '2024-06-12', close: 90 });
    expect(y.highestYtd).toEqual({ ret: 130 / 100 - 1, date: '2024-09-10', close: 130 });
    expect(y.isYtd).toBe(false);
  });
  it('keeps a positive lowest YTD positive and dates extremes at the earliest close', () => {
    const y = row(2025);
    expect(num(y.yearReturn)).toBeCloseTo(0.2, 12);
    expect(!isNa(y.lowestYtd) && y.lowestYtd.ret).toBeCloseTo(0.1, 12);
    expect(!isNa(y.lowestYtd) && y.lowestYtd.date).toBe('2025-01-02');
    expect(!isNa(y.highestYtd) && y.highestYtd.ret).toBeCloseTo(0.2, 12);
    expect(!isNa(y.highestYtd) && y.highestYtd.date).toBe('2025-02-03');
  });
  it('uses closes, never intraday highs or lows', () => {
    // Every bar trades 50% above and below its close. The extremes must ignore that.
    const y = row(2024);
    expect(!isNa(y.highestYtd) && y.highestYtd.close).toBe(130);
    expect(!isNa(y.lowestYtd) && y.lowestYtd.close).toBe(90);
  });
  it('marks the as-of year as year to date and excludes it from statistics', () => {
    const y = row(2026);
    expect(y.status).toBe('current-partial');
    expect(y.isYtd).toBe(true);
    expect(num(y.yearReturn)).toBeCloseTo(151.734 / 145.2 - 1, 12);
    expect(!isNa(y.lowestYtd) && y.lowestYtd.ret).toBe(0);
    expect(board.completeYears).toBe(2);
    expect([board.yearStats.n, board.yearStats.positive]).toEqual([2, 2]);
    expect(num(board.yearStats.median)).toBeCloseTo(0.205, 12);
    expect(board.yearStats.best).toEqual({ year: 2024, ret: num(row(2024).yearReturn) });
  });
  it('does not present a since-first-date figure as a year return', () => {
    const y = row(2023);
    expect(y.status).toBe('listing-partial');
    expect(isNa(y.yearReturn) && y.yearReturn.code).toBe('missing-base-close');
    expect(isNa(y.highestYtd)).toBe(true);
    expect(y.sinceFirst).toEqual({ ret: 0, fromDate: '2023-12-28', toDate: '2023-12-29' });
    expect(y.countsInStats).toBe(false);
  });
  it('treats a month end as-of date as a complete month inside an unfinished year', () => {
    const b = monthlyBoard(sliceAsOf(bars, '2026-10-30'));
    expect(b.currentMonth).toEqual({ year: 2026, month: 10, partial: false });
    expect(b.years[b.years.length - 1]!.months[9]!.status).toBe('complete');
    expect(b.years[b.years.length - 1]!.status).toBe('current-partial');
  });
});

describe('history that starts mid year', () => {
  const mid = monthlyBoard(build('2024-05-15', '2025-03-31'));
  it('keeps known complete months and withholds the year return', () => {
    const y = mid.years[0]!;
    expect(y.year).toBe(2024);
    expect(y.status).toBe('listing-partial');
    expect(isNa(y.yearReturn)).toBe(true);
    expect(y.sinceFirst!.fromDate).toBe('2024-05-15');
    expect(y.sinceFirst!.ret).toBeCloseTo(0, 12);
    expect(y.months[4]!.status).toBe('listing-partial');
    expect(y.months[4]!.sinceFirst!.fromDate).toBe('2024-05-15');
    expect(y.months[5]!.status).toBe('complete');
    expect(y.months[5]!.baseDate).toBe('2024-05-31');
    expect(y.months[3]!.status).toBe('outside-history');
    expect(mid.completeYears).toBe(0);
    expect(isNa(mid.yearStats.median)).toBe(true);
    expect(mid.yearStats.win).toBeNull();
    // 2025 has a valid base and is the unfinished as-of year.
    expect(mid.years[1]!.status).toBe('current-partial');
    expect(mid.years[1]!.baseDate).toBe('2024-12-31');
  });
});

describe('missing sessions', () => {
  it('reports a missing prior year end close instead of bridging it', () => {
    const gap = monthlyBoard(bars.filter((b) => b.date !== '2024-12-31'));
    const y24 = gap.years.find((r) => r.year === 2024)!;
    const y25 = gap.years.find((r) => r.year === 2025)!;
    expect(y24.status).toBe('missing-data');
    expect(isNa(y24.yearReturn) && y24.yearReturn.code).toBe('missing-session');
    expect(y24.months[11]!.status).toBe('missing-data');
    expect(y25.status).toBe('missing-data');
    expect(isNa(y25.yearReturn) && y25.yearReturn.code).toBe('missing-session');
    expect(isNa(y25.highestYtd)).toBe(true);
    expect(y25.months[0]!.status).toBe('missing-data');
    expect(y25.months[1]!.status).toBe('complete'); // February has its own valid base
    expect(gap.completeYears).toBe(0);
  });
  it('counts a missing session inside a month and marks a whole missing month', () => {
    const hole = monthlyBoard(bars.filter((b) => b.date !== '2024-07-10' && b.date.slice(0, 7) !== '2025-06'));
    const jul = hole.years.find((r) => r.year === 2024)!.months[6]!;
    expect(jul.status).toBe('complete');
    expect(jul.missingSessions).toBe(1);
    const y25 = hole.years.find((r) => r.year === 2025)!;
    expect(y25.months[5]!.status).toBe('no-data');
    expect(y25.months[6]!.status).toBe('missing-data'); // July has no June month end base
    expect(y25.missingSessions).toBe(20); // June 2025 has 20 sessions, Juneteenth is a holiday
  });
  it('handles an empty series', () => {
    const e = monthlyBoard([]);
    expect(e.years).toEqual([]);
    expect(e.asOf).toBeNull();
    expect(e.monthStats.length).toBe(12);
  });
});

describe('same elapsed session comparison', () => {
  it('compares the current month with earlier months after the same number of sessions', () => {
    const c = monthElapsedComparison(bars);
    if (isNa(c)) throw new Error('unexpected');
    expect([c.year, c.month, c.elapsedSessions]).toEqual([2026, 11, 10]);
    expect(c.currentRet).toBeCloseTo(-0.05, 12);
    expect(c.baseDate).toBe('2026-10-30');
    const same = c.sameMonth!;
    expect(same.rows.map((r) => r.year)).toEqual([2024, 2025]);
    expect(same.rows[0]!.dateAtElapsed).toBe('2024-11-14');
    expect([same.n, same.lower, same.higher]).toEqual([2, 0, 2]);
    expect(same.median).toBeCloseTo(0, 12);
    expect(same.percentileOfCurrent).toBe(0);
    expect(c.all.n).toBe(34);
    expect(c.all.excluded).toEqual({ noBase: 1, tooFewSessions: 0, missingSessions: 0 });
    const jan24 = c.all.rows.find((r) => r.year === 2024 && r.month === 1)!;
    expect(jan24.retAtElapsed).toBeCloseTo(0.1, 12);
    expect(num(jan24.restOfPeriod)).toBeCloseTo(0, 12);
    expect(num(jan24.periodReturn)).toBeCloseTo(0.1, 12);
  });
  it('excludes months shorter than the elapsed count and counts them', () => {
    const c = monthElapsedComparison(sliceAsOf(bars, '2024-10-31'));
    if (isNa(c)) throw new Error('unexpected');
    expect(c.elapsedSessions).toBe(23);
    expect(c.all.n).toBe(0);
    expect(c.all.excluded).toEqual({ noBase: 1, tooFewSessions: 9, missingSessions: 0 });
    expect(isNa(c.all.median)).toBe(true);
    expect(isNa(c.all.percentileOfCurrent)).toBe(true);
  });
  it('excludes an earlier month that lacks a session inside the compared stretch', () => {
    const c = monthElapsedComparison(bars.filter((b) => b.date !== '2025-11-05'));
    if (isNa(c)) throw new Error('unexpected');
    expect(c.sameMonth!.rows.map((r) => r.year)).toEqual([2024]);
    expect(c.sameMonth!.excluded.missingSessions).toBe(1);
  });
  it('is unavailable without a base or with a hole in the current month', () => {
    const noBase = monthElapsedComparison(build('2026-11-03', '2026-11-13'));
    expect(isNa(noBase) && noBase.code).toBe('missing-base-close');
    const hole = monthElapsedComparison(bars.filter((b) => b.date !== '2026-11-04'));
    expect(isNa(hole) && hole.code).toBe('missing-session');
    expect(isNa(monthElapsedComparison([]))).toBe(true);
  });
  it('compares the year to date with earlier years after the same number of sessions', () => {
    const c = yearElapsedComparison(bars);
    if (isNa(c)) throw new Error('unexpected');
    expect(c.month).toBeNull();
    expect(c.sameMonth).toBeNull();
    expect(c.elapsedSessions).toBe(sessionsBetween('2026-01-01', '2026-11-13').length);
    expect(c.all.rows.map((r) => r.year)).toEqual([2024, 2025]);
    expect(c.all.rows[0]!.retAtElapsed).toBeCloseTo(0.21, 12);
    expect(c.all.rows[1]!.retAtElapsed).toBeCloseTo(0.2, 12);
    expect(num(c.all.rows[1]!.periodReturn)).toBeCloseTo(0.2, 12);
    expect(c.all.excluded.noBase).toBe(1);
    expect(c.all.percentileOfCurrent).toBe(0);
  });
});

describe('year to date summary', () => {
  it('places the close inside the closing range of the year', () => {
    const s = ytdSummary(bars);
    if (isNa(s)) throw new Error('unexpected');
    expect(s.baseDate).toBe('2025-12-31');
    expect(s.ret).toBeCloseTo(151.734 / 145.2 - 1, 12);
    expect(s.high.date).toBe('2026-02-02');
    expect(s.high.ret).toBeCloseTo(0.1, 12);
    expect(s.low.date).toBe('2026-01-02');
    expect(s.low.ret).toBe(0);
    expect(num(s.rangePosition)).toBeCloseTo(0.45, 9);
    expect(s.fromYearHigh).toBeCloseTo(-0.05, 12);
    expect(s.sessions).toBe(sessionsBetween('2026-01-01', '2026-11-13').length);
  });
  it('reports a flat range and a missing base as reasons', () => {
    const flat = ytdSummary(sliceAsOf(bars, '2026-01-20'));
    expect(!isNa(flat) && isNa(flat.rangePosition) && flat.rangePosition.code).toBe('flat-range');
    const noBase = ytdSummary(build('2026-03-02', '2026-06-30'));
    expect(isNa(noBase) && noBase.code).toBe('missing-base-close');
  });
  it('can be asked at an earlier bar without seeing later rows', () => {
    const i = bars.findIndex((b) => b.date === '2024-07-01');
    expect(ytdSummary(bars, i)).toEqual(ytdSummary(bars.slice(0, i + 1)));
    const s = ytdSummary(bars, i);
    expect(!isNa(s) && s.low.date).toBe('2024-06-12');
  });
});

describe('invariants and fixture smoke', () => {
  it('appending future rows does not change completed periods', () => {
    const early = monthlyBoard(sliceAsOf(bars, '2025-08-15'));
    for (const y of early.years) {
      const fullRow = row(y.year);
      if (y.countsInStats) expect({ ...fullRow, months: [] }).toEqual({ ...y, months: [] });
      y.months.forEach((c, k) => {
        if (c.countsInStats || c.status === 'listing-partial') expect(fullRow.months[k]).toEqual(c);
      });
    }
  });
  it('scaling every price by one factor does not change returns or statuses', () => {
    const scaled = monthlyBoard(scale(bars, 7.3));
    scaled.years.forEach((y, i) => {
      const o = board.years[i]!;
      expect(y.status).toBe(o.status);
      if (!isNa(y.yearReturn)) expect(y.yearReturn).toBeCloseTo(num(o.yearReturn), 9);
      if (!isNa(y.lowestYtd) && !isNa(o.lowestYtd)) {
        expect(y.lowestYtd.ret).toBeCloseTo(o.lowestYtd.ret, 9);
        expect(y.lowestYtd.date).toBe(o.lowestYtd.date);
      }
      y.months.forEach((c, k) => {
        expect(c.status).toBe(o.months[k]!.status);
        if (!isNa(c.ret)) expect(c.ret).toBeCloseTo(num(o.months[k]!.ret), 9);
      });
    });
    const a = monthElapsedComparison(bars);
    const b = monthElapsedComparison(scale(bars, 7.3));
    expect(!isNa(a) && !isNa(b) && Math.abs(a.currentRet - b.currentRet) < 1e-9 && a.all.n === b.all.n).toBe(true);
  });
  it('runs on a long and a short fixture history', () => {
    const nvda = monthlyBoard(fixture('NVDA'));
    expect(nvda.years[0]).toMatchObject({ year: 1999, status: 'listing-partial' });
    expect(nvda.years[0]!.months[0]!.status).toBe('listing-partial');
    expect(nvda.years[0]!.months[1]!.status).toBe('complete');
    expect(nvda.completeYears).toBe(26); // 2000 through 2025
    expect(nvda.monthStats.every((s) => s.n >= 26 && s.win !== null)).toBe(true);
    expect(nvda.currentMonth).toEqual({ year: 2026, month: 11, partial: true });
    for (const y of nvda.years) {
      if (isNa(y.highestYtd) || isNa(y.lowestYtd) || isNa(y.yearReturn)) continue;
      expect(y.lowestYtd.ret).toBeLessThanOrEqual(y.yearReturn + 1e-12);
      expect(y.highestYtd.ret).toBeGreaterThanOrEqual(y.yearReturn - 1e-12);
    }
    const sndk = monthlyBoard(fixture('SNDK'));
    expect(sndk.years.map((y) => y.status)).toEqual(['listing-partial', 'current-partial']);
    expect(sndk.years[0]!.months[1]!.status).toBe('listing-partial');
    expect(sndk.years[0]!.months[2]!.status).toBe('complete');
    expect(sndk.completeYears).toBe(0);
    expect(isNa(monthElapsedComparison(fixture('SNDK')))).toBe(false);
    const y = yearElapsedComparison(fixture('SNDK'));
    expect(!isNa(y) && y.all.n).toBe(0);
    expect(isNa(ytdSummary(fixture('NVDA')))).toBe(false);
  });
});
