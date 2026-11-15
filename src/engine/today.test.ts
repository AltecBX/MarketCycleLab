import { describe, expect, it } from 'vitest';
import { isNa, na, type Bar, type EarningsEvent, type Instrument } from './core/types';
import { DEFAULT_ALERT_CONFIG, evaluateAlerts, newAlerts, sortAlerts, todaySummary, type Alert, type AlertEvaluation, type TodayInput } from './today';
import { fixtureSource, seriesFromCloses, syntheticDaily, syntheticEarnings } from '../data/fixtures/synthetic';
import { INSTRUMENTS } from '../data/fixtures/universe';
import type { SourceHealth } from '../data/contracts';

const src = fixtureSource();
const stock: Pick<Instrument, 'id' | 'symbol' | 'name' | 'type'> = { id: 'us:test', symbol: 'TEST', name: 'Test Corp', type: 'stock' };
const fund: Pick<Instrument, 'id' | 'symbol' | 'name' | 'type'> = { id: 'us:fund', symbol: 'FUND', name: 'Test Fund', type: 'etf' };
const ev = (date: string, extra: Partial<EarningsEvent> = {}): EarningsEvent => ({ instrumentId: 'us:test', symbol: 'TEST', date, time: 'amc', status: 'confirmed', source: src, ...extra });
const today = '2026-11-14';
const flat = (n: number, v = 100) => new Array<number>(n).fill(v);
const run = (bars: readonly Bar[], earnings: readonly EarningsEvent[] = [], extra = {}): AlertEvaluation => {
  const r = evaluateAlerts({ instrument: stock, bars, earnings, today, ...extra });
  if (isNa(r)) throw new Error('unexpected refusal');
  return r;
};
const rules = (r: AlertEvaluation) => r.alerts.map((a) => a.rule);
const scale = (bs: readonly Bar[], k: number): Bar[] => bs.map((b) => ({ ...b, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k }));

describe('alert rules at the default thresholds', () => {
  it('flags known earnings within seven calendar days', () => {
    const quiet = seriesFromCloses(flat(5));
    const seven = run(quiet, [ev('2026-11-21')]);
    expect(rules(seven)).toEqual(['earnings-soon']);
    expect(seven.alerts[0]).toMatchObject({ date: '2026-11-21', state: 'confirmed', value: 7, key: 'us:test|2026-11-21|earnings-soon|confirmed' });
    expect(rules(run(quiet, [ev('2026-11-22')]))).toEqual([]);
    expect(rules(run(quiet, [ev('2026-11-14')]))).toEqual(['earnings-soon']);
    const none = run(quiet, [ev('2026-08-01')]);
    expect(none.alerts).toEqual([]);
    expect(none.withheld.filter((w) => w.rule === 'earnings-soon').map((w) => w.reason.code)).toEqual(['no-coverage']);
    const etf = evaluateAlerts({ instrument: fund, bars: quiet, earnings: na('not-applicable'), today });
    expect(!isNa(etf) && etf.alerts.length === 0 && etf.withheld.every((w) => w.rule !== 'earnings-soon')).toBe(true);
  });
  it('flags a 5% down session, including the exact threshold', () => {
    expect(rules(run(seriesFromCloses([100, 100, 95]), [ev('2027-02-01')]))).toEqual(['down-session']);
    expect(rules(run(seriesFromCloses([100, 100, 95.1]), [ev('2027-02-01')]))).toEqual([]);
    const a = run(seriesFromCloses([100, 100, 90]), [ev('2027-02-01')]).alerts[0]!;
    expect(a.value).toBeCloseTo(-0.1, 12);
    expect(a.severity).toBe('high');
  });
  it('flags a 20% drawdown from the closing high and dates it at the first breach', () => {
    const closes = [90, 100, 96, 92, 88, 84, 81, 80, 79.5];
    const bars = seriesFromCloses(closes);
    const day1 = run(bars.slice(0, 8), [ev('2027-02-01')]);
    expect(rules(day1)).toEqual(['drawdown']);
    expect(day1.alerts[0]!.date).toBe(bars[7]!.date);
    expect(day1.alerts[0]!.value).toBeCloseTo(-0.2, 12);
    const day2 = run(bars, [ev('2027-02-01')]);
    expect(day2.alerts[0]!.key).toBe(day1.alerts[0]!.key); // the same breach keeps one key
    expect(day2.alerts[0]!.value).toBeCloseTo(79.5 / 100 - 1, 12);
    expect(rules(run(bars.slice(0, 7), [ev('2027-02-01')]))).toEqual([]); // 19% is not a breach
  });
  it('uses the highest close inside the lookback window', () => {
    const closes = [200, ...flat(260, 100), 85];
    const bars = seriesFromCloses(closes, '2025-01-02');
    // The 200 close is older than 252 sessions, so the relevant high is 100 and 85 is a 15% drawdown.
    expect(rules(run(bars, [ev('2027-02-01')]))).toContain('down-session');
    expect(rules(run(bars, [ev('2027-02-01')]))).not.toContain('drawdown');
    const whole = evaluateAlerts({ instrument: stock, bars, earnings: [ev('2027-02-01')], today }, { ...DEFAULT_ALERT_CONFIG, drawdownLookback: null });
    expect(!isNa(whole) && whole.alerts.some((a) => a.rule === 'drawdown')).toBe(true);
  });
  it('flags only a new close below the 200 session average', () => {
    const base = [...flat(200), 101];
    const breach = seriesFromCloses([...base, 99], '2025-01-02');
    const r = run(breach, [ev('2027-02-01')]);
    expect(rules(r)).toEqual(['sma200-breach']);
    expect(r.alerts[0]).toMatchObject({ date: breach[breach.length - 1]!.date, state: 'new-breach', severity: 'medium' });
    const dayAfter = seriesFromCloses([...base, 99, 98.5], '2025-01-02');
    expect(rules(run(dayAfter, [ev('2027-02-01')]))).toEqual([]); // already below, not a new breach
    const stillAbove = seriesFromCloses([...base, 100.5], '2025-01-02');
    expect(rules(run(stillAbove, [ev('2027-02-01')]))).toEqual([]);
    const short = run(seriesFromCloses(flat(150)), [ev('2027-02-01')]);
    expect(short.withheld.map((w) => [w.rule, w.reason.code])).toEqual([['sma200-breach', 'insufficient-history']]);
  });
});

describe('alert safety', () => {
  const bars = seriesFromCloses([100, 100, 90]);
  it('refuses provisional and hypothetical inputs', () => {
    const p = evaluateAlerts({ instrument: stock, bars, earnings: [], today, provisional: true });
    expect(isNa(p) && p.code).toBe('invalid-input');
    const h = evaluateAlerts({ instrument: stock, bars, earnings: [], today, hypothetical: true });
    expect(isNa(h) && h.code).toBe('invalid-input');
  });
  it('withholds price rules on stale or failed data instead of reporting an all clear', () => {
    const stale = run(bars, [ev('2027-02-01')], { lastCompletedSession: '2026-11-13' });
    expect(stale.alerts).toEqual([]);
    expect(stale.withheld.map((w) => w.reason.code)).toEqual(['stale-source', 'stale-source', 'stale-source']);
    const failed = evaluateAlerts({ instrument: stock, bars: na('source-failed', 'provider down'), earnings: [ev('2026-11-16')], today });
    expect(!isNa(failed) && failed.alerts.map((a) => a.rule)).toEqual(['earnings-soon']);
    expect(!isNa(failed) && failed.withheld.every((w) => w.reason.code === 'source-failed')).toBe(true);
  });
  it('never duplicates an alert across repeated runs', () => {
    const first = run(bars, [ev('2026-11-16')]).alerts;
    const second = run(bars, [ev('2026-11-16')]).alerts;
    expect(first.map((a) => a.key)).toEqual(second.map((a) => a.key));
    const seen = new Set(first.map((a) => a.key));
    expect(newAlerts(second, seen)).toEqual([]);
    expect(newAlerts([...first, ...second], []).length).toBe(first.length);
    // A confirmation of a previously estimated date is a new state and a new key.
    const estimated = run(bars, [ev('2026-11-16', { status: 'estimated' })]).alerts.find((a) => a.rule === 'earnings-soon')!;
    expect(seen.has(estimated.key)).toBe(false);
  });
  it('orders by severity, then rule, then size', () => {
    const mk = (rule: Alert['rule'], severity: Alert['severity'], value: number, symbol: string): Alert => ({ key: `${symbol}${rule}`, instrumentId: symbol, symbol, rule, date: today, state: 's', severity, title: '', detail: '', value });
    const sorted = sortAlerts([mk('earnings-soon', 'low', 6, 'A'), mk('sma200-breach', 'medium', -0.01, 'B'), mk('down-session', 'high', -0.06, 'C'), mk('down-session', 'high', -0.12, 'D'), mk('drawdown', 'high', -0.25, 'E')]);
    expect(sorted.map((a) => a.symbol)).toEqual(['E', 'D', 'C', 'B', 'A']);
  });
  it('is unchanged by a price scale factor', () => {
    const bars2 = seriesFromCloses([90, 100, 96, 92, 88, 84, 81, 75]);
    const a = run(bars2, [ev('2026-11-16')]);
    const b = run(scale(bars2, 4.2), [ev('2026-11-16')]);
    expect(b.alerts.map((x) => x.key)).toEqual(a.alerts.map((x) => x.key));
    b.alerts.forEach((x, i) => expect(x.value).toBeCloseTo(a.alerts[i]!.value, 12));
  });
});

describe('today summary', () => {
  const health: SourceHealth[] = [
    { id: 'prices', label: 'Daily prices', kind: 'synthetic-fixture', state: 'ok', feeds: ['close'], lastSuccess: null, lastAttempt: null, dataThrough: '2026-11-13' },
    { id: 'earnings', label: 'Earnings dates', kind: 'synthetic-fixture', state: 'failed', feeds: ['next earnings'], lastSuccess: null, lastAttempt: null, dataThrough: null, error: 'timeout' },
  ];
  const mk = (symbol: string, bars: TodayInput['bars'], earnings: TodayInput['earnings'], extra: Partial<TodayInput> = {}): TodayInput => ({
    instrument: { id: `us:${symbol.toLowerCase()}`, symbol, name: `${symbol} Corp`, type: 'stock' },
    bars,
    earnings,
    ...extra,
  });
  const inputs: TodayInput[] = [
    mk('HELD', seriesFromCloses([100, 100, 94], '2026-11-11'), [ev('2026-11-18')], { shares: 10, impliedMove: { perShare: 6, expiry: '2026-11-20' } }),
    mk('DARK', na('source-failed', 'provider down'), [ev('2026-11-19')], { shares: 5 }),
    mk('NOQTY', seriesFromCloses([50, 50, 50], '2026-11-11'), na('source-failed', 'earnings source down'), { shares: null }),
    mk('WATCH', seriesFromCloses([20, 20, 21], '2026-11-11'), [ev('2026-11-17', { status: 'estimated' })]),
  ];
  const s = todaySummary(inputs, { today, lastCompletedSession: '2026-11-13', health });

  it('keeps position dollars separate from watch only names and never counts an unknown as zero', () => {
    expect(s.totals).toEqual({ heldCount: 3, watchOnlyCount: 1, positionDollars: 940, markedCount: 1, unmarked: ['DARK', 'NOQTY'], complete: false });
    const held = s.rows[0]!;
    expect(held.close).toBe(94);
    expect(held.closeDate).toBe('2026-11-13');
    expect(held.dayChange).toBeCloseTo(-0.06, 12);
    expect(held.positionValue).toBe(940);
    const dark = s.rows[1]!;
    expect(isNa(dark.close) && dark.close.code).toBe('source-failed');
    expect(isNa(dark.positionValue) && dark.positionValue.code).toBe('source-failed');
    const noQty = s.rows[2]!;
    expect(isNa(noQty.positionValue) && noQty.positionValue.code).toBe('no-coverage');
    const watch = s.rows[3]!;
    expect(watch.held).toBe(false);
    expect(isNa(watch.positionValue) && watch.positionValue.code).toBe('not-applicable');
    expect(isNa(held.sma200) && held.sma200.code).toBe('insufficient-history');
    expect(!isNa(held.drawdown) && held.drawdown.value).toBeCloseTo(-0.06, 12);
  });
  it('builds the week ahead queue with honest exposure coverage', () => {
    const w = s.weekAhead;
    expect([w.from, w.to]).toEqual(['2026-11-14', '2026-11-20']); // Saturday looks at the coming week
    expect(w.items.map((i) => i.symbol)).toEqual(['WATCH', 'HELD', 'DARK']);
    expect(w.knownExposure).toBe(940);
    expect(w.exposureCovered).toBe(1);
    expect(w.exposureMissing).toEqual(['DARK']);
    expect(w.dateUnknown).toEqual(['NOQTY']);
    const held = w.items.find((i) => i.symbol === 'HELD')!;
    expect(held.impliedHoldingMove).toBe(60);
    expect(held.impliedExpiry).toBe('2026-11-20');
    const watch = w.items.find((i) => i.symbol === 'WATCH')!;
    expect(isNa(watch.exposure) && watch.exposure.code).toBe('not-applicable');
  });
  it('surfaces top flags, selloffs and source health', () => {
    expect(s.topFlags[0]).toMatchObject({ symbol: 'HELD', rule: 'down-session' });
    expect(s.selloffs.map((r) => r.symbol)).toEqual(['HELD']);
    expect(s.topFlags.filter((a) => a.rule === 'earnings-soon').map((a) => a.symbol).sort()).toEqual(['DARK', 'HELD', 'WATCH']);
    expect(new Set(s.topFlags.map((a) => a.key)).size).toBe(s.topFlags.length);
    expect(s.healthIssues.map((h) => h.id)).toEqual(['earnings']);
    expect(s.health.length).toBe(2);
  });
  it('marks a stale position as unmarked', () => {
    const stale = todaySummary([mk('OLD', seriesFromCloses([10, 10, 10], '2026-11-02'), [], { shares: 3 })], { today, lastCompletedSession: '2026-11-13' });
    expect(stale.totals.positionDollars).toBe(0);
    expect(stale.totals.unmarked).toEqual(['OLD']);
    expect(stale.totals.complete).toBe(false);
    const pv = stale.rows[0]!.positionValue;
    expect(isNa(pv) && pv.code).toBe('stale-source');
    expect(stale.rows[0]!.close).toBe(10); // the dated last close is still shown
  });
});

describe('fixture smoke test', () => {
  it('summarizes NVDA, MU and SPY from the synthetic fixture', () => {
    const inputs: TodayInput[] = ['NVDA', 'MU', 'SPY'].map((sym, k) => {
      const inst = INSTRUMENTS.find((i) => i.symbol === sym)!;
      return { instrument: inst, bars: syntheticDaily(inst).bars, earnings: syntheticEarnings(inst), ...(k < 2 ? { shares: 100 } : {}) };
    });
    const s = todaySummary(inputs, { today, lastCompletedSession: '2026-11-13' });
    expect(s.rows.length).toBe(3);
    expect(s.totals.heldCount).toBe(2);
    expect(s.totals.complete).toBe(true);
    for (const r of s.rows) {
      expect(typeof r.close).toBe('number');
      expect(r.closeDate).toBe('2026-11-13');
      expect(isNa(r.sma200)).toBe(false);
      expect(isNa(r.drawdown)).toBe(false);
    }
    const expected = s.rows.slice(0, 2).reduce((a, r) => a + 100 * (r.close as number), 0);
    expect(s.totals.positionDollars).toBeCloseTo(expected, 6);
    const spy = s.rows[2]!;
    expect(isNa(spy.nextEarnings) && spy.nextEarnings.code).toBe('not-applicable');
    expect(isNa(s.rows[0]!.nextEarnings)).toBe(false);
    expect(s.weekAhead.dateUnknown).toEqual([]);
  });
});
