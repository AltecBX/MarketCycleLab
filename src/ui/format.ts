/** Display formatting. One place so a percent, a date or a dollar amount reads the same everywhere. */
import { isNa, isNum, type Maybe, type ReasonCode, type Unavailable } from '../engine/core/types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTH_NAMES = MONTHS;

/** 'Nov 13, 2026'. */
export const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return 'n/a';
  const y = iso.slice(0, 4);
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  return `${MONTHS[m - 1] ?? '?'} ${d}, ${y}`;
};

/** 'Nov 13'. */
export const fmtDateShort = (iso: string | null | undefined): string => {
  if (!iso) return 'n/a';
  return `${MONTHS[Number(iso.slice(5, 7)) - 1] ?? '?'} ${Number(iso.slice(8, 10))}`;
};

/** ET timestamp for a UTC instant, 'Nov 14, 10:00am ET'. */
export const fmtTimeET = (isoInstant: string | null | undefined): string => {
  if (!isoInstant) return 'n/a';
  const d = new Date(isoInstant);
  if (Number.isNaN(d.getTime())) return 'n/a';
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('month')} ${g('day')}, ${g('hour')}:${g('minute')}${g('dayPeriod').toLowerCase()} ET`;
};

const MINUS = '−';
const sign = (x: number, signed: boolean): string => (x < 0 ? MINUS : signed && x > 0 ? '+' : '');

/** Fraction to percent text. 0.1234 gives '+12.34%' when signed. */
export const fmtPct = (x: number | null | undefined, digits = 2, signed = true): string => {
  if (!isNum(x)) return 'n/a';
  const v = Math.abs(x * 100);
  return `${sign(x, signed)}${v.toFixed(digits)}%`;
};

/** Percentage-point difference stored as a fraction. 0.0123 gives '+1.23 pp'. */
export const fmtPp = (x: number | null | undefined, digits = 2): string => {
  if (!isNum(x)) return 'n/a';
  return `${sign(x, true)}${Math.abs(x * 100).toFixed(digits)} pp`;
};

export const fmtNum = (x: number | null | undefined, digits = 2, signed = false): string => {
  if (!isNum(x)) return 'n/a';
  return `${sign(x, signed)}${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};

export const fmtInt = (x: number | null | undefined): string => (isNum(x) ? Math.round(x).toLocaleString('en-US') : 'n/a');

export const fmtPrice = (x: number | null | undefined): string => (isNum(x) ? `$${fmtNum(x, 2)}` : 'n/a');

/** Compact money: $1.23T, $45.6B, $789M, $12.3K. */
export const fmtMoney = (x: number | null | undefined, signed = false): string => {
  if (!isNum(x)) return 'n/a';
  const a = Math.abs(x);
  const s = sign(x, signed);
  if (a >= 1e12) return `${s}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(a >= 1e11 ? 0 : 1)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}K`;
  return `${s}$${a.toFixed(2)}`;
};

export const fmtDollars = (x: number | null | undefined, signed = false): string => {
  if (!isNum(x)) return 'n/a';
  return `${sign(x, signed)}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
};

export const fmtMultiple = (x: number | null | undefined, digits = 1): string => (isNum(x) ? `${x.toFixed(digits)}×` : 'n/a');

export const plural = (n: number, one: string, many = `${one}s`): string => `${fmtInt(n)} ${n === 1 ? one : many}`;

export const dirClass = (x: number | null | undefined): 'up' | 'down' | 'flat' => (!isNum(x) || x === 0 ? 'flat' : x > 0 ? 'up' : 'down');

/** Non-color cue for direction. */
export const dirGlyph = (x: number | null | undefined): string => (!isNum(x) || x === 0 ? '' : x > 0 ? '▲' : '▼');

const REASON_TEXT: Record<ReasonCode, string> = {
  'insufficient-history': 'Not enough history',
  'missing-session': 'A session is missing',
  'missing-base-close': 'No base close',
  'no-coverage': 'No coverage',
  'not-applicable': 'Not applicable',
  'basis-mismatch': 'Price basis mismatch',
  'basis-boundary': 'Before the current security',
  'flat-range': 'Flat range',
  'incomplete-period': 'Period incomplete',
  'not-matured': 'Not matured yet',
  'sample-too-small': 'Sample too small',
  'gate-failed': 'Did not pass its gate',
  'stale-source': 'Source is stale',
  'source-failed': 'Source failed',
  'ambiguous-timing': 'Timing unknown',
  'unknown-symbol': 'Unknown symbol',
  'invalid-input': 'Invalid input',
  'not-validated': 'Not validated',
};

export const reasonText = (u: Unavailable): string => REASON_TEXT[u.code] ?? 'Unavailable';
export const reasonDetail = (u: Unavailable): string => (u.detail ? `${reasonText(u)}. ${u.detail}` : reasonText(u));

/** Format a Maybe<number> with a formatter, or the short reason. */
export const fmtMaybe = (v: Maybe<number> | null | undefined, f: (x: number) => string): string => {
  if (v === null || v === undefined) return 'n/a';
  if (isNa(v)) return 'n/a';
  return f(v);
};

/** Heat color for a signed fraction with intensity capped at `cap`. Returns a CSS background value. */
export const heatBg = (x: number | null | undefined, cap = 0.09): string | undefined => {
  if (!isNum(x) || x === 0) return undefined;
  const t = Math.min(1, Math.abs(x) / cap);
  const pct = Math.round(14 + t * 46);
  return `color-mix(in srgb, var(${x > 0 ? '--up' : '--down'}) ${pct}%, var(--surface))`;
};
