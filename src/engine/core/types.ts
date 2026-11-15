/**
 * Canonical shared types for every analytical engine.
 *
 * Conventions that every engine relies on:
 * - A session date is an exchange-local calendar date, 'YYYY-MM-DD'.
 * - A bar is a COMPLETED regular session. Intraday or extended-hours previews never enter a series.
 * - A missing value is a structured `Unavailable`, never 0 and never NaN.
 * - Percent quantities are stored as fractions (0.05 = 5%). Percentage-point differences are also
 *   stored as fractions and labeled "pp" by the presentation layer.
 */

export type ISODate = string;

export type ReasonCode =
  | 'insufficient-history'
  | 'missing-session'
  | 'missing-base-close'
  | 'no-coverage'
  | 'not-applicable'
  | 'basis-mismatch'
  | 'basis-boundary'
  | 'flat-range'
  | 'incomplete-period'
  | 'not-matured'
  | 'sample-too-small'
  | 'gate-failed'
  | 'stale-source'
  | 'source-failed'
  | 'ambiguous-timing'
  | 'unknown-symbol'
  | 'invalid-input'
  | 'not-validated';

export interface Unavailable {
  readonly unavailable: true;
  readonly code: ReasonCode;
  readonly detail?: string;
}

export type Maybe<T> = T | Unavailable;

export const na = (code: ReasonCode, detail?: string): Unavailable =>
  detail === undefined ? { unavailable: true, code } : { unavailable: true, code, detail };

export const isNa = (v: unknown): v is Unavailable =>
  typeof v === 'object' && v !== null && (v as { unavailable?: unknown }).unavailable === true;

export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Unwrap a Maybe<number> to number | null for arithmetic that tolerates gaps explicitly. */
export const numOrNull = (v: Maybe<number> | null | undefined): number | null => (isNum(v) ? v : null);

/** Completed regular-session OHLCV bar on one declared price basis. */
export interface Bar {
  date: ISODate;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Shares traded. Null when the source did not verify volume for the session. */
  volume: number | null;
}

/**
 * Price basis of a series.
 * - 'split-adjusted': quote OHLC on one consistent split basis, no dividend reinvestment. Used for
 *   raw price change, weekly and monthly boards, ranges, option strikes.
 * - 'total-return': dividend-adjusted closes. Used only where declared and where both legs match.
 */
export type PriceBasis = 'split-adjusted' | 'total-return';

export type SourceKind = 'synthetic-fixture' | 'provider' | 'reviewed-capture' | 'owner-input' | 'proxy';

export interface SourceCapture {
  /** Stable provider or fixture identifier, for example 'synthetic-v1'. */
  provider: string;
  kind: SourceKind;
  /** When this capture was collected, ISO timestamp. */
  capturedAt: string;
  /** Provider publication time if the provider states one. */
  publishedAt?: string;
  /** Parser or generator version that produced the rows. */
  version: string;
  note?: string;
}

export interface Coverage {
  /** Earliest usable completed session in the series. */
  first: ISODate | null;
  /** Latest completed session in the series. */
  last: ISODate | null;
  sessions: number;
  /** Expected exchange sessions between first and last that the series does not contain. */
  missingSessions: ISODate[];
  /** True when the requested window is fully covered. */
  complete: boolean;
  /** Earliest date the caller asked for, when a window was requested. */
  requestedFrom?: ISODate;
  note?: string;
}

export type SecurityType = 'stock' | 'adr' | 'etf' | 'index';

export interface SymbolAlias {
  symbol: string;
  /** Inclusive validity window of this display symbol for the instrument. Null means open ended. */
  from: ISODate | null;
  to: ISODate | null;
  /** Evidence note. Aliases without identity evidence are never spliced. */
  evidence: string;
}

export interface BasisBoundary {
  /** First session of the current continuous security. History before it is a different basis. */
  date: ISODate;
  reason: string;
}

export interface Instrument {
  /** Canonical instrument id. Stable across ticker changes. Never shown as a ticker. */
  id: string;
  /** Current display ticker. */
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  type: SecurityType;
  /** Country of the issuer when not the United States. */
  country?: string;
  aliases: SymbolAlias[];
  basisBoundary?: BasisBoundary;
  listedOn?: ISODate;
  /** Verified industry classification, separate from curated trading themes. */
  industry?: string;
  sector?: string;
  /** Sector ETF symbol used for sector-relative comparisons, when verified. */
  sectorEtf?: string;
}

export interface DailySeries {
  instrumentId: string;
  symbol: string;
  currency: string;
  basis: PriceBasis;
  bars: Bar[];
  coverage: Coverage;
  source: SourceCapture;
}

export type EarningsTime = 'bmo' | 'amc' | 'during' | 'unknown';
export type DateStatus = 'confirmed' | 'estimated';

export interface EarningsEvent {
  instrumentId: string;
  symbol: string;
  /** Calendar date of the release, exchange-local. */
  date: ISODate;
  time: EarningsTime;
  status: DateStatus;
  fiscalPeriod?: string;
  /** When this date and time became known. Required for point-in-time model features. */
  knownAt?: string;
  epsActual?: number | null;
  epsEstimate?: number | null;
  revenueActual?: number | null;
  revenueEstimate?: number | null;
  source: SourceCapture;
}

/** A proportion with its exact hits, denominator and Wilson interval. Never shown without n. */
export interface Proportion {
  hits: number;
  n: number;
  rate: number;
  lo: number;
  hi: number;
  level: number;
}

export interface Distribution {
  n: number;
  mean: number;
  median: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  min: number;
  max: number;
}

/** Shared status vocabulary for any modeled probability. */
export type ModelStatus = 'valid' | 'not-reliable' | 'insufficient-evidence' | 'stale' | 'unavailable';
