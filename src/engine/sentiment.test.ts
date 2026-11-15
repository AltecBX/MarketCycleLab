import { describe, expect, it } from 'vitest';
import { nextSession, sessionOnOrBefore } from './core/calendar';
import { rsiWilder } from './core/indicators';
import { minusMonths } from './core/series';
import type { Bar } from './core/types';
import {
  SENTIMENT_DEFAULTS, ZONE_LEGEND, buildOverlay, clusterStudy, confirmedSwings, extremeClusters, swingsKnownAsOf, swingsWithScores, zoneOf, type ScorePoint,
} from './sentiment';
import { seriesFromCloses, syntheticDaily } from '../data/fixtures/synthetic';
import { INSTRUMENTS } from '../data/fixtures/universe';

const scoresFor = (bars: readonly Bar[], values: readonly number[]): ScorePoint[] => values.map((score, i) => ({ date: bars[i]!.date, score }));

describe('zones', () => {
  it('puts each boundary in the less extreme zone', () => {
    expect(zoneOf(0)).toBe('extreme-fear');
    expect(zoneOf(24.99)).toBe('extreme-fear');
    expect(zoneOf(25)).toBe('fear');
    expect(zoneOf(44.99)).toBe('fear');
    expect(zoneOf(45)).toBe('neutral');
    expect(zoneOf(55)).toBe('neutral');
    expect(zoneOf(55.01)).toBe('greed');
    expect(zoneOf(75)).toBe('greed');
    expect(zoneOf(75.01)).toBe('extreme-greed');
    expect(zoneOf(100)).toBe('extreme-greed');
  });
  it('publishes a legend and its provenance', () => {
    expect(ZONE_LEGEND.map((z) => z.zone)).toEqual(['extreme-fear', 'fear', 'neutral', 'greed', 'extreme-greed']);
    expect(SENTIMENT_DEFAULTS.thresholds).toEqual([25, 45, 55, 75]);
    expect(SENTIMENT_DEFAULTS.boundaryProvenance).toBe('proposed');
  });
});

describe('overlay', () => {
  const bars = seriesFromCloses([100, 101, 102, 103, 104, 105], '2026-11-02');
  it('joins on the same date and reports what was dropped', () => {
    const scores: ScorePoint[] = [
      { date: bars[0]!.date, score: 50 },
      { date: bars[1]!.date, score: 40 },
      { date: '2026-11-07', score: 10 }, // Saturday, no bar
      { date: bars[3]!.date, score: 30 },
      { date: bars[3]!.date, score: 31 }, // duplicate date
      { date: bars[4]!.date, score: 140 }, // out of range
    ];
    const o = buildOverlay(scores, bars, 'Test archive', 'Test benchmark');
    expect(o.rows.map((r) => r.date)).toEqual([bars[0]!.date, bars[1]!.date, bars[3]!.date]);
    expect(o.scoresWithoutBar).toBe(1);
    expect(o.invalidScores).toBe(2);
    expect(o.barsWithoutScore).toBe(1); // bars[2] sits inside the score range with no score
    expect(o.rows.map((r) => r.priorKnown)).toEqual([false, true, false]);
    expect(o.scoreLabel).toBe('Test archive');
    expect(o.benchmarkLabel).toBe('Test benchmark');
  });
});

describe('confirmed swings', () => {
  const closes = [100, 110, 104, 99, 95, 96, 101, 108, 120, 113];
  const bars = seriesFromCloses(closes, '2026-10-01');
  const dates = bars.map((b) => b.date);
  it('dates the turn and the later confirmation separately', () => {
    const r = confirmedSwings(closes, dates);
    expect(r.swings.map((s) => [s.kind, s.turnIndex, s.confirmIndex])).toEqual([
      ['low', 0, 1],
      ['high', 1, 2],
      ['low', 4, 6],
      ['high', 8, 9],
    ]);
    expect(r.swings[0]!.leading).toBe(true);
    expect(r.swings[1]!.leading).toBe(false);
    expect(r.swings[2]!.reversal).toBeCloseTo(101 / 95 - 1, 12);
    expect(r.swings.every((s) => s.confirmIndex > s.turnIndex)).toBe(true);
    expect(r.pending).toMatchObject({ kind: 'low', index: 9, moveSoFar: 0 });
  });
  it('never backdates a confirmation', () => {
    const full = confirmedSwings(closes, dates).swings;
    for (let k = 1; k <= closes.length; k++) {
      const prefix = confirmedSwings(closes.slice(0, k), dates.slice(0, k)).swings;
      expect(prefix).toEqual(full.filter((s) => s.confirmIndex < k));
    }
    // On session 5 the low of session 4 has not been confirmed. It is pending, not a swing.
    const atFive = confirmedSwings(closes.slice(0, 6), dates.slice(0, 6));
    expect(atFive.swings.length).toBe(2);
    expect(atFive.pending).toMatchObject({ kind: 'low', index: 4 });
    expect(swingsKnownAsOf(full, dates[5]!).length).toBe(2);
    expect(swingsKnownAsOf(full, dates[6]!).length).toBe(3);
  });
  it('is unchanged by a price scale factor and keeps the earliest tie', () => {
    const scaled = confirmedSwings(closes.map((c) => c * 2.5), dates).swings;
    expect(scaled.map((s) => [s.kind, s.turnIndex, s.confirmIndex])).toEqual(confirmedSwings(closes, dates).swings.map((s) => [s.kind, s.turnIndex, s.confirmIndex]));
    const tie = [100, 110, 110, 104];
    const t = confirmedSwings(tie, dates.slice(0, 4)).swings;
    expect(t[t.length - 1]).toMatchObject({ kind: 'high', turnIndex: 1 });
  });
  it('keeps the same session score and labels a nearby alternative', () => {
    const scores = scoresFor(bars, [50, 70, 60, 40, 20, 12, 30, 50, 80, 85]);
    const o = buildOverlay(scores, bars, 'Test archive', 'Test benchmark');
    const { swings } = swingsWithScores(o);
    const low = swings.find((s) => s.kind === 'low' && s.turnIndex === 4)!;
    expect(low.sameSessionScore).toBe(20);
    expect(low.sameSessionZone).toBe('extreme-fear');
    expect(low.nearbyAlternative).toEqual({ date: dates[5], score: 12, zone: 'extreme-fear', sessionsFromTurn: 1 });
    const high = swings.find((s) => s.kind === 'high' && s.turnIndex === 8)!;
    expect(high.sameSessionScore).toBe(80);
    expect(high.nearbyAlternative).toMatchObject({ date: dates[9], score: 85 });
    const firstHigh = swings.find((s) => s.kind === 'high' && s.turnIndex === 1)!;
    expect(firstHigh.sameSessionScore).toBe(70);
  });
});

describe('extreme clusters', () => {
  const bars = seriesFromCloses(Array.from({ length: 12 }, (_, i) => 100 + i), '2026-11-02');
  it('anchors at the first entry after a known prior state', () => {
    const o = buildOverlay(scoresFor(bars, [50, 20, 18, 30, 22, 80, 78, 50]), bars, 's', 'b');
    const fear = extremeClusters(o, 'fear');
    expect(fear.clusters.map((c) => [c.anchorDate, c.sessions, c.extremeScore])).toEqual([
      [bars[1]!.date, 2, 18],
      [bars[4]!.date, 1, 22],
    ]);
    expect(fear.clusters[0]!.extremeDate).toBe(bars[2]!.date);
    expect(fear.unknownPriorExcluded).toBe(0);
    const greed = extremeClusters(o, 'greed');
    expect(greed.clusters.map((c) => [c.anchorDate, c.sessions])).toEqual([[bars[5]!.date, 2]]);
  });
  it('excludes a stretch whose prior state is unknown', () => {
    const leading = buildOverlay(scoresFor(bars, [20, 22, 50, 10]), bars, 's', 'b');
    const r = extremeClusters(leading, 'fear');
    expect(r.unknownPriorExcluded).toBe(1);
    expect(r.clusters.map((c) => c.anchorDate)).toEqual([bars[3]!.date]);
    expect(r.clusters[0]!.open).toBe(true);
    const gapped: ScorePoint[] = [
      { date: bars[0]!.date, score: 50 },
      { date: bars[2]!.date, score: 10 }, // the session before has no score
      { date: bars[3]!.date, score: 12 },
    ];
    const g = extremeClusters(buildOverlay(gapped, bars, 's', 'b'), 'fear');
    expect(g.clusters).toEqual([]);
    expect(g.unknownPriorExcluded).toBe(1);
  });
});

describe('cluster outcomes', () => {
  const closes = Array.from({ length: 300 }, (_, i) => 100 + i * 0.5);
  const bars = seriesFromCloses(closes, '2025-01-02').map((b, i) => ({ ...b, open: b.open + (i % 2 ? 0.1 : 0), high: Math.max(b.high, b.open + 0.1) }));
  const scores = bars.map((b, i) => ({ date: b.date, score: i === 10 || i === 11 || i === 15 || i === 290 ? 15 : 50 }));
  const o = buildOverlay(scores, bars, 'Test archive', 'Test benchmark');
  it('enters at the next session and aligns calendar month horizons to sessions', () => {
    const s = clusterStudy(o, bars, 'fear', { horizonsMonths: [1, 12] });
    expect(s.clusters.map((c) => c.anchorDate)).toEqual([bars[10]!.date, bars[15]!.date, bars[290]!.date]);
    const one = s.horizons[0]!;
    expect(one.months).toBe(1);
    expect(one.n).toBe(1);
    expect(one.overlapDropped).toBe(1);
    expect(one.notMatured).toBe(1);
    const oc = one.outcomes[0]!;
    expect(oc.entryDate).toBe(nextSession(bars[10]!.date));
    expect(oc.entryPrice).toBe(bars[11]!.open);
    expect(oc.endDate).toBe(sessionOnOrBefore(minusMonths(oc.entryDate, -1)));
    const endBar = bars.find((b) => b.date === oc.endDate)!;
    expect(oc.ret).toBeCloseTo(endBar.close / bars[11]!.open - 1, 12);
    expect(oc.maxDrawdown).toBeCloseTo(bars[11]!.close / bars[11]!.open - 1, 12);
    expect(one.win).toMatchObject({ hits: 1, n: 1 });
    expect(s.horizons[1]!.n).toBe(1);
    expect(s.scoreLabel).toBe('Test archive');
    expect(s.entry).toBe('next-open');
  });
  it('supports a signal close entry and keeps fear and greed separate', () => {
    const s = clusterStudy(o, bars, 'fear', { entry: 'signal-close', horizonsMonths: [1] });
    expect(s.horizons[0]!.outcomes[0]!.entryPrice).toBe(bars[10]!.close);
    expect(s.horizons[0]!.outcomes[0]!.entryDate).toBe(bars[10]!.date);
    const g = clusterStudy(o, bars, 'greed');
    expect(g.clusters).toEqual([]);
    expect(g.horizons.every((h) => h.n === 0 && h.win === null && h.returns === null)).toBe(true);
  });
  it('does not change earlier outcomes when later rows arrive', () => {
    const cut = 200;
    const early = clusterStudy(buildOverlay(scores.slice(0, cut), bars.slice(0, cut), 's', 'b'), bars.slice(0, cut), 'fear', { horizonsMonths: [1] });
    const full = clusterStudy(o, bars, 'fear', { horizonsMonths: [1] });
    expect(early.horizons[0]!.outcomes).toEqual(full.horizons[0]!.outcomes.filter((x) => x.endDate <= bars[cut - 1]!.date));
  });
});

describe('fixture smoke test', () => {
  it('runs the study on a synthetic benchmark with a labeled proxy score', () => {
    const spy = syntheticDaily(INSTRUMENTS.find((i) => i.symbol === 'SPY')!);
    const rsi = rsiWilder(spy.bars.map((b) => b.close));
    const scores: ScorePoint[] = [];
    spy.bars.forEach((b, i) => {
      if (rsi[i] !== null) scores.push({ date: b.date, score: rsi[i]! });
    });
    const o = buildOverlay(scores, spy.bars, 'Synthetic proxy score', 'SPY synthetic fixture');
    expect(o.rows.length).toBe(scores.length);
    expect(o.barsWithoutScore).toBe(0);
    const { swings } = swingsWithScores(o);
    expect(swings.length).toBeGreaterThan(10);
    for (let i = 1; i < swings.length; i++) {
      expect(swings[i]!.kind).not.toBe(swings[i - 1]!.kind);
      expect(swings[i]!.confirmIndex).toBeGreaterThan(swings[i]!.turnIndex);
    }
    for (const kind of ['fear', 'greed'] as const) {
      const s = clusterStudy(o, spy.bars, kind);
      expect(s.horizons.map((h) => h.months)).toEqual([1, 3, 6, 12]);
      for (const h of s.horizons) {
        expect(h.n + h.notMatured + h.overlapDropped + h.unavailable).toBe(s.clusters.length);
        if (h.win) expect(h.win.n).toBe(h.n);
      }
    }
  });
});
