import { describe, expect, it } from 'vitest';
import type { CashFlowPeriod, ForwardEps } from '../data/contracts';
import { isNa, na, type SourceCapture } from './core/types';
import {
  appendObservation, cashOnHand, deriveFcf, fcfForCurrentFilter, forwardPe, latestFcf, observationFromRecord, ownHistoryPercentile,
  peerContext, trailingPe, trailingYearFcf, valuationFacts, type ForwardPeRecord, type QuarterlyEps, type ValuationArchive,
} from './valuation';

const src: SourceCapture = { provider: 'test', kind: 'synthetic-fixture', capturedAt: '2026-11-14T00:00:00Z', version: 't' };
const est = (value: number, over: Partial<ForwardEps> = {}): ForwardEps => ({
  value, asOf: '2026-11-13', horizon: 'FY1', fiscalYearEnd: '2026-12-31', currency: 'USD', source: src, ...over,
});
const pe = (price: number, e: ForwardEps | null, priceDate = '2026-11-13') => forwardPe({ price, priceDate, priceCurrency: 'USD', estimate: e });
const period = (periodEnd: string, ocf: number, capex: number, fcf: number | null, over: Partial<CashFlowPeriod> = {}): CashFlowPeriod => ({
  scope: 'quarter', periodEnd, filedAt: periodEnd.replace(/-\d\d$/, '-28').replace('-09-', '-10-').replace('-06-', '-07-').replace('-03-', '-04-').replace('-12-', '-12-'),
  currency: 'USD', operatingCashFlow: ocf, capex, freeCashFlow: fcf, source: src, ...over,
});

describe('forward P/E', () => {
  it('is price over positive FY1 EPS with a full display record', () => {
    const r = pe(100, est(5));
    expect(isNa(r)).toBe(false);
    if (isNa(r)) return;
    expect(r.value).toBe(20);
    expect(r.basis).toBe('FY1');
    expect(r.priceDate).toBe('2026-11-13');
    expect(r.estimateDate).toBe('2026-11-13');
    expect(r.eps).toBe(5);
    expect(r.source).toBe(src);
  });
  it('never forces a multiple from a non positive estimate', () => {
    for (const e of [-1.2, 0]) {
      const r = pe(100, est(e));
      expect(isNa(r) && r.code).toBe('not-applicable');
      expect(isNa(r) && r.detail).toMatch(/not positive/);
    }
  });
  it('rejects currency, horizon, staleness and ordering problems with reasons', () => {
    expect(isNa(pe(100, null)) && (pe(100, null) as { code: string }).code).toBe('no-coverage');
    const cur = pe(100, est(5, { currency: 'EUR' }));
    expect(isNa(cur) && cur.code).toBe('basis-mismatch');
    const stale = pe(100, est(5, { asOf: '2026-11-02' }));
    expect(isNa(stale) && stale.code).toBe('stale-source');
    const within = pe(100, est(5, { asOf: '2026-11-06' }));
    expect(isNa(within)).toBe(false);
    const future = pe(100, est(5, { asOf: '2026-11-16' }));
    expect(isNa(future) && future.code).toBe('basis-mismatch');
    const ended = pe(100, est(5, { fiscalYearEnd: '2026-09-30' }));
    expect(isNa(ended) && ended.code).toBe('stale-source');
    const passthrough = forwardPe({ price: 100, priceDate: '2026-11-13', priceCurrency: 'USD', estimate: na('no-coverage', 'none') });
    expect(isNa(passthrough) && passthrough.detail).toBe('none');
    const badPrice = pe(0, est(5));
    expect(isNa(badPrice) && badPrice.code).toBe('invalid-input');
    const custom = forwardPe({ price: 100, priceDate: '2026-11-13', priceCurrency: 'USD', estimate: est(5, { asOf: '2026-11-02' }), maxEstimateAgeDays: 30 });
    expect(isNa(custom)).toBe(false);
  });
});

describe('trailing P/E', () => {
  const q = (periodEnd: string, eps: number, over: Partial<QuarterlyEps> = {}): QuarterlyEps => ({ periodEnd, eps, basis: 'gaap', currency: 'USD', ...over });
  const four = [q('2026-09-30', 1), q('2026-06-30', -0.2), q('2026-03-31', 0.5), q('2025-12-31', 0.7)];
  it('sums four consecutive comparable quarters, allowing a negative quarter', () => {
    const r = trailingPe({ price: 50, priceDate: '2026-11-13', priceCurrency: 'USD', quarters: [...four, q('2025-09-30', 9)] });
    expect(isNa(r)).toBe(false);
    if (isNa(r)) return;
    expect(r.epsSum).toBeCloseTo(2, 12);
    expect(r.value).toBeCloseTo(25, 12);
    expect(r.quarters.map((x) => x.periodEnd)).toEqual(['2026-09-30', '2026-06-30', '2026-03-31', '2025-12-31']);
  });
  it('withholds on a non positive sum, too few quarters, mixed basis or a gap', () => {
    const neg = trailingPe({ price: 50, priceDate: '2026-11-13', priceCurrency: 'USD', quarters: four.map((x) => ({ ...x, eps: -Math.abs(x.eps) })) });
    expect(isNa(neg) && neg.code).toBe('not-applicable');
    const three = trailingPe({ price: 50, priceDate: '2026-11-13', priceCurrency: 'USD', quarters: four.slice(0, 3) });
    expect(isNa(three) && three.code).toBe('insufficient-history');
    const mixed = trailingPe({ price: 50, priceDate: '2026-11-13', priceCurrency: 'USD', quarters: [...four.slice(0, 3), q('2025-12-31', 0.7, { basis: 'adjusted' })] });
    expect(isNa(mixed) && mixed.code).toBe('insufficient-history');
    const gap = trailingPe({ price: 50, priceDate: '2026-11-13', priceCurrency: 'USD', quarters: [...four.slice(0, 3), q('2025-09-30', 0.7)] });
    expect(isNa(gap) && gap.code).toBe('basis-mismatch');
  });
  it('uses only quarters published by the price date', () => {
    const quarters = [q('2026-09-30', 5, { reportedAt: '2026-11-20' }), ...four.slice(1), q('2025-09-30', 0.4)];
    const r = trailingPe({ price: 28, priceDate: '2026-11-13', priceCurrency: 'USD', quarters });
    expect(isNa(r)).toBe(false);
    if (!isNa(r)) expect(r.epsSum).toBeCloseTo(-0.2 + 0.5 + 0.7 + 0.4, 12);
  });
});

describe('valuation archive and context', () => {
  const obs = (date: string, value: number) => ({ date, value, basis: 'FY1' as const, currency: 'USD', source: src });
  it('is append only and refuses backfill', () => {
    let a: ValuationArchive = [];
    let r = appendObservation(a, obs('2026-11-10', 20));
    expect(r.appended).toBe(true);
    a = r.archive;
    r = appendObservation(a, obs('2026-11-10', 99));
    expect(r.appended).toBe(false);
    expect(r.archive).toBe(a);
    expect(a[0]!.value).toBe(20);
    r = appendObservation(a, obs('2026-11-05', 18));
    expect(r.appended).toBe(false);
    expect(r.reason).toMatch(/backfill/);
    r = appendObservation(a, obs('2026-11-11', -3));
    expect(r.appended).toBe(false);
    const rec = pe(100, est(5)) as ForwardPeRecord;
    expect(observationFromRecord(rec)).toMatchObject({ date: '2026-11-13', value: 20, basis: 'FY1' });
  });
  it('needs ten compatible earlier captures for an own history percentile', () => {
    const mk = (n: number): ValuationArchive => Array.from({ length: n }, (_, i) => obs(`2026-10-${String(i + 1).padStart(2, '0')}`, 10 + i));
    const nine = ownHistoryPercentile(mk(9), obs('2026-11-13', 15));
    expect(isNa(nine) && nine.code).toBe('sample-too-small');
    expect(isNa(nine) && nine.detail).toMatch(/9 of 10/);
    const ten = ownHistoryPercentile(mk(10), obs('2026-11-13', 15));
    expect(isNa(ten)).toBe(false);
    if (!isNa(ten)) {
      expect(ten.n).toBe(10);
      expect(ten.percentile).toBeCloseTo(0.55, 12); // five lower, one equal
      expect(ten.median).toBe(14.5);
    }
    // Captures on or after the current date and other currencies do not count.
    const other = [...mk(9), { ...obs('2026-10-20', 12), currency: 'EUR' }, obs('2026-11-13', 30)];
    expect(isNa(ownHistoryPercentile(other, obs('2026-11-13', 15)))).toBe(true);
  });
  it('needs three peers with a snapshot inside seven days', () => {
    const subject = pe(100, est(5));
    const peer = (symbol: string, price: number, priceDate = '2026-11-13') => ({ symbol, record: pe(price, est(5, { asOf: priceDate }), priceDate) });
    const two = peerContext(subject, [peer('A', 50), peer('B', 150)], '2026-11-13');
    expect(isNa(two) && two.code).toBe('sample-too-small');
    const old = peerContext(subject, [peer('A', 50), peer('B', 150), peer('C', 200, '2026-11-02')], '2026-11-13');
    expect(isNa(old)).toBe(true);
    const ok = peerContext(subject, [peer('A', 50), peer('B', 150), peer('C', 200, '2026-11-09'), { symbol: 'D', record: pe(10, est(-1)) }], '2026-11-13');
    expect(isNa(ok)).toBe(false);
    if (!isNa(ok)) {
      expect(ok.n).toBe(3);
      expect(ok.median).toBe(30);
      expect(ok.subjectPercentile).toBeCloseTo(1 / 3, 12);
      expect(ok.excluded.map((e) => e.symbol)).toEqual(['D']);
    }
  });
});

describe('cash flow', () => {
  it('derives FCF with capex signed either way', () => {
    expect(deriveFcf(10, 3)).toBe(7);
    expect(deriveFcf(10, -3)).toBe(7);
    expect(deriveFcf(-2, 3)).toBe(-5);
  });
  it('reads the newest period and flags a prior period fallback', () => {
    const periods = [period('2026-09-30', 10, 3, 7), period('2026-06-30', 8, 2, 6)];
    const r = latestFcf(periods);
    expect(isNa(r)).toBe(false);
    if (!isNa(r)) {
      expect(r.value).toBe(7);
      expect(r.isLatestPeriod).toBe(true);
      expect(fcfForCurrentFilter(r)).toBe(7);
    }
    const lacking = [period('2026-09-30', 10, 3, null), period('2026-06-30', 8, -2, 6)];
    const f = latestFcf(lacking);
    expect(isNa(f)).toBe(false);
    if (!isNa(f)) {
      expect(f.value).toBe(6);
      expect(f.periodEnd).toBe('2026-06-30');
      expect(f.newestPeriodEnd).toBe('2026-09-30');
      expect(f.isLatestPeriod).toBe(false);
      expect(f.capex).toBe(2);
      expect(f.note).toMatch(/2026-09-30/);
      const cur = fcfForCurrentFilter(f);
      expect(isNa(cur) && cur.code).toBe('stale-source');
      expect(fcfForCurrentFilter(f, true)).toBe(6);
    }
  });
  it('never mixes fiscal scopes and respects the filing date', () => {
    const periods = [period('2026-09-30', 30, 9, 21, { scope: 'ytd' }), period('2026-06-30', 8, 2, 6, { filedAt: '2026-07-28' }), period('2025-12-31', 40, 10, 30, { scope: 'fiscal-year' })];
    const q = latestFcf(periods);
    expect(!isNa(q) && q.value).toBe(6);
    expect(!isNa(q) && q.scope).toBe('quarter');
    const y = latestFcf(periods, { scope: 'fiscal-year' });
    expect(!isNa(y) && y.value).toBe(30);
    const before = latestFcf(periods, { asOf: '2026-07-01' });
    expect(isNa(before) && before.code).toBe('no-coverage');
    expect(isNa(latestFcf(null))).toBe(true);
    const passthrough = latestFcf(na('not-applicable', 'Funds'));
    expect(isNa(passthrough) && passthrough.code).toBe('not-applicable');
  });
  it('sums a trailing year only from four consecutive quarters with FCF', () => {
    const qs = [period('2026-09-30', 10, 3, 7), period('2026-06-30', 8, 2, 6), period('2026-03-31', 5, 2, 3), period('2025-12-31', 6, 2, 4)];
    const t = trailingYearFcf(qs);
    expect(!isNa(t) && t.value).toBe(20);
    expect(isNa(trailingYearFcf(qs.slice(0, 3)))).toBe(true);
    const hole = trailingYearFcf([{ ...qs[0]!, freeCashFlow: null }, ...qs.slice(1)]);
    expect(isNa(hole) && hole.code).toBe('no-coverage');
  });
  it('dates cash on hand at the balance sheet', () => {
    const c = cashOnHand({ value: 5e9, asOf: '2026-09-30', source: src });
    expect(!isNa(c) && c.asOf).toBe('2026-09-30');
    expect(!isNa(c) && c.label).toMatch(/2026-09-30/);
    expect(isNa(cashOnHand(null))).toBe(true);
  });
  it('bundles facts from one capture', () => {
    const facts = valuationFacts({ close: 100, date: '2026-11-13', currency: 'USD' }, {
      instrumentId: 'x', currency: 'USD', marketCap: { value: 6e10, asOf: '2026-11-13', source: src }, sharesOutstanding: na('no-coverage'),
      forwardEps: est(4), cash: { value: 1e9, asOf: '2026-09-30', source: src }, cashFlow: [period('2026-09-30', 10, 3, 7)], beta: 1,
    });
    expect(!isNa(facts.forwardPe) && facts.forwardPe.value).toBe(25);
    expect(facts.marketCap).toBe(6e10);
    const none = valuationFacts({ close: 100, date: '2026-11-13', currency: 'USD' }, na('not-applicable', 'Fund'));
    expect(isNa(none.forwardPe) && isNa(none.fcf) && isNa(none.cash) && isNa(none.marketCap)).toBe(true);
  });
});
