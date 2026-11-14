import { describe, expect, it } from 'vitest';
import { nextSession } from './core/calendar';
import { mulberry32 } from './core/stats';
import { isNa, type Bar, type EarningsEvent, type Maybe, type Proportion } from './core/types';
import { INSTRUMENTS } from '../data/fixtures/universe';
import { fixtureSource, seriesFromCloses, syntheticDaily, syntheticEarnings } from '../data/fixtures/synthetic';
import {
  DECLINE_DEFAULTS, EXHAUSTION_PATTERNS, declineHorizonStats, declineHorizonTable, declineMeasure, detectPattern, drawdownPositions, exposurePath,
  exposureScenarios, findDeclines, followThrough, groupEpisodes, lastingBottom, lastingBottomStats, moveRarity, recoveryStats, sessionMeasures, studyPattern,
} from './declines';

type Row = [open: number, high: number, low: number, close: number, volume?: number | null];

/** Bars on consecutive exchange sessions from explicit OHLC rows. */
const mk = (rows: readonly Row[], start = '2024-01-02'): Bar[] => {
  let d = start;
  return rows.map(([open, high, low, close, volume], k) => {
    if (k > 0) d = nextSession(d);
    return { date: d, open, high, low, close, volume: volume === undefined ? 1_000_000 : volume };
  });
};

const flat = (n: number, px = 100): Row[] => Array.from({ length: n }, () => [px, px, px, px] as Row);

const num = <T,>(v: Maybe<T>): T => {
  if (isNa(v)) throw new Error('expected a value');
  return v;
};

const rate = (p: Maybe<Proportion>): Proportion => num(p);

const noise = (n: number, seed: number, start = 100): Bar[] => {
  const rnd = mulberry32(seed);
  const rows: Row[] = [];
  let prev = start;
  for (let i = 0; i < n; i++) {
    const open = prev * (1 + (rnd() - 0.5) * 0.02);
    const close = open * (1 + (rnd() - 0.5) * 0.08);
    const high = Math.max(open, close) * (1 + rnd() * 0.01);
    const low = Math.min(open, close) * (1 - rnd() * 0.01);
    rows.push([open, high, low, close, 1_000_000 * (0.5 + rnd() * 3)]);
    prev = close;
  }
  return mk(rows, '2015-01-02');
};

describe('decline measures', () => {
  const bars = mk([
    [100, 100, 100, 100],
    [98, 99, 90, 92],
    [92, 92, 87, 87.4], // drop from the open, no gap
    [83.9, 85, 83.9, 84.5], // gap down that closes above its open
  ]);

  it('computes the four bases separately', () => {
    expect(num(declineMeasure(bars, 1, 'close-vs-prev-close'))).toBeCloseTo(-0.08, 12);
    expect(num(declineMeasure(bars, 1, 'close-vs-open'))).toBeCloseTo(92 / 98 - 1, 12);
    expect(num(declineMeasure(bars, 1, 'close-vs-high'))).toBeCloseTo(92 / 99 - 1, 12);
    expect(num(declineMeasure(bars, 1, 'low-vs-prev-close'))).toBeCloseTo(-0.1, 12);
    const m = num(sessionMeasures(bars, 1));
    expect(num(m.gap)).toBeCloseTo(-0.02, 12);
    expect(m.highToLow).toBeCloseTo(90 / 99 - 1, 12);
    expect(m.intradayOrder).toBe('indeterminate');
    expect(num(m.closeInRange)).toBeCloseTo(2 / 9, 12);
    expect(num(m.lowerWick)).toBeCloseTo(2 / 9, 12);
  });

  it('has no previous close basis on the first session and reports why', () => {
    const r = declineMeasure(bars, 0, 'close-vs-prev-close');
    expect(isNa(r) && r.code).toBe('missing-base-close');
    expect(num(declineMeasure(bars, 0, 'close-vs-open'))).toBe(0);
    const flatDay = num(sessionMeasures(bars, 0));
    expect(isNa(flatDay.closeInRange) && flatDay.closeInRange.code).toBe('flat-range');
  });

  it('keeps a drop from the open distinct from a gap down', () => {
    // Session 2: no gap, 5% from the open. Session 3: 4% gap down, closes above its open.
    expect(num(num(sessionMeasures(bars, 2)).gap)).toBeCloseTo(0, 12);
    const fromOpen = findDeclines(bars, { threshold: 0.03, basis: 'close-vs-open' }).occurrences.map((o) => o.index);
    const closeToClose = findDeclines(bars, { threshold: 0.03, basis: 'close-vs-prev-close' }).occurrences.map((o) => o.index);
    expect(fromOpen).toEqual([1, 2]);
    expect(closeToClose).toEqual([1, 2, 3]);
  });

  it('ranks a move against earlier sessions only', () => {
    const closes = [100, 99, 101, 97, 98, 93.1];
    const b = seriesFromCloses(closes);
    const r = num(moveRarity(b, 5, 'close-vs-prev-close'));
    expect(r.measure).toBeCloseTo(-0.05, 12);
    expect(r.priorEligible).toBe(4);
    expect(r.atLeastAsSevere.hits).toBe(0);
    expect(num(r.percentile)).toBe(0);
    const r3 = num(moveRarity(b, 3, 'close-vs-prev-close'));
    expect(r3.priorEligible).toBe(2);
    // Later rows never change an earlier ranking.
    expect(num(moveRarity(b.slice(0, 4), 3, 'close-vs-prev-close'))).toEqual(r3);
  });
});

describe('finding declines and episodes', () => {
  const closes = new Array(40).fill(100) as number[];
  // Qualifying 6% drops at 10, 12 and 20, with recoveries in between.
  const path = [...closes];
  const drop = (i: number) => {
    path[i] = path[i - 1]! * 0.94;
    path[i + 1] = path[i]! / 0.94;
  };
  drop(10);
  drop(12);
  drop(20);
  const bars = seriesFromCloses(path);

  it('counts exact qualifications against eligible history', () => {
    const s = findDeclines(bars, { threshold: 0.05 });
    expect(s.occurrences.map((o) => o.index)).toEqual([10, 12, 20]);
    expect(s.eligibleSessions).toBe(39);
    expect(s.rarity.hits).toBe(3);
    expect(s.rarity.n).toBe(39);
    expect(rate(s.rarity.proportion).rate).toBeCloseTo(3 / 39, 12);
    expect(s.from).toBe(bars[1]!.date);
    expect(s.to).toBe(bars[39]!.date);
    expect(s.basisLabel).toBe('Close vs previous close');
    expect(findDeclines(bars, { threshold: -0.05 }).occurrences.length).toBe(3);
  });

  it('groups repeated qualifying days into chronological episodes and keeps the raw list', () => {
    const s = findDeclines(bars, { threshold: 0.05 });
    expect(s.episodes.map((e) => e.indices)).toEqual([[10, 12], [20]]);
    expect(s.episodes[0]!.anchorDate).toBe(bars[10]!.date);
    expect(s.episodes[0]!.days).toBe(2);
    expect(s.occurrences.length).toBe(3);
    const tight = findDeclines(bars, { threshold: 0.05, episodeGapSessions: 1 });
    expect(tight.episodes.length).toBe(3);
    expect(groupEpisodes(bars, [3, 4, 30], [-0.06, -0.09, -0.05], 5)[0]!.worstMeasure).toBe(-0.09);
  });

  it('restricts the output period while earlier bars stay available as warm up', () => {
    const s = findDeclines(bars, { threshold: 0.05, from: bars[15]!.date });
    expect(s.occurrences.map((o) => o.index)).toEqual([20]);
    expect(s.eligibleSessions).toBe(25);
    expect(isNa(s.occurrences[0]!.relativeVolume)).toBe(false);
  });

  it('reports context known on the signal date and structured reasons when missing', () => {
    const market = seriesFromCloses(path.map((_, i) => 100 + i));
    const withGap = market.filter((_, i) => i !== 20);
    const s = findDeclines(bars, { threshold: 0.05, market: withGap });
    const e10 = s.occurrences[0]!;
    const m10 = num(e10.market);
    expect(num(m10.dayReturn)).toBeCloseTo(110 / 109 - 1, 12);
    expect(isNa(m10.aboveSma200) && m10.aboveSma200.code).toBe('insufficient-history');
    const e20 = s.occurrences[2]!;
    expect(isNa(e20.market) && e20.market.code).toBe('missing-session');
    expect(isNa(e20.sector) && e20.sector.code).toBe('no-coverage');
    expect(isNa(e10.stock.aboveSma50) && e10.stock.aboveSma50.code).toBe('insufficient-history');
  });

  it('keeps earnings, ordinary and unknown cohorts separate', () => {
    const ev = (date: string, time: EarningsEvent['time']): EarningsEvent => ({ instrumentId: 'x', symbol: 'X', date, time, status: 'confirmed', source: fixtureSource() });
    // After the close on session 9 reacts on session 10. Unknown timing on session 19 makes 19 and 20 unknown.
    const events = [ev(bars[5]!.date, 'bmo'), ev(bars[9]!.date, 'amc'), ev(bars[19]!.date, 'unknown')];
    const s = findDeclines(bars, { threshold: 0.05, earnings: events });
    expect(s.occurrences.map((o) => o.earnings)).toEqual(['earnings', 'ordinary', 'unknown']);
    expect(s.earningsCohorts).toEqual({ earnings: 1, ordinary: 1, unknown: 1 });
    expect(s.earningsCoverage).toBe(true);
    const none = findDeclines(bars, { threshold: 0.05 });
    expect(none.occurrences.every((o) => o.earnings === 'unknown')).toBe(true);
    expect(none.earningsCoverage).toBe(false);
    // Sessions before the first known event are unknown, not ordinary.
    const late = findDeclines(bars, { threshold: 0.05, earnings: [ev(bars[15]!.date, 'bmo')] });
    expect(late.occurrences.map((o) => o.earnings)).toEqual(['unknown', 'unknown', 'ordinary']);
  });
});

describe('horizon outcomes', () => {
  const bars = mk([
    [100, 100, 100, 100],
    [99, 99, 94, 95], // event: close 95, low 94
    [95, 100, 93.5, 96], // trades below the event low, intraday touch of +5%
    [96, 99, 96, 98.5], // closes above +3%
    [98, 98, 95.5, 96], // endpoint +1.05%
    [96, 96, 96, 96],
  ]);

  it('separates endpoint, close touch and intraday touch', () => {
    const s = declineHorizonStats(bars, [1], 3, { minCases: 1 });
    expect(s.n).toBe(1);
    expect(s.up).toBe(1);
    expect(num(s.returns).median).toBeCloseTo(96 / 95 - 1, 12);
    expect(num(s.worstClose).min).toBeCloseTo(96 / 95 - 1, 12);
    expect(num(s.worstLow).min).toBeCloseTo(93.5 / 95 - 1, 12);
    expect(num(s.troughLowOffset).median).toBe(1);
    expect(num(s.troughCloseOffset).median).toBe(1); // earliest of the tied lowest closes
    const [b3, b5, b10] = s.bounces;
    expect([b3!.touch.hits, b3!.close.hits, b3!.endpoint.hits]).toEqual([1, 1, 0]);
    expect([b5!.touch.hits, b5!.close.hits, b5!.endpoint.hits]).toEqual([1, 0, 0]);
    expect([b10!.touch.hits, b10!.close.hits, b10!.endpoint.hits]).toEqual([0, 0, 0]);
    expect(num(b5!.sessionsToTouch).median).toBe(1);
  });

  it('separates trading below the event low from closing below it', () => {
    const s = declineHorizonStats(bars, [1], 3, { minCases: 1 });
    expect(s.tradedBelowEventLow.hits).toBe(1);
    expect(s.closedBelowEventLow.hits).toBe(0);
    expect(s.eventLowHeld.hits).toBe(0);
  });

  it('keeps counts and withholds the rate under the sample gate', () => {
    const s = declineHorizonStats(bars, [1], 3);
    expect(s.positive.hits).toBe(1);
    expect(s.positive.n).toBe(1);
    expect(isNa(s.positive.proportion) && s.positive.proportion.code).toBe('sample-too-small');
    expect(rate(declineHorizonStats(bars, [1], 3, { minCases: 1 }).positive.proportion).rate).toBe(1);
  });

  it('uses horizon plus one spacing and reports every exclusion', () => {
    const b = seriesFromCloses(Array.from({ length: 40 }, (_, i) => 100 + (i % 3)));
    const s = declineHorizonStats(b, [10, 12, 16, 37], 5, { minCases: 1 });
    expect(s.spacing).toBe(6);
    expect(s.anchorsConsidered).toBe(4);
    expect(s.excludedOverlap).toBe(1); // 12 overlaps 10, 16 is exactly six sessions later
    expect(s.notMatured).toBe(1); // 37 + 5 is past the last bar
    expect(s.n).toBe(2);
    expect(s.anchorDates).toEqual([b[10]!.date, b[16]!.date]);
    const table = declineHorizonTable(b, [10, 12, 16, 37]);
    expect(table.map((t) => t.horizon)).toEqual([...DECLINE_DEFAULTS.spec.horizons]);
    expect(table[9]!.n).toBe(0);
    expect(isNa(table[9]!.returns)).toBe(true);
  });

  it('counts further consecutive lower closes with their own denominators', () => {
    const b = seriesFromCloses([100, 95, 94, 93, 96, 96, 96, 90, 91, 90, 89]);
    const f = followThrough(b, [1, 7], { minCases: 1 });
    expect([f.one.hits, f.one.n]).toEqual([1, 2]);
    expect([f.two.hits, f.two.n]).toEqual([1, 2]);
    expect([f.three.hits, f.three.n]).toEqual([0, 2]);
    expect([f.immediateBounce.hits, f.immediateBounce.n]).toEqual([1, 2]);
    // An anchor too close to the end leaves the three session denominator.
    const g = followThrough(b, [1, 8], { minCases: 1 });
    expect(g.two.n).toBe(2);
    expect(g.three.n).toBe(1);
  });
});

describe('time to recovery', () => {
  // Event closes: 95 at index 1 (recovers to 100 at offset 2), 90 at index 8 (never inside h), 85 at index 15 (data ends).
  const b = seriesFromCloses([100, 95, 97, 100, 100, 100, 100, 100, 90, 91, 92, 93, 94, 95, 96, 85, 86]);

  it('reports recovered, not recovered and censored cases with the right denominator', () => {
    const r = recoveryStats(b, [1, 8, 15], 4, { kind: 'previous-close' }, 'close', { minCases: 1 });
    expect(r.recovered).toBe(1);
    expect(r.notRecovered).toBe(1);
    expect(r.censored).toBe(1);
    expect([r.withinHorizon.hits, r.withinHorizon.n]).toEqual([1, 2]);
    expect(num(r.sessions).median).toBe(2);
    expect(r.cases.map((c) => c.sessions)).toEqual([2, null, null]);
    // Risk sets: 3 at session 1 (one censored), 2 at session 2 (one return), so S(2) = 0.5.
    expect(r.kmMedianSessions).toBe(2);
    // With no return at all the median is not identified.
    expect(recoveryStats(b, [8], 4, { kind: 'previous-close' }).kmMedianSessions).toBeNull();
    expect(r.targetLabel).toBe('Close before the event');
  });

  it('starts the study with cases below the level', () => {
    const up = seriesFromCloses([100, 101, 102, 103, 104, 105]);
    const r = recoveryStats(up, [1], 2, { kind: 'previous-close' });
    expect(r.alreadyAtTarget).toBe(1);
    expect(r.cases.length).toBe(0);
    const first = recoveryStats(up, [0], 2, { kind: 'previous-close' });
    expect(first.noTarget).toBe(1);
  });

  it('distinguishes an intraday return from a closing return', () => {
    const bars = mk([
      [100, 100, 100, 100],
      [100, 100, 94, 95],
      [95, 100.5, 95, 97],
      [97, 98, 96, 97],
      [97, 97, 97, 97],
    ]);
    expect(recoveryStats(bars, [1], 3, { kind: 'previous-close' }, 'intraday').recovered).toBe(1);
    expect(recoveryStats(bars, [1], 3, { kind: 'previous-close' }, 'close').recovered).toBe(0);
    expect(recoveryStats(bars, [1], 3, { kind: 'above-event-close', pct: 0.02 }, 'close').cases[0]!.sessions).toBe(1);
  });
});

describe('lasting bottom', () => {
  const event: Row[] = [[100, 100, 100, 100], [99, 99, 94, 95]];
  const opts = { horizon: 4, rebound: 0.05 };

  it('needs the low to hold for the whole window and a rebound inside it', () => {
    const bars = mk([...event, [95, 97, 94.5, 96], [96, 100, 96, 99.8], [99, 100, 97, 98], [98, 99, 97, 98], [98, 98, 98, 98]]);
    const r = num(lastingBottom(bars, 1, opts));
    expect(r.status).toBe('held-and-rebounded');
    expect(r.provisionalConfirmDate).toBe(bars[3]!.date);
    expect(r.finalConfirmDate).toBe(bars[5]!.date);
    expect(r.eventLow).toBe(94);
  });

  it('reports a broken low, a missing rebound and an unmatured window', () => {
    const broken = mk([...event, [95, 96, 93, 95.5], [95, 96, 95, 96], [96, 96, 96, 96], [96, 96, 96, 96]]);
    const b = num(lastingBottom(broken, 1, opts));
    expect(b.status).toBe('low-broken');
    expect(b.brokenDate).toBe(broken[2]!.date);
    const none = mk([...event, [95, 96, 95, 96], [96, 97, 95, 96], [96, 97, 95, 96], [96, 97, 95, 96]]);
    expect(num(lastingBottom(none, 1, opts)).status).toBe('no-rebound');
    const short = mk([...event, [95, 96, 95, 96], [96, 100, 96, 99.9]]);
    const s = num(lastingBottom(short, 1, opts));
    expect(s.status).toBe('not-matured');
    expect(s.finalConfirmDate).toBeNull();
    expect(s.provisionalConfirmDate).toBe(short[3]!.date);
  });

  it('marks a same bar break and intraday rebound as indeterminate', () => {
    const bars = mk([...event, [95, 100, 93, 99.8], [99, 99, 99, 99], [99, 99, 99, 99], [99, 99, 99, 99]]);
    expect(num(lastingBottom(bars, 1, { ...opts, reboundMode: 'intraday' })).status).toBe('indeterminate');
    // With a closing rebound the close comes after the low, so the break is known to be first.
    expect(num(lastingBottom(bars, 1, { ...opts, reboundMode: 'close' })).status).toBe('low-broken');
  });

  it('excludes unmatured and indeterminate cases from the held rate', () => {
    const bars = mk([...event, [95, 97, 94.5, 96], [96, 100, 96, 99.8], [99, 100, 97, 98], [98, 99, 97, 98], [98, 98, 98, 98], [98, 98, 92, 92.1], [92, 93, 92, 92.5]]);
    const s = lastingBottomStats(bars, [1, 7], { ...opts, minCases: 1 });
    expect(s.counts['held-and-rebounded']).toBe(1);
    expect(s.counts['not-matured']).toBe(1);
    expect([s.held.hits, s.held.n]).toEqual([1, 1]);
  });
});

describe('ex post drawdown position', () => {
  it('describes front, middle, late and after trough only for a recovered drawdown', () => {
    const b = seriesFromCloses([100, 97, 94, 91, 88, 85, 80, 90, 100, 96, 95]);
    const at = drawdownPositions(b);
    expect(num(at(1)).stage).toBe('front');
    expect(num(at(3)).stage).toBe('middle');
    expect(num(at(5)).stage).toBe('late');
    expect(num(at(6)).fractionToTrough).toBe(1);
    expect(num(at(7)).stage).toBe('after-trough');
    const p = num(at(2));
    expect(p.exPost).toBe(true);
    expect([p.peakDate, p.troughDate, p.recoveryDate]).toEqual([b[0]!.date, b[6]!.date, b[8]!.date]);
    expect(p.depth).toBeCloseTo(-0.2, 12);
    const peak = at(8);
    expect(isNa(peak) && peak.code).toBe('not-applicable');
    const open = at(9);
    expect(isNa(open) && open.code).toBe('not-matured');
  });
});

describe('selling exhaustion patterns', () => {
  it('names every pattern from the specification', () => {
    expect(EXHAUSTION_PATTERNS.map((p) => p.id)).toEqual([
      'more-down-1', 'more-down-2', 'more-down-3', 'immediate-bounce', 'gap-down-close-above-open', 'new-low-top-quartile-close',
      'gap-recovery-through-prev-close', 'multi-day-decline-reversal', 'volume-2x', 'lower-wick', 'rsi-oversold', 'retest-then-recovery', 'delayed-bottom',
    ]);
  });

  it('anchors a delayed pattern on its confirm date and measures outcomes from there', () => {
    const b = seriesFromCloses([100, 100, 94, 93, 92, 95, 96, 97, 98, 99, 100]);
    const occ = detectPattern(b, 'more-down-2', { threshold: 0.05 });
    expect(occ.length).toBe(1);
    expect([occ[0]!.eventIndex, occ[0]!.confirmIndex, occ[0]!.confirmLag]).toEqual([2, 4, 2]);
    expect(detectPattern(b, 'more-down-3', { threshold: 0.05 }).length).toBe(0);
    expect(detectPattern(b, 'immediate-bounce', { threshold: 0.05 }).length).toBe(0);
    const study = studyPattern(b, 'more-down-2', { threshold: 0.05, horizons: [3], minCases: 1 });
    const o = study.horizons[0]!.outcomes[0]!;
    expect(o.anchorIndex).toBe(4);
    expect(o.ret).toBeCloseTo(97 / 92 - 1, 12);
    // Before the confirm session exists the pattern is not usable.
    expect(detectPattern(b.slice(0, 4), 'more-down-2', { threshold: 0.05 }).length).toBe(0);
    expect(detectPattern(b.slice(0, 5), 'more-down-2', { threshold: 0.05 })).toEqual(occ);
  });

  it('detects gap, wick and volume patterns with the specification thresholds', () => {
    const rows: Row[] = [...flat(22), [96.5, 99, 96, 98, 1_000_000], [98, 98, 98, 98], [99, 99, 89, 93, 2_500_000], [93, 93, 93, 93], [92, 94.5, 91.5, 94]];
    const b = mk(rows);
    // Session 22: gap of 3.5% down, closes above its open.
    expect(detectPattern(b, 'gap-down-close-above-open', { threshold: 0.05 }).map((o) => o.eventIndex)).toEqual([22]);
    // Session 24: 5.1% decline on 2.5x volume with a lower wick of 0.4. Not a long wick.
    expect(detectPattern(b, 'volume-2x', { threshold: 0.05 }).map((o) => o.eventIndex)).toEqual([24]);
    expect(detectPattern(b, 'lower-wick', { threshold: 0.05 }).length).toBe(0);
    expect(detectPattern(b, 'lower-wick', { threshold: 0.05, params: { lowerWickMin: 0.4 } }).map((o) => o.eventIndex)).toEqual([24]);
    // Session 26: opens 1.1% below the previous close and closes above it.
    expect(detectPattern(b, 'gap-recovery-through-prev-close', { threshold: 0.05 }).map((o) => o.eventIndex)).toEqual([26]);
    // Session 24 trades below the prior 20 session low but closes at 0.4 of its range.
    expect(detectPattern(b, 'new-low-top-quartile-close', { threshold: 0.05 }).length).toBe(0);
    expect(detectPattern(b, 'new-low-top-quartile-close', { threshold: 0.05, params: { topQuartileClose: 0.4 } }).map((o) => o.confirmIndex)).toEqual([24]);
  });

  it('detects oversold RSI and a multi day decline reversal', () => {
    const closes: number[] = [100];
    for (let i = 1; i <= 20; i++) closes.push(closes[i - 1]! * 0.99);
    closes.push(closes[20]! * 0.94, closes[20]! * 0.95, closes[20]! * 0.95);
    const b = seriesFromCloses(closes);
    expect(detectPattern(b, 'rsi-oversold', { threshold: 0.05 }).map((o) => o.eventIndex)).toEqual([21]);
    const rev = detectPattern(b, 'multi-day-decline-reversal', { threshold: 0.05 });
    expect(rev.map((o) => [o.eventIndex, o.confirmIndex])).toEqual([[21, 22]]);
  });

  it('detects a retest followed by a recovery and a delayed bottom', () => {
    const retest = mk([
      [100, 100, 100, 100],
      [99, 99, 94, 94.5], // event, low 94
      [95, 97, 95, 96],
      [96, 96, 94.5, 95], // retest within 1% of the event low
      [95, 96.5, 95, 96],
      [96, 98.5, 96, 98], // +3.2% from the retest close
      [98, 98, 98, 98],
    ]);
    const r = detectPattern(retest, 'retest-then-recovery', { threshold: 0.05 });
    expect(r.map((o) => [o.eventIndex, o.confirmIndex])).toEqual([[1, 5]]);
    const failed = retest.map((x, i) => (i === 4 ? { ...x, low: 92 } : x));
    expect(detectPattern(failed, 'retest-then-recovery', { threshold: 0.05 }).length).toBe(0);

    const delayed = mk([
      [100, 100, 100, 100],
      [99, 99, 94, 94.5], // event, low 94
      [94, 95, 93, 94],
      [94, 94, 90, 91], // lower low inside the window
      [91, 94, 91, 93],
      [93, 96.5, 93, 96], // +5.5% from the later low close
      [96, 96, 96, 96],
    ]);
    const params = { delayedBottomWindow: 3, delayedBottomHold: 2 };
    const d = detectPattern(delayed, 'delayed-bottom', { threshold: 0.05, params });
    expect(d.map((o) => [o.eventIndex, o.confirmIndex])).toEqual([[1, 5]]);
    // Not usable until the hold period has completed.
    expect(detectPattern(delayed.slice(0, 5), 'delayed-bottom', { threshold: 0.05, params }).length).toBe(0);
    const undercut = delayed.map((x, i) => (i === 5 ? { ...x, low: 89 } : x));
    expect(detectPattern(undercut, 'delayed-bottom', { threshold: 0.05, params }).length).toBe(0);
  });
});

describe('hold, trim, add exposure', () => {
  const b = seriesFromCloses([100, 95, 90, 99, 104.5]);
  const a = { shares: 100, price: 50, trimFraction: 0.25, addShares: 20 };

  it('applies historical paths to explicit share exposures', () => {
    const s = declineHorizonStats(b, [1], 3, { minCases: 1 });
    const cmp = num(exposureScenarios(s.outcomes, a));
    expect(cmp.hypothetical).toBe(true);
    const [hold, trim, add] = cmp.scenarios;
    expect(hold!.perCase[0]!.endpoint).toBeCloseTo(100 * 50 * 0.1, 9);
    expect(trim!.perCase[0]!.endpoint).toBeCloseTo(75 * 50 * 0.1, 9);
    expect(add!.perCase[0]!.endpoint).toBeCloseTo(120 * 50 * 0.1, 9);
    expect(hold!.perCase[0]!.worstClose).toBeCloseTo(100 * 50 * (90 / 95 - 1), 9);
    expect(cmp.assumptions.join(' ')).toMatch(/No fees/);
    expect(JSON.stringify(cmp)).not.toMatch(/recommend/i);
  });

  it('builds a dollar path and rejects invalid assumptions', () => {
    const p = num(exposurePath(b, 1, 3, a));
    expect(p.map((x) => x.offset)).toEqual([0, 1, 2, 3]);
    expect(p[0]!.hold).toBe(0);
    expect(p[3]!.add).toBeCloseTo(120 * 50 * 0.1, 9);
    const bad = exposureScenarios([], { ...a, trimFraction: 1.5 });
    expect(isNa(bad) && bad.code).toBe('invalid-input');
  });
});

describe('invariants', () => {
  const bars = noise(700, 11);
  const run = (b: readonly Bar[], to?: string) => {
    const s = findDeclines(b, { threshold: 0.03, to });
    const anchors = s.episodes.map((e) => e.anchorIndex);
    return {
      events: s.occurrences.map((o) => [o.date, +o.measure.toFixed(12), isNa(o.rsi14) ? null : +o.rsi14.toFixed(9), isNa(o.stock.aboveSma200) ? null : o.stock.aboveSma200]),
      episodes: s.episodes.map((e) => [e.anchorDate, e.days]),
      rarity: [s.rarity.hits, s.rarity.n],
      horizon: (() => {
        const h = declineHorizonStats(b, anchors, 5, { minCases: 1 });
        return [h.n, h.up, h.down, h.tradedBelowEventLow.hits, h.bounces.map((x) => x.touch.hits)];
      })(),
    };
  };

  it('appending future rows does not change an earlier as-of study', () => {
    const cut = 500;
    const early = bars.slice(0, cut);
    const asOf = early[cut - 1]!.date;
    const a = findDeclines(early, { threshold: 0.03 });
    const b = findDeclines(bars, { threshold: 0.03, to: asOf });
    expect(b.occurrences).toEqual(a.occurrences);
    expect(b.episodes).toEqual(a.episodes);
    expect(b.rarity).toEqual(a.rarity);
    // Pattern occurrences confirmed by the cut are identical with or without later rows.
    for (const p of EXHAUSTION_PATTERNS) {
      const e = detectPattern(early, p.id, { threshold: 0.03 });
      const f = detectPattern(bars, p.id, { threshold: 0.03 }).filter((o) => o.confirmIndex < cut);
      expect(f).toEqual(e);
    }
    expect(num(moveRarity(bars, cut - 1, 'close-vs-prev-close'))).toEqual(num(moveRarity(early, cut - 1, 'close-vs-prev-close')));
  });

  it('scaling every price by one factor does not change returns or states', () => {
    const scaled = bars.map((b) => ({ ...b, open: b.open * 2, high: b.high * 2, low: b.low * 2, close: b.close * 2 }));
    expect(run(scaled)).toEqual(run(bars));
    for (const id of ['retest-then-recovery', 'delayed-bottom', 'new-low-top-quartile-close', 'gap-down-close-above-open'] as const) {
      const a = detectPattern(bars, id, { threshold: 0.03 }).map((o) => [o.eventIndex, o.confirmIndex]);
      const b = detectPattern(scaled, id, { threshold: 0.03 }).map((o) => [o.eventIndex, o.confirmIndex]);
      expect(b).toEqual(a);
    }
    const at = drawdownPositions(bars);
    const atS = drawdownPositions(scaled);
    for (const i of [50, 200, 400]) {
      const x = at(i);
      const y = atS(i);
      expect(isNa(x) ? x.code : x.stage).toEqual(isNa(y) ? y.code : y.stage);
    }
  });
});

describe('synthetic fixture smoke test', () => {
  for (const sym of ['NVDA', 'SNDK']) {
    it(`studies ${sym} declines end to end`, () => {
      const inst = INSTRUMENTS.find((i) => i.symbol === sym)!;
      const bars = syntheticDaily(inst).bars;
      const spy = syntheticDaily(INSTRUMENTS.find((i) => i.symbol === 'SPY')!).bars;
      const ev = syntheticEarnings(inst);
      const s = findDeclines(bars, { threshold: 0.05, market: spy, earnings: Array.isArray(ev) ? ev : undefined });
      expect(s.eligibleSessions).toBe(bars.length - 1);
      expect(s.occurrences.length).toBeGreaterThan(0);
      expect(s.episodes.length).toBeLessThanOrEqual(s.occurrences.length);
      expect(s.earningsCohorts.earnings + s.earningsCohorts.ordinary + s.earningsCohorts.unknown).toBe(s.occurrences.length);
      const anchors = s.episodes.map((e) => e.anchorIndex);
      for (const t of declineHorizonTable(bars, anchors)) {
        expect(t.n + t.notMatured + t.excludedOverlap).toBe(t.anchorsConsidered);
        expect(t.up + t.flat + t.down).toBe(t.n);
        expect(t.tradedBelowEventLow.hits + t.eventLowHeld.hits).toBe(t.n);
        expect(t.closedBelowEventLow.hits).toBeLessThanOrEqual(t.tradedBelowEventLow.hits);
        for (const bnc of t.bounces) {
          expect(bnc.close.hits).toBeLessThanOrEqual(bnc.touch.hits);
          expect(bnc.endpoint.hits).toBeLessThanOrEqual(bnc.close.hits);
        }
      }
      const rec = recoveryStats(bars, anchors, 20, { kind: 'previous-close' });
      expect(rec.recovered + rec.notRecovered + rec.censored).toBe(rec.cases.length);
      const lb = lastingBottomStats(bars, anchors);
      expect(Object.values(lb.counts).reduce((a, b) => a + b, 0)).toBe(lb.cases.length);
      for (const p of EXHAUSTION_PATTERNS) {
        const st = studyPattern(bars, p.id, { threshold: 0.05, horizons: [5, 20] });
        for (const o of st.occurrences) expect(o.confirmIndex).toBeGreaterThanOrEqual(o.eventIndex);
        expect(st.horizons.length).toBe(2);
      }
      const last = moveRarity(bars, bars.length - 1, 'close-vs-prev-close');
      expect(isNa(last)).toBe(false);
    });
  }
});
