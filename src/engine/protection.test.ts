import { describe, expect, it } from 'vitest';
import { isNa, na, type SourceCapture } from './core/types';
import {
  blackScholes,
  breakevens,
  conservativePremium,
  coverage,
  freezeScenario,
  ladderCashFlows,
  maxCoveredContracts,
  payoffAt,
  payoffCurve,
  preExpiryScenario,
  quoteSpread,
  quoteStatus,
  rollCashFlow,
  summarizePlan,
  upsideSurrenderedAt,
  validatePlan,
  type OptionLeg,
  type OptionQuote,
  type ProtectionPlan,
} from './protection';

const AS_OF = '2026-11-13';
const EXP = '2026-12-18';
const SRC: SourceCapture = { provider: 'test', kind: 'synthetic-fixture', capturedAt: '2026-11-14T00:00:00Z', version: 't' };

const call = (contracts: number, strike = 110, premium = 2): OptionLeg => ({ kind: 'call', side: 'short', strike, premium, contracts, expiry: EXP });
const put = (contracts: number, strike = 95, premium = 3): OptionLeg => ({ kind: 'put', side: 'long', strike, premium, contracts, expiry: EXP });
const base: ProtectionPlan = { shares: 300, spot: 100, spotDate: AS_OF };

const ok = <T,>(v: T | ReturnType<typeof na>): T => {
  if (isNa(v)) throw new Error(`unexpected unavailable: ${v.code} ${v.detail ?? ''}`);
  return v as T;
};

describe('terminal payoff', () => {
  it('shares only is q (X - S)', () => {
    expect(payoffAt(base, 90).net).toBe(-3000);
    expect(payoffAt(base, 100).net).toBe(0);
    const s = ok(summarizePlan(base, AS_OF));
    expect(s.gainUnbounded).toBe(true);
    expect(s.maxLoss).toBe(-30000);
    expect(s.maxLossPrice).toBe(0);
    expect(s.breakevens).toEqual([100]);
  });
  it('covered call adds 100 n (premium - max(X - K, 0))', () => {
    const plan = { ...base, call: call(2) };
    const p = payoffAt(plan, 120);
    expect(p.shares).toBe(6000);
    expect(p.call).toBe(200 * (2 - 10));
    expect(p.net).toBe(4400);
    expect(payoffAt(plan, 100).net).toBe(400);
    const c = coverage(plan);
    expect(c.maxCoveredContracts).toBe(3);
    expect(c.coveredCallContracts).toBe(2);
    expect(c.sharesWithoutCall).toBe(100);
    expect(ok(summarizePlan(plan, AS_OF)).gainUnbounded).toBe(true);
  });
  it('a fully covered call caps the gain and moves the breakeven down by the premium', () => {
    const plan = { ...base, call: call(3) };
    const s = ok(summarizePlan(plan, AS_OF));
    expect(s.gainUnbounded).toBe(false);
    expect(s.maxGain).toBe(3600);
    expect(s.maxGainPrice).toBe(110);
    expect(s.breakevens).toEqual([98]);
    expect(s.effectiveCallSalePrice).toBe(112);
    expect(s.netPremium).toBe(600);
    expect(upsideSurrenderedAt(plan, 130)).toBe(9000 - 3600);
    expect(upsideSurrenderedAt(plan, 105)).toBe(0);
  });
  it('protective put adds 100 n (max(K - X, 0) - premium) and floors the loss', () => {
    const plan = { ...base, put: put(3) };
    const p = payoffAt(plan, 80);
    expect(p.shares).toBe(-6000);
    expect(p.put).toBe(300 * (15 - 3));
    expect(p.net).toBe(-2400);
    const s = ok(summarizePlan(plan, AS_OF));
    expect(s.maxLoss).toBe(-2400);
    expect(s.lossUnbounded).toBe(false);
    expect(s.effectivePutFloor).toBe(92);
    expect(s.breakevens).toEqual([103]);
    expect(s.netPremium).toBe(-900);
  });
  it('collar combines both legs', () => {
    const plan = { ...base, call: call(3), put: put(3) };
    const s = ok(summarizePlan(plan, AS_OF));
    expect(s.maxLoss).toBe(-1800);
    expect(s.maxGain).toBe(2700);
    expect(s.breakevens).toEqual([101]);
    expect(payoffAt(plan, 50).net).toBe(-1800);
    expect(payoffAt(plan, 200).net).toBe(2700);
    expect(s.changeAtSpot).toBe(-300);
  });
  it('trim reduces the remaining share exposure and books explicit costs', () => {
    const plan: ProtectionPlan = { ...base, trim: { shares: 100, costs: 5 } };
    const p = payoffAt(plan, 80);
    expect(p.shares).toBe(-4000);
    expect(p.trim).toBe(-5);
    expect(p.net).toBe(-4005);
    expect(p.sharesOnly).toBe(-6000);
    // A trim at a price below spot realizes that difference.
    expect(payoffAt({ ...base, trim: { shares: 100, price: 99 } }, 100).net).toBe(-100);
    expect(coverage({ ...plan, call: call(3) }).uncoveredCallContracts).toBe(1);
  });
  it('separates gross from net of fees', () => {
    const plan = { ...base, call: call(3), put: put(3), feePerContract: 0.65 };
    const p = payoffAt(plan, 100);
    expect(p.gross).toBe(-300);
    expect(p.fees).toBeCloseTo(3.9, 12);
    expect(p.net).toBeCloseTo(-303.9, 12);
    expect(payoffCurve(plan, 80, 120, 4).map((x) => x.price)).toEqual([80, 90, 100, 110, 120]);
  });
  it('flags uncovered calls and an unbounded loss', () => {
    const plan = { ...base, call: call(4) };
    const s = ok(summarizePlan(plan, AS_OF));
    expect(s.coverage.uncoveredCallContracts).toBe(1);
    expect(s.lossUnbounded).toBe(true);
    expect(s.maxLoss).toBeNull();
    expect(s.issues.some((i) => i.code === 'uncovered-call')).toBe(true);
    expect(s.issues.some((i) => i.code === 'assignment')).toBe(true);
    // Above the strike the uncovered contract loses 100 per dollar.
    expect(payoffAt(plan, 130).net - payoffAt(plan, 120).net).toBe(-1000);
    expect(breakevens(plan).length).toBe(2);
  });
  it('compares against an own share loss budget', () => {
    const collar = ok(summarizePlan({ ...base, call: call(3), put: put(3) }, AS_OF, { lossBudget: 3000 }));
    expect(collar.lossBudget?.sharesOnlyBudgetPrice).toBe(90);
    expect(collar.lossBudget?.planChangeAtThatPrice).toBe(-1800);
    expect(isNa(collar.lossBudget?.planBudgetPrice)).toBe(true);
    expect(collar.lossBudget?.worstCaseInsideBudget).toBe(true);
    const bare = ok(summarizePlan(base, AS_OF, { lossBudget: 3000 }));
    expect(bare.lossBudget?.planBudgetPrice).toBe(90);
    expect(bare.lossBudget?.worstCaseInsideBudget).toBe(false);
    const putOnly = ok(summarizePlan({ ...base, put: put(3) }, AS_OF, { lossBudget: 1500 }));
    // Above the put strike: 300 (X - 100) - 900 = -1500 at X = 98.
    expect(putOnly.lossBudget?.planBudgetPrice).toBeCloseTo(98, 12);
    expect(putOnly.lossBudget?.worstCaseInsideBudget).toBe(false);
    expect(isNa(ok(summarizePlan(base, AS_OF, { lossBudget: 40000 })).lossBudget?.sharesOnlyBudgetPrice)).toBe(true);
  });
});

describe('validation', () => {
  const codes = (plan: ProtectionPlan) => validatePlan(plan, AS_OF).filter((i) => i.severity === 'error').map((i) => i.code);
  it('rejects invalid legs with a reason', () => {
    expect(codes({ ...base, call: call(1, 110, -1) })).toContain('negative-premium');
    expect(codes({ ...base, call: { ...call(1), multiplier: 10 } })).toContain('non-standard-contract');
    expect(codes({ ...base, put: { ...put(1), adjusted: true } })).toContain('non-standard-contract');
    expect(codes({ ...base, call: { ...call(1), expiry: AS_OF } })).toContain('expired');
    expect(codes({ ...base, call: { ...call(1), expiry: '2026-13-40' } })).toContain('invalid-expiry');
    expect(codes({ ...base, call: { ...call(1), side: 'long' } })).toContain('wrong-direction');
    expect(codes({ ...base, put: { ...put(1), kind: 'call' } })).toContain('wrong-direction');
    expect(codes({ ...base, call: call(1.5) })).toContain('invalid-contracts');
    expect(codes({ ...base, call: call(1, 0) })).toContain('invalid-strike');
    expect(codes({ ...base, shares: 0 })).toContain('invalid-shares');
    expect(codes({ ...base, shares: -100 })).toContain('invalid-shares');
    expect(codes({ ...base, spot: 0 })).toContain('invalid-spot');
    expect(codes({ ...base, trim: { shares: 400 } })).toContain('invalid-trim');
    expect(codes({ ...base, call: call(3), put: put(3) })).toEqual([]);
    const bad = summarizePlan({ ...base, call: call(1, 110, -1) }, AS_OF);
    expect(isNa(bad) && bad.code).toBe('invalid-input');
  });
  it('warns on partial coverage, excess puts and mismatched expiries', () => {
    const w = (plan: ProtectionPlan) => validatePlan(plan, AS_OF).map((i) => i.code);
    expect(w({ ...base, shares: 250, put: put(2) })).toContain('partial-coverage');
    expect(w({ ...base, put: put(4) })).toContain('excess-puts');
    expect(w({ ...base, call: call(3), put: { ...put(3), expiry: '2027-01-15' } })).toContain('expiry-mismatch');
    expect(maxCoveredContracts(250)).toBe(2);
    expect(maxCoveredContracts(99)).toBe(0);
    expect(maxCoveredContracts(-500)).toBe(0);
  });
});

describe('ladder and roll cash flows', () => {
  it('sums a ladder gross and net', () => {
    const l = ladderCashFlows([call(1, 110, 2), call(2, 115, 1.2), put(1, 95, 3)], 0.65);
    expect(l.gross).toBeCloseTo(200 + 240 - 300, 12);
    expect(l.fees).toBeCloseTo(2.6, 12);
    expect(l.net).toBeCloseTo(137.4, 12);
    expect(l.flows.length).toBe(3);
  });
  it('rolls a short call: buy back, sell the next', () => {
    const r = ok(rollCashFlow({ closing: call(3, 110, 2), closePrice: 1.5, opening: { ...call(3, 115, 2.5), expiry: '2027-01-15' }, feePerContract: 1 }));
    expect(r.close.gross).toBe(-450);
    expect(r.open.gross).toBe(750);
    expect(r.gross).toBe(300);
    expect(r.fees).toBe(6);
    expect(r.net).toBe(294);
    expect(r.realizedOnClosedLeg).toBe(150);
    expect(isNa(rollCashFlow({ closing: call(1), closePrice: -1, opening: call(1) }))).toBe(true);
    expect(isNa(rollCashFlow({ closing: { ...call(1), multiplier: 50 }, closePrice: 1, opening: call(1) }))).toBe(true);
  });
});

describe('quotes', () => {
  const q: OptionQuote = { contractId: 'c', bid: 1.9, ask: 2.1, quoteDate: AS_OF, timestampVerified: false, source: SRC };
  it('classifies dated, stale, manual and unavailable', () => {
    expect(quoteStatus(q, AS_OF)).toBe('dated');
    expect(quoteStatus(q, '2026-11-16')).toBe('stale');
    expect(quoteStatus(q, '2026-11-16', 3)).toBe('dated');
    expect(quoteStatus({ ...q, manual: true }, '2027-01-01')).toBe('manual');
    expect(quoteStatus(null, AS_OF)).toBe('unavailable');
    expect(quoteStatus({ ...q, bid: na('no-coverage'), ask: na('no-coverage') }, AS_OF)).toBe('unavailable');
    expect(quoteStatus({ ...q, quoteDate: null }, AS_OF)).toBe('unavailable');
  });
  it('prices conservatively and never invents a side', () => {
    expect(conservativePremium(q, 'short')).toBe(1.9);
    expect(conservativePremium(q, 'long')).toBe(2.1);
    expect(isNa(conservativePremium({ ...q, bid: na('no-coverage') }, 'short'))).toBe(true);
    expect(quoteSpread(q)).toBeCloseTo(0.1, 12);
    expect(isNa(quoteSpread({ ...q, ask: na('no-coverage') }))).toBe(true);
  });
});

describe('Black Scholes model scenarios', () => {
  it('matches textbook values', () => {
    const c = ok(blackScholes({ kind: 'call', spot: 100, strike: 100, years: 1, iv: 0.2, rate: 0.05 }));
    const p = ok(blackScholes({ kind: 'put', spot: 100, strike: 100, years: 1, iv: 0.2, rate: 0.05 }));
    expect(c.value).toBeCloseTo(10.4506, 4);
    expect(p.value).toBeCloseTo(5.5735, 4);
    expect(c.delta).toBeCloseTo(0.6368, 4);
    expect(p.delta).toBeCloseTo(-0.3632, 4);
    expect(c.gamma).toBeCloseTo(0.018762, 6);
    expect(c.vegaPerPoint).toBeCloseTo(0.37524, 5);
    expect(c.thetaPerDay).toBeCloseTo(-6.414 / 365, 5);
    expect(c.rhoPerPoint).toBeCloseTo(0.53232, 5);
    // Put call parity: C - P = S - K exp(-rT).
    expect(c.value - p.value).toBeCloseTo(100 - 100 * Math.exp(-0.05), 10);
    expect(c.label).toBe('Model scenario, not a quote');
  });
  it('returns intrinsic at expiry and refuses non positive volatility before it', () => {
    expect(ok(blackScholes({ kind: 'call', spot: 112, strike: 110, years: 0, iv: 0.3, rate: 0.04 })).value).toBe(2);
    expect(ok(blackScholes({ kind: 'put', spot: 112, strike: 110, years: 0, iv: 0.3, rate: 0.04 })).value).toBe(0);
    expect(isNa(blackScholes({ kind: 'call', spot: 100, strike: 100, years: 0.5, iv: 0, rate: 0.04 }))).toBe(true);
    expect(isNa(blackScholes({ kind: 'call', spot: 0, strike: 100, years: 0.5, iv: 0.2, rate: 0.04 }))).toBe(true);
  });
  it('pre expiry scenario converges to the terminal payoff and is labeled as a model', () => {
    const plan = { ...base, call: call(3), put: put(3), feePerContract: 0.65 };
    const atExpiry = ok(preExpiryScenario(plan, { price: 90, callYears: 0, putYears: 0, iv: 0.4, rate: 0.04 }));
    expect(atExpiry.net).toBeCloseTo(payoffAt(plan, 90).net, 9);
    const early = ok(preExpiryScenario(plan, { price: 90, callYears: 0.1, putYears: 0.1, iv: 0.4, rate: 0.04 }));
    expect(early.label).toBe('Model scenario, not a quote');
    expect(early.putModelValue!).toBeGreaterThan(5); // more than intrinsic
    expect(early.callModelValue!).toBeGreaterThan(0);
    expect(isNa(preExpiryScenario(plan, { price: -1, iv: 0.4, rate: 0.04 }))).toBe(true);
  });
});

describe('scenario records and invariants', () => {
  it('freezes a scenario and supersedes instead of editing', () => {
    const plan = { ...base, call: call(3), put: put(3) };
    const rec = ok(freezeScenario({ id: 's1', createdAt: '2026-11-14T15:00:00Z', asOf: AS_OF, symbol: 'AAA', instrumentId: 'us:aaa', plan, premiumBasis: { call: 'manual', put: 'dated' }, lossBudget: 3000 }));
    expect(Object.isFrozen(rec)).toBe(true);
    expect(Object.isFrozen(rec.plan.call)).toBe(true);
    expect(() => {
      (rec.plan as ProtectionPlan).shares = 1;
    }).toThrow();
    plan.shares = 999; // the source object is independent of the record
    expect(rec.plan.shares).toBe(300);
    expect(rec.summary.maxLoss).toBe(-1800);
    expect(rec.label).toMatch(/Hypothetical/);
    const next = ok(freezeScenario({ id: 's2', createdAt: '2026-11-15T15:00:00Z', asOf: AS_OF, symbol: 'AAA', instrumentId: 'us:aaa', plan: { ...base, put: put(3) }, supersedes: 's1' }));
    expect(next.supersedes).toBe('s1');
    expect(isNa(freezeScenario({ id: 's3', createdAt: 'x', asOf: AS_OF, symbol: 'AAA', instrumentId: 'us:aaa', plan: { ...base, shares: 0 } }))).toBe(true);
  });
  it('dollar results are unchanged when prices scale by a factor and shares by its inverse', () => {
    const plan: ProtectionPlan = { ...base, call: call(3), put: put(3) };
    const k = 4; // a 4 for 1 split of the underlying with strikes and premiums adjusted, 12 contracts
    const scaled: ProtectionPlan = { shares: 1200, spot: 25, spotDate: AS_OF, call: call(12, 27.5, 0.5), put: put(12, 23.75, 0.75) };
    for (const x of [60, 95, 100, 110, 140]) expect(payoffAt(scaled, x / k).net).toBeCloseTo(payoffAt(plan, x).net, 9);
    const a = ok(summarizePlan(plan, AS_OF));
    const b = ok(summarizePlan(scaled, AS_OF));
    expect(b.maxLoss).toBeCloseTo(a.maxLoss!, 9);
    expect(b.breakevens[0]! * k).toBeCloseTo(a.breakevens[0]!, 9);
  });
});
