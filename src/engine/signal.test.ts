import { describe, expect, it } from 'vitest';
import { sessionsBetween } from './core/calendar';
import { mulberry32 } from './core/stats';
import type { Bar, EarningsEvent } from './core/types';
import { INSTRUMENTS } from '../data/fixtures/universe';
import { syntheticDaily, syntheticEarnings } from '../data/fixtures/synthetic';
import { SIGNAL_DEFAULTS, SIGNAL_PROVENANCE, computeSignalScore, signalDataGate, signalRegistration, type SignalDataHealth, type SignalScore } from './signal';
import { assertNoLookAhead, perturbFuture, scaleBars } from './validation';

const NOW = '2026-11-14T15:00:00Z';
const health: SignalDataHealth = { sourceFailed: false, lastGoodCheckAt: '2026-11-14T14:30:00Z', expectedLatestSession: '2026-11-13', presentLatestSession: '2026-11-13' };

const gauss = (r: () => number): number => {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
};
const DATES = sessionsBetween('2008-01-02', '2026-11-13');
/** Series of n sessions ending 2026-11-13 from per session log returns. */
const build = (n: number, step: (i: number) => number): Bar[] => {
  const dates = DATES.slice(DATES.length - n);
  let lp = Math.log(100);
  let prev = 100;
  return dates.map((date, i) => {
    lp += step(i);
    const close = Math.exp(lp);
    const bar: Bar = { date, open: prev, high: Math.max(prev, close), low: Math.min(prev, close), close, volume: 1_000_000 };
    prev = close;
    return bar;
  });
};
/**
 * Planted edge: 126 session up and down regimes, switch points offset so that every 21 session
 * grid anchor sits at least ten sessions inside a regime. Direction over 5 and 10 sessions is
 * then decided by the regime, which the moving average inputs observe.
 */
const planted = (n: number, seed: number, shift = 0): Bar[] => {
  const r = mulberry32(seed);
  return build(n, (i) => (Math.floor((i + shift + 126 - 11) / 126) % 2 === 0 ? 0.004 : -0.004) + 0.0008 * gauss(r));
};
const noise = (n: number, seed: number): Bar[] => {
  const r = mulberry32(seed);
  return build(n, () => 0.015 * gauss(r));
};
const N_PLANTED = 1260 + 252 * 6 + 60;
const score = (bars: readonly Bar[], extra: Partial<Parameters<typeof computeSignalScore>[0]> = {}): SignalScore =>
  computeSignalScore({ symbol: 'TEST', bars, health, now: NOW, ...extra });

describe('data gate', () => {
  it('passes a fresh check with complete history', () => {
    expect(signalDataGate(health, NOW)).toMatchObject({ status: 'ok', ageMinutes: 30, limitMinutes: 120 });
    expect(signalDataGate({ ...health, lastGoodCheckAt: '2026-11-14T13:00:00Z' }, NOW).status).toBe('ok'); // exactly 120 minutes
  });
  it('a single source failure disables the score despite an earlier success', () => {
    const g = signalDataGate({ ...health, sourceFailed: true, failure: 'Daily history request failed' }, NOW);
    expect(g.status).toBe('stale');
    expect(g.lastGoodCheckAt).toBe('2026-11-14T14:30:00Z');
    expect(g.reason).toBe('A required source failed its latest check. Daily history request failed. Last good check 2026-11-14T14:30:00Z');
  });
  it('an overdue, missing, future or invalid check fails closed', () => {
    expect(signalDataGate({ ...health, lastGoodCheckAt: '2026-11-14T12:59:00Z' }, NOW).status).toBe('stale');
    expect(signalDataGate({ ...health, lastGoodCheckAt: '2026-11-14T16:00:00Z' }, NOW).status).toBe('stale');
    expect(signalDataGate({ ...health, lastGoodCheckAt: null }, NOW).status).toBe('unavailable');
    expect(signalDataGate({ ...health, lastGoodCheckAt: 'not a time' }, NOW).status).toBe('unavailable');
  });
  it('lagging completed history is stale', () => {
    expect(signalDataGate({ ...health, presentLatestSession: '2026-11-12' }, NOW).status).toBe('stale');
    expect(signalDataGate({ ...health, presentLatestSession: null }, NOW).status).toBe('stale');
  });
  it('a failed gate withholds every horizon and computes nothing', () => {
    const bars = planted(N_PLANTED, 7);
    const s = score(bars, { health: { ...health, sourceFailed: true } });
    expect(s.gate.status).toBe('stale');
    for (const h of s.horizons) {
      expect(h.status).toBe('stale');
      expect(h.buy).toBeNull();
      expect(h.sell).toBeNull();
      expect(h.evidence).toEqual([]);
      expect(h.reasons[0]).toMatch(/Last good check 2026-11-14T14:30:00Z/);
    }
    expect(score(bars, { health: { ...health, lastGoodCheckAt: null } }).horizons.every((h) => h.status === 'unavailable')).toBe(true);
  });
  it('an incomplete latest date in the series itself is stale even when health metadata looks fine', () => {
    const s = score(planted(N_PLANTED, 7).slice(0, -1));
    expect(s.gate.status).toBe('stale');
    expect(s.gate.reason).toMatch(/Completed history ends 2026-11-12, expected 2026-11-13/);
    expect(s.horizons.every((h) => h.status === 'stale' && h.buy === null)).toBe(true);
  });
});

describe('planted edge', () => {
  const bars = planted(N_PLANTED, 7);
  const s = score(bars);
  it('passes the gate for 5 and 10 sessions and reports the evidence behind it', () => {
    for (const h of s.horizons.filter((x) => x.horizon !== 20)) {
      expect(h.status).toBe('valid');
      expect(h.reasons).toEqual([]);
      // The anchor sits inside a down regime.
      expect(h.buy!).toBeLessThan(0.1);
      expect(h.buy!).toBeGreaterThanOrEqual(SIGNAL_DEFAULTS.probabilityFloor);
      expect(h.sell!).toBeCloseTo(1 - h.buy!, 12);
      expect(h.interval!.lo).toBeLessThanOrEqual(h.buy!);
      expect(h.interval!.hi).toBeGreaterThanOrEqual(h.buy!);
      const e = h.evaluation!;
      expect(e.blocks).toHaveLength(6);
      expect(e.blocks.every((b) => b.ready && b.beatsBaseline && b.forecasts === 12 && b.calendarSessionsMissing === 0)).toBe(true);
      expect(e.brier!).toBeLessThan(0.05);
      expect(e.baselineBrier!).toBeGreaterThan(0.2);
      expect(e.hitRate!.rate).toBeGreaterThan(0.9);
      expect(h.usableInputs).toBeGreaterThanOrEqual(2);
      expect(h.matches).toBeGreaterThanOrEqual(10);
      expect(h.comparable!.median).toBeLessThan(0);
      expect(h.comparable!.medianWorstCloseDrawdown).toBeLessThanOrEqual(0);
      expect(h.comparable!.p10).toBeLessThanOrEqual(h.comparable!.p90);
    }
  });
  it('gives the opposite side when the anchor sits in an up regime', () => {
    const up = score(planted(N_PLANTED, 7, 126));
    const h = up.horizons[1]!;
    expect(h.status).toBe('valid');
    expect(h.buy!).toBeGreaterThan(0.9);
    expect(h.buy!).toBeLessThanOrEqual(1 - SIGNAL_DEFAULTS.probabilityFloor);
  });
  it('sorts active evidence by absolute contribution and keeps inactive inputs last', () => {
    const ev = s.horizons[1]!.evidence;
    expect(ev).toHaveLength(22);
    const firstInactive = ev.findIndex((e) => !e.active);
    const active = firstInactive < 0 ? ev : ev.slice(0, firstInactive);
    expect(ev.slice(active.length).every((e) => !e.active && e.contribution === 0 && e.estimate === null && !!e.inactiveReason)).toBe(true);
    for (let i = 1; i < active.length; i++) expect(Math.abs(active[i - 1]!.contribution)).toBeGreaterThanOrEqual(Math.abs(active[i]!.contribution));
    expect(new Set(ev.map((e) => e.id)).size).toBe(22);
    expect(ev.find((e) => e.id === 'earnings')!.active).toBe(false);
    expect(ev.every((e) => !/NaN|undefined|—|–/.test(e.context))).toBe(true);
  });
  it('stores the horizon, target and sell definition with every response', () => {
    const h = s.horizons[1]!;
    expect(s.horizons.map((x) => x.horizon)).toEqual([5, 10, 20]);
    expect(h.target).toBe('Close after 10 completed sessions above the anchor close');
    expect(h.sellDefinition).toBe('No higher close after 10 completed sessions. Includes flat closes');
    expect(h.registration).toEqual(signalRegistration(10));
    expect(h.registration.split).toEqual({ burnIn: 1260, blockSize: 252, spacing: 21, embargo: 21, minBlocks: 3, minForecastsPerBlock: 10 });
    expect(s.asOf).toBe('2026-11-13');
    expect(s.modelVersion).toBe('signal-score-v1');
    expect(SIGNAL_PROVENANCE.embargo).toBe('spec');
    expect(SIGNAL_PROVENANCE.priorMass).toBe('proposed');
  });
  it('enforces the 21 session grid and the strict embargo', () => {
    const n = bars.length;
    for (const h of s.horizons) {
      const rows = h.evaluation!.rows;
      expect(rows.every((r) => r.index % 21 === 0 && r.index >= 1260)).toBe(true);
      // Every own stock case behind the anchor satisfies case index + horizon + 21 < issue index.
      for (const e of h.evidence) {
        if (!e.matchRange) continue;
        const lastIdx = bars.findIndex((b) => b.date === e.matchRange!.last);
        expect(lastIdx % 21).toBe(0);
        expect(lastIdx + h.horizon + 21).toBeLessThan(n - 1);
      }
      // The anchor baseline counts every earlier day with a matured, embargoed label.
      expect(h.baseline!.n).toBe(n - 1 - h.horizon - 21);
    }
  });
  it('future block labels never change an earlier block forecast', () => {
    const cut = 1260 + 2 * 252 - 1; // last session of the second block
    const other = score(perturbFuture(bars, cut));
    for (let k = 0; k < 3; k++) {
      const a = s.horizons[k]!.evaluation!.rows.filter((r) => r.index <= cut);
      const b = other.horizons[k]!.evaluation!.rows.filter((r) => r.index <= cut);
      expect(a).toHaveLength(24);
      expect(b).toEqual(a);
    }
    const compute = (x: readonly Bar[]) => computeSignalScore({ symbol: 'TEST', bars: x, health: { ...health, expectedLatestSession: x[x.length - 1]!.date, presentLatestSession: x[x.length - 1]!.date }, now: NOW });
    expect(() => assertNoLookAhead(compute, (r, c) => r.horizons.map((h) => h.evaluation!.rows.filter((row) => row.index <= c)), bars, cut)).not.toThrow();
  });
  it('scaling every price by one factor changes nothing', () => {
    const scaled = score(scaleBars(bars, 4));
    expect(scaled.horizons.map((h) => [h.status, h.buy, h.usableInputs, h.matches])).toEqual(s.horizons.map((h) => [h.status, h.buy, h.usableInputs, h.matches]));
    expect(scaled.horizons[1]!.evidence.map((e) => [e.id, e.state, e.contribution])).toEqual(s.horizons[1]!.evidence.map((e) => [e.id, e.state, e.contribution]));
  });
});

describe('withholding', () => {
  it('pure noise never gets a number', () => {
    for (const seed of [1, 2, 3]) {
      const s = score(noise(3000, seed));
      for (const h of s.horizons) {
        expect(['not-reliable', 'insufficient-evidence']).toContain(h.status);
        expect(h.buy).toBeNull();
        expect(h.sell).toBeNull();
        expect(h.interval).toBeNull();
        expect(h.reasons.length).toBeGreaterThan(0);
        // The evidence stays inspectable while the number is withheld.
        expect(h.evidence.length).toBe(22);
        expect(h.evaluation!.blocks.length).toBe(6);
      }
    }
  });
  it('a flat series has no higher closes and no model', () => {
    const s = score(build(2100, () => 0));
    for (const h of s.horizons) {
      expect(h.baseline).toEqual({ rate: 0, hits: 0, n: 2100 - 1 - h.horizon - 21 });
      expect(h.status).toBe('insufficient-evidence');
      expect(h.buy).toBeNull();
    }
  });
  it('short history is insufficient evidence', () => {
    const s = score(planted(1260 + 2 * 252, 7));
    for (const h of s.horizons) {
      expect(h.status).toBe('insufficient-evidence');
      expect(h.reasons.join(' ')).toMatch(/Only 2 complete evaluation blocks, needs 3/);
      expect(h.buy).toBeNull();
    }
    const tiny = score(planted(300, 7));
    expect(tiny.horizons.every((h) => h.status === 'insufficient-evidence' && h.evaluation!.blocks.length === 0)).toBe(true);
  });
});

describe('group and pool evidence', () => {
  const own = planted(700, 21);
  const peerA = planted(N_PLANTED, 31);
  const peerB = planted(N_PLANTED, 41);
  const groupN = (s: SignalScore, id: string) => s.horizons[1]!.evidence.find((e) => e.id === id)!;
  it('a sparse stock borrows dated group cases and labels the origin', () => {
    const alone = score(own);
    const withGroup = score(own, { peers: [{ symbol: 'PA', bars: peerA, origin: 'group' }] });
    const month = groupN(withGroup, 'month');
    expect(groupN(alone, 'month').group).toBeNull();
    expect(month.group!.n).toBeGreaterThanOrEqual(10);
    expect(['stock', 'group']).toContain(month.origin);
    expect(month.retrospectiveGroup).toBe(true);
    expect(withGroup.horizons[1]!.matches).toBeGreaterThan(alone.horizons[1]!.matches);
    // Still withheld: the stock itself has too little history for held out blocks.
    expect(withGroup.horizons[1]!.status).toBe('insufficient-evidence');
  });
  it('uses at most one case per calendar date and respects the membership start', () => {
    const one = score(own, { peers: [{ symbol: 'PA', bars: peerA, origin: 'group' }] });
    const twin = score(own, { peers: [{ symbol: 'PA', bars: peerA, origin: 'group' }, { symbol: 'PB', bars: peerB, origin: 'group' }] });
    // Both peers share the same grid dates, so the second adds no further cases.
    const total = (s: SignalScore) => groupN(s, 'month').group!.n;
    expect(total(twin)).toBe(total(one));
    // Cases before the dated membership start are not used.
    const dated = score(own, { peers: [{ symbol: 'PA', bars: peerA, origin: 'group', memberSince: '2022-01-03' }] });
    expect(total(dated)).toBeGreaterThan(0);
    expect(total(dated)).toBeLessThan(total(one));
    expect(groupN(dated, 'month').retrospectiveGroup).toBe(false);
    const never = score(own, { peers: [{ symbol: 'PA', bars: peerA, origin: 'group', memberSince: '2027-01-01' }] });
    expect(groupN(never, 'month').group).toBeNull();
    // The stock passed as its own peer is ignored.
    const self = score(own, { peers: [{ symbol: 'TEST', bars: peerA, origin: 'group' }] });
    expect(groupN(self, 'month').group).toBeNull();
  });
  it('pooled cases move the global anchor and are labeled as pool', () => {
    const pooled = score(own, { peers: [{ symbol: 'PA', bars: peerA, origin: 'pool' }] });
    const e = groupN(pooled, 'month');
    expect(e.pool!.n).toBeGreaterThanOrEqual(10);
    expect(e.group).toBeNull();
    expect(e.active).toBe(true);
  });
});

describe('fixture smoke', () => {
  const inst = (sym: string) => INSTRUMENTS.find((i) => i.symbol === sym)!;
  const spy = syntheticDaily(inst('SPY')).bars;
  const xlk = syntheticDaily(inst('XLK')).bars;
  it('scores a long history inside the time budget and never shows a number without a valid status', () => {
    const bars = syntheticDaily(inst('NVDA')).bars;
    const t0 = performance.now();
    const s = score(bars, { symbol: 'NVDA', spyBars: spy, groupBars: xlk, groupLabel: 'XLK', earnings: syntheticEarnings(inst('NVDA')) as EarningsEvent[], dataVersion: 'synthetic-v1' });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(s.dataVersion).toBe('synthetic-v1');
    expect(s.horizons).toHaveLength(3);
    for (const h of s.horizons) {
      expect(['valid', 'not-reliable', 'insufficient-evidence']).toContain(h.status);
      if (h.status !== 'valid') expect(h.buy).toBeNull();
      expect(h.evidence).toHaveLength(22);
      expect(h.evaluation!.blocks.length).toBe(Math.floor((bars.length - 1260) / 252));
      expect(h.evaluation!.coverage.historyFrom).toBe('1999-01-22');
      expect(h.evidence.find((e) => e.id === 'earnings')!.state).not.toBeNull();
    }
  });
  it('withholds a short history', () => {
    const s = score(syntheticDaily(inst('SNDK')).bars, { symbol: 'SNDK', spyBars: spy });
    expect(s.asOf).toBe('2026-11-13');
    for (const h of s.horizons) {
      expect(h.status).toBe('insufficient-evidence');
      expect(h.buy).toBeNull();
      expect(h.evaluation!.forecasts).toBe(0);
    }
  });
});
