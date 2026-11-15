/**
 * Protection planner math. Hypothetical scenario analysis only. Nothing here is a quote, a fill
 * or an order, and nothing is sent to a broker.
 *
 * Definitions (owner specification section 14). All results are signed dollar changes from the
 * current spot S at a terminal price X on expiry:
 * - Shares only:      q (X - S)
 * - Covered call:     adds 100 n (premium received - max(X - K_call, 0))
 * - Protective put:   adds 100 n (max(K_put - X, 0) - premium paid)
 * - Collar:           both option legs
 * - Trim:             the trimmed shares stop moving with X. They realize (trim price - S) per
 *                     share, less explicit costs. Trim cash is held as cash and earns nothing.
 * Premiums are per share. A standard U.S. equity option contract covers 100 shares. Adjusted or
 * non standard contracts are not supported.
 *
 * Pre expiry values use a European Black Scholes model with a zero dividend assumption and
 * hypothetical volatility, rate and time. They are model scenarios, never quotes.
 */
import { isIsoDate, toDayNum } from './core/calendar';
import { normCdf } from './core/stats';
import { isNa, na, type ISODate, type Maybe, type SourceCapture } from './core/types';

export const STANDARD_MULTIPLIER = 100;
export const PROTECTION_VERSION = 'protection-v1';

export type OptionKind = 'call' | 'put';
export type LegSide = 'short' | 'long';

export interface OptionLeg {
  kind: OptionKind;
  side: LegSide;
  strike: number;
  /** Premium per share. Received for a short leg, paid for a long leg. Always non negative. */
  premium: number;
  contracts: number;
  expiry: ISODate;
  /** Shares per contract. Only 100 is supported. */
  multiplier?: number;
  /** True for a contract adjusted by a corporate action. Not supported. */
  adjusted?: boolean;
  contractId?: string;
}

export interface TrimLeg {
  shares: number;
  /** Sale price per share. Defaults to spot. */
  price?: number;
  /** Explicit total costs of the sale in dollars (commissions, fees). */
  costs?: number;
}

export interface ProtectionPlan {
  /** Shares held before any trim. Must be positive: short stock is outside this planner. */
  shares: number;
  /** Current spot S: the dated completed close the scenario starts from. */
  spot: number;
  spotDate: ISODate;
  /** Short call written against the shares. */
  call?: OptionLeg;
  /** Long put bought to protect the shares. */
  put?: OptionLeg;
  trim?: TrimLeg;
  /** Fee per option contract in dollars, applied once per leg. */
  feePerContract?: number;
}

export type IssueSeverity = 'error' | 'warning';

export interface PlanIssue {
  severity: IssueSeverity;
  code:
    | 'invalid-shares'
    | 'invalid-spot'
    | 'negative-premium'
    | 'invalid-strike'
    | 'invalid-contracts'
    | 'non-standard-contract'
    | 'expired'
    | 'invalid-expiry'
    | 'wrong-direction'
    | 'uncovered-call'
    | 'excess-puts'
    | 'partial-coverage'
    | 'invalid-trim'
    | 'assignment'
    | 'expiry-mismatch';
  message: string;
}

const multiplierOf = (leg: OptionLeg): number => leg.multiplier ?? STANDARD_MULTIPLIER;

/** Largest number of standard contracts fully covered by a share count: floor(shares / 100). */
export const maxCoveredContracts = (shares: number): number => (shares > 0 ? Math.floor(shares / STANDARD_MULTIPLIER) : 0);

/** Validate one option leg against the as-of session. */
export const validateLeg = (leg: OptionLeg, asOf: ISODate, role: 'covered-call' | 'protective-put'): PlanIssue[] => {
  const out: PlanIssue[] = [];
  const name = role === 'covered-call' ? 'Covered call' : 'Protective put';
  if (!Number.isFinite(leg.premium) || leg.premium < 0) out.push({ severity: 'error', code: 'negative-premium', message: `${name} premium must be zero or more.` });
  if (!Number.isFinite(leg.strike) || leg.strike <= 0) out.push({ severity: 'error', code: 'invalid-strike', message: `${name} strike must be a positive price.` });
  if (!Number.isInteger(leg.contracts) || leg.contracts <= 0) out.push({ severity: 'error', code: 'invalid-contracts', message: `${name} contracts must be a positive whole number.` });
  if (multiplierOf(leg) !== STANDARD_MULTIPLIER || leg.adjusted) {
    out.push({ severity: 'error', code: 'non-standard-contract', message: `${name} is an adjusted or non standard contract. Only standard 100 share contracts are supported.` });
  }
  if (!isIsoDate(leg.expiry)) out.push({ severity: 'error', code: 'invalid-expiry', message: `${name} expiry is not a valid date.` });
  else if (leg.expiry <= asOf) out.push({ severity: 'error', code: 'expired', message: `${name} expiry ${leg.expiry} is not after ${asOf}.` });
  const wantKind: OptionKind = role === 'covered-call' ? 'call' : 'put';
  const wantSide: LegSide = role === 'covered-call' ? 'short' : 'long';
  if (leg.kind !== wantKind || leg.side !== wantSide) {
    out.push({ severity: 'error', code: 'wrong-direction', message: `${name} must be a ${wantSide} ${wantKind}.` });
  }
  return out;
};

/** Shares that remain after the trim. */
export const remainingShares = (plan: ProtectionPlan): number => plan.shares - (plan.trim?.shares ?? 0);

export interface CoverageSummary {
  remainingShares: number;
  maxCoveredContracts: number;
  callContracts: number;
  /** Short call contracts fully backed by remaining shares. */
  coveredCallContracts: number;
  /** Short call contracts with no shares behind them. Loss on these is uncapped. */
  uncoveredCallContracts: number;
  putContracts: number;
  /** Long put contracts matched to remaining shares. */
  protectingPutContracts: number;
  /** Long puts beyond the shares held. These are a separate bearish position, not protection. */
  excessPutContracts: number;
  /** Remaining shares not under a call. They keep full upside. */
  sharesWithoutCall: number;
  /** Remaining shares not under a put. They keep full downside. */
  sharesWithoutPut: number;
}

export const coverage = (plan: ProtectionPlan): CoverageSummary => {
  const rem = Math.max(0, remainingShares(plan));
  const max = maxCoveredContracts(rem);
  const calls = plan.call?.contracts ?? 0;
  const puts = plan.put?.contracts ?? 0;
  const coveredCalls = Math.min(calls, max);
  const protectingPuts = Math.min(puts, max);
  return {
    remainingShares: rem,
    maxCoveredContracts: max,
    callContracts: calls,
    coveredCallContracts: coveredCalls,
    uncoveredCallContracts: calls - coveredCalls,
    putContracts: puts,
    protectingPutContracts: protectingPuts,
    excessPutContracts: puts - protectingPuts,
    sharesWithoutCall: rem - coveredCalls * STANDARD_MULTIPLIER,
    sharesWithoutPut: rem - protectingPuts * STANDARD_MULTIPLIER,
  };
};

/** Validate a whole plan. Errors block the calculation. Warnings are surfaced beside the result. */
export const validatePlan = (plan: ProtectionPlan, asOf: ISODate): PlanIssue[] => {
  const out: PlanIssue[] = [];
  if (!Number.isFinite(plan.shares) || plan.shares <= 0) {
    out.push({ severity: 'error', code: 'invalid-shares', message: 'Shares held must be positive. Zero and short stock positions are outside this planner.' });
  }
  if (!Number.isFinite(plan.spot) || plan.spot <= 0) out.push({ severity: 'error', code: 'invalid-spot', message: 'Spot must be a positive dated close.' });
  if (plan.trim) {
    const t = plan.trim;
    if (!Number.isFinite(t.shares) || t.shares < 0 || t.shares > plan.shares) out.push({ severity: 'error', code: 'invalid-trim', message: 'Trim shares must be between zero and the shares held.' });
    if (t.price !== undefined && (!Number.isFinite(t.price) || t.price <= 0)) out.push({ severity: 'error', code: 'invalid-trim', message: 'Trim price must be a positive price.' });
    if (t.costs !== undefined && (!Number.isFinite(t.costs) || t.costs < 0)) out.push({ severity: 'error', code: 'invalid-trim', message: 'Trim costs must be zero or more.' });
  }
  if (plan.call) out.push(...validateLeg(plan.call, asOf, 'covered-call'));
  if (plan.put) out.push(...validateLeg(plan.put, asOf, 'protective-put'));
  if (out.some((i) => i.severity === 'error')) return out;
  const c = coverage(plan);
  if (c.uncoveredCallContracts > 0) {
    out.push({ severity: 'warning', code: 'uncovered-call', message: `${c.uncoveredCallContracts} short call contracts are not covered by shares. Loss on them is uncapped above the strike.` });
  }
  if (c.excessPutContracts > 0) {
    out.push({ severity: 'warning', code: 'excess-puts', message: `${c.excessPutContracts} put contracts exceed the shares held. They are a separate position, not protection.` });
  }
  if (plan.call && c.sharesWithoutCall > 0 && c.uncoveredCallContracts === 0) {
    out.push({ severity: 'warning', code: 'partial-coverage', message: `${c.sharesWithoutCall} shares are not under a call and keep full upside.` });
  }
  if (plan.put && c.sharesWithoutPut > 0 && c.excessPutContracts === 0) {
    out.push({ severity: 'warning', code: 'partial-coverage', message: `${c.sharesWithoutPut} shares are not under a put and keep full downside.` });
  }
  if (plan.call) {
    out.push({ severity: 'warning', code: 'assignment', message: `Above ${plan.call.strike} at expiry, or earlier at the holder's choice, ${c.coveredCallContracts * STANDARD_MULTIPLIER} shares can be called away at the strike.` });
  }
  if (plan.call && plan.put && plan.call.expiry !== plan.put.expiry) {
    out.push({ severity: 'warning', code: 'expiry-mismatch', message: 'Call and put expiries differ. The terminal payoff assumes one common expiry price and is approximate.' });
  }
  return out;
};

export interface PayoffBreakdown {
  /** Terminal price X. */
  price: number;
  /** Remaining shares x (X - S). */
  shares: number;
  /** Realized on trimmed shares: trim shares x (trim price - S) - costs. */
  trim: number;
  /** Option legs before fees. */
  call: number;
  put: number;
  fees: number;
  /** Before option fees and trim costs. */
  gross: number;
  /** After option fees and trim costs. */
  net: number;
  /** What the original share count alone would have changed by: q (X - S). */
  sharesOnly: number;
}

const optionFees = (plan: ProtectionPlan): number => (plan.feePerContract ?? 0) * ((plan.call?.contracts ?? 0) + (plan.put?.contracts ?? 0));

/** Signed dollar change from spot at terminal price X on expiry. Callers validate the plan first. */
export const payoffAt = (plan: ProtectionPlan, price: number): PayoffBreakdown => {
  const S = plan.spot;
  const trimShares = plan.trim?.shares ?? 0;
  const trimPrice = plan.trim?.price ?? S;
  const trimCosts = plan.trim?.costs ?? 0;
  const shares = (plan.shares - trimShares) * (price - S);
  const trimGross = trimShares * (trimPrice - S);
  const call = plan.call ? STANDARD_MULTIPLIER * plan.call.contracts * (plan.call.premium - Math.max(price - plan.call.strike, 0)) : 0;
  const put = plan.put ? STANDARD_MULTIPLIER * plan.put.contracts * (Math.max(plan.put.strike - price, 0) - plan.put.premium) : 0;
  const fees = optionFees(plan) + trimCosts;
  const gross = shares + trimGross + call + put;
  return { price, shares, trim: trimGross - trimCosts, call, put, fees, gross, net: gross - fees, sharesOnly: plan.shares * (price - S) };
};

export const payoffCurve = (plan: ProtectionPlan, from: number, to: number, steps = 60): PayoffBreakdown[] => {
  const out: PayoffBreakdown[] = [];
  const n = Math.max(1, Math.floor(steps));
  for (let i = 0; i <= n; i++) out.push(payoffAt(plan, from + ((to - from) * i) / n));
  return out;
};

export interface LossBudgetComparison {
  /** Further dollar loss the owner is willing to bear, as a positive number. */
  budget: number;
  /** Price at which the shares alone lose exactly the budget. Unavailable when the budget exceeds the share value. */
  sharesOnlyBudgetPrice: Maybe<number>;
  /** Plan's net change at that price. */
  planChangeAtThatPrice: Maybe<number>;
  /** Highest price at or below spot where the plan loses exactly the budget. Unavailable when it never does. */
  planBudgetPrice: Maybe<number>;
  /** True when the plan's worst case loss stays inside the budget. */
  worstCaseInsideBudget: boolean;
}

export interface PlanSummary {
  issues: PlanIssue[];
  coverage: CoverageSummary;
  /** Terminal prices where the net change is zero. */
  breakevens: number[];
  /** Worst net change over all terminal prices. Negative for a loss. Null when unbounded. */
  maxLoss: number | null;
  maxLossPrice: number | null;
  lossUnbounded: boolean;
  /** Largest net gain. Null when unbounded. */
  maxGain: number | null;
  maxGainPrice: number | null;
  gainUnbounded: boolean;
  /** Net option premium: received minus paid, before fees. */
  netPremium: number;
  fees: number;
  /** Effective sale price per share if called away: strike plus the call premium. */
  effectiveCallSalePrice: number | null;
  /** Effective floor per share under the put: strike minus the put premium. */
  effectivePutFloor: number | null;
  /** Net change at spot, mostly premiums and costs. */
  changeAtSpot: number;
  lossBudget?: LossBudgetComparison;
  notes: string[];
}

/** Kink prices of the piecewise linear payoff, with 0 first. */
const kinks = (plan: ProtectionPlan): number[] => {
  const ks = [0];
  if (plan.put) ks.push(plan.put.strike);
  if (plan.call) ks.push(plan.call.strike);
  return [...new Set(ks)].sort((a, b) => a - b);
};

/** Slope of the net payoff above the highest strike, in dollars per dollar of price. */
const topSlope = (plan: ProtectionPlan): number => remainingShares(plan) - STANDARD_MULTIPLIER * (plan.call?.contracts ?? 0);

/** Zero crossings of the net payoff over X >= 0. */
export const breakevens = (plan: ProtectionPlan): number[] => {
  const ks = kinks(plan);
  const out: number[] = [];
  const f = (x: number) => payoffAt(plan, x).net;
  const push = (x: number) => {
    if (!out.some((y) => Math.abs(y - x) < 1e-9)) out.push(x);
  };
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i]!;
    const b = ks[i + 1]!;
    const fa = f(a);
    const fb = f(b);
    if (fa === 0) push(a);
    if (fa * fb < 0) push(a + ((b - a) * -fa) / (fb - fa));
  }
  const last = ks[ks.length - 1]!;
  const fl = f(last);
  if (fl === 0) push(last);
  const slope = topSlope(plan);
  if (slope !== 0 && -fl / slope > 0) push(last - fl / slope);
  return out.sort((a, b) => a - b);
};

/** Price at or below spot where the net change equals `target` (a negative number), searching downward from spot. */
const priceForChange = (plan: ProtectionPlan, target: number): Maybe<number> => {
  const pts = [...kinks(plan).filter((k) => k < plan.spot), plan.spot].sort((a, b) => b - a);
  const f = (x: number) => payoffAt(plan, x).net;
  for (let i = 0; i < pts.length - 1; i++) {
    const hi = pts[i]!;
    const lo = pts[i + 1]!;
    const fh = f(hi) - target;
    const fl = f(lo) - target;
    if (fh === 0) return hi;
    if (fh * fl < 0) return hi + ((lo - hi) * -fh) / (fl - fh);
    if (fl === 0) return lo;
  }
  return na('not-applicable', 'The plan never loses that much at or below spot');
};

/** Summary of a plan at expiry: coverage, breakevens, extremes, premium, and an optional loss budget check. */
export const summarizePlan = (plan: ProtectionPlan, asOf: ISODate, opts: { lossBudget?: number } = {}): Maybe<PlanSummary> => {
  const issues = validatePlan(plan, asOf);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length) return na('invalid-input', errors.map((e) => e.message).join(' '));
  const ks = kinks(plan);
  const pts = ks.map((k) => payoffAt(plan, k));
  const slope = topSlope(plan);
  const lossUnbounded = slope < 0;
  const gainUnbounded = slope > 0;
  let minP = pts[0]!;
  let maxP = pts[0]!;
  for (const p of pts) {
    if (p.net < minP.net) minP = p;
    if (p.net > maxP.net) maxP = p;
  }
  const netPremium =
    (plan.call ? STANDARD_MULTIPLIER * plan.call.contracts * plan.call.premium : 0) - (plan.put ? STANDARD_MULTIPLIER * plan.put.contracts * plan.put.premium : 0);
  const summary: PlanSummary = {
    issues,
    coverage: coverage(plan),
    breakevens: breakevens(plan),
    maxLoss: lossUnbounded ? null : minP.net,
    maxLossPrice: lossUnbounded ? null : minP.price,
    lossUnbounded,
    maxGain: gainUnbounded ? null : maxP.net,
    maxGainPrice: gainUnbounded ? null : maxP.price,
    gainUnbounded,
    netPremium,
    fees: optionFees(plan) + (plan.trim?.costs ?? 0),
    effectiveCallSalePrice: plan.call ? plan.call.strike + plan.call.premium : null,
    effectivePutFloor: plan.put ? plan.put.strike - plan.put.premium : null,
    changeAtSpot: payoffAt(plan, plan.spot).net,
    notes: [
      'Terminal values at expiry on one common price. Early assignment, dividends and taxes are not modeled.',
      'Trim cash is held as cash and earns nothing in this scenario.',
      'Cost basis does not enter these figures. Changes are measured from the current spot.',
    ],
  };
  if (opts.lossBudget !== undefined && Number.isFinite(opts.lossBudget) && opts.lossBudget > 0) {
    const B = opts.lossBudget;
    const sharesPrice: Maybe<number> = B <= plan.shares * plan.spot ? plan.spot - B / plan.shares : na('not-applicable', 'The budget exceeds the value of the shares');
    summary.lossBudget = {
      budget: B,
      sharesOnlyBudgetPrice: sharesPrice,
      planChangeAtThatPrice: isNa(sharesPrice) ? sharesPrice : payoffAt(plan, sharesPrice).net,
      planBudgetPrice: priceForChange(plan, -B),
      worstCaseInsideBudget: !lossUnbounded && minP.net >= -B,
    };
  }
  return summary;
};

/** Upside given up versus holding the original shares alone, at terminal price X. Zero or more above the cap. */
export const upsideSurrenderedAt = (plan: ProtectionPlan, price: number): number => {
  const p = payoffAt(plan, price);
  return Math.max(0, p.sharesOnly - p.net);
};

// ---------------------------------------------------------------------------------------------
// Ladder and roll cash flows
// ---------------------------------------------------------------------------------------------

export interface CashFlow {
  label: string;
  /** Signed dollars: positive is cash received. */
  gross: number;
  fees: number;
  net: number;
}

const legLabel = (l: OptionLeg): string => `${l.side === 'short' ? 'Sell' : 'Buy'} ${l.contracts} ${l.kind} ${l.strike} expiring ${l.expiry}`;

/** Opening cash flows for a ladder of legs across strikes or expiries. */
export const ladderCashFlows = (legs: readonly OptionLeg[], feePerContract = 0): { flows: CashFlow[]; gross: number; fees: number; net: number } => {
  const flows = legs.map((l) => {
    const gross = (l.side === 'short' ? 1 : -1) * multiplierOf(l) * l.contracts * l.premium;
    const fees = feePerContract * l.contracts;
    return { label: legLabel(l), gross, fees, net: gross - fees };
  });
  const gross = flows.reduce((s, f) => s + f.gross, 0);
  const fees = flows.reduce((s, f) => s + f.fees, 0);
  return { flows, gross, fees, net: gross - fees };
};

export interface RollInput {
  /** The open leg being closed, with its original premium. */
  closing: OptionLeg;
  /** Price per share to close it: paid to buy back a short leg, received to sell a long leg. */
  closePrice: number;
  /** The new leg being opened. */
  opening: OptionLeg;
  feePerContract?: number;
}

export interface RollResult {
  close: CashFlow;
  open: CashFlow;
  /** Net credit (positive) or debit (negative) of the roll, after fees. */
  net: number;
  gross: number;
  fees: number;
  /** Realized result on the closed leg versus its original premium, before fees. */
  realizedOnClosedLeg: number;
}

/** Cash flows of rolling one leg into another. */
export const rollCashFlow = (r: RollInput): Maybe<RollResult> => {
  if (!Number.isFinite(r.closePrice) || r.closePrice < 0) return na('invalid-input', 'Close price must be zero or more');
  if (r.opening.premium < 0 || r.closing.premium < 0) return na('invalid-input', 'Premiums must be zero or more');
  if (multiplierOf(r.closing) !== STANDARD_MULTIPLIER || multiplierOf(r.opening) !== STANDARD_MULTIPLIER || r.closing.adjusted || r.opening.adjusted) {
    return na('not-applicable', 'Adjusted or non standard contracts are not supported');
  }
  const fee = r.feePerContract ?? 0;
  const closeSign = r.closing.side === 'short' ? -1 : 1;
  const closeGross = closeSign * STANDARD_MULTIPLIER * r.closing.contracts * r.closePrice;
  const openGross = (r.opening.side === 'short' ? 1 : -1) * STANDARD_MULTIPLIER * r.opening.contracts * r.opening.premium;
  const closeFees = fee * r.closing.contracts;
  const openFees = fee * r.opening.contracts;
  const realized = (r.closing.side === 'short' ? 1 : -1) * STANDARD_MULTIPLIER * r.closing.contracts * (r.closing.premium - r.closePrice);
  return {
    close: { label: `Close ${r.closing.contracts} ${r.closing.kind} ${r.closing.strike} expiring ${r.closing.expiry}`, gross: closeGross, fees: closeFees, net: closeGross - closeFees },
    open: { label: legLabel(r.opening), gross: openGross, fees: openFees, net: openGross - openFees },
    gross: closeGross + openGross,
    fees: closeFees + openFees,
    net: closeGross + openGross - closeFees - openFees,
    realizedOnClosedLeg: realized,
  };
};

// ---------------------------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------------------------

/** dated: usable and dated on the as-of session. stale: older. manual: typed by the owner. */
export type QuoteStatus = 'dated' | 'stale' | 'unavailable' | 'manual';

export interface OptionQuote {
  contractId: string;
  bid: Maybe<number>;
  ask: Maybe<number>;
  /** Session the quote belongs to. */
  quoteDate: ISODate | null;
  /** True only when the provider supplies a verified exchange quote timestamp. */
  timestampVerified: boolean;
  manual?: boolean;
  openInterest?: Maybe<number>;
  source: SourceCapture;
}

/** Classify a quote against the as-of session. A quote older than `maxAgeDays` calendar days is stale. */
export const quoteStatus = (q: OptionQuote | null | undefined, asOf: ISODate, maxAgeDays = 0): QuoteStatus => {
  if (!q) return 'unavailable';
  if (q.manual) return 'manual';
  if (!q.quoteDate || (isNa(q.bid) && isNa(q.ask))) return 'unavailable';
  return toDayNum(asOf) - toDayNum(q.quoteDate) > maxAgeDays ? 'stale' : 'dated';
};

/**
 * Conservative premium for a leg: a short leg is priced at the bid, a long leg at the ask.
 * Unavailable when that side of the quote is missing. A mid is never invented.
 */
export const conservativePremium = (q: OptionQuote, side: LegSide): Maybe<number> => {
  const v = side === 'short' ? q.bid : q.ask;
  if (isNa(v)) return na('no-coverage', `No ${side === 'short' ? 'bid' : 'ask'} in the dated quote`);
  if (!Number.isFinite(v) || v < 0) return na('invalid-input', 'Quote is not a valid price');
  return v;
};

/** Bid to ask spread as a fraction of the mid. Unavailable without both sides. */
export const quoteSpread = (q: OptionQuote): Maybe<number> => {
  if (isNa(q.bid) || isNa(q.ask)) return na('no-coverage', 'Needs both bid and ask');
  const mid = (q.bid + q.ask) / 2;
  if (!(mid > 0) || q.ask < q.bid) return na('invalid-input', 'Bid and ask are not a valid market');
  return (q.ask - q.bid) / mid;
};

// ---------------------------------------------------------------------------------------------
// Black Scholes model scenarios (never quotes)
// ---------------------------------------------------------------------------------------------

export interface BlackScholesInput {
  kind: OptionKind;
  spot: number;
  strike: number;
  /** Time to expiry in years. */
  years: number;
  /** Hypothetical annualized volatility as a fraction. */
  iv: number;
  /** Hypothetical continuously compounded annual rate as a fraction. */
  rate: number;
}

export interface BlackScholesResult {
  label: 'Model scenario, not a quote';
  model: 'Black Scholes, European exercise, zero dividends';
  value: number;
  delta: number;
  gamma: number;
  /** Per one calendar day. */
  thetaPerDay: number;
  /** Per one volatility point (0.01). */
  vegaPerPoint: number;
  /** Per one rate point (0.01). */
  rhoPerPoint: number;
  d1: number | null;
  d2: number | null;
  limitations: string[];
}

const BS_LIMITS = [
  'European exercise. U.S. equity options are American and can be assigned early.',
  'Zero dividends assumed.',
  'Volatility, rate and time are hypothetical inputs, not market data.',
];

const pdf = (x: number): number => Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);

/** European Black Scholes value and sensitivities with zero dividends. At or past expiry returns intrinsic value. */
export const blackScholes = (i: BlackScholesInput): Maybe<BlackScholesResult> => {
  if (![i.spot, i.strike, i.years, i.iv, i.rate].every(Number.isFinite) || i.spot <= 0 || i.strike <= 0) return na('invalid-input', 'Spot and strike must be positive');
  const base = { label: 'Model scenario, not a quote', model: 'Black Scholes, European exercise, zero dividends', limitations: BS_LIMITS } as const;
  if (i.years <= 0) {
    const intrinsic = i.kind === 'call' ? Math.max(i.spot - i.strike, 0) : Math.max(i.strike - i.spot, 0);
    const itm = i.kind === 'call' ? i.spot > i.strike : i.spot < i.strike;
    return { ...base, value: intrinsic, delta: itm ? (i.kind === 'call' ? 1 : -1) : 0, gamma: 0, thetaPerDay: 0, vegaPerPoint: 0, rhoPerPoint: 0, d1: null, d2: null };
  }
  if (i.iv <= 0) return na('invalid-input', 'Volatility must be positive before expiry');
  const sq = i.iv * Math.sqrt(i.years);
  const d1 = (Math.log(i.spot / i.strike) + (i.rate + (i.iv * i.iv) / 2) * i.years) / sq;
  const d2 = d1 - sq;
  const disc = Math.exp(-i.rate * i.years);
  const call = i.spot * normCdf(d1) - i.strike * disc * normCdf(d2);
  const value = i.kind === 'call' ? call : call - i.spot + i.strike * disc;
  const delta = i.kind === 'call' ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = pdf(d1) / (i.spot * sq);
  const thetaYear =
    i.kind === 'call'
      ? (-i.spot * pdf(d1) * i.iv) / (2 * Math.sqrt(i.years)) - i.rate * i.strike * disc * normCdf(d2)
      : (-i.spot * pdf(d1) * i.iv) / (2 * Math.sqrt(i.years)) + i.rate * i.strike * disc * normCdf(-d2);
  const vega = i.spot * pdf(d1) * Math.sqrt(i.years);
  const rho = i.kind === 'call' ? i.strike * i.years * disc * normCdf(d2) : -i.strike * i.years * disc * normCdf(-d2);
  return { ...base, value, delta, gamma, thetaPerDay: thetaYear / 365, vegaPerPoint: vega / 100, rhoPerPoint: rho / 100, d1, d2 };
};

export interface PreExpiryAssumptions {
  /** Hypothetical price on the scenario date. */
  price: number;
  /** Years remaining to the call and put expiries on the scenario date. */
  callYears?: number;
  putYears?: number;
  iv: number;
  rate: number;
}

export interface PreExpiryScenario {
  label: 'Model scenario, not a quote';
  price: number;
  shares: number;
  trim: number;
  /** 100 n (premium received - model call value). */
  call: number;
  /** 100 n (model put value - premium paid). */
  put: number;
  fees: number;
  net: number;
  callModelValue: number | null;
  putModelValue: number | null;
  assumptions: PreExpiryAssumptions;
  limitations: string[];
}

/** Signed change from spot before expiry, marking option legs at a Black Scholes model value. */
export const preExpiryScenario = (plan: ProtectionPlan, a: PreExpiryAssumptions): Maybe<PreExpiryScenario> => {
  if (!Number.isFinite(a.price) || a.price <= 0) return na('invalid-input', 'Scenario price must be positive');
  const terminal = payoffAt(plan, a.price);
  let call = 0;
  let put = 0;
  let cv: number | null = null;
  let pv: number | null = null;
  if (plan.call) {
    const m = blackScholes({ kind: 'call', spot: a.price, strike: plan.call.strike, years: a.callYears ?? 0, iv: a.iv, rate: a.rate });
    if (isNa(m)) return m;
    cv = m.value;
    call = STANDARD_MULTIPLIER * plan.call.contracts * (plan.call.premium - m.value);
  }
  if (plan.put) {
    const m = blackScholes({ kind: 'put', spot: a.price, strike: plan.put.strike, years: a.putYears ?? 0, iv: a.iv, rate: a.rate });
    if (isNa(m)) return m;
    pv = m.value;
    put = STANDARD_MULTIPLIER * plan.put.contracts * (m.value - plan.put.premium);
  }
  return {
    label: 'Model scenario, not a quote',
    price: a.price,
    shares: terminal.shares,
    trim: terminal.trim,
    call,
    put,
    fees: terminal.fees,
    net: terminal.shares + terminal.trim + call + put - optionFees(plan),
    callModelValue: cv,
    putModelValue: pv,
    assumptions: { ...a },
    limitations: BS_LIMITS,
  };
};

// ---------------------------------------------------------------------------------------------
// Immutable scenario records
// ---------------------------------------------------------------------------------------------

export interface ScenarioRecord {
  readonly id: string;
  readonly version: string;
  /** When the scenario was saved, ISO timestamp supplied by the caller. */
  readonly createdAt: string;
  readonly asOf: ISODate;
  readonly symbol: string;
  readonly instrumentId: string;
  readonly plan: Readonly<ProtectionPlan>;
  readonly premiumBasis: { readonly call?: QuoteStatus; readonly put?: QuoteStatus };
  readonly summary: Readonly<PlanSummary>;
  readonly label: 'Hypothetical scenario. Not a quote, a fill or an order.';
  /** Id of an earlier record this one supersedes. Earlier records are never edited. */
  readonly supersedes?: string;
}

const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
};

/** Save a scenario as an immutable record. A correction is a new record that names the one it supersedes. */
export const freezeScenario = (input: {
  id: string;
  createdAt: string;
  asOf: ISODate;
  symbol: string;
  instrumentId: string;
  plan: ProtectionPlan;
  premiumBasis?: { call?: QuoteStatus; put?: QuoteStatus };
  lossBudget?: number;
  supersedes?: string;
}): Maybe<ScenarioRecord> => {
  const summary = summarizePlan(input.plan, input.asOf, { lossBudget: input.lossBudget });
  if (isNa(summary)) return summary;
  const rec: ScenarioRecord = {
    id: input.id,
    version: PROTECTION_VERSION,
    createdAt: input.createdAt,
    asOf: input.asOf,
    symbol: input.symbol,
    instrumentId: input.instrumentId,
    plan: JSON.parse(JSON.stringify(input.plan)) as ProtectionPlan,
    premiumBasis: { ...(input.premiumBasis ?? {}) },
    summary: JSON.parse(JSON.stringify(summary)) as PlanSummary,
    label: 'Hypothetical scenario. Not a quote, a fill or an order.',
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
  };
  return deepFreeze(rec);
};
