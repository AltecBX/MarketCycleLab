/**
 * Data contracts between providers, the client cache and the views.
 * Engines never talk to a provider. They receive validated series through these shapes.
 */
import type { DailySeries, EarningsEvent, ISODate, Instrument, Maybe, SourceCapture, SourceKind } from '../engine/core/types';

export interface DatedValue {
  value: number;
  /** Date the value refers to (balance sheet date, estimate capture date). */
  asOf: ISODate;
  source: SourceCapture;
}

export interface ForwardEps extends DatedValue {
  /** Fiscal horizon. FY1 is never mixed with next-twelve-months. */
  horizon: 'FY1';
  fiscalYearEnd: ISODate;
  currency: string;
}

export type FiscalScope = 'quarter' | 'fiscal-year' | 'ttm' | 'ytd';

export interface CashFlowPeriod {
  scope: FiscalScope;
  periodEnd: ISODate;
  filedAt: ISODate;
  currency: string;
  operatingCashFlow: number;
  /** Capital expenditure as a positive outflow. */
  capex: number;
  /** operatingCashFlow - capex. Null when the report did not let it be derived. */
  freeCashFlow: number | null;
  source: SourceCapture;
}

export interface Fundamentals {
  instrumentId: string;
  currency: string;
  marketCap: Maybe<DatedValue>;
  sharesOutstanding: Maybe<DatedValue>;
  forwardEps: Maybe<ForwardEps>;
  /** Cash and cash equivalents at the balance sheet date. */
  cash: Maybe<DatedValue>;
  /** Fiscal periods, newest first. */
  cashFlow: Maybe<CashFlowPeriod[]>;
  beta: Maybe<number>;
}

export type GroupKind = 'curated-theme' | 'verified-industry' | 'etf-basket';

export interface TradingGroup {
  id: string;
  name: string;
  kind: GroupKind;
  /** Member display symbols. Membership can be many-to-many. */
  members: string[];
  /** Why these names sit together, and the evidence quality. */
  basis: string;
  asOf: ISODate;
}

export type HealthState = 'ok' | 'degraded' | 'failed' | 'stale';

export interface SourceHealth {
  id: string;
  label: string;
  kind: SourceKind;
  state: HealthState;
  /** What this source feeds. */
  feeds: string[];
  lastSuccess: string | null;
  lastAttempt: string | null;
  /** Latest completed session the source covers. */
  dataThrough: ISODate | null;
  error?: string;
  /** What remains usable when the source is not ok. */
  fallback?: string;
}

export interface ResolvedSymbol {
  instrument: Instrument;
  /** Set when the query matched a former ticker. */
  viaAlias?: { symbol: string; evidence: string };
}

export interface CalendarEntry extends EarningsEvent {
  name: string;
  marketCap: number | null;
}

export interface Clock {
  /** Current instant, ISO timestamp. Frozen in fixture mode so results are reproducible. */
  now: string;
  /** Latest session whose regular close has happened. */
  lastCompletedSession: ISODate;
}

export interface DataProvider {
  readonly id: string;
  readonly kind: SourceKind;
  /** Human label shown wherever data from this provider appears. */
  readonly label: string;
  clock(): Clock;
  listInstruments(): Promise<Instrument[]>;
  resolve(symbol: string): Promise<Maybe<ResolvedSymbol>>;
  getDaily(instrumentId: string): Promise<Maybe<DailySeries>>;
  getEarnings(instrumentId: string): Promise<Maybe<EarningsEvent[]>>;
  getFundamentals(instrumentId: string): Promise<Maybe<Fundamentals>>;
  getGroups(): Promise<TradingGroup[]>;
  getEarningsCalendar(from: ISODate, to: ISODate): Promise<Maybe<CalendarEntry[]>>;
  health(): Promise<SourceHealth[]>;
}
