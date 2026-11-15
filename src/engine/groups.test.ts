import { describe, expect, it } from 'vitest';
import { GROUPS, INSTRUMENTS } from '../data/fixtures/universe';
import { seriesFromCloses, syntheticDaily } from '../data/fixtures/synthetic';
import { sliceAsOf } from './core/series';
import { isNa, na, type Bar, type Maybe } from './core/types';
import {
  aggregateGroups, coMovement, coMovementMatrix, displayGroupOf, findGroup, groupParticipation, industryGrouping, membershipsOf,
  minComparableReturns, participationFromRows, providerGrouping, sessionReturn, themesGrouping, topMovers, type GroupingModel, type MetricRow,
} from './groups';

const NA = na('no-coverage');
const row = (symbol: string, day: Maybe<number>, ytd: Maybe<number> = NA): MetricRow => ({ symbol, dayChange: day, wtd: NA, mtd: NA, qtd: NA, ytd });
const model: GroupingModel = {
  kind: 'curated-theme', label: 'Trading groups', note: '', unclassified: [],
  groups: [
    { id: 'a', name: 'Alpha', kind: 'curated-theme', members: ['A1', 'A2', 'A3', 'A4'], basis: '' },
    { id: 'b', name: 'Beta', kind: 'curated-theme', members: ['B1', 'A1'], basis: '' },
    { id: 'c', name: 'Gamma', kind: 'curated-theme', members: ['C1'], basis: '' },
    { id: 'd', name: 'Delta', kind: 'curated-theme', members: ['D1', 'D2'], basis: '' },
  ],
};
const rows: MetricRow[] = [row('A1', 0.04), row('A2', -0.02), row('A3', 0.01), row('A4', NA), row('B1', -0.03), row('C1', 0.1), row('D1', NA)];

describe('grouping models', () => {
  it('keeps themes, industry and provider labels separate with deterministic display groups', () => {
    const themes = themesGrouping(GROUPS);
    expect(themes.kind).toBe('curated-theme');
    expect(membershipsOf('MRVL', themes).map((g) => g.id)).toEqual(['ai-chips', 'chip-design']);
    expect(displayGroupOf('MRVL', themes)?.id).toBe('ai-chips');
    expect(displayGroupOf('SPY', themes)).toBeNull();
    expect(findGroup(themes, 'memory AND storage')?.id).toBe('memory-storage');
    const industry = industryGrouping(INSTRUMENTS);
    expect(industry.kind).toBe('verified-industry');
    expect(membershipsOf('NVDA', industry).length).toBe(1);
    expect(industry.groups.some((g) => g.members.includes('SPY'))).toBe(false);
    const provider = providerGrouping({ CBRS: 'Software', NVDA: 'Semiconductors', ZZZ: null }, 'Vendor');
    expect(provider.kind).toBe('provider-classification');
    expect(provider.unclassified).toEqual(['ZZZ']);
    // A provider label never changes the curated theme.
    expect(displayGroupOf('CBRS', themes)?.id).toBe('ai-chips');
    expect(displayGroupOf('CBRS', provider)?.name).toBe('Software');
  });
});

describe('group aggregates', () => {
  it('is equal weighted over members with data and reports honest denominators', () => {
    const cmp = aggregateGroups(rows, model, 'day');
    const a = cmp.aggregates.find((g) => g.groupId === 'a')!;
    expect(a.members).toBe(4);
    expect(a.inScope).toBe(4);
    expect(a.withData).toBe(3);
    expect(a.average).toBeCloseTo(0.01, 12);
    expect(a.median).toBeCloseTo(0.01, 12);
    expect(a.up).toBe(2);
    expect(a.down).toBe(1);
    expect(a.best).toEqual({ symbol: 'A1', value: 0.04 });
    expect(a.worst).toEqual({ symbol: 'A2', value: -0.02 });
    expect(a.breadth).toBe('broad');
    expect(a.coverageLabel).toBe('3 of 4 members with data');
    const b = cmp.aggregates.find((g) => g.groupId === 'b')!;
    expect(b.withData).toBe(2);
    expect(b.breadth).toBe('narrow');
    expect(b.average).toBeCloseTo(0.005, 12);
    const c = cmp.aggregates.find((g) => g.groupId === 'c')!;
    expect(c.breadth).toBe('single');
    const d = cmp.aggregates.find((g) => g.groupId === 'd')!;
    expect(d.inScope).toBe(1);
    expect(d.withData).toBe(0);
    expect(d.breadth).toBe('none');
    expect(isNa(d.value)).toBe(true);
  });
  it('orders strongest or weakest with unavailable groups last and a common zero scale', () => {
    const strong = aggregateGroups(rows, model, 'day');
    expect(strong.aggregates.map((g) => g.groupId)).toEqual(['c', 'a', 'b', 'd']);
    expect(strong.maxAbs).toBeCloseTo(0.1, 12);
    expect(strong.aggregates[0]!.bar).toBe(1);
    expect(strong.aggregates[1]!.bar).toBeCloseTo(0.1, 12);
    expect(strong.aggregates[3]!.bar).toBe(0);
    const weak = aggregateGroups(rows, model, 'day', { order: 'weakest' });
    expect(weak.aggregates.map((g) => g.groupId)).toEqual(['b', 'a', 'c', 'd']);
    const searched = aggregateGroups(rows, model, 'day', { search: 'alp' });
    expect(searched.aggregates.map((g) => g.name)).toEqual(['Alpha']);
  });
  it('median differs from average when a member is extreme', () => {
    const r = [row('A1', 0.01), row('A2', 0.02), row('A3', -0.3)];
    const cmp = aggregateGroups(r, model, 'day', { stat: 'median' });
    const a = cmp.aggregates.find((g) => g.groupId === 'a')!;
    expect(a.median).toBeCloseTo(0.01, 12);
    expect(a.average).toBeCloseTo(-0.09, 12);
    expect(a.value).toBe(a.median);
  });
  it('lists top movers with honest empty sides', () => {
    const all = topMovers(rows, 'day');
    expect(all.winners.map((w) => w.symbol)).toEqual(['C1', 'A1', 'A3']);
    expect(all.losers.map((w) => w.symbol)).toEqual(['B1', 'A2']);
    expect(all.withData).toBe(5);
    const g = topMovers(rows, 'day', { group: model.groups[2]! });
    expect(g.scopeLabel).toBe('Gamma, Today');
    expect(g.winners.length).toBe(1);
    expect(g.losers).toEqual([]);
    expect(g.losersNote).toBe('No decliners today');
    const none = topMovers(rows, 'ytd');
    expect(none.winnersNote).toBe('No YTD data in this scope');
    const allDown = topMovers([row('X', -0.01), row('Y', -0.02)], 'day');
    expect(allDown.winners).toEqual([]);
    expect(allDown.winnersNote).toBe('No gainers today');
    expect(allDown.losers.map((l) => l.symbol)).toEqual(['Y', 'X']);
  });
});

describe('co movement', () => {
  const zig = (n: number, f: (i: number) => number, start = 100): number[] => {
    const out = [start];
    for (let i = 1; i <= n; i++) out.push(out[i - 1]! * (1 + f(i)));
    return out;
  };
  it('states the minimum comparable returns', () => {
    expect(minComparableReturns(63)).toBe(51);
    expect(minComparableReturns(252)).toBe(202);
    expect(minComparableReturns(20)).toBe(30);
  });
  it('is +1 for identical moves and -1 for mirrored moves', () => {
    const a = seriesFromCloses(zig(70, (i) => (i % 2 ? 0.01 : -0.02)));
    const same = coMovement(a, seriesFromCloses(zig(70, (i) => (i % 2 ? 0.02 : -0.04), 50)), 63);
    expect(isNa(same)).toBe(false);
    if (!isNa(same)) {
      expect(same.correlation).toBeCloseTo(1, 10);
      expect(same.n).toBe(63);
      expect(same.sameDirection?.rate).toBe(1);
      expect(same.from).toBe(a[8]!.date);
      expect(same.to).toBe(a[70]!.date);
      expect(isNa(same.excessCorrelation)).toBe(true);
    }
    const mirror = coMovement(a, seriesFromCloses(zig(70, (i) => (i % 2 ? -0.01 : 0.02))), 63);
    expect(!isNa(mirror) && mirror.correlation).toBeCloseTo(-1, 10);
    expect(!isNa(mirror) && mirror.sameDirection?.rate).toBe(0);
  });
  it('removes a shared market move in the excess version', () => {
    const m = zig(70, (i) => (i % 3 === 0 ? 0.03 : -0.01));
    const noiseA = (i: number) => (i % 2 ? 0.004 : -0.004);
    const noiseB = (i: number) => (i % 2 ? -0.004 : 0.004);
    const mkt = seriesFromCloses(m);
    const withNoise = (noise: (i: number) => number) => seriesFromCloses(zig(70, (i) => m[i]! / m[i - 1]! - 1 + noise(i)));
    const r = coMovement(withNoise(noiseA), withNoise(noiseB), 63, mkt);
    expect(isNa(r)).toBe(false);
    if (!isNa(r)) {
      expect(r.correlation).toBeGreaterThan(0.5);
      expect(r.excessCorrelation).toBeCloseTo(-1, 8);
    }
  });
  it('reports sparse coverage instead of a number', () => {
    const a = seriesFromCloses(zig(40, (i) => (i % 2 ? 0.01 : -0.02)));
    const r = coMovement(a, a, 63);
    expect(isNa(r) && r.code).toBe('sample-too-small');
    expect(isNa(r) && r.detail).toMatch(/40 comparable returns, needs 51/);
    const full = seriesFromCloses(zig(70, (i) => (i % 2 ? 0.01 : -0.02)));
    // Remove 15 sessions from one leg: each removal drops two return slots.
    const holes = full.filter((_, i) => i < 20 || i % 4 !== 0);
    const sparse = coMovement(full, holes, 63);
    expect(isNa(sparse) && sparse.code).toBe('sample-too-small');
    expect(isNa(coMovement([], full, 63))).toBe(true);
  });
  it('excludes zero return days from the same direction rate', () => {
    const a = seriesFromCloses(zig(70, (i) => (i % 2 ? 0.01 : -0.01)));
    const b = seriesFromCloses(zig(70, (i) => (i % 4 === 0 ? 0 : i % 2 ? 0.01 : -0.01)));
    const r = coMovement(a, b, 63);
    expect(isNa(r)).toBe(false);
    if (!isNa(r)) {
      expect(r.sameDirection!.n).toBeLessThan(63);
      expect(r.sameDirection!.rate).toBe(1);
    }
  });
  it('is unchanged by later rows and by a price scale factor', () => {
    const nvda = syntheticDaily(INSTRUMENTS.find((i) => i.symbol === 'NVDA')!).bars;
    const amd = syntheticDaily(INSTRUMENTS.find((i) => i.symbol === 'AMD')!).bars;
    const spy = syntheticDaily(INSTRUMENTS.find((i) => i.symbol === 'SPY')!).bars;
    const cut = '2025-06-30';
    const asOf = coMovement(sliceAsOf(nvda, cut), sliceAsOf(amd, cut), 252, sliceAsOf(spy, cut));
    const again = coMovement(sliceAsOf(nvda, cut), sliceAsOf(amd, cut), 252, spy);
    expect(again).toEqual(asOf);
    const scaled = coMovement(sliceAsOf(nvda, cut).map((b: Bar) => ({ ...b, open: b.open * 4, high: b.high * 4, low: b.low * 4, close: b.close * 4 })), sliceAsOf(amd, cut), 252);
    expect(!isNa(scaled) && !isNa(asOf) && scaled.correlation).toBeCloseTo(!isNa(asOf) ? asOf.correlation : NaN, 10);
    expect(!isNa(asOf) && asOf.n).toBe(252);
  });
  it('runs pairwise on the fixture, including a short history', () => {
    const pick = (s: string) => ({ symbol: s, bars: syntheticDaily(INSTRUMENTS.find((i) => i.symbol === s)!).bars });
    const pairs = coMovementMatrix([pick('SNDK'), pick('MU'), pick('WDC')], 63, pick('SPY').bars);
    expect(pairs.length).toBe(3);
    expect(pairs.every((p) => !isNa(p.result))).toBe(true);
    const cbrs = coMovement(pick('CBRS').bars, pick('NVDA').bars, 252);
    expect(isNa(cbrs) && cbrs.code).toBe('sample-too-small');
  });
});

describe('participation', () => {
  const mk = (closes: number[]) => seriesFromCloses(closes, '2026-11-09');
  const date = '2026-11-10';
  const bars = new Map<string, Bar[]>([
    ['S', mk([100, 90])],
    ['P1', mk([100, 97])],
    ['P2', mk([100, 98])],
    ['P3', mk([100, 101])],
    ['P4', mk([100])],
  ]);
  it('shows which peers participated and reads the move by a stated rule', () => {
    const p = groupParticipation('S', date, ['S', 'P1', 'P2', 'P3', 'P4', 'P5'], bars);
    expect(p.stockReturn).toBeCloseTo(-0.1, 12);
    expect(p.peersWithData).toBe(3);
    expect(p.peerMedian).toBeCloseTo(-0.02, 12);
    expect(p.versusPeerMedian).toBeCloseTo(-0.08, 12);
    expect(p.peersDown?.hits).toBe(2);
    expect(p.peersDown?.n).toBe(3);
    expect(p.downSymbols).toEqual(['P1', 'P2']);
    expect(p.upSymbols).toEqual(['P3']);
    expect(p.reading).toBe('group-wide');
    expect(p.peers.find((x) => x.symbol === 'P4')!.ret).toMatchObject({ unavailable: true, code: 'missing-session' });
    expect(p.peers.find((x) => x.symbol === 'P5')!.ret).toMatchObject({ unavailable: true, code: 'no-coverage' });
  });
  it('separates stock specific, mixed, not a decline and unknown', () => {
    const specific = new Map(bars);
    specific.set('P1', mk([100, 101]));
    specific.set('P2', mk([100, 102]));
    expect(groupParticipation('S', date, ['S', 'P1', 'P2', 'P3'], specific).reading).toBe('stock-specific');
    const mixed = new Map(bars);
    mixed.set('P4', mk([100, 103]));
    expect(groupParticipation('S', date, ['S', 'P1', 'P2', 'P3', 'P4'], mixed).reading).toBe('mixed');
    expect(groupParticipation('P3', date, ['S', 'P1', 'P2', 'P3'], bars).reading).toBe('not-a-decline');
    expect(groupParticipation('S', date, ['S', 'P1'], bars).reading).toBe('unknown');
    expect(groupParticipation('ZZ', date, ['S', 'P1', 'P2'], bars).reading).toBe('unknown');
  });
  it('requires the previous exchange session for a daily return', () => {
    const gap: Bar[] = [mk([100])[0]!, { ...mk([100, 100, 95])[2]! }];
    const r = sessionReturn(gap, '2026-11-11');
    expect(isNa(r) && r.code).toBe('missing-session');
    expect(sessionReturn(mk([100, 95]), '2026-11-10')).toBeCloseTo(-0.05, 12);
  });
  it('compares a period metric with the peer median from rows', () => {
    const r = participationFromRows('A2', rows, model.groups[0]!, 'day');
    expect(r.stock).toBe(-0.02);
    expect(r.peerMedian).toBeCloseTo(0.025, 12);
    expect(r.peersWithData).toBe(2);
    expect(r.versusPeerMedian).toBeCloseTo(-0.045, 12);
    expect(r.peersDown?.hits).toBe(0);
    const missing = participationFromRows('ZZ', rows, model.groups[0]!, 'day');
    expect(isNa(missing.stock)).toBe(true);
  });
});
