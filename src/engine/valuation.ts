/**
 * Valuation and cash flow rules (owner specification section 13, cash flow tab of section 12).
 *
 * Definitions
 * - Forward P/E (FY1) = completed close / verified positive annual forward EPS, same currency,
 *   same fiscal horizon, estimate captured on or shortly before the price date. One function
 *   (`forwardPe`) produces the one display record that the quote strip and the screener both use,
 *   so the two can never disagree. A non positive, stale, mismatched or missing estimate gives a
 *   structured reason. A multiple is never forced.
 * - Trailing P/E = close / sum of four consecutive comparable actual quarterly EPS (one basis, one
 *   currency) ending on or before the price date. Individual quarters may be negative. The sum
 *   must be positive.
 * - Own history percentile needs at least ten compatible archived observations. Peer context needs
 *   at least three peers whose snapshot is within seven days. The archive is append only: a daily
 *   close can never backfill a historic forward estimate.
 * - Free cash flow = operating cash flow - capital expenditure as a positive outflow. Fiscal scopes
 *   (quarter, year to date, trailing year, fiscal year) are never mixed. When the newest report
 *   lacks FCF the latest verified prior period is shown with its date, flagged as not current and
 *   excluded from "current" filters by default.
 * - Cash on hand is cash and equivalents at the balance sheet date. It says nothing about current
 *   cash generation.
 */
import type { CashFlowPeriod, DatedValue, FiscalScope, ForwardEps, Fundamentals } from '../data/contracts';
import { calendarDaysBetween } from './core/series';
import { median, midrankPercentile } from './core/stats';
import { isNa, na, type ISODate, type Maybe, type SourceCapture } from './core/types';

export const VALUATION_DEFAULTS = {
  /** Largest calendar gap between the estimate capture date and the price date. */
  maxEstimateAgeDays: { value: 7, provenance: 'proposed' as const },
  /** Largest calendar age of the newest actual quarter used for a trailing multiple. */
  maxLatestQuarterAgeDays: { value: 200, provenance: 'proposed' as const },
  /** Accepted calendar spacing between consecutive fiscal quarter ends. */
  quarterSpacingDays: { min: 80, max: 100, provenance: 'proposed' as const },
  minOwnHistoryObservations: { value: 10, provenance: 'spec' as const },
  peerSnapshotMaxDays: { value: 7, provenance: 'spec' as const },
  minPeers: { value: 3, provenance: 'spec' as const },
} as const;

/* ------------------------------------------------------------------ forward P/E */

export interface ForwardPeInput {
  /** Completed research close. */
  price: number;
  priceDate: ISODate;
  priceCurrency: string;
  estimate: Maybe<ForwardEps> | null | undefined;
  maxEstimateAgeDays?: number;
}

/** The single display record for a forward multiple. */
export interface ForwardPeRecord {
  value: number;
  basis: 'FY1';
  basisLabel: string;
  price: number;
  priceDate: ISODate;
  eps: number;
  estimateDate: ISODate;
  fiscalYearEnd: ISODate;
  currency: string;
  source: SourceCapture;
}

/** Canonical FY1 forward P/E. Feeds the quote strip and the screener from one record. */
export const forwardPe = (input: ForwardPeInput): Maybe<ForwardPeRecord> => {
  const { price, priceDate, priceCurrency, estimate } = input;
  if (estimate === null || estimate === undefined) return na('no-coverage', 'No verified FY1 estimate');
  if (isNa(estimate)) return estimate;
  if (!(Number.isFinite(price) && price > 0)) return na('invalid-input', 'Price is not a positive number');
  if (!Number.isFinite(estimate.value)) return na('invalid-input', 'Forward EPS is not a finite number');
  if (estimate.horizon !== 'FY1') return na('basis-mismatch', 'Estimate is not on the FY1 horizon');
  if (estimate.currency !== priceCurrency) {
    return na('basis-mismatch', `Price is in ${priceCurrency}, estimate is in ${estimate.currency}`);
  }
  if (estimate.value <= 0) {
    return na('not-applicable', 'Forward EPS is not positive (loss making or non positive estimate). No multiple.');
  }
  const age = calendarDaysBetween(estimate.asOf, priceDate);
  if (age < 0) return na('basis-mismatch', `Estimate dated ${estimate.asOf} is later than the price date ${priceDate}`);
  const tol = input.maxEstimateAgeDays ?? VALUATION_DEFAULTS.maxEstimateAgeDays.value;
  if (age > tol) {
    return na('stale-source', `Estimate dated ${estimate.asOf} is ${age} days older than the ${priceDate} close`);
  }
  if (estimate.fiscalYearEnd < priceDate) {
    return na('stale-source', `FY1 fiscal year ended ${estimate.fiscalYearEnd}, before the ${priceDate} close`);
  }
  return {
    value: price / estimate.value,
    basis: 'FY1',
    basisLabel: 'Forward P/E, FY1 annual EPS estimate',
    price,
    priceDate,
    eps: estimate.value,
    estimateDate: estimate.asOf,
    fiscalYearEnd: estimate.fiscalYearEnd,
    currency: priceCurrency,
    source: estimate.source,
  };
};

/* ----------------------------------------------------------------- trailing P/E */

export type EpsBasis = 'gaap' | 'adjusted';

export interface QuarterlyEps {
  periodEnd: ISODate;
  /** Standalone quarter EPS on the declared basis. May be negative. */
  eps: number;
  basis: EpsBasis;
  currency: string;
  /** Publication date. When present, a quarter is usable only once it was published. */
  reportedAt?: ISODate;
}

export interface TrailingPeInput {
  price: number;
  priceDate: ISODate;
  priceCurrency: string;
  quarters: readonly QuarterlyEps[];
  basis?: EpsBasis;
}

export interface TrailingPeRecord {
  value: number;
  basis: EpsBasis;
  basisLabel: string;
  price: number;
  priceDate: ISODate;
  epsSum: number;
  /** The four quarters used, newest first. */
  quarters: QuarterlyEps[];
  currency: string;
}

/** Trailing P/E from four consecutive comparable actual quarters ending on or before the price date. */
export const trailingPe = (input: TrailingPeInput): Maybe<TrailingPeRecord> => {
  const basis = input.basis ?? 'gaap';
  if (!(Number.isFinite(input.price) && input.price > 0)) return na('invalid-input', 'Price is not a positive number');
  const usable = input.quarters
    .filter(
      (q) =>
        q.basis === basis &&
        q.currency === input.priceCurrency &&
        Number.isFinite(q.eps) &&
        q.periodEnd <= input.priceDate &&
        (q.reportedAt === undefined || q.reportedAt <= input.priceDate),
    )
    .sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : a.periodEnd > b.periodEnd ? -1 : 0));
  const four = usable.slice(0, 4);
  if (four.length < 4) {
    return na('insufficient-history', `Needs four comparable ${basis} quarters in ${input.priceCurrency}, found ${four.length}`);
  }
  const newestAge = calendarDaysBetween(four[0]!.periodEnd, input.priceDate);
  if (newestAge > VALUATION_DEFAULTS.maxLatestQuarterAgeDays.value) {
    return na('stale-source', `Newest actual quarter ended ${four[0]!.periodEnd}, ${newestAge} days before the price date`);
  }
  const { min, max } = VALUATION_DEFAULTS.quarterSpacingDays;
  for (let k = 0; k < 3; k++) {
    const gap = calendarDaysBetween(four[k + 1]!.periodEnd, four[k]!.periodEnd);
    if (gap < min || gap > max) {
      return na('basis-mismatch', `Quarters ending ${four[k + 1]!.periodEnd} and ${four[k]!.periodEnd} are not consecutive`);
    }
  }
  const epsSum = four.reduce((s, q) => s + q.eps, 0);
  if (epsSum <= 0) return na('not-applicable', 'Trailing four quarter EPS is not positive. No multiple.');
  return {
    value: input.price / epsSum,
    basis,
    basisLabel: `Trailing P/E, four ${basis === 'gaap' ? 'GAAP' : 'adjusted'} quarters`,
    price: input.price,
    priceDate: input.priceDate,
    epsSum,
    quarters: four,
    currency: input.priceCurrency,
  };
};

/* --------------------------------------------------------------------- archive */

/** One captured forward multiple. Stored once and never rewritten. */
export interface ValuationObservation {
  date: ISODate;
  value: number;
  basis: 'FY1';
  currency: string;
  source: SourceCapture;
}

export type ValuationArchive = readonly ValuationObservation[];

export interface AppendResult {
  archive: ValuationArchive;
  appended: boolean;
  /** Why nothing was appended. */
  reason?: string;
}

/** Turn a display record into an archive observation dated at its price date. */
export const observationFromRecord = (r: ForwardPeRecord): ValuationObservation => ({
  date: r.priceDate,
  value: r.value,
  basis: r.basis,
  currency: r.currency,
  source: r.source,
});

/**
 * Append only. A date already captured is never overwritten, and a date earlier than the newest
 * capture is refused because a later estimate cannot be written into the past.
 */
export const appendObservation = (archive: ValuationArchive, obs: ValuationObservation): AppendResult => {
  if (!(Number.isFinite(obs.value) && obs.value > 0)) return { archive, appended: false, reason: 'Observation is not a positive multiple' };
  const last = archive[archive.length - 1];
  if (archive.some((o) => o.date === obs.date)) {
    return { archive, appended: false, reason: `Already captured for ${obs.date}. Captured consensus is append only.` };
  }
  if (last && obs.date < last.date) {
    return { archive, appended: false, reason: `Cannot backfill ${obs.date} behind the newest capture ${last.date}` };
  }
  return { archive: [...archive, obs], appended: true };
};

export interface OwnHistoryContext {
  /** Midrank percentile of the current multiple inside earlier compatible captures. */
  percentile: number;
  n: number;
  from: ISODate;
  to: ISODate;
  min: number;
  max: number;
  median: number;
}

/** Percentile of the current multiple in its own earlier captures. Needs ten compatible observations. */
export const ownHistoryPercentile = (
  archive: ValuationArchive,
  current: Pick<ValuationObservation, 'date' | 'value' | 'basis' | 'currency'>,
): Maybe<OwnHistoryContext> => {
  const prior = archive.filter((o) => o.date < current.date && o.basis === current.basis && o.currency === current.currency);
  const need = VALUATION_DEFAULTS.minOwnHistoryObservations.value;
  if (prior.length < need) {
    return na('sample-too-small', `Collecting. ${prior.length} of ${need} compatible captures before ${current.date}.`);
  }
  const vals = prior.map((o) => o.value);
  return {
    percentile: midrankPercentile(vals, current.value),
    n: vals.length,
    from: prior[0]!.date,
    to: prior[prior.length - 1]!.date,
    min: Math.min(...vals),
    max: Math.max(...vals),
    median: median(vals),
  };
};

export interface PeerSnapshot {
  symbol: string;
  record: Maybe<ForwardPeRecord>;
}

export interface PeerContext {
  asOf: ISODate;
  n: number;
  median: number;
  min: number;
  max: number;
  /** Midrank percentile of the subject inside the peer multiples, when the subject has one. */
  subjectPercentile: Maybe<number>;
  used: { symbol: string; value: number; priceDate: ISODate }[];
  excluded: { symbol: string; reason: string }[];
}

/** Peer multiple context. Needs at least three peers with a compatible snapshot within seven days. */
export const peerContext = (subject: Maybe<ForwardPeRecord>, peers: readonly PeerSnapshot[], asOf: ISODate): Maybe<PeerContext> => {
  const used: PeerContext['used'] = [];
  const excluded: PeerContext['excluded'] = [];
  const maxDays = VALUATION_DEFAULTS.peerSnapshotMaxDays.value;
  const currency = isNa(subject) ? null : subject.currency;
  for (const p of peers) {
    if (isNa(p.record)) {
      excluded.push({ symbol: p.symbol, reason: p.record.detail ?? p.record.code });
      continue;
    }
    const age = Math.abs(calendarDaysBetween(p.record.priceDate, asOf));
    if (age > maxDays) {
      excluded.push({ symbol: p.symbol, reason: `Snapshot dated ${p.record.priceDate} is more than ${maxDays} days from ${asOf}` });
      continue;
    }
    if (currency !== null && p.record.currency !== currency) {
      excluded.push({ symbol: p.symbol, reason: `Currency ${p.record.currency} differs from ${currency}` });
      continue;
    }
    used.push({ symbol: p.symbol, value: p.record.value, priceDate: p.record.priceDate });
  }
  const need = VALUATION_DEFAULTS.minPeers.value;
  if (used.length < need) return na('sample-too-small', `Needs ${need} peers with a compatible snapshot, found ${used.length}`);
  const vals = used.map((u) => u.value);
  return {
    asOf,
    n: used.length,
    median: median(vals),
    min: Math.min(...vals),
    max: Math.max(...vals),
    subjectPercentile: isNa(subject) ? subject : midrankPercentile(vals, subject.value),
    used,
    excluded,
  };
};

/* ------------------------------------------------------------------- cash flow */

/** FCF = operating cash flow - capital expenditure. Accepts capex signed either way. */
export const deriveFcf = (operatingCashFlow: number, capex: number): number => operatingCashFlow - Math.abs(capex);

export interface FcfRecord {
  value: number;
  scope: FiscalScope;
  periodEnd: ISODate;
  filedAt: ISODate;
  currency: string;
  operatingCashFlow: number;
  /** Positive outflow. */
  capex: number;
  /** True when this is the newest released period of the scope. False for a dated fallback. */
  isLatestPeriod: boolean;
  /** Period end of the newest released report of the scope. */
  newestPeriodEnd: ISODate;
  /** Set when the newest report lacked FCF and an earlier period is shown. */
  note?: string;
  source: SourceCapture;
}

export interface LatestFcfOptions {
  /** Fiscal scope to read. Scopes are never mixed. Default quarter. */
  scope?: FiscalScope;
  /** Use only reports filed on or before this date. */
  asOf?: ISODate;
}

/**
 * Free cash flow of the newest released fiscal period of one scope. When that report has no FCF
 * the latest earlier period that has one is returned, flagged `isLatestPeriod: false` with a note.
 */
export const latestFcf = (periods: Maybe<readonly CashFlowPeriod[]> | null | undefined, opts: LatestFcfOptions = {}): Maybe<FcfRecord> => {
  if (periods === null || periods === undefined) return na('no-coverage', 'No cash flow reports');
  if (isNa(periods)) return periods;
  const scope = opts.scope ?? 'quarter';
  const inScope = periods
    .filter((p) => p.scope === scope && (opts.asOf === undefined || p.filedAt <= opts.asOf))
    .sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : a.periodEnd > b.periodEnd ? -1 : 0));
  const newest = inScope[0];
  if (!newest) return na('no-coverage', `No released ${scope} cash flow report`);
  const hit = inScope.find((p) => p.freeCashFlow !== null && Number.isFinite(p.freeCashFlow));
  if (!hit) return na('no-coverage', `No ${scope} report with free cash flow`);
  const isLatest = hit === newest;
  const rec: FcfRecord = {
    value: hit.freeCashFlow!,
    scope,
    periodEnd: hit.periodEnd,
    filedAt: hit.filedAt,
    currency: hit.currency,
    operatingCashFlow: hit.operatingCashFlow,
    capex: Math.abs(hit.capex),
    isLatestPeriod: isLatest,
    newestPeriodEnd: newest.periodEnd,
    source: hit.source,
  };
  if (!isLatest) {
    rec.note = `The report for the period ended ${newest.periodEnd} has no free cash flow. Showing the period ended ${hit.periodEnd}.`;
  }
  return rec;
};

/**
 * The FCF value a "current" filter may use. A dated fallback from an earlier period is excluded
 * unless the caller opts in.
 */
export const fcfForCurrentFilter = (rec: Maybe<FcfRecord>, allowPriorPeriod = false): Maybe<number> => {
  if (isNa(rec)) return rec;
  if (!rec.isLatestPeriod && !allowPriorPeriod) {
    return na('stale-source', rec.note ?? `Latest period lacks free cash flow. Prior period ${rec.periodEnd} is not current.`);
  }
  return rec.value;
};

export interface TtmFcf {
  value: number;
  scope: 'ttm';
  periodEnd: ISODate;
  /** The four standalone quarters summed, newest first. */
  quarters: ISODate[];
  currency: string;
}

/** Trailing year FCF as the sum of the four newest consecutive standalone quarters, all with FCF. */
export const trailingYearFcf = (periods: Maybe<readonly CashFlowPeriod[]> | null | undefined, asOf?: ISODate): Maybe<TtmFcf> => {
  if (periods === null || periods === undefined) return na('no-coverage', 'No cash flow reports');
  if (isNa(periods)) return periods;
  const q = periods
    .filter((p) => p.scope === 'quarter' && (asOf === undefined || p.filedAt <= asOf))
    .sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : a.periodEnd > b.periodEnd ? -1 : 0))
    .slice(0, 4);
  if (q.length < 4) return na('insufficient-history', `Needs four standalone quarters, found ${q.length}`);
  if (q.some((p) => p.freeCashFlow === null)) return na('no-coverage', 'A quarter inside the trailing year has no free cash flow');
  if (new Set(q.map((p) => p.currency)).size > 1) return na('basis-mismatch', 'Quarters are in different currencies');
  const { min, max } = VALUATION_DEFAULTS.quarterSpacingDays;
  for (let k = 0; k < 3; k++) {
    const gap = calendarDaysBetween(q[k + 1]!.periodEnd, q[k]!.periodEnd);
    if (gap < min || gap > max) return na('basis-mismatch', 'Quarters are not consecutive');
  }
  return {
    value: q.reduce((s, p) => s + p.freeCashFlow!, 0),
    scope: 'ttm',
    periodEnd: q[0]!.periodEnd,
    quarters: q.map((p) => p.periodEnd),
    currency: q[0]!.currency,
  };
};

export interface CashOnHand {
  value: number;
  /** Balance sheet date. */
  asOf: ISODate;
  label: string;
  source: SourceCapture;
}

/** Cash and equivalents with its balance sheet date. */
export const cashOnHand = (cash: Maybe<DatedValue> | null | undefined): Maybe<CashOnHand> => {
  if (cash === null || cash === undefined) return na('no-coverage', 'No reported cash balance');
  if (isNa(cash)) return cash;
  if (!Number.isFinite(cash.value)) return na('invalid-input', 'Cash balance is not a finite number');
  return { value: cash.value, asOf: cash.asOf, label: `Cash and equivalents at ${cash.asOf}`, source: cash.source };
};

/** Convenience: every valuation and cash fact of one instrument from one fundamentals capture. */
export interface ValuationFacts {
  forwardPe: Maybe<ForwardPeRecord>;
  fcf: Maybe<FcfRecord>;
  cash: Maybe<CashOnHand>;
  marketCap: Maybe<number>;
}

export const valuationFacts = (
  price: Maybe<{ close: number; date: ISODate; currency: string }>,
  fundamentals: Maybe<Fundamentals> | null | undefined,
): ValuationFacts => {
  if (fundamentals === null || fundamentals === undefined || isNa(fundamentals)) {
    const r = fundamentals === null || fundamentals === undefined ? na('no-coverage', 'No fundamentals capture') : fundamentals;
    return { forwardPe: r, fcf: r, cash: r, marketCap: r };
  }
  return {
    forwardPe: isNa(price)
      ? price
      : forwardPe({ price: price.close, priceDate: price.date, priceCurrency: price.currency, estimate: fundamentals.forwardEps }),
    fcf: latestFcf(fundamentals.cashFlow),
    cash: cashOnHand(fundamentals.cash),
    marketCap: isNa(fundamentals.marketCap) ? fundamentals.marketCap : fundamentals.marketCap.value,
  };
};
