import { describe, expect, it } from 'vitest';
import { sessionsBetween } from './core/calendar';
import { isNa, isNum, type Bar, type EarningsEvent } from './core/types';
import { INSTRUMENTS } from '../data/fixtures/universe';
import { fixtureSource, syntheticDaily, syntheticEarnings } from '../data/fixtures/synthetic';
import { buildWeeks, sortWeeklyRows, weekLabelOf, weekStreaks, weeklyAcceptanceSummary, weeklyBoard, weeklySeasonality, type WeekRecord } from './weeklyBoard';

type Over = Record<string, Partial<Bar>>;

/** Bars on real exchange sessions. Open defaults to the previous close, high and low to the body. */
const mkBars = (from: string, to: string, closeOf: (i: number, date: string) => number, over: Over = {}): Bar[] => {
  let prev: number | null = null;
  return sessionsBetween(from, to).map((date, i) => {
    const c = over[date]?.close ?? closeOf(i, date);
    const o = over[date]?.open ?? prev ?? c;
    const b: Bar = { date, open: o, high: Math.max(o, c), low: Math.min(o, c), close: c, volume: 1000, ...over[date] };
    b.open = o;
    b.close = c;
    prev = c;
    return b;
  });
};

/**
 * Hand built scenario, 2025-10-20 through 2026-01-14.
 * Before 2025-11-24 closes alternate 100 and 101, with 100 on Friday 2025-11-21 (session index 24).
 */
const EXPLICIT: Over = {
  // Thanksgiving week, four sessions. Base 100.
  '2025-11-24': { open: 102, high: 104, low: 101, close: 103, volume: 1500 },
  '2025-11-25': { open: 103, high: 104, low: 99, close: 100, volume: 1500 },
  '2025-11-26': { open: 100, high: 101, low: 98, close: 99, volume: 1000 },
  '2025-11-28': { open: 99, high: 100, low: 98, close: 99, volume: 1200 },
  // Up week. Base 99.
  '2025-12-01': { close: 100 }, '2025-12-02': { close: 101 }, '2025-12-03': { close: 102 }, '2025-12-04': { close: 103 }, '2025-12-05': { close: 104 },
  // Flat range week. Base 104.
  '2025-12-08': { close: 104 }, '2025-12-09': { close: 104 }, '2025-12-10': { close: 104 }, '2025-12-11': { close: 104 }, '2025-12-12': { close: 104 },
  // Down week with a Friday low. Base 104.
  '2025-12-15': { close: 103 }, '2025-12-16': { close: 102 }, '2025-12-17': { close: 101 }, '2025-12-18': { close: 100 },
  '2025-12-19': { open: 100, high: 100, low: 96, close: 97 },
  // Christmas week, four sessions, gap down that closes green. Base 97.
  '2025-12-22': { open: 95, high: 98, low: 94, close: 98 },
  '2025-12-23': { close: 99 }, '2025-12-24': { close: 100 }, '2025-12-26': { close: 101 },
  // New Year week, labeled 2026-01-02. Base 101.
  '2025-12-29': { close: 102 }, '2025-12-30': { close: 103 }, '2025-12-31': { close: 104 }, '2026-01-02': { close: 105 },
  '2026-01-05': { close: 106 }, '2026-01-06': { close: 107 }, '2026-01-07': { close: 108 }, '2026-01-08': { close: 109 }, '2026-01-09': { close: 110 },
  '2026-01-12': { close: 111 }, '2026-01-13': { close: 112 }, '2026-01-14': { close: 113 },
};
const alt = (i: number): number => ((24 - i) % 2 === 0 ? 100 : 101);
const scenario = (): Bar[] => mkBars('2025-10-20', '2026-01-14', alt, EXPLICIT);
const spyBars = (): Bar[] => mkBars('2025-10-20', '2026-01-14', (i) => 400 + i);
const byLabel = (weeks: readonly WeekRecord[], label: string): WeekRecord => {
  const w = weeks.find((x) => x.label === label);
  if (!w) throw new Error(`no week ${label}`);
  return w;
};
const num = (v: unknown): number => {
  if (!isNum(v)) throw new Error(`expected a number, got ${JSON.stringify(v)}`);
  return v;
};
const ev = (date: string, time: EarningsEvent['time']): EarningsEvent => ({
  instrumentId: 'us:test', symbol: 'TEST', date, time, status: 'confirmed', source: fixtureSource(),
});

describe('week construction', () => {
  const weeks = buildWeeks({ bars: scenario(), spy: spyBars() });

  it('labels a holiday short week by its nominal Friday with true sessions and day count', () => {
    const w = byLabel(weeks, '2025-11-28');
    expect(w.key).toBe('2025-11-24');
    expect(w.firstSession).toBe('2025-11-24');
    expect(w.lastSession).toBe('2025-11-28');
    expect(w.expectedDays).toBe(4);
    expect(w.tradedDays).toBe(4);
    expect(w.flags.shortWeekDays).toBe(4);
    expect(w.status).toBe('complete');
    expect(w.counted).toBe(true);
    expect(w.base).toEqual({ date: '2025-11-21', close: 100 });
    expect(weekLabelOf('2025-11-26')).toBe('2025-11-28');
  });

  it('computes return, gap, range and extreme dates from the prior week close', () => {
    const w = byLabel(weeks, '2025-11-28');
    expect(num(w.ret)).toBeCloseTo(-0.01, 12);
    expect(num(w.gap)).toBeCloseTo(0.02, 12);
    expect(num(w.highRet)).toBeCloseTo(0.04, 12);
    expect(num(w.lowRet)).toBeCloseTo(-0.02, 12);
    expect(num(w.closeInRange)).toBeCloseTo(1 / 6, 12);
    // Ties resolve to the earliest date.
    expect(w.highDate).toBe('2025-11-24');
    expect(w.highWeekday).toBe('Mon');
    expect(w.lowDate).toBe('2025-11-26');
    expect(w.lowWeekday).toBe('Wed');
    expect(w.days.map((d) => +num(d.rel).toFixed(4))).toEqual([0.03, 0, -0.01, -0.01]);
    expect(num(w.intensity)).toBeCloseTo(-0.01 / 0.09, 12);
  });

  it('computes relative volume and the sigma move from the 20 sessions before the week', () => {
    const w = byLabel(weeks, '2025-11-28');
    expect(num(w.relVolume)).toBeCloseTo(1.3, 12);
    expect(w.flags.highVolume).toBe(true);
    // Twenty prior daily returns alternate +1% and 100/101 - 1.
    const rets = Array.from({ length: 20 }, (_, k) => (k % 2 === 0 ? 0.01 : 100 / 101 - 1));
    const m = rets.reduce((a, b) => a + b, 0) / 20;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / 19);
    expect(num(w.sigma)).toBeCloseTo(-0.01 / (sd * Math.sqrt(4)), 10);
  });

  it('reports a flat range week instead of a close in range value', () => {
    const w = byLabel(weeks, '2025-12-12');
    expect(num(w.ret)).toBe(0);
    expect(isNa(w.closeInRange) && w.closeInRange.code).toBe('flat-range');
    expect(w.counted).toBe(true);
  });

  it('groups the New Year week under its Friday label year with actual dates', () => {
    const w = byLabel(weeks, '2026-01-02');
    expect(w.labelYear).toBe(2026);
    expect(w.labelMonth).toBe(1);
    expect(w.ordinalInMonth).toBe(1);
    expect(w.days.map((d) => d.date)).toEqual(['2025-12-29', '2025-12-30', '2025-12-31', '2026-01-02']);
    expect(w.base).toEqual({ date: '2025-12-26', close: 101 });
    expect(num(w.ret)).toBeCloseTo(105 / 101 - 1, 12);
    // Year extremes use the calendar year of the last session: only 2026-01-02 so far.
    expect(isNa(w.closeVsYearHigh)).toBe(false);
    if (!isNa(w.closeVsYearHigh) && !isNa(w.closeVsYearLow)) {
      expect(w.closeVsYearHigh).toEqual({ value: 0, date: '2026-01-02', close: 105, coverageFrom: '2026-01-02' });
      expect(w.closeVsYearLow.value).toBe(0);
    }
  });

  it('computes year closing extremes through the week and SMA50 availability', () => {
    const w = byLabel(weeks, '2025-12-19');
    if (isNa(w.closeVsYearHigh) || isNa(w.closeVsYearLow)) throw new Error('expected extremes');
    expect(w.closeVsYearHigh.close).toBe(104);
    expect(w.closeVsYearHigh.date).toBe('2025-12-05'); // earliest of the tied 104 closes
    expect(w.closeVsYearHigh.value).toBeCloseTo(97 / 104 - 1, 12);
    expect(w.closeVsYearLow.close).toBe(97);
    expect(w.closeVsYearLow.date).toBe('2025-12-19');
    expect(w.closeVsYearHigh.coverageFrom).toBe('2025-10-20');
    expect(isNa(w.closeVsSma50) && w.closeVsSma50.code).toBe('insufficient-history'); // 44 sessions
    const later = byLabel(weeks, '2026-01-09');
    const closes = scenario().filter((b) => b.date <= '2026-01-09').map((b) => b.close);
    expect(closes.length).toBeGreaterThanOrEqual(50);
    const sma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
    expect(num(later.closeVsSma50)).toBeCloseTo(110 / sma50 - 1, 12);
  });

  it('marks the week still trading at the cutoff as partial and keeps it out of counts', () => {
    const w = byLabel(weeks, '2026-01-16');
    expect(w.status).toBe('partial');
    expect(w.counted).toBe(false);
    expect(w.tradedDays).toBe(3);
    expect(num(w.ret)).toBeCloseTo(113 / 110 - 1, 12); // shown as week to date, never counted
    const prev = byLabel(weeks, '2026-01-09');
    expect(isNa(prev.nextWeekRet) && prev.nextWeekRet.code).toBe('not-matured');
  });

  it('gives the first week no base and does not count it', () => {
    const w = byLabel(weeks, '2025-10-24');
    expect(w.status).toBe('complete');
    expect(isNa(w.base) && w.base.code).toBe('missing-base-close');
    expect(isNa(w.ret)).toBe(true);
    expect(w.counted).toBe(false);
  });

  it('fills the following week return only when that week is complete', () => {
    expect(num(byLabel(weeks, '2025-12-19').nextWeekRet)).toBeCloseTo(101 / 97 - 1, 12);
    expect(num(byLabel(weeks, '2025-12-05').nextWeekRet)).toBe(0);
  });
});

describe('missing data', () => {
  it('reports a missing prior close and never bridges it', () => {
    const bars = scenario().filter((b) => b.date !== '2025-12-12');
    const weeks = buildWeeks({ bars });
    const gapWeek = byLabel(weeks, '2025-12-12');
    expect(gapWeek.status).toBe('missing');
    expect(gapWeek.statusNote).toContain('2025-12-12');
    expect(gapWeek.counted).toBe(false);
    expect(isNa(gapWeek.ret) && gapWeek.ret.code).toBe('missing-session');
    const next = byLabel(weeks, '2025-12-19');
    expect(isNa(next.base) && next.base.code).toBe('missing-session');
    expect(isNa(next.ret)).toBe(true);
    expect(next.counted).toBe(false);
    // The week before the gap has no valid next week return.
    const before = byLabel(weeks, '2025-12-05');
    expect(isNa(before.nextWeekRet) && before.nextWeekRet.code).toBe('missing-session');
    const board = weeklyBoard({ bars, year: 2025 });
    expect(board.summary.missingWeeks).toBe(1);
    expect(board.summary.completedWeeks).toBe(7);
  });

  it('treats an expected completed session the series lacks as missing', () => {
    const bars = scenario().filter((b) => b.date <= '2026-01-08');
    const asData = byLabel(buildWeeks({ bars }), '2026-01-09');
    expect(asData.status).toBe('partial');
    const byClock = byLabel(buildWeeks({ bars, expectedThrough: '2026-01-09' }), '2026-01-09');
    expect(byClock.status).toBe('missing');
    expect(byClock.counted).toBe(false);
  });

  it('marks a week where history starts mid week as a listing partial', () => {
    const bars = scenario().filter((b) => b.date >= '2025-10-22');
    const w = byLabel(buildWeeks({ bars }), '2025-10-24');
    expect(w.status).toBe('partial');
    expect(w.statusNote).toContain('History starts');
  });

  it('discloses when fewer than 21 price anchors precede the week', () => {
    const bars = scenario().filter((b) => b.date >= '2025-11-10');
    const w = byLabel(buildWeeks({ bars }), '2025-11-28');
    expect(isNa(w.sigma) && w.sigma.code).toBe('insufficient-history');
    expect(isNa(w.relVolume) && w.relVolume.code).toBe('insufficient-history');
    expect(num(w.ret)).toBeCloseTo(-0.01, 12);
    // Exactly 20 sessions before the week: volume ratio works, sigma still lacks the 21st anchor.
    const bars20 = scenario().filter((b) => b.date >= '2025-10-27');
    const w20 = byLabel(buildWeeks({ bars: bars20 }), '2025-11-28');
    expect(isNum(w20.relVolume)).toBe(true);
    expect(isNa(w20.sigma) && w20.sigma.code).toBe('insufficient-history');
  });

  it('handles unverified volume', () => {
    const bars = scenario().map((b) => (b.date === '2025-11-25' ? { ...b, volume: null } : b));
    const w = byLabel(buildWeeks({ bars }), '2025-11-28');
    expect(isNa(w.relVolume) && w.relVolume.code).toBe('no-coverage');
    expect(w.flags.highVolume).toBe(false);
  });
});

describe('SPY comparison', () => {
  it('uses the same sessions and reports excess in percentage points', () => {
    const weeks = buildWeeks({ bars: scenario(), spy: spyBars() });
    const w = byLabel(weeks, '2025-11-28');
    expect(num(w.spyRet)).toBeCloseTo(428 / 424 - 1, 12);
    expect(num(w.excess)).toBeCloseTo(-0.01 - (428 / 424 - 1), 12);
  });

  it('is unavailable without a comparison series', () => {
    const board = weeklyBoard({ bars: scenario(), year: 2025 });
    expect(board.comparisonProvided).toBe(false);
    expect(isNa(board.summary.spy) && board.summary.spy.code).toBe('no-coverage');
    expect(board.spyView.available).toBe(false);
    expect(board.weeks.every((w) => isNa(w.spyRet))).toBe(true);
  });

  it('withholds the comparison for a week where coverage differs', () => {
    const spy = spyBars().filter((b) => b.date !== '2025-12-03');
    const board = weeklyBoard({ bars: scenario(), spy, year: 2025 });
    const w = byLabel(board.weeks, '2025-12-05');
    expect(isNa(w.excess) && w.excess.code).toBe('no-coverage');
    expect(w.counted).toBe(true);
    expect(board.spyView.excluded).toBe(1);
    expect(board.spyView.bars.length).toBe(8);
    if (isNa(board.summary.spy)) throw new Error('expected spy summary');
    expect(board.summary.spy.comparableWeeks).toBe(8);
    const sum = board.spyView.bars.reduce((a, b) => a + b.excess, 0);
    expect(board.summary.spy.runningExcess).toBeCloseTo(sum, 12);
    expect(board.spyView.bars[board.spyView.bars.length - 1]!.running).toBeCloseTo(sum, 12);
  });
});

describe('earnings markers', () => {
  it('has none when no events are supplied', () => {
    const board = weeklyBoard({ bars: scenario(), year: 2025 });
    expect(board.earningsProvided).toBe(false);
    expect(board.weeks.some((w) => w.flags.earnings)).toBe(false);
    expect(board.tells.earningsWeeks).toEqual([]);
  });

  it('maps the report and the reacting session to their weeks', () => {
    const earnings = [ev('2025-12-03', 'amc'), ev('2025-12-19', 'amc'), ev('2025-11-25', 'unknown'), ev('2026-01-06', 'bmo')];
    const weeks = buildWeeks({ bars: scenario(), earnings });
    const wed = byLabel(weeks, '2025-12-05');
    expect(wed.flags.earnings).toBe(true);
    expect(wed.earnings[0]).toMatchObject({ reportDate: '2025-12-03', reactionDate: '2025-12-04', reportInWeek: true, reactionInWeek: true });
    expect(wed.earnings[0]!.detail).toContain('after the close');
    // A Friday after the close report reacts the next week. Both weeks carry the marker.
    const fri = byLabel(weeks, '2025-12-19');
    expect(fri.earnings[0]).toMatchObject({ reportInWeek: true, reactionInWeek: false, reactionDate: '2025-12-22' });
    const after = byLabel(weeks, '2025-12-26');
    expect(after.earnings[0]).toMatchObject({ reportInWeek: false, reactionInWeek: true });
    const unknown = byLabel(weeks, '2025-11-28');
    expect(unknown.earnings[0]!.reactionDate).toBeNull();
    expect(unknown.earnings[0]!.detail).toContain('unknown time');
    expect(byLabel(weeks, '2026-01-09').earnings[0]).toMatchObject({ reactionDate: '2026-01-06', reactionInWeek: true });
    expect(byLabel(weeks, '2025-12-12').flags.earnings).toBe(false);
    const board = weeklyBoard({ bars: scenario(), earnings, year: 2025 });
    expect(board.tells.earningsWeeks.map((w) => w.label)).toEqual(['2025-11-28', '2025-12-05', '2025-12-19', '2025-12-26']);
    expect(board.tells.earningsWeeks[1]!.range).toBeCloseTo(104 / 99 - 1, 12);
  });
});

describe('board for a year', () => {
  const board = weeklyBoard({ bars: scenario(), spy: spyBars(), year: 2025 });

  it('counts only complete weeks with a base', () => {
    const s = board.summary;
    expect(board.weeks.map((w) => w.label)).toEqual([
      '2025-10-24', '2025-10-31', '2025-11-07', '2025-11-14', '2025-11-21', '2025-11-28', '2025-12-05', '2025-12-12', '2025-12-19', '2025-12-26',
    ]);
    expect(s.completedWeeks).toBe(9);
    expect(s.upWeeks).toBe(4);
    expect(s.downWeeks).toBe(4);
    expect(s.flatWeeks).toBe(1);
    expect(s.uncountedCompleteWeeks).toBe(1);
    expect(s.upRate).toMatchObject({ hits: 4, n: 9 });
    expect(num(s.medianReturn)).toBe(0);
    if (isNa(s.best) || isNa(s.worst) || isNa(s.lastWeek)) throw new Error('expected summary values');
    expect(s.best).toEqual({ label: '2025-12-05', ret: 104 / 99 - 1 });
    expect(s.worst).toEqual({ label: '2025-12-19', ret: 97 / 104 - 1 });
    expect(s.lastWeek.label).toBe('2025-12-26');
    expect(board.availableYears).toEqual([2025, 2026]);
  });

  it('summarizes weekly lows', () => {
    // Lows versus prior close, sorted: -7.69%, -3.09%, -2%, -0.99%, -0.99%, 0 x 4.
    const lows = [96 / 104 - 1, 94 / 97 - 1, -0.02, 100 / 101 - 1, 100 / 101 - 1, 0, 0, 0, 0];
    expect(num(board.summary.medianWeekLow)).toBeCloseTo(100 / 101 - 1, 12);
    // Type 7 quantile at 0.2 over 9 values: position 1.6.
    expect(num(board.summary.stayedAbove80)).toBeCloseTo(lows[1]! + 0.6 * (lows[2]! - lows[1]!), 12);
    expect(board.dip.n).toBe(9);
    expect(board.dip.below).toEqual([{ level: -0.03, count: 2 }, { level: -0.05, count: 1 }, { level: -0.08, count: 0 }]);
    expect(board.dip.dipped5).toBe(1);
    expect(board.dip.dipped5Recovered).toBe(0);
    expect(board.dip.points.filter((p) => p.isLast).map((p) => p.label)).toEqual(['2025-12-26']);
    expect(board.dip.points.find((p) => p.label === '2025-12-26')!.outcome).toBe('up');
  });

  it('builds the current streak with its chained move', () => {
    const st = board.summary.currentStreak;
    if (isNa(st)) throw new Error('expected a streak');
    expect(st).toMatchObject({ direction: 'up', length: 1, fromDate: '2025-12-19', fromClose: 97, toDate: '2025-12-26', toClose: 101, isLongestOfYear: true });
    expect(st.chained).toBeCloseTo(101 / 97 - 1, 12);
    expect(board.summary.longestDown!.length).toBe(2); // Nov 21 and Nov 28
    expect(board.summary.longestDown!.fromDate).toBe('2025-11-14');
    expect(board.summary.longestDown!.chained).toBeCloseTo(99 / 101 - 1, 12);
  });

  it('extends the current streak across the year boundary and flags it', () => {
    const b26 = weeklyBoard({ bars: scenario(), year: 2026 });
    expect(b26.summary.completedWeeks).toBe(2);
    expect(b26.summary.partialWeeks).toBe(1);
    const st = b26.summary.currentStreak;
    if (isNa(st)) throw new Error('expected a streak');
    expect(st).toMatchObject({ direction: 'up', length: 3, fromDate: '2025-12-19', fromClose: 97, toClose: 110, startedBeforeYear: true });
    expect(st.chained).toBeCloseTo(110 / 97 - 1, 12);
    // Default year is the calendar year of the last bar.
    expect(weeklyBoard({ bars: scenario() }).year).toBe(2026);
  });

  it('lays weeks out by month and Friday ordinal with row and column aggregates', () => {
    const nov = board.grid.rows[10]!;
    expect(nov.cells.map((c) => c?.label ?? null)).toEqual(['2025-11-07', '2025-11-14', '2025-11-21', '2025-11-28', null]);
    const oct = board.grid.rows[9]!;
    expect(oct.cells.map((c) => c?.label ?? null)).toEqual([null, null, null, '2025-10-24', '2025-10-31']);
    const dec = board.grid.rows[11]!;
    expect(dec.counted).toBe(4);
    expect(dec.upWeeks).toBe(2);
    expect(dec.highest).toEqual({ ret: 104 / 99 - 1, label: '2025-12-05' });
    expect(dec.deepestDip).toEqual({ lowRet: 96 / 104 - 1, label: '2025-12-19' });
    expect(isNa(board.grid.rows[0]!.highest)).toBe(true);
    const f4 = board.grid.footer[3]!;
    expect(f4.weeksCounted).toBe(2); // Nov 28 and Dec 26. Oct 24 has no base.
    expect(num(f4.median)).toBeCloseTo((-0.01 + (101 / 97 - 1)) / 2, 12);
    expect(f4.winRate).toMatchObject({ hits: 1, n: 2 });
    expect(board.grid.footer.reduce((a, f) => a + f.weeksCounted, 0)).toBe(9);
  });

  it('finds the tells', () => {
    const t = board.tells;
    expect(t.weakCloseDownWeeks).toMatchObject({ count: 4, ofDownWeeks: 4 });
    expect(t.strongCloseUpWeeks).toMatchObject({ count: 4, ofUpWeeks: 4 });
    expect(t.gapUpClosedRed).toEqual({ count: 1, ofGapUps: 1, labels: ['2025-11-28'] });
    expect(t.gapDownClosedGreen).toEqual({ count: 1, ofGapDowns: 1, labels: ['2025-12-26'] });
    expect(t.thursdayFridayLows).toMatchObject({ hits: 1, n: 9 });
    expect(t.bigDown.weeks.map((w) => w.label)).toEqual(['2025-12-19']);
    expect(t.bigDown.matured).toBe(1);
    expect(t.bigDown.nextWeek!.median).toBeCloseTo(101 / 97 - 1, 12);
    expect(t.bigDown.nextWeekUp).toMatchObject({ hits: 1, n: 1 });
    expect(t.bigUp.weeks.map((w) => w.label)).toEqual(['2025-12-05']);
    expect(t.bigUp.nextWeekUp).toMatchObject({ hits: 0, n: 1 });
    expect(t.mostUnusual[0]!.label).toBe('2025-12-19');
    expect(t.longestUp!.length).toBe(1);
  });

  it('aggregates by weekday from actual daily returns', () => {
    const d = board.dayOfWeek;
    expect(d.map((r) => r.name)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
    expect(d[0]!.n).toBe(9); // the first Monday has no earlier close
    expect(d[3]!.n).toBe(8); // two Thursday holidays
    expect(d.reduce((a, r) => a + r.highsSet, 0)).toBe(9);
    expect(d.map((r) => r.lowsSet)).toEqual([7, 0, 1, 0, 1]);
    expect(d[4]!.winRate!.n).toBe(d[4]!.n);
  });

  it('exposes range chart points and a sortable table with nulls last', () => {
    const p = board.rangeChart.find((x) => x.label === '2025-11-28')!;
    expect(p).toMatchObject({ month: 11, counted: true, earnings: false });
    expect(p.lowRet).toBeCloseTo(-0.02, 12);
    expect(p.highRet).toBeCloseTo(0.04, 12);
    expect(board.rangeChart[0]!.closeRet).toBeNull();
    const asc = sortWeeklyRows(board.table, 'ret', 'asc');
    const desc = sortWeeklyRows(board.table, 'ret', 'desc');
    expect(asc[0]!.label).toBe('2025-12-19');
    expect(desc[0]!.label).toBe('2025-12-05');
    expect(asc[asc.length - 1]!.ret).toBeNull();
    expect(desc[desc.length - 1]!.ret).toBeNull();
    // Stable ties: the two +1% weeks keep chronological order in both directions.
    const ties = (rows: typeof asc) => rows.filter((r) => r.label === '2025-10-31' || r.label === '2025-11-14').map((r) => r.label);
    expect(ties(asc)).toEqual(['2025-10-31', '2025-11-14']);
    expect(ties(desc)).toEqual(['2025-10-31', '2025-11-14']);
    expect(sortWeeklyRows(board.table, 'label', 'desc')[0]!.label).toBe('2025-12-26');
  });

  it('returns the acceptance figures', () => {
    const a = weeklyAcceptanceSummary(weeklyBoard({ bars: scenario(), year: 2025, asOf: '2025-12-19', earnings: [ev('2025-12-03', 'amc')] }));
    expect(a.completedWeeks).toBe(8);
    expect(a.upWeeks).toBe(3);
    expect(a.best).toEqual({ label: '2025-12-05', ret: 104 / 99 - 1 });
    expect(a.worst).toEqual({ label: '2025-12-19', ret: 97 / 104 - 1 });
    expect(a.lastWeek).toMatchObject({ label: '2025-12-19', close: 97, yearHighDate: '2025-12-05', yearLowDate: '2025-12-19', yearLowClose: 97 });
    expect(a.lastWeek!.lowRet).toBeCloseTo(96 / 104 - 1, 12);
    expect(a.lastWeek!.closeVsYearHigh).toBeCloseTo(97 / 104 - 1, 12);
    expect(a.losingStreak).toMatchObject({ length: 1, fromDate: '2025-12-12', fromClose: 104 });
    expect(a.losingStreak!.chained).toBeCloseTo(97 / 104 - 1, 12);
    expect(a.earningsWeeks).toEqual([{ label: '2025-12-05', ret: 104 / 99 - 1 }]);
  });
});

describe('streaks', () => {
  it('chains a multi week losing streak from the close before it', () => {
    // Weekly closes after a base of 100: up, then five losing weeks.
    const fridays: Record<string, number> = {
      '2025-10-31': 110, '2025-11-07': 105, '2025-11-14': 100, '2025-11-21': 96, '2025-11-28': 92, '2025-12-05': 88,
    };
    let level = 100;
    const bars = mkBars('2025-10-20', '2025-12-05', (_i, date) => {
      if (fridays[date] !== undefined) level = fridays[date]!;
      return level;
    });
    const board = weeklyBoard({ bars, year: 2025 });
    const st = board.summary.currentStreak;
    if (isNa(st)) throw new Error('expected a streak');
    expect(st).toMatchObject({ direction: 'down', length: 5, fromDate: '2025-10-31', fromClose: 110, firstLabel: '2025-11-07', lastLabel: '2025-12-05', isLongestOfYear: true });
    expect(st.chained).toBeCloseTo(88 / 110 - 1, 12);
    expect(weeklyAcceptanceSummary(board).losingStreak).toMatchObject({ length: 5, fromDate: '2025-10-31' });
    expect(weekStreaks(board.weeks).map((s) => `${s.direction}${s.length}`)).toEqual(['up1', 'down5']);
  });

  it('withholds the current streak when a later week is missing data', () => {
    const bars = scenario().filter((b) => b.date !== '2025-12-24' && b.date <= '2025-12-26');
    const board = weeklyBoard({ bars, year: 2025 });
    expect(isNa(board.summary.currentStreak) && board.summary.currentStreak.code).toBe('missing-session');
  });
});

describe('year boundaries and ISO week 53', () => {
  it('keeps actual dates for the week that straddles New Year in an ISO 53 week year', () => {
    const bars = mkBars('2020-12-14', '2021-01-15', (i) => 100 + i);
    const weeks = buildWeeks({ bars });
    const w = byLabel(weeks, '2021-01-01');
    expect(w).toMatchObject({ key: '2020-12-28', labelYear: 2021, labelMonth: 1, ordinalInMonth: 1, isoYear: 2020, isoWeek: 53, tradedDays: 4, expectedDays: 4, lastSession: '2020-12-31', status: 'complete', counted: true });
    if (isNa(w.closeVsYearHigh)) throw new Error('expected extremes');
    expect(w.closeVsYearHigh.date).toBe('2020-12-31'); // calendar year of the last session is 2020
    const b21 = weeklyBoard({ bars, year: 2021 });
    expect(b21.weeks.map((x) => x.label)).toEqual(['2021-01-01', '2021-01-08', '2021-01-15']);
    expect(b21.summary.completedWeeks).toBe(3);
    const b20 = weeklyBoard({ bars, year: 2020 });
    expect(b20.weeks.map((x) => x.label)).toEqual(['2020-12-18', '2020-12-25']);
    expect(b20.summary.completedWeeks).toBe(1); // the first week has no base
    const season = weeklySeasonality(weeks);
    const w53 = season.byIsoWeek.find((b) => b.key === 53)!;
    expect(w53.n).toBe(1);
    expect(w53.sparse).toBe(true);
    expect(w53.labels).toEqual(['2021-01-01']);
  });
});

describe('invariants', () => {
  const strip = (w: WeekRecord) => ({ ...w });

  it('appending future rows does not change earlier weeks', () => {
    const full = buildWeeks({ bars: scenario(), spy: spyBars() });
    const cutBars = scenario().filter((b) => b.date <= '2025-12-19');
    const cut = buildWeeks({ bars: cutBars, spy: spyBars() });
    const viaAsOf = buildWeeks({ bars: scenario(), spy: spyBars(), asOf: '2025-12-19' });
    const earlier = (ws: WeekRecord[]) => ws.filter((w) => w.label <= '2025-12-12').map(strip);
    expect(earlier(cut)).toEqual(earlier(full));
    expect(viaAsOf).toEqual(cut);
    // The last cut week differs only in its outcome field.
    const a = byLabel(cut, '2025-12-19');
    const b = byLabel(full, '2025-12-19');
    expect({ ...a, nextWeekRet: null }).toEqual({ ...b, nextWeekRet: null });
    expect(isNa(a.nextWeekRet)).toBe(true);
  });

  it('scaling every price by one factor does not change returns or states', () => {
    const k = 3.7;
    const scaled = scenario().map((b) => ({ ...b, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k }));
    const a = weeklyBoard({ bars: scenario(), spy: spyBars(), year: 2025 });
    const b = weeklyBoard({ bars: scaled, spy: spyBars(), year: 2025 });
    expect(b.summary.completedWeeks).toBe(a.summary.completedWeeks);
    expect(b.summary.upWeeks).toBe(a.summary.upWeeks);
    for (let i = 0; i < a.table.length; i++) {
      const x = a.table[i]!;
      const y = b.table[i]!;
      expect(y.status).toBe(x.status);
      expect(y.highWeekday).toBe(x.highWeekday);
      expect(y.lowWeekday).toBe(x.lowWeekday);
      for (const key of ['ret', 'gap', 'lowRet', 'highRet', 'closeInRange', 'relVolume', 'sigma', 'excess', 'closeVsYearHigh', 'closeVsYearLow', 'nextWeekRet'] as const) {
        if (x[key] === null) expect(y[key]).toBeNull();
        else expect(y[key]!).toBeCloseTo(x[key]!, 10);
      }
    }
  });
});

describe('synthetic fixture smoke', () => {
  const inst = (s: string) => INSTRUMENTS.find((i) => i.symbol === s)!;

  it('builds a full 2026 board for a long history', () => {
    const nvda = syntheticDaily(inst('NVDA'));
    const spy = syntheticDaily(inst('SPY'));
    const e = syntheticEarnings(inst('NVDA'));
    const input = { bars: nvda.bars, spy: spy.bars, earnings: Array.isArray(e) ? e : null };
    const all = buildWeeks(input);
    const board = weeklyBoard(input, all);
    expect(board.year).toBe(2026);
    expect(board.asOf).toBe('2026-11-13');
    expect(board.summary.completedWeeks).toBe(46); // Fridays Jan 2 through Nov 13
    expect(board.summary.partialWeeks + board.summary.missingWeeks).toBe(0);
    expect(board.summary.upWeeks + board.summary.downWeeks + board.summary.flatWeeks).toBe(46);
    expect(board.weeks.every((w) => isNum(w.sigma) && isNum(w.relVolume) && isNum(w.excess))).toBe(true);
    expect(board.tells.earningsWeeks.length).toBeGreaterThanOrEqual(3);
    expect(board.grid.rows.flatMap((r) => r.cells).filter(Boolean).length).toBe(46);
    expect(isNa(board.summary.currentStreak)).toBe(false);
    const prior = weeklyBoard({ ...input, year: 2019 }, all);
    expect(prior.summary.completedWeeks).toBe(52);
    const season = weeklySeasonality(all);
    expect(season.yearsCovered.length).toBe(11);
    expect(season.byOrdinalInMonth.map((b) => b.key)).toEqual([1, 2, 3, 4, 5]);
    expect(season.byOrdinalInMonth.reduce((a, b) => a + b.n, 0)).toBe(season.weeksCounted);
    expect(season.byIsoWeek.reduce((a, b) => a + b.n, 0)).toBe(season.weeksCounted);
    expect(season.byIsoWeek.find((b) => b.key === 20)!.sparse).toBe(false);
    expect(season.byIsoWeek.find((b) => b.key === 53)!.sparse).toBe(true);
    expect(season.byOrdinalInMonth[0]!.winRate!.lo).toBeLessThan(season.byOrdinalInMonth[0]!.winRate!.rate);
  });

  it('handles a short history that starts at a basis boundary', () => {
    const sndk = syntheticDaily(inst('SNDK'));
    const spy = syntheticDaily(inst('SPY'));
    const all = buildWeeks({ bars: sndk.bars, spy: spy.bars });
    expect(all[0]!.label).toBe('2025-02-28');
    expect(all[0]!.counted).toBe(false); // no close before the first week
    const b25 = weeklyBoard({ bars: sndk.bars, spy: spy.bars, year: 2025 }, all);
    expect(b25.availableYears).toEqual([2025, 2026]);
    expect(b25.summary.uncountedCompleteWeeks).toBe(1);
    const first = b25.weeks[1]!;
    expect(first.counted).toBe(true);
    expect(isNa(first.sigma) && first.sigma.code).toBe('insufficient-history');
    expect(weeklyAcceptanceSummary(weeklyBoard({ bars: sndk.bars, spy: spy.bars }, all)).completedWeeks).toBe(46);
  });
});
