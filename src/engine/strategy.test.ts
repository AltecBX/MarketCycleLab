import { describe, expect, it } from 'vitest';
import { isNa, type Bar } from './core/types';
import { BOUNCE_BELOW_SMA200, LAB_DEFAULTS, STRATEGY_DEFAULTS, auditRule, labAnalogOutcomes, scanSignals, type Rule } from './strategy';
import { seriesFromCloses, syntheticDaily } from '../data/fixtures/synthetic';
import { INSTRUMENTS } from '../data/fixtures/universe';

const scale = (bs: readonly Bar[], k: number): Bar[] => bs.map((b) => ({ ...b, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k }));

const BOUNCE: Rule = {
  id: 't-bounce',
  label: 'Up 5% over two sessions',
  conditions: [{ kind: 'move', sessions: 2, atLeast: 0.05 }],
  trigger: 'first-session',
  entry: 'signal-close',
  horizon: 2,
};

const closes = [100, 100, 100, 106, 107, 100, 100, 106, 104, 102, 101, 100];
const bars = seriesFromCloses(closes, '2026-10-01');

describe('signal scan', () => {
  it('fires on the first session the conditions hold after a session they did not', () => {
    const s = scanSignals(bars, BOUNCE);
    expect(s.signals).toEqual([3, 7]);
    expect(s.firstEvaluable).toBe(2);
    expect(s.unevaluable).toBe(2);
    expect(s.priorUnknownSkipped).toBe(0);
    expect(scanSignals(bars, { ...BOUNCE, trigger: 'every-session' }).signals).toEqual([3, 4, 7]);
  });
  it('skips a first session trigger whose prior state is unknown', () => {
    const s = scanSignals(seriesFromCloses([100, 100, 110, 111, 100, 100, 110]), BOUNCE);
    expect(s.priorUnknownSkipped).toBe(1);
    expect(s.signals).toEqual([6]);
  });
  it('evaluates drawdown, moving average and relative conditions from past data only', () => {
    const dd = scanSignals(seriesFromCloses([100, 120, 110, 95, 97, 130, 103]), {
      ...BOUNCE,
      conditions: [{ kind: 'drawdown', atLeast: 0.2 }],
    });
    expect(dd.signals).toEqual([3, 6]); // 95/120 and 103/130 are both at least 20% below the running peak
    const ma = scanSignals(seriesFromCloses([10, 10, 10, 9, 9, 12, 12]), { ...BOUNCE, conditions: [{ kind: 'sma', n: 3, side: 'below' }] });
    expect(ma.signals).toEqual([3]);
    expect(ma.firstEvaluable).toBe(2);
    const stock = seriesFromCloses([100, 100, 110, 110, 121]);
    const bench = seriesFromCloses([100, 100, 102, 102, 110]);
    const rel: Rule = { ...BOUNCE, conditions: [{ kind: 'relative', sessions: 1, atLeast: 0.05 }] };
    expect(scanSignals(stock, rel, bench).signals).toEqual([2]); // +10% against +2%, then +10% against +7.8%
    const holes = scanSignals(stock, rel, bench.filter((_, i) => i !== 1));
    expect(holes.signals).toEqual([]);
    expect(holes.unevaluable).toBe(3); // sessions 0, 1 and 2 have no usable benchmark pair
    expect(scanSignals(stock, rel).evaluable).toBe(0); // no benchmark supplied
  });
});

describe('rule audit', () => {
  it('applies entry timing and per side cost by hand', () => {
    const a = auditRule(bars, BOUNCE, { holdoutFrom: '2099-01-01' });
    expect(isNa(a)).toBe(false);
    if (isNa(a)) return;
    expect(a.rows.map((r) => r.signalIndex)).toEqual([3, 7]);
    const r0 = a.rows[0]!;
    expect(r0.entryDate).toBe(bars[3]!.date);
    expect(r0.entryPrice).toBe(106);
    expect(r0.exitDate).toBe(bars[5]!.date);
    expect(r0.gross).toBeCloseTo(100 / 106 - 1, 12);
    expect(r0.net).toBeCloseTo((100 * (1 - 0.0005)) / (106 * (1 + 0.0005)) - 1, 12);
    expect(r0.maxCloseRet).toBeCloseTo(107 / 106 - 1, 12);
    expect(r0.minCloseRet).toBeCloseTo(100 / 106 - 1, 12);
    expect(a.costBps).toBe(STRATEGY_DEFAULTS.costBps);
    expect(a.resultKind).toBe('conditional-price-outcomes');
    expect(isNa(a.simulation) && a.simulation.code).toBe('not-applicable');
    expect(a.all.n).toBe(2);
    expect(a.all.win).toMatchObject({ hits: 0, n: 2 });
    const zero = auditRule(bars, BOUNCE, { costBps: 0, holdoutFrom: '2099-01-01' });
    expect(!isNa(zero) && zero.rows[0]!.net).toBeCloseTo(100 / 106 - 1, 12);
  });
  it('enters at the next open when declared', () => {
    const custom = bars.map((b) => ({ ...b }));
    custom[4] = { ...custom[4]!, open: 108, high: 108 };
    const a = auditRule(custom, { ...BOUNCE, entry: 'next-open' }, { holdoutFrom: '2099-01-01', costBps: 0 });
    expect(isNa(a)).toBe(false);
    if (isNa(a)) return;
    expect(a.rows[0]!.entryDate).toBe(custom[4]!.date);
    expect(a.rows[0]!.entryPrice).toBe(108);
    expect(a.rows[0]!.exitDate).toBe(custom[5]!.date);
    expect(a.rows[0]!.gross).toBeCloseTo(100 / 108 - 1, 12);
  });
  it('keeps holds from overlapping and counts unmatured signals', () => {
    const up = seriesFromCloses(Array.from({ length: 12 }, (_, i) => 100 * 1.03 ** i));
    const rule: Rule = { ...BOUNCE, trigger: 'every-session', horizon: 3 };
    const a = auditRule(up, rule, { holdoutFrom: '2099-01-01' });
    expect(isNa(a)).toBe(false);
    if (isNa(a)) return;
    expect(a.scan.signals).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(a.notMatured).toBe(3); // signals at 9, 10 and 11 have no completed three session window
    expect(a.rows.map((r) => r.signalIndex)).toEqual([2, 5, 8]);
    expect(a.overlapDropped).toBe(4);
  });
  it('compares with the baseline over the same dates', () => {
    const a = auditRule(bars, BOUNCE, { holdoutFrom: '2099-01-01', costBps: 0 });
    if (isNa(a)) throw new Error('unexpected');
    // Baseline: every session from the first evaluable index (2) to the last matured index (9).
    const expected = [2, 3, 4, 5, 6, 7, 8, 9].map((i) => closes[i + 2]! / closes[i]! - 1);
    expect(a.all.baseline.allSessions).toBe(8);
    expect(a.all.baseline.allWinRate).toBeCloseTo(expected.filter((x) => x > 0).length / 8, 12);
    expect(a.all.baseline.spaced).toBe(4);
    expect(a.all.from).toBe(bars[2]!.date);
    expect(a.all.to).toBe(bars[9]!.date);
    expect(typeof a.all.winRateDiffPp).toBe('number');
  });
  it('splits selection and holdout, embargoes the boundary and withholds a thin verdict', () => {
    const a = auditRule(bars, BOUNCE, { holdoutFrom: bars[8]!.date });
    if (isNa(a)) throw new Error('unexpected');
    expect(a.splitDate).toBe(bars[8]!.date);
    // The signal at 3 exits at 5, inside selection. The signal at 7 exits at 9, across the split.
    expect(a.rows.map((r) => [r.signalIndex, r.segment])).toEqual([[3, 'selection']]);
    expect(a.embargoed).toBe(1);
    expect(a.selection.n).toBe(1);
    expect(a.holdout.n).toBe(0);
    expect(a.verdict.status).toBe('insufficient-evidence');
    expect(isNa(a.holdout.medianDiff)).toBe(true);
  });
  it('reports a failure outcome when the rule defines one', () => {
    const rule: Rule = { ...BOUNCE, failure: { kind: 'close-below-prior-low', lookback: 2 } };
    const a = auditRule(seriesFromCloses([101, 100, 100, 106, 107, 99, 100, 106, 104, 102, 101, 100]), rule, { holdoutFrom: '2099-01-01' });
    if (isNa(a)) throw new Error('unexpected');
    expect(a.rows[0]).toMatchObject({ failed: true, failOffset: 2, failLevel: 100 });
    expect(a.rows[1]).toMatchObject({ failed: false, failOffset: null, failLevel: 99 });
    expect(a.all.failure).toMatchObject({ hits: 1, n: 2 });
  });
  it('adds a simulation only when exposure, compounding and equity are specified', () => {
    const a = auditRule(bars, BOUNCE, { holdoutFrom: '2099-01-01', costBps: 0, simulation: { initialEquity: 1000, exposure: 0.5, compounding: true } });
    if (isNa(a) || isNa(a.simulation)) throw new Error('unexpected');
    const r1 = 100 / 106 - 1;
    const r2 = 102 / 106 - 1;
    const e1 = 1000 * (1 + 0.5 * r1);
    const e2 = e1 * (1 + 0.5 * r2);
    expect(a.simulation.finalEquity).toBeCloseTo(e2, 9);
    expect(a.simulation.totalReturn).toBeCloseTo(e2 / 1000 - 1, 12);
    expect(a.simulation.maxDrawdown).toBeCloseTo(e2 / 1000 - 1, 12);
    expect(a.simulation.label).toBe('Specified simulation');
    const bad = auditRule(bars, BOUNCE, { simulation: { initialEquity: 1000, exposure: 2, compounding: false } });
    expect(!isNa(bad) && isNa(bad.simulation) && bad.simulation.code).toBe('invalid-input');
  });
  it('rejects an empty rule and an unevaluable history', () => {
    const empty = auditRule(bars, { ...BOUNCE, conditions: [] });
    expect(isNa(empty) && empty.code).toBe('invalid-input');
    const short = auditRule(bars, BOUNCE_BELOW_SMA200);
    expect(isNa(short) && short.code).toBe('insufficient-history');
  });
  it('is unchanged by later rows and by a price scale factor', () => {
    const nvda = syntheticDaily(INSTRUMENTS.find((i) => i.symbol === 'NVDA')!).bars.slice(-1500);
    const opts = { holdoutFrom: nvda[1000]!.date };
    const full = auditRule(nvda, BOUNCE_BELOW_SMA200, opts);
    const k = 1200;
    const prefix = auditRule(nvda.slice(0, k), BOUNCE_BELOW_SMA200, opts);
    if (isNa(full) || isNa(prefix)) throw new Error('unexpected');
    expect(prefix.rows).toEqual(full.rows.filter((r) => r.signalIndex + BOUNCE_BELOW_SMA200.horizon <= k - 1));
    const scaled = auditRule(scale(nvda, 2.5), BOUNCE_BELOW_SMA200, opts);
    if (isNa(scaled)) throw new Error('unexpected');
    expect(scaled.rows.map((r) => r.signalDate)).toEqual(full.rows.map((r) => r.signalDate));
    scaled.rows.forEach((r, i) => expect(r.net).toBeCloseTo(full.rows[i]!.net, 10));
  });
});

describe('Lab analog rule', () => {
  const long = seriesFromCloses(Array.from({ length: 600 }, (_, i) => 100 + (i % 7) + i * 0.1), '2020-01-02');
  it('requires 30 non overlapping supports for a frequency', () => {
    expect(LAB_DEFAULTS.minSupport).toBe(30);
    expect(LAB_DEFAULTS.horizons).toEqual([1, 5, 10, 15]);
    const thirty = Array.from({ length: 30 }, (_, i) => i * 15);
    const ok = labAnalogOutcomes(long, thirty);
    expect(ok.horizons.map((h) => h.support)).toEqual([30, 30, 30, 30]);
    for (const h of ok.horizons) expect(isNa(h.frequency)).toBe(false);
    const twentyNine = thirty.slice(0, 29);
    const thin = labAnalogOutcomes(long, twentyNine);
    for (const h of thin.horizons) {
      expect(isNa(h.frequency) && h.frequency.code).toBe('sample-too-small');
      expect(h.support).toBe(29);
      expect(h.summary.returns).not.toBeNull(); // the description stays available
    }
  });
  it('counts overlap and maturity before the gate', () => {
    const dense = Array.from({ length: 40 }, (_, i) => i * 5); // 40 anchors five sessions apart
    const r = labAnalogOutcomes(long, dense);
    const h15 = r.horizons.find((h) => h.horizon === 15)!;
    expect(h15.support).toBe(14);
    expect(h15.overlapDropped).toBe(26);
    expect(isNa(h15.frequency)).toBe(true);
    const h5 = r.horizons.find((h) => h.horizon === 5)!;
    expect(h5.support).toBe(40);
    expect(isNa(h5.frequency)).toBe(false);
    const tail = labAnalogOutcomes(long, [590, 598]);
    expect(tail.horizons.find((h) => h.horizon === 10)!.notMatured).toBe(1); // 598 is dropped as overlapping, 590 cannot mature
  });
});

describe('fixture smoke test', () => {
  it('audits the example rule on a long and a short synthetic history', () => {
    for (const sym of ['NVDA', 'SNDK']) {
      const bars = syntheticDaily(INSTRUMENTS.find((i) => i.symbol === sym)!).bars;
      const a = auditRule(bars, BOUNCE_BELOW_SMA200);
      expect(isNa(a)).toBe(false);
      if (isNa(a)) continue;
      expect(a.all.n).toBe(a.rows.length);
      expect(a.selection.n + a.holdout.n).toBe(a.rows.length);
      for (let i = 1; i < a.rows.length; i++) expect(a.rows[i]!.signalIndex - a.rows[i - 1]!.signalIndex).toBeGreaterThanOrEqual(20);
      expect(['valid', 'not-reliable', 'insufficient-evidence']).toContain(a.verdict.status);
      expect(a.note).toMatch(/Not simulated trading performance/);
      if (sym === 'SNDK') expect(a.verdict.status).toBe('insufficient-evidence');
    }
  });
});
