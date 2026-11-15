import { describe, expect, it } from 'vitest';
import { nextSession } from './core/calendar';
import { mulberry32 } from './core/stats';
import { isNa, type Bar, type EarningsEvent } from './core/types';
import { INSTRUMENTS } from '../data/fixtures/universe';
import { fixtureSource, seriesFromCloses, syntheticDaily, syntheticEarnings } from '../data/fixtures/synthetic';
import { ANALOG_DEFAULTS, FEATURE_KEYS, buildFeatures, findAnalogs, isMaturedBefore, searchByConditions, type AnalogResult, type FeatureKey } from './analogs';

const noise = (n: number, seed: number, start = '2015-01-02'): Bar[] => {
  const rnd = mulberry32(seed);
  const bars: Bar[] = [];
  let prev = 100;
  let d = start;
  for (let i = 0; i < n; i++) {
    if (i > 0) d = nextSession(d);
    const open = prev * (1 + (rnd() - 0.5) * 0.02);
    const close = open * (1 + (rnd() - 0.5) * 0.08);
    const high = Math.max(open, close) * (1 + rnd() * 0.01);
    const low = Math.min(open, close) * (1 - rnd() * 0.01);
    bars.push({ date: d, open, high, low, close, volume: Math.round(1_000_000 * (0.5 + rnd() * 3)) });
    prev = close;
  }
  return bars;
};

const ok = (r: AnalogResult | { unavailable: true }): AnalogResult => {
  if (isNa(r)) throw new Error('expected a result');
  return r as AnalogResult;
};

const SHAPE: FeatureKey[] = ['dayReturn', 'rangePosition', 'lowerWick', 'upperWick'];

describe('feature builder', () => {
  it('computes past only features by hand', () => {
    const bars: Bar[] = seriesFromCloses([100, 98, 96, 97, 90]);
    bars[4] = { ...bars[4]!, open: 96, high: 98, low: 88, close: 90 };
    const fm = buildFeatures(bars);
    expect(fm.values.dayReturn[0]).toBeNull();
    expect(fm.values.dayReturn[4]).toBeCloseTo(90 / 97 - 1, 12);
    expect(fm.values.rangePosition[4]).toBeCloseTo(0.2, 12);
    expect(fm.values.lowerWick[4]).toBeCloseTo(0.2, 12);
    expect(fm.values.upperWick[4]).toBeCloseTo(0.2, 12);
    expect(fm.values.downStreak.slice(1)).toEqual([1, 2, 0, 1]);
    expect(fm.values.drawdown[4]).toBeCloseTo(-0.1, 12);
    expect(fm.values.drawdown[0]).toBe(0);
    expect(fm.values.rsi14[4]).toBeNull();
    expect(fm.values.distSma200[4]).toBeNull();
    expect(fm.values.marketReturn[4]).toBeNull();
    expect(fm.values.earnings[4]).toBeNull(); // no events supplied means unknown, not zero
  });

  it('aligns market context by date and leaves gaps empty', () => {
    const bars = noise(260, 3);
    const market = noise(260, 4).filter((_, i) => i !== 250);
    const fm = buildFeatures(bars, { market });
    expect(fm.values.marketReturn[250]).toBeNull();
    expect(fm.values.marketReturn[251]).toBeCloseTo(market[250]!.close / market[249]!.close - 1, 12);
    expect(fm.values.marketDistSma200[100]).toBeNull();
    expect(typeof fm.values.marketDistSma200[255]).toBe('number');
  });

  it('flags earnings reaction sessions only where coverage is known', () => {
    const bars = noise(120, 5);
    const ev: EarningsEvent = { instrumentId: 'x', symbol: 'X', date: bars[60]!.date, time: 'amc', status: 'confirmed', source: fixtureSource() };
    const fm = buildFeatures(bars, { earnings: [ev] });
    expect(fm.values.earnings[59]).toBeNull(); // before the first known event
    expect(fm.values.earnings[60]).toBe(0);
    expect(fm.values.earnings[61]).toBe(1); // after the close reacts the next session
    expect(fm.values.earnings[62]).toBe(0);
  });
});

describe('closest condition matching', () => {
  const bars = noise(900, 21);
  const fm = buildFeatures(bars, {}, 'TEST');
  const q = 880;

  it('guards against target leakage', () => {
    expect(isMaturedBefore(869, 10, 880)).toBe(true);
    expect(isMaturedBefore(870, 10, 880)).toBe(false);
    expect(isMaturedBefore(868, 10, 880, 1)).toBe(true);
    expect(isMaturedBefore(869, 10, 880, 1)).toBe(false);
    const r = ok(findAnalogs(fm, q, { horizon: 10 }));
    expect(r.counts.scanned).toBe(q);
    expect(r.counts.notMaturedBeforeQuery).toBe(10);
    for (const c of r.cases) {
      expect(c.index + 10).toBeLessThan(q);
      expect(c.outcome.endDate < bars[q]!.date).toBe(true);
    }
    const e = ok(findAnalogs(fm, q, { horizon: 10, embargo: 5 }));
    expect(e.counts.notMaturedBeforeQuery).toBe(15);
  });

  it('ranks by distance, caps the cases and keeps future paths apart', () => {
    const r = ok(findAnalogs(fm, q, { horizon: 10 }));
    expect(r.status).toBe('ok');
    expect(r.cases.length).toBe(ANALOG_DEFAULTS.spec.maxCases);
    const d = r.cases.map((c) => c.distance!);
    expect([...d].sort((a, b) => a - b)).toEqual(d);
    for (let i = 0; i < r.cases.length; i++) for (let j = i + 1; j < r.cases.length; j++) {
      expect(Math.abs(r.cases[i]!.index - r.cases[j]!.index)).toBeGreaterThan(10);
    }
    expect(r.counts.ownCases).toBe(15);
    expect(r.counts.overlapDropped + r.counts.beyondLimit + r.counts.tooFewSharedFeatures + r.counts.toleranceFailed + r.counts.notMaturedBeforeQuery + r.counts.ownCases).toBe(q);
    expect(r.summary.n).toBe(15);
    expect(r.summary.up + r.summary.flat + r.summary.down).toBe(15);
    expect(isNa(r.summary.positive.proportion)).toBe(false);
  });

  it('publishes why each case matched', () => {
    const r = ok(findAnalogs(fm, q, { horizon: 10 }));
    for (const c of r.cases) {
      expect(c.sharedFeatures.length).toBeGreaterThanOrEqual(ANALOG_DEFAULTS.spec.minSharedFeatures);
      const share = c.contributions.reduce((a, x) => a + x.share, 0);
      expect(share).toBeCloseTo(1, 9);
      const ss = c.contributions.reduce((a, x) => a + x.weight * x.zDiff * x.zDiff, 0);
      const sw = c.contributions.reduce((a, x) => a + x.weight, 0);
      expect(c.distance!).toBeCloseTo(Math.sqrt(ss / sw), 12);
      expect(c.origin).toBe('own');
      expect(c.symbol).toBe('TEST');
    }
    expect(r.matchedDimensions.length).toBeGreaterThanOrEqual(6);
    expect(r.query.unusable.map((u) => u.key)).toEqual(expect.arrayContaining(['marketReturn', 'earnings']));
  });

  it('finds a planted exact match first', () => {
    const planted = bars.map((b) => ({ ...b }));
    const p = 400;
    const qb = planted[q]!;
    const prevQ = planted[q - 1]!.close;
    const prevP = planted[p - 1]!.close;
    const k = prevP / prevQ;
    planted[p] = { ...planted[p]!, open: qb.open * k, high: qb.high * k, low: qb.low * k, close: qb.close * k };
    const f2 = buildFeatures(planted);
    const r = ok(findAnalogs(f2, q, { horizon: 5, keys: SHAPE, minSharedFeatures: 4 }));
    expect(r.cases[0]!.index).toBe(p);
    expect(r.cases[0]!.distance!).toBeLessThan(1e-9);
    expect(r.cases[1]!.distance!).toBeGreaterThan(1e-6);
  });

  it('requires a minimum number of shared features', () => {
    const r = ok(findAnalogs(fm, q, { horizon: 5, keys: SHAPE }));
    expect(r.status).toBe('insufficient-features');
    expect(r.cases).toEqual([]);
    expect(r.notes[0]).toMatch(/4 comparable features/);
    // Early in a series the long window features do not exist yet.
    const early = ok(findAnalogs(fm, 30, { horizon: 5 }));
    expect(early.status).toBe('insufficient-features');
  });

  it('applies tolerances and weights', () => {
    const tol = ok(findAnalogs(fm, q, { horizon: 10, tolerances: { dayReturn: 0.25 } }));
    expect(tol.counts.toleranceFailed).toBeGreaterThan(0);
    for (const c of tol.cases) expect(Math.abs(c.contributions.find((x) => x.key === 'dayReturn')!.zDiff)).toBeLessThanOrEqual(0.25);
    const w = ok(findAnalogs(fm, q, { horizon: 10, weights: { relVolume: 0 } }));
    expect(w.matchedDimensions).not.toContain('relVolume');
    expect(w.query.unusable.find((u) => u.key === 'relVolume')!.reason).toMatch(/Weight/);
  });

  it('builds aligned paths, later lows and recovery timing', () => {
    const r = ok(findAnalogs(fm, q, { horizon: 10, pathBefore: 3 }));
    const c = r.cases[0]!;
    expect(c.path.map((p) => p.offset)).toEqual([-3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(c.path[3]!.rel).toBe(0);
    expect(c.path[13]!.rel).toBeCloseTo(c.outcome.ret, 12);
    const before = ok(findAnalogs(fm, q, { horizon: 10, pathBefore: 3, pathBaseline: 'before' })).cases[0]!;
    expect(before.path[2]!.rel).toBe(0);
    expect(r.medianPath.length).toBe(14);
    expect(r.medianPath[3]!.median).toBe(0);
    expect(r.medianPath[13]!.n).toBe(r.cases.length);
    for (const x of r.cases) {
      if (x.reversalSessions !== null) expect(bars[x.index + x.reversalSessions]!.close).toBeGreaterThan(bars[x.index]!.close);
      if (!x.recoveryApplicable) expect(x.recoverySessions).toBeNull();
      if (x.recoverySessions !== null) expect(bars[x.index + x.recoverySessions]!.close).toBeGreaterThanOrEqual(bars[x.index - 1]!.close);
    }
    expect(r.summary.recovery.n).toBe(r.cases.filter((x) => x.recoveryApplicable).length);
  });

  it('standardizes with observations before the query only', () => {
    // Changing or appending rows after the query leaves the result identical.
    const cut = bars.slice(0, q + 1);
    const a = ok(findAnalogs(buildFeatures(cut, {}, 'TEST'), q, { horizon: 10 }));
    const b = ok(findAnalogs(fm, q, { horizon: 10 }));
    expect(b).toEqual(a);
    const shocked = bars.map((x, i) => (i > q ? { ...x, open: x.open * 3, high: x.high * 3, low: x.low * 3, close: x.close * 3 } : x));
    const c = ok(findAnalogs(buildFeatures(shocked, {}, 'TEST'), q, { horizon: 10 }));
    expect(c).toEqual(a);
  });

  it('does not change when every price is scaled by one factor', () => {
    const scaled = bars.map((b) => ({ ...b, open: b.open * 2, high: b.high * 2, low: b.low * 2, close: b.close * 2 }));
    const a = ok(findAnalogs(fm, q, { horizon: 10 }));
    const b = ok(findAnalogs(buildFeatures(scaled, {}, 'TEST'), q, { horizon: 10 }));
    expect(b.cases.map((c) => c.index)).toEqual(a.cases.map((c) => c.index));
    b.cases.forEach((c, i) => {
      expect(c.distance!).toBeCloseTo(a.cases[i]!.distance!, 9);
      expect(c.outcome.ret).toBeCloseTo(a.cases[i]!.outcome.ret, 12);
    });
    expect(b.summary.up).toBe(a.summary.up);
  });
});

describe('sparse stock support and labeled group cohorts', () => {
  const own = noise(300, 31, '2023-06-01');
  const peer1 = noise(1500, 32, '2019-01-02');
  const peer2 = noise(1500, 33, '2019-01-02');
  const fm = buildFeatures(own, {}, 'OWN');
  const q = own.length - 1;
  const opts = { horizon: 20, tolerances: { dayReturn: 0.6, rsi14: 0.8, drawdown: 0.8 } };

  it('reports thin own support and adds nothing without a cohort', () => {
    const r = ok(findAnalogs(fm, q, opts));
    expect(r.counts.ownCases).toBeLessThan(10);
    expect(r.counts.groupCases).toBe(0);
    expect(r.notes.join(' ')).toMatch(/No group cohort was supplied/);
    expect(r.status === 'sparse' || r.status === 'none').toBe(true);
    if (r.summary.n > 0) expect(isNa(r.summary.positive.proportion)).toBe(true);
  });

  it('adds explicitly labeled group cases and keeps the own count', () => {
    const cohorts = [
      { symbol: 'PEER1', features: buildFeatures(peer1, {}, 'PEER1'), membershipNote: 'Curated theme as defined today.' },
      { symbol: 'PEER2', features: buildFeatures(peer2, {}, 'PEER2') },
    ];
    const base = ok(findAnalogs(fm, q, opts));
    const r = ok(findAnalogs(fm, q, { ...opts, cohorts }));
    expect(r.counts.ownCases).toBe(base.counts.ownCases);
    expect(r.counts.groupCases).toBeGreaterThan(0);
    expect(r.cases.length).toBe(r.counts.ownCases + r.counts.groupCases);
    expect(r.ownSummary.n).toBe(r.counts.ownCases);
    expect(r.summary.n).toBe(r.cases.length);
    expect(r.notes.join(' ')).toMatch(/retrospective/);
    expect(r.notes.join(' ')).toMatch(/PEER1: Curated theme as defined today/);
    const qDate = own[q]!.date;
    const dates = new Set<string>();
    for (const c of r.cases) {
      expect(dates.has(c.date)).toBe(false); // one case per calendar date
      dates.add(c.date);
      if (c.origin === 'group') {
        expect(['PEER1', 'PEER2']).toContain(c.symbol);
        expect(c.outcome.endDate < qDate).toBe(true); // matured strictly before the query date
      }
    }
    const group = r.cases.filter((c) => c.origin === 'group');
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      if (group[i]!.symbol === group[j]!.symbol) expect(Math.abs(group[i]!.index - group[j]!.index)).toBeGreaterThan(20);
    }
  });

  it('never uses group rows on or after the query date', () => {
    const lateOnly = noise(200, 34, own[q]!.date); // peer history starts on the query date
    const r = ok(findAnalogs(fm, q, { ...opts, cohorts: [{ symbol: 'LATE', features: buildFeatures(lateOnly, {}, 'LATE') }] }));
    expect(r.counts.groupCases).toBe(0);
  });
});

describe('threshold driven search', () => {
  const bars = noise(900, 41);
  const fm = buildFeatures(bars);
  const q = 899;

  it('keeps sessions that meet every rule with matured, spaced outcomes', () => {
    const r = ok(searchByConditions(fm, q, [{ key: 'dayReturn', op: 'lte', value: -0.03 }, { key: 'rsi14', op: 'between', value: 0, value2: 45 }], { horizon: 10 }));
    expect(r.entry).toBe('rule-search');
    expect(r.cases.length).toBeGreaterThan(0);
    for (const c of r.cases) {
      expect(fm.values.dayReturn[c.index]!).toBeLessThanOrEqual(-0.03);
      expect(fm.values.rsi14[c.index]!).toBeLessThanOrEqual(45);
      expect(c.index + 10).toBeLessThan(q);
    }
    for (let i = 1; i < r.cases.length; i++) expect(r.cases[i]!.index - r.cases[i - 1]!.index).toBeGreaterThanOrEqual(11);
    expect(r.counts.ownCases).toBe(r.cases.length);
    expect(r.summary.n).toBe(r.cases.length);
    expect(r.notes[0]).toMatch(/at or below -0.03/);
    expect(r.cases[0]!.distance).not.toBeNull();
  });

  it('never lets a missing value pass a numeric rule', () => {
    const r = ok(searchByConditions(fm, q, [{ key: 'distSma200', op: 'lte', value: 10 }], { horizon: 5 }));
    for (const c of r.cases) expect(c.index).toBeGreaterThanOrEqual(199);
    const none = ok(searchByConditions(fm, q, [{ key: 'marketReturn', op: 'lte', value: 10 }], { horizon: 5 }));
    expect(none.status).toBe('none');
    const bad = searchByConditions(fm, q, [], { horizon: 5 });
    expect(isNa(bad) && bad.code).toBe('invalid-input');
  });

  it('is unchanged by later rows', () => {
    const cond = [{ key: 'dayReturn' as const, op: 'lte' as const, value: -0.03 }];
    const a = ok(searchByConditions(buildFeatures(bars.slice(0, 701)), 700, cond, { horizon: 10 }));
    const b = ok(searchByConditions(fm, 700, cond, { horizon: 10 }));
    expect(b).toEqual(a);
  });
});

describe('synthetic fixture smoke test', () => {
  const spy = syntheticDaily(INSTRUMENTS.find((i) => i.symbol === 'SPY')!).bars;
  for (const sym of ['NVDA', 'SNDK']) {
    it(`finds analogs for ${sym}`, () => {
      const inst = INSTRUMENTS.find((i) => i.symbol === sym)!;
      const bars = syntheticDaily(inst).bars;
      const ev = syntheticEarnings(inst);
      const fm = buildFeatures(bars, { market: spy, earnings: Array.isArray(ev) ? ev : undefined }, sym);
      for (const key of FEATURE_KEYS) expect(fm.values[key].length).toBe(bars.length);
      const q = bars.length - 1;
      const r = ok(findAnalogs(fm, q, { horizon: 20 }));
      expect(r.query.date).toBe('2026-11-13');
      expect(r.query.usableFeatures).toEqual(expect.arrayContaining(['marketReturn', 'marketDistSma200', 'rsi14']));
      for (const c of r.cases) expect(c.index + 20).toBeLessThan(q);
      if (sym === 'NVDA') {
        expect(r.status).toBe('ok');
        expect(r.cases.length).toBe(15);
      } else {
        // Short history: fewer comparable non overlapping cases, reported honestly.
        expect(r.counts.ownCases).toBe(r.cases.length);
        expect(r.cases.length).toBeLessThanOrEqual(15);
      }
      const rule = ok(searchByConditions(fm, q, [{ key: 'dayReturn', op: 'lte', value: -0.05 }], { horizon: 20 }));
      expect(rule.summary.n).toBe(rule.cases.length);
    });
  }
});
