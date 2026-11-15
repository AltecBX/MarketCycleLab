import { describe, expect, it } from 'vitest';
import {
  buildRuns, classifySessions, completedRunHistogram, completedRuns, durationStats, exitOdds, maOverview, MA_WINDOWS, runLengthHistogram, runSurvival,
  searchRuns, smaAt, sortRuns, studyAfterAge, type MaRun,
} from './maRuns';
import { isNa, type Bar } from './core/types';
import { validateBars } from './core/series';
import { INSTRUMENTS } from '../data/fixtures/universe';
import { seriesFromCloses, syntheticDaily } from '../data/fixtures/synthetic';

/**
 * With a 2 session average, close < SMA exactly when the close fell from the prior close, so a
 * below run is a streak of down closes and distance is (c - prev) / (c + prev). Easy to check by hand.
 */
const s2 = (closes: number[]) => buildRuns(seriesFromCloses(closes), 2);

// Below run lengths 1, 2, 2, 3 completed, then a live below run of age 2.
const KM_CLOSES = [100, 101, 100, 101, 100, 99, 100, 99, 98, 99, 98, 97, 96, 97, 96, 95];

describe('run construction', () => {
  it('handles a one day cross', () => {
    const set = s2([100, 101, 102, 101, 102, 103]);
    expect(set.runs.map((r) => [r.side, r.startKind, r.status, r.length])).toEqual([
      ['above', 'leading', 'completed', 2],
      ['below', 'cross', 'completed', 1],
      ['above', 'cross', 'active', 2],
    ]);
    const below = set.runs[1]!;
    expect(below.confirmed).toBe(true);
    expect(below.exitKind).toBe('cross');
    expect(below.entryDate).toBe(below.lastDate);
    expect(below.moveToExit).toBeCloseTo(102 / 101 - 1, 12);
    expect(below.farthestDistance).toBeCloseTo(101 / 101.5 - 1, 12);
    expect(below.extremeFromEntry).toBe(0);
    expect(below.extremeDatesCoincide).toBe(true);
    // The leading run is observed but is not a confirmed completed crossing.
    expect(set.runs[0]!.confirmed).toBe(false);
  });

  it('treats an exact touch as a boundary that belongs to neither side', () => {
    const closes = [100, 101, 102, 102, 103, 104, 103];
    const set = s2(closes);
    expect(set.runs.map((r) => [r.side, r.startKind, r.length, r.exitKind])).toEqual([
      ['above', 'leading', 2, 'touch'],
      ['above', 'touch', 2, 'cross'],
      ['below', 'cross', 1, null],
    ]);
    expect(classifySessions(seriesFromCloses(closes), 2).state[3]).toBe('touch');
    // Same side sessions plus the touch day plus the first unavailable day account for every bar.
    expect(set.runs.reduce((a, r) => a + r.length, 0)).toBe(closes.length - 2);
    const carry = buildRuns(seriesFromCloses(closes), 2, { touchPolicy: 'carry' });
    expect(carry.runs.map((r) => [r.side, r.length])).toEqual([['above', 5], ['below', 1]]);
    const onTouch = s2([100, 101, 101]);
    expect(!isNa(onTouch.current) && onTouch.current.side).toBe('touch');
    expect(!isNa(onTouch.current) && onTouch.current.age).toBe(0);
  });

  it('labels a series that starts already below as leading and keeps it out of completed statistics', () => {
    const bars = seriesFromCloses([100, 99, 98, 99]);
    const set = buildRuns(bars, 2);
    expect(set.runs[0]).toMatchObject({ side: 'below', startKind: 'leading', length: 2, status: 'completed', confirmed: false });
    expect(durationStats(set, 'below')).toBeNull();
    expect(set.counts.leading).toBe(1);
    const optIn = buildRuns(bars, 2, { includeUnverified: true });
    expect(durationStats(optIn, 'below')?.n).toBe(1);
  });

  it('never produces a 200 session average from 199 sessions', () => {
    const closes = Array.from({ length: 199 }, (_, i) => 100 + i * 0.1);
    const bars199 = seriesFromCloses(closes);
    const set = buildRuns(bars199, 200);
    expect(set.runs).toEqual([]);
    expect(isNa(set.current) && set.current.code).toBe('insufficient-history');
    expect(isNa(smaAt(bars199, 198, 200))).toBe(true);
    const bars200 = seriesFromCloses([...closes, 130]);
    const ok = buildRuns(bars200, 200);
    expect(!isNa(ok.current) && ok.current.side).toBe('above');
    expect(!isNa(ok.current) && ok.current.age).toBe(1);
    const m = smaAt(bars200, 199, 200);
    expect(m).toBeCloseTo((closes.reduce((a, b) => a + b, 0) + 130) / 200, 9);
  });

  it('does not bridge a missing session inside the window', () => {
    const full = seriesFromCloses([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    const gapped = full.filter((_, i) => i !== 6);
    const cls = classifySessions(gapped, 5);
    expect(cls.state.map((s) => (s === 'unavailable' ? 0 : 1))).toEqual([0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1]);
    const set = buildRuns(gapped, 5);
    expect(set.runs.map((r) => [r.startKind, r.status, r.exitKind, r.length])).toEqual([
      ['leading', 'interrupted', 'gap', 2],
      ['after-gap', 'active', null, 1],
    ]);
    expect(isNa(set.runs[0]!.moveToExit)).toBe(true);
    expect(set.counts.afterGap).toBe(1);
    const cut = buildRuns(gapped.slice(0, 9), 5);
    expect(isNa(cut.current) && cut.current.code).toBe('missing-session');
    // A corrupt close breaks the window the same way.
    const corrupt: Bar[] = full.map((b, i) => (i === 6 ? { ...b, close: NaN } : b));
    const c2 = buildRuns(corrupt, 5);
    expect(c2.runs[0]!.status).toBe('interrupted');
    expect(isNa(buildRuns(corrupt.slice(0, 9), 5).current)).toBe(true);
  });

  it('dates the two extremes separately when they differ', () => {
    const bars = seriesFromCloses([100, 104, 94, 93, 92, 95]);
    const run = buildRuns(bars, 2).runs.find((r) => r.side === 'below')!;
    expect(run.length).toBe(3);
    expect(run.farthestDistance).toBeCloseTo(-10 / 198, 12);
    expect(run.farthestDistanceDate).toBe(bars[2]!.date);
    expect(run.extremeFromEntry).toBeCloseTo(92 / 94 - 1, 12);
    expect(run.extremeFromEntryDate).toBe(bars[4]!.date);
    expect(run.extremeDatesCoincide).toBe(false);
    expect(run.exitDate).toBe(bars[5]!.date);
    expect(run.moveToExit).toBeCloseTo(95 / 94 - 1, 12);
    // Above runs mirror the sign convention.
    const up = buildRuns(seriesFromCloses([100, 99, 110, 111, 112, 111]), 2).runs.find((r) => r.side === 'above')!;
    expect(up.farthestDistance).toBeCloseTo(11 / 209, 12);
    expect(up.extremeFromEntry).toBeCloseTo(112 / 110 - 1, 12);
    expect(up.extremeDatesCoincide).toBe(false);
  });

  it('resolves tied extremes to the earliest date', () => {
    const bars = seriesFromCloses([100, 100, 100, 80, 70, 72, 70, 75]);
    const set = buildRuns(bars, 3);
    const run = set.runs[0]!;
    expect(run).toMatchObject({ side: 'below', startKind: 'touch', length: 4, exitKind: 'cross', confirmed: true });
    expect(run.extremeFromEntry).toBeCloseTo(-0.125, 12);
    expect(run.extremeFromEntryDate).toBe(bars[4]!.date);
    expect(run.farthestDistance).toBeCloseTo(70 / (250 / 3) - 1, 12);
    expect(run.farthestDistanceDate).toBe(bars[4]!.date);
    expect(run.extremeDatesCoincide).toBe(true);
  });

  it('keeps the live run active when its low was reached on the last bar', () => {
    const bars = seriesFromCloses([100, 101, 100, 99, 97]);
    const set = buildRuns(bars, 2);
    const run = set.runs[set.runs.length - 1]!;
    expect(run).toMatchObject({ side: 'below', status: 'active', length: 3, exitKind: null, exitDate: null, exitClose: null, confirmed: false });
    expect(isNa(run.moveToExit) && run.moveToExit.code).toBe('not-matured');
    expect(run.extremeFromEntry).toBeCloseTo(-0.03, 12);
    expect(run.extremeFromEntryDate).toBe(bars[4]!.date);
    expect(run.farthestDistanceDate).toBe(bars[4]!.date);
    expect(!isNa(set.current) && set.current.age).toBe(3);
    expect(!isNa(set.current) && set.current.distance).toBeCloseTo(-2 / 196, 12);
    // The live run is not a completed sample.
    expect(completedRuns(set, 'below')).toEqual([]);
  });
});

describe('age study and survival', () => {
  const set = s2(KM_CLOSES);

  it('builds the expected sample', () => {
    expect(completedRuns(set, 'below').map((r) => r.length)).toEqual([1, 2, 2, 3]);
    const live = set.runs[set.runs.length - 1]!;
    expect(live).toMatchObject({ side: 'below', status: 'active', length: 2 });
    const st = durationStats(set, 'below')!;
    expect(st).toMatchObject({ n: 4, median: 2, mean: 2, longest: 3 });
  });

  it('counts sessions to exit after day a as L + 1 - a', () => {
    const a3 = studyAfterAge(set, { side: 'below', age: 3 });
    expect(isNa(a3)).toBe(false);
    if (isNa(a3)) return;
    expect(a3.reached).toBe(1);
    expect(a3.notReached).toBe(3);
    expect(a3.rows[0]).toMatchObject({ length: 3, sessionsToExit: 1 });
    expect(a3.warning).toMatch(/Small sample/);
    const a2 = studyAfterAge(set, { side: 'current', age: 2 });
    if (isNa(a2)) throw new Error('expected a study');
    expect(a2.side).toBe('below');
    expect(a2.rows.map((r) => r.sessionsToExit)).toEqual([1, 1, 2]);
    expect(a2.median).toBe(1);
    expect(a2.active).toEqual({ age: 2, entryDate: set.runs[set.runs.length - 1]!.entryDate });
    const a9 = studyAfterAge(set, { side: 'below', age: 9 });
    expect(!isNa(a9) && a9.reached).toBe(0);
    expect(isNa(studyAfterAge(set, { side: 'below', age: 0 }))).toBe(true);
  });

  it('right censors the live run in Kaplan Meier', () => {
    const sv = runSurvival(set, 'below');
    expect(sv.events).toBe(4);
    expect(sv.censored).toBe(1);
    expect(sv.steps.map((s) => [s.t, s.atRisk, s.events, +s.survival.toFixed(6)])).toEqual([
      [1, 5, 1, 0.8],
      [2, 3, 2, 0.266667],
      [3, 1, 1, 0],
    ]);
    // A live run of one session says nothing about run length.
    const one = runSurvival(s2([100, 101, 100, 101, 100]), 'below');
    expect(one.uninformative).toBe(1);
    expect(one.censored).toBe(0);
  });

  it('gives conditional exit odds only when the gate passes', () => {
    const open = exitOdds(set, { side: 'current', minAtRisk: 1 });
    if (isNa(open)) throw new Error('expected odds');
    expect(open.age).toBe(2);
    expect(open.atRisk).toBe(3);
    expect(open.status).toBe('valid');
    expect(open.rows.map((r) => r.within)).toEqual([1, 3, 5]);
    expect(open.rows[0]!.probability).toBeCloseTo(2 / 3, 12);
    expect(open.rows[1]!.probability).toBeCloseTo(1, 12);
    expect(open.rows[0]!.completedOnly).toMatchObject({ hits: 2, n: 3 });
    expect(open.typicalRemaining).toBe(1);
    const gated = exitOdds(set, { side: 'current' });
    if (isNa(gated)) throw new Error('expected odds');
    expect(gated.status).toBe('insufficient-evidence');
    expect(isNa(gated.rows[0]!.probability) && gated.rows[0]!.probability.code).toBe('sample-too-small');
    expect(gated.rows[0]!.completedOnly).toMatchObject({ hits: 2, n: 3 });
    expect(isNa(gated.typicalRemaining)).toBe(true);
    expect(gated.note).toMatch(/withheld/);
    // No live run on the requested side and no age given.
    expect(isNa(exitOdds(set, { side: 'above' }))).toBe(true);
  });

  it('reports unresolved interrupted runs with conservative bounds', () => {
    const bars = seriesFromCloses(KM_CLOSES).filter((_, i) => i !== 6);
    const g = buildRuns(bars, 2);
    expect(completedRuns(g, 'below').map((r) => r.length)).toEqual([1, 3]);
    expect(g.runs.filter((r) => r.status === 'interrupted').map((r) => r.length)).toEqual([2]);
    expect(g.counts.afterGap).toBe(1);
    const o = exitOdds(g, { side: 'below', age: 2, windows: [1], minAtRisk: 1 });
    if (isNa(o)) throw new Error('expected odds');
    expect(o.atRisk).toBe(1);
    expect(o.rows[0]!.unresolved).toBe(1);
    expect(o.rows[0]!.bounds).toEqual({ lo: 0, hi: 0.5 });
    expect(o.rows[0]!.probability).toBeCloseTo(0, 12);
    expect(o.survival.steps.map((s) => [s.t, s.atRisk, +s.survival.toFixed(4)])).toEqual([
      [1, 4, 0.75],
      [3, 1, 0],
    ]);
  });

  it('withholds an estimate beyond the observed support', () => {
    // Completed below runs 1 and 2, then a live run of age 4: the curve never reaches zero.
    const g = s2([100, 101, 100, 101, 100, 99, 100, 99, 98, 97, 96]);
    const o = exitOdds(g, { side: 'current', windows: [1], minAtRisk: 1 });
    if (isNa(o)) throw new Error('expected odds');
    expect(o.age).toBe(4);
    expect(o.status).toBe('insufficient-evidence');
    const o2 = exitOdds(g, { side: 'below', age: 2, windows: [1, 5], minAtRisk: 1 });
    if (isNa(o2)) throw new Error('expected odds');
    expect(o2.rows[0]!.probability).toBeCloseTo(0.5, 12);
    expect(isNa(o2.rows[1]!.probability) && o2.rows[1]!.probability.code).toBe('no-coverage');
  });
});

describe('histogram', () => {
  it('uses one bin per session count for short spans', () => {
    const bins = runLengthHistogram([1, 1, 2, 3, 5]);
    expect(bins.map((b) => b.label)).toEqual(['1', '2', '3', '4', '5']);
    expect(bins.map((b) => b.count)).toEqual([2, 1, 1, 0, 1]);
    expect(runLengthHistogram([])).toEqual([]);
    expect(runLengthHistogram([7, 7])).toEqual([{ lo: 7, hi: 7, label: '7', count: 2 }]);
  });
  it('uses about eight even bins for wide spans, with labels that never share a boundary', () => {
    const lengths = [1, 1, 2, 3, 40];
    const bins = runLengthHistogram(lengths);
    expect(bins.length).toBe(8);
    expect(bins[0]!.label).toBe('1 to 5');
    expect(bins[7]!.label).toBe('36 to 40');
    expect(bins.reduce((a, b) => a + b.count, 0)).toBe(lengths.length);
    for (let i = 1; i < bins.length; i++) expect(bins[i]!.lo).toBe(bins[i - 1]!.hi + 1);
    for (let span = 13; span <= 400; span++) {
      const b = runLengthHistogram([1, span]);
      expect(b.length).toBeGreaterThanOrEqual(7);
      expect(b.length).toBeLessThanOrEqual(12);
      expect(new Set(b.map((x) => x.hi - x.lo)).size).toBe(1);
      expect(b.reduce((a, x) => a + x.count, 0)).toBe(2);
      expect(b[b.length - 1]!.hi).toBeGreaterThanOrEqual(span);
    }
  });
});

describe('sorting and search', () => {
  const set = s2(KM_CLOSES);
  it('sorts with missing values last in both directions and stable ties', () => {
    const byMoveDesc = sortRuns(set.runs, 'moveToExit', 'desc');
    const byMoveAsc = sortRuns(set.runs, 'moveToExit', 'asc');
    expect(byMoveDesc[byMoveDesc.length - 1]!.status).toBe('active');
    expect(byMoveAsc[byMoveAsc.length - 1]!.status).toBe('active');
    const byLen = sortRuns(completedRuns(set, 'below'), 'length', 'desc');
    expect(byLen.map((r) => r.length)).toEqual([3, 2, 2, 1]);
    expect(byLen[1]!.entryDate < byLen[2]!.entryDate).toBe(true);
    expect(sortRuns(set.runs, 'entryDate', 'asc').map((r) => r.entryIndex)).toEqual(set.runs.map((r) => r.entryIndex));
  });
  it('filters by side, status, length, dates and free text', () => {
    expect(searchRuns(set.runs, { side: 'below', status: 'completed', minLength: 2 }).map((r) => r.length)).toEqual([2, 2, 3]);
    expect(searchRuns(set.runs, { query: 'active below' }).length).toBe(1);
    const target = set.runs[3]!;
    expect(searchRuns(set.runs, { query: target.entryDate }).some((r) => r === target)).toBe(true);
    expect(searchRuns(set.runs, { from: target.entryDate, to: target.lastDate }).includes(target)).toBe(true);
    expect(searchRuns(set.runs, { to: '2000-01-01' })).toEqual([]);
  });
});

describe('invariants', () => {
  const nvda = syntheticDaily(INSTRUMENTS.find((i) => i.symbol === 'NVDA')!).bars;
  const tail = nvda.slice(-900);

  it('appending future rows does not change earlier as-of results', () => {
    for (const w of [5, 50, 200]) {
      const cut = 600;
      const early = buildRuns(tail.slice(0, cut), w);
      const full = buildRuns(tail, w);
      const settled = early.runs.filter((r) => r.status === 'completed');
      expect(settled.length).toBeGreaterThan(0);
      expect(full.runs.slice(0, settled.length)).toEqual(settled);
      const a = classifySessions(tail.slice(0, cut), w);
      const b = classifySessions(tail, w);
      expect(b.state.slice(0, cut)).toEqual(a.state);
      // The live run at the cut keeps its entry and its extremes so far can only extend.
      const live = early.runs[early.runs.length - 1]!;
      const later = full.runs[settled.length]!;
      expect(later.entryDate).toBe(live.entryDate);
      expect(later.length).toBeGreaterThanOrEqual(live.length);
    }
  });

  it('scaling every price by one factor does not change states, lengths or distances', () => {
    const k = 3.7;
    const scaled: Bar[] = tail.map((b) => ({ ...b, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k }));
    for (const w of MA_WINDOWS) {
      const a = buildRuns(tail, w);
      const b = buildRuns(scaled, w);
      const key = (r: MaRun) => [r.side, r.startKind, r.status, r.length, r.entryDate, r.exitDate, r.farthestDistanceDate, r.extremeFromEntryDate];
      expect(b.runs.map(key)).toEqual(a.runs.map(key));
      for (let i = 0; i < a.runs.length; i++) {
        expect(b.runs[i]!.farthestDistance).toBeCloseTo(a.runs[i]!.farthestDistance, 9);
        expect(b.runs[i]!.extremeFromEntry).toBeCloseTo(a.runs[i]!.extremeFromEntry, 9);
      }
    }
  });
});

describe('fixture smoke test', () => {
  for (const sym of ['NVDA', 'SNDK']) {
    it(`covers all six averages for ${sym}`, () => {
      const bars = syntheticDaily(INSTRUMENTS.find((i) => i.symbol === sym)!).bars;
      expect(validateBars(bars)).toEqual([]);
      const overview = maOverview(bars);
      expect(overview.map((c) => c.window)).toEqual([...MA_WINDOWS]);
      for (const cell of overview) {
        expect(isNa(cell.current)).toBe(false);
        if (isNa(cell.current)) continue;
        expect(cell.current.date).toBe(bars[bars.length - 1]!.date);
        const set = buildRuns(bars, cell.window);
        const cls = classifySessions(bars, cell.window);
        const sameSide = set.runs.reduce((a, r) => a + r.length, 0);
        const other = cls.state.filter((s) => s === 'touch' || s === 'unavailable').length;
        expect(sameSide + other).toBe(bars.length);
        expect(set.counts.active + (cell.current.side === 'touch' ? 1 : 0)).toBe(1);
        expect(set.counts.leading).toBeLessThanOrEqual(1);
        for (const side of ['above', 'below'] as const) {
          const hist = completedRunHistogram(set, side);
          expect(hist.reduce((a, b) => a + b.count, 0)).toBe(completedRuns(set, side).length);
          for (const r of completedRuns(set, side)) {
            expect(side === 'below' ? r.farthestDistance < 0 : r.farthestDistance > 0).toBe(true);
            expect(side === 'below' ? r.extremeFromEntry <= 0 : r.extremeFromEntry >= 0).toBe(true);
          }
        }
        const odds = exitOdds(set, { side: 'current' });
        if (!isNa(odds)) {
          for (const row of odds.rows) {
            if (typeof row.probability === 'number') {
              expect(row.probability).toBeGreaterThanOrEqual(0);
              expect(row.probability).toBeLessThanOrEqual(1);
            }
          }
          const study = studyAfterAge(set, { side: 'current', age: odds.age });
          expect(isNa(study)).toBe(false);
        }
      }
    });
  }
});
