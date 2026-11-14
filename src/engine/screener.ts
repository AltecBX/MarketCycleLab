/**
 * Stock screener model (owner specification section 12).
 *
 * Definitions
 * - A row is one instrument at one completed close. Every price derived field uses that close.
 * - Daily change = C / previous session close - 1. WTD, MTD, QTD, YTD use the final close of the
 *   preceding period as base (core `periodToDate`).
 * - Signed % from the 200 day average = C / SMA200 - 1, from 200 consecutive completed sessions.
 * - 52 week traded high = highest daily high of the last 252 completed sessions (source: computed
 *   from daily bars). Drawdown = C / H - 1. Required gain to regain H = H / C - 1.
 * - Forward P/E, cash and free cash flow come from `valuation.ts`, the same records the quote strip
 *   uses. The screener FCF value is the newest released period only. A dated prior period fallback
 *   stays on the record for display and never passes a "current" filter.
 * - The universe is stocks and ADRs with market cap at or above the active minimum (default $2B).
 *   ETFs and members below the floor are outside the universe but stay visible, labeled, in group
 *   research. No ticker specific inclusion rule exists.
 * - Missing data never passes an ordinary numeric filter and always sorts last, in both directions.
 * - Filter values are entered in display units: percent as a number of percent, market cap, cash
 *   and FCF in billions of dollars.
 */
import type { Fundamentals, TradingGroup } from '../data/contracts';
import { prevSession, sessionOnOrBefore, sessionsBetween } from './core/calendar';
import { rsiWilder } from './core/indicators';
import { periodToDate, sliceAsOf, type Period } from './core/series';
import { isNa, isNum, na, type Bar, type ISODate, type Instrument, type Maybe, type ModelStatus, type SecurityType } from './core/types';
import { cashOnHand, fcfForCurrentFilter, forwardPe, latestFcf, type CashOnHand, type FcfRecord, type ForwardPeRecord } from './valuation';

export const SCREENER_DEFAULTS = {
  minCapBillions: { value: 2, provenance: 'spec' as const },
  quickCapBillions: { value: 10, provenance: 'spec' as const },
  high52wSessions: { value: 252, provenance: 'proposed' as const },
  /** Relative tolerance for numeric equality and inclusive comparisons. */
  epsilon: 1e-9,
  pageSize: { value: 50, provenance: 'proposed' as const },
} as const;

/* ------------------------------------------------------------------------ rows */

export type QuoteCondition = 'completed-close' | 'stale-close' | 'no-data';

export interface BuyScore {
  /** Estimated probability of a higher close after 10 sessions, when its gate passed. */
  value: Maybe<number>;
  status: ModelStatus;
}

export interface ScreenerRow {
  instrumentId: string;
  symbol: string;
  name: string;
  type: SecurityType;
  exchange: string;
  currency: string;
  country: string | null;
  /** Former tickers, searchable. */
  aliases: string[];
  /** The one deterministic display group, or null. */
  group: string | null;
  groupId: string | null;
  /** Every curated group the symbol belongs to. */
  groups: string[];
  industry: string | null;
  sector: string | null;
  price: Maybe<number>;
  priceDate: ISODate | null;
  quoteCondition: QuoteCondition;
  marketCap: Maybe<number>;
  forwardPe: Maybe<number>;
  forwardPeRecord: Maybe<ForwardPeRecord>;
  rsi14: Maybe<number>;
  /** Signed C / SMA200 - 1. */
  sma200Dist: Maybe<number>;
  buy10: Maybe<number>;
  buy10Status: ModelStatus;
  weekMove: Maybe<number>;
  dayChange: Maybe<number>;
  wtd: Maybe<number>;
  mtd: Maybe<number>;
  qtd: Maybe<number>;
  ytd: Maybe<number>;
  high52w: Maybe<number>;
  high52wDate: ISODate | null;
  /** Sessions the high was taken over. Fewer than 252 when history is shorter. */
  high52wSessions: number;
  high52wSource: string;
  /** C / H - 1, zero or negative. */
  drawdown: Maybe<number>;
  /** H / C - 1, the gain needed to regain the high. */
  requiredGain: Maybe<number>;
  cash: Maybe<number>;
  cashRecord: Maybe<CashOnHand>;
  /** Newest released fiscal period FCF. Unavailable when only a prior period has it. */
  fcf: Maybe<number>;
  fcfRecord: Maybe<FcfRecord>;
  /** Set when history was cut at a spin off or similar basis boundary. */
  basisNote: string | null;
}

export interface RowExtras {
  /** Freeze the row at this date. Later bars are ignored. */
  asOf?: ISODate;
  groups?: readonly TradingGroup[];
  buy10?: BuyScore;
  weekMove?: Maybe<number>;
}

const NOT_SUPPLIED = (what: string) => na('not-validated', `${what} was not supplied`);

/** True when the last n bars are n consecutive exchange sessions. */
const contiguousTail = (bars: readonly Bar[], n: number): boolean => {
  if (bars.length < n) return false;
  const first = bars[bars.length - n]!.date;
  const last = bars[bars.length - 1]!.date;
  return sessionsBetween(first, last).length === n;
};

const periodRet = (bars: readonly Bar[], i: number, p: Period): Maybe<number> => {
  const r = periodToDate(bars, i, p);
  return isNa(r) ? r : r.ret;
};

/** Build one screener row from an instrument, its completed daily bars and its fundamentals. */
export const buildScreenerRow = (
  instrument: Instrument,
  allBars: readonly Bar[] | null | undefined,
  fundamentals: Maybe<Fundamentals> | null | undefined,
  extras: RowExtras = {},
): ScreenerRow => {
  const memberships = (extras.groups ?? []).filter((g) => g.members.includes(instrument.symbol));
  const fund = fundamentals === null || fundamentals === undefined ? na('no-coverage', 'No fundamentals capture') : fundamentals;
  const fcfRecord = isNa(fund) ? fund : latestFcf(fund.cashFlow, extras.asOf ? { asOf: extras.asOf } : {});
  const cashRecord = isNa(fund) ? fund : cashOnHand(fund.cash);
  const row: ScreenerRow = {
    instrumentId: instrument.id,
    symbol: instrument.symbol,
    name: instrument.name,
    type: instrument.type,
    exchange: instrument.exchange,
    currency: instrument.currency,
    country: instrument.country ?? null,
    aliases: instrument.aliases.map((a) => a.symbol),
    group: memberships[0]?.name ?? null,
    groupId: memberships[0]?.id ?? null,
    groups: memberships.map((g) => g.name),
    industry: instrument.industry ?? null,
    sector: instrument.sector ?? null,
    price: na('no-coverage', 'No completed sessions'),
    priceDate: null,
    quoteCondition: 'no-data',
    marketCap: isNa(fund) ? fund : isNa(fund.marketCap) ? fund.marketCap : fund.marketCap.value,
    forwardPe: na('no-coverage', 'No completed close'),
    forwardPeRecord: na('no-coverage', 'No completed close'),
    rsi14: na('no-coverage', 'No completed sessions'),
    sma200Dist: na('no-coverage', 'No completed sessions'),
    buy10: extras.buy10 ? extras.buy10.value : NOT_SUPPLIED('Signal Score'),
    buy10Status: extras.buy10 ? extras.buy10.status : 'unavailable',
    weekMove: extras.weekMove ?? NOT_SUPPLIED('Weekly range move'),
    dayChange: na('no-coverage', 'No completed sessions'),
    wtd: na('no-coverage', 'No completed sessions'),
    mtd: na('no-coverage', 'No completed sessions'),
    qtd: na('no-coverage', 'No completed sessions'),
    ytd: na('no-coverage', 'No completed sessions'),
    high52w: na('no-coverage', 'No completed sessions'),
    high52wDate: null,
    high52wSessions: 0,
    high52wSource: 'Highest traded high of the last 252 completed sessions, computed from daily bars',
    drawdown: na('no-coverage', 'No completed sessions'),
    requiredGain: na('no-coverage', 'No completed sessions'),
    cash: isNa(cashRecord) ? cashRecord : cashRecord.value,
    cashRecord,
    fcf: fcfForCurrentFilter(fcfRecord),
    fcfRecord,
    basisNote: null,
  };

  let bars: readonly Bar[] = allBars ?? [];
  if (extras.asOf) bars = sliceAsOf(bars, extras.asOf);
  const boundary = instrument.basisBoundary;
  if (boundary && bars.length && bars[0]!.date < boundary.date) {
    bars = bars.filter((b) => b.date >= boundary.date);
    row.basisNote = `History before ${boundary.date} is a different basis and is not used. ${boundary.reason}`;
  }
  if (bars.length === 0) return row;

  const i = bars.length - 1;
  const last = bars[i]!;
  row.price = last.close;
  row.priceDate = last.date;
  const expected = extras.asOf ? sessionOnOrBefore(extras.asOf) : last.date;
  row.quoteCondition = last.date < expected ? 'stale-close' : 'completed-close';

  const prev = bars[i - 1];
  if (!prev) row.dayChange = na('insufficient-history', 'No previous close');
  else if (prev.date !== prevSession(last.date)) row.dayChange = na('missing-session', `Expected a close on ${prevSession(last.date)}`);
  else row.dayChange = last.close / prev.close - 1;

  row.wtd = periodRet(bars, i, 'W');
  row.mtd = periodRet(bars, i, 'M');
  row.qtd = periodRet(bars, i, 'Q');
  row.ytd = periodRet(bars, i, 'Y');

  if (bars.length < 200) row.sma200Dist = na('insufficient-history', `Needs 200 completed sessions, has ${bars.length}`);
  else if (!contiguousTail(bars, 200)) row.sma200Dist = na('missing-session', 'A session is missing inside the 200 session window');
  else {
    let s = 0;
    for (let k = i - 199; k <= i; k++) s += bars[k]!.close;
    row.sma200Dist = last.close / (s / 200) - 1;
  }

  if (bars.length < 15) row.rsi14 = na('insufficient-history', `Needs 15 completed sessions, has ${bars.length}`);
  else if (!contiguousTail(bars, 15)) row.rsi14 = na('missing-session', 'A session is missing inside the RSI window');
  else {
    const r = rsiWilder(bars.map((b) => b.close))[i];
    row.rsi14 = r === null || r === undefined ? na('insufficient-history', 'RSI14 not seeded') : r;
  }

  const want = SCREENER_DEFAULTS.high52wSessions.value;
  const n = Math.min(want, bars.length);
  let hi = -Infinity;
  let hiDate: ISODate = last.date;
  for (let k = i - n + 1; k <= i; k++) {
    const b = bars[k]!;
    if (b.high > hi) {
      hi = b.high;
      hiDate = b.date;
    }
  }
  row.high52w = hi;
  row.high52wDate = hiDate;
  row.high52wSessions = n;
  if (n < want) row.high52wSource = `Highest traded high since history starts ${bars[0]!.date} (${n} sessions), computed from daily bars`;
  row.drawdown = last.close / hi - 1;
  row.requiredGain = hi / last.close - 1;

  const pe = isNa(fund)
    ? fund
    : forwardPe({ price: last.close, priceDate: last.date, priceCurrency: instrument.currency, estimate: fund.forwardEps });
  row.forwardPeRecord = pe;
  row.forwardPe = isNa(pe) ? pe : pe.value;
  return row;
};

/* ---------------------------------------------------------------------- fields */

export type FieldId =
  | 'symbol' | 'name' | 'group' | 'industry' | 'sector' | 'exchange' | 'type'
  | 'price' | 'cap' | 'pe' | 'rsi' | 'sma200' | 'buy10' | 'week'
  | 'day' | 'wtd' | 'mtd' | 'qtd' | 'ytd'
  | 'high52' | 'drawdown' | 'gain' | 'cash' | 'fcf';

export type FieldUnit = 'text' | 'price' | 'billions' | 'multiple' | 'index' | 'percent';
export type FieldTab = 'main' | 'cash' | 'drawdown' | 'filter-only';

export interface FieldDef {
  id: FieldId;
  label: string;
  short: string;
  kind: 'number' | 'text';
  unit: FieldUnit;
  tab: FieldTab;
  /** True when the value depends on the completed close and needs a fresh quote to filter on. */
  priceDerived: boolean;
  aliases: string[];
  /** Compact definition for hover, focus and tap. */
  definition: string;
  get: (row: ScreenerRow) => number | string | null;
}

const num = (v: Maybe<number>): number | null => (isNum(v) ? v : null);

const F = (
  id: FieldId, label: string, short: string, unit: FieldUnit, tab: FieldTab, priceDerived: boolean,
  aliases: string[], definition: string, get: FieldDef['get'],
): FieldDef => ({ id, label, short, kind: unit === 'text' ? 'text' : 'number', unit, tab, priceDerived, aliases, definition, get });

/** Column and filter registry, in main table order. */
export const SCREENER_FIELDS: readonly FieldDef[] = [
  F('symbol', 'Symbol', 'Symbol', 'text', 'main', false, ['symbol', 'ticker'], 'Current display ticker.', (r) => r.symbol),
  F('name', 'Company', 'Company', 'text', 'main', false, ['name', 'company'], 'Issuer name.', (r) => r.name),
  F('price', 'Price', 'Price', 'price', 'main', true, ['price', 'px', 'close'], 'Latest completed regular session close.', (r) => num(r.price)),
  F('cap', 'Market cap', 'Cap', 'billions', 'main', false, ['cap', 'marketcap', 'mcap'], 'Market capitalization in billions of dollars at its capture date.', (r) => num(r.marketCap)),
  F('group', 'Trading group', 'Group', 'text', 'main', false, ['group', 'theme'], 'Curated trading theme. A research grouping, not evidence of co movement.', (r) => r.group),
  F('pe', 'Forward P/E', 'Fwd P/E', 'multiple', 'main', true, ['pe', 'fpe', 'forwardpe'], 'Close divided by the verified positive FY1 annual EPS estimate. Blank when EPS is not positive or the estimate is stale.', (r) => num(r.forwardPe)),
  F('rsi', 'RSI 14', 'RSI', 'index', 'main', true, ['rsi', 'rsi14'], 'Wilder RSI over 14 sessions, 0 to 100.', (r) => num(r.rsi14)),
  F('sma200', '% from 200 day average', 'vs 200d', 'percent', 'main', true, ['sma200', 'ma200', '200ma', '200d', 'from200'], 'Close divided by the 200 session simple average, minus 1. Negative means below.', (r) => num(r.sma200Dist)),
  F('buy10', '10 session Buy %', 'Buy 10', 'percent', 'main', true, ['buy10', 'buy'], 'Modeled chance of a higher close after 10 sessions. Shown only when its reliability gate passes.', (r) => num(r.buy10)),
  F('week', 'Week move', 'Week move', 'percent', 'main', true, ['week', 'weekmove'], 'Expected weekly move from the Weekly Range Engine, when a forecast exists.', (r) => num(r.weekMove)),
  F('day', 'Today', 'Today', 'percent', 'main', true, ['day', 'today', 'chg', 'change'], 'Close versus the previous session close.', (r) => num(r.dayChange)),
  F('wtd', 'Week to date', 'WTD', 'percent', 'main', true, ['wtd'], 'Close versus the final close of the prior week.', (r) => num(r.wtd)),
  F('mtd', 'Month to date', 'MTD', 'percent', 'main', true, ['mtd'], 'Close versus the final close of the prior month.', (r) => num(r.mtd)),
  F('qtd', 'Quarter to date', 'QTD', 'percent', 'main', true, ['qtd'], 'Close versus the final close of the prior quarter.', (r) => num(r.qtd)),
  F('ytd', 'Year to date', 'YTD', 'percent', 'main', true, ['ytd'], 'Close versus the final close of the prior year.', (r) => num(r.ytd)),
  F('high52', '52 week traded high', '52w high', 'price', 'drawdown', true, ['high52', '52wh', 'high'], 'Highest daily high of the last 252 completed sessions, computed from daily bars.', (r) => num(r.high52w)),
  F('drawdown', 'From 52 week high', 'Off high', 'percent', 'drawdown', true, ['drawdown', 'dd', 'offhigh'], 'Close divided by the 52 week traded high, minus 1.', (r) => num(r.drawdown)),
  F('gain', 'Gain to regain high', 'To regain', 'percent', 'drawdown', true, ['gain', 'regain'], '52 week traded high divided by the close, minus 1.', (r) => num(r.requiredGain)),
  F('cash', 'Cash on hand', 'Cash', 'billions', 'cash', false, ['cash'], 'Cash and equivalents at the balance sheet date, in billions.', (r) => num(r.cash)),
  F('fcf', 'Free cash flow', 'FCF', 'billions', 'cash', false, ['fcf', 'freecashflow'], 'Operating cash flow minus capital expenditure for the newest released fiscal period, in billions.', (r) => num(r.fcf)),
  F('industry', 'Industry', 'Industry', 'text', 'filter-only', false, ['industry'], 'Verified industry classification.', (r) => r.industry),
  F('sector', 'Sector', 'Sector', 'text', 'filter-only', false, ['sector'], 'Sector classification.', (r) => r.sector),
  F('exchange', 'Exchange', 'Exch', 'text', 'filter-only', false, ['exchange', 'exch'], 'Listing exchange.', (r) => r.exchange),
  F('type', 'Security type', 'Type', 'text', 'filter-only', false, ['type', 'security'], 'Stock, ADR or ETF.', (r) => r.type),
];

const FIELD_BY_ID = new Map<string, FieldDef>(SCREENER_FIELDS.map((f) => [f.id, f]));
const FIELD_BY_ALIAS = new Map<string, FieldDef>();
for (const f of SCREENER_FIELDS) {
  FIELD_BY_ALIAS.set(f.id, f);
  for (const a of f.aliases) FIELD_BY_ALIAS.set(a.toLowerCase(), f);
}

export const fieldDef = (id: FieldId): FieldDef => FIELD_BY_ID.get(id)!;
export const fieldByAlias = (alias: string): FieldDef | null => FIELD_BY_ALIAS.get(alias.trim().toLowerCase()) ?? null;
export const fieldsOfTab = (tab: FieldTab): FieldDef[] => SCREENER_FIELDS.filter((f) => f.tab === tab);

/** Convert a value entered in display units to the stored unit. */
const toInternal = (f: FieldDef, v: number): number => (f.unit === 'percent' ? v / 100 : f.unit === 'billions' ? v * 1e9 : v);

/* -------------------------------------------------------------------- universe */

export interface UniverseResult {
  rows: ScreenerRow[];
  minCapBillions: number;
  counts: {
    candidates: number;
    included: number;
    belowFloor: number;
    noMarketCap: number;
    /** ETFs and indexes. They are not part of the stock universe. */
    notEligibleType: number;
  };
}

/** Numeric cap floor on stocks and ADRs. A row with no market cap never passes. */
export const applyUniverse = (rows: readonly ScreenerRow[], minCapBillions: number = SCREENER_DEFAULTS.minCapBillions.value): UniverseResult => {
  const floor = minCapBillions * 1e9;
  const out: ScreenerRow[] = [];
  const counts = { candidates: rows.length, included: 0, belowFloor: 0, noMarketCap: 0, notEligibleType: 0 };
  for (const r of rows) {
    if (r.type !== 'stock' && r.type !== 'adr') counts.notEligibleType++;
    else if (!isNum(r.marketCap)) counts.noMarketCap++;
    else if (r.marketCap < floor) counts.belowFloor++;
    else out.push(r);
  }
  counts.included = out.length;
  return { rows: out, minCapBillions, counts };
};

/** Steps of the minimum market cap control, in billions. Exact values can also be typed. */
export const capScaleSteps = (): number[] => {
  const out: number[] = [];
  for (let v = 2; v < 10; v += 1) out.push(v);
  for (let v = 10; v < 100; v += 5) out.push(v);
  for (let v = 100; v < 500; v += 25) out.push(v);
  for (let v = 500; v <= 4000; v += 100) out.push(v);
  return out;
};

/** Parse a typed minimum market cap such as "55", "$55B", "1.5t" or "2500m" into billions. */
export const parseCapInput = (text: string): Maybe<number> => {
  const m = /^\$?\s*(\d+(?:\.\d+)?|\.\d+)\s*(k|m|mm|b|bn|t|tn)?$/i.exec(text.trim());
  if (!m) return na('invalid-input', `"${text.trim()}" is not a market cap. Enter billions, for example 55.`);
  const v = Number(m[1]) * suffixToBillions(m[2]);
  const min = SCREENER_DEFAULTS.minCapBillions.value;
  if (v < min) return na('invalid-input', `The universe starts at $${min}B.`);
  return v;
};

const suffixToBillions = (s: string | undefined): number => {
  switch ((s ?? 'b').toLowerCase()) {
    case 'k': return 1e-6;
    case 'm': case 'mm': return 1e-3;
    case 't': case 'tn': return 1e3;
    default: return 1;
  }
};

export type GroupMemberStatus = 'in-universe' | 'below-floor' | 'etf' | 'no-market-cap' | 'not-loaded';

export interface GroupMemberRow {
  symbol: string;
  row: ScreenerRow | null;
  status: GroupMemberStatus;
  label: string;
}

/** Every member of a group for explicit group research, labeled by why it is or is not in the universe. */
export const groupResearchMembers = (
  group: Pick<TradingGroup, 'members'>,
  rows: readonly ScreenerRow[],
  minCapBillions: number = SCREENER_DEFAULTS.minCapBillions.value,
): GroupMemberRow[] => {
  const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
  return group.members.map((symbol) => {
    const row = bySymbol.get(symbol) ?? null;
    if (!row) return { symbol, row, status: 'not-loaded', label: 'Not loaded' };
    if (row.type === 'etf' || row.type === 'index') return { symbol, row, status: 'etf', label: 'ETF. Shown for group research, outside the stock universe.' };
    if (!isNum(row.marketCap)) return { symbol, row, status: 'no-market-cap', label: 'No market cap in this capture' };
    if (row.marketCap < minCapBillions * 1e9) return { symbol, row, status: 'below-floor', label: `Below the $${fmtNum(minCapBillions)}B minimum` };
    return { symbol, row, status: 'in-universe', label: 'In the screened universe' };
  });
};

/** Member counts per curated group across the given rows (all memberships). Sorted by name. */
export const groupCounts = (rows: readonly ScreenerRow[]): { group: string; count: number }[] => {
  const counts = new Map<string, number>();
  for (const r of rows) for (const g of r.groups) counts.set(g, (counts.get(g) ?? 0) + 1);
  return [...counts.entries()].map(([group, count]) => ({ group, count })).sort((a, b) => a.group.localeCompare(b.group));
};

/* --------------------------------------------------------------------- sorting */

export type SortDir = 'asc' | 'desc';

export interface SortState {
  field: FieldId;
  dir: SortDir;
}

/**
 * Sort by one column. Numbers sort by signed value. Text sorts case insensitively. Missing values
 * are last in BOTH directions. Ties keep their incoming order (stable).
 */
export const sortRows = (rows: readonly ScreenerRow[], field: FieldId, dir: SortDir): ScreenerRow[] => {
  const f = fieldDef(field);
  const sign = dir === 'asc' ? 1 : -1;
  const keyed = rows.map((row, idx) => ({ row, idx, v: f.get(row) }));
  keyed.sort((a, b) => {
    const am = a.v === null || (typeof a.v === 'number' && !Number.isFinite(a.v));
    const bm = b.v === null || (typeof b.v === 'number' && !Number.isFinite(b.v));
    if (am || bm) return am && bm ? a.idx - b.idx : am ? 1 : -1;
    let c: number;
    if (typeof a.v === 'number' && typeof b.v === 'number') c = a.v - b.v;
    else c = String(a.v).localeCompare(String(b.v), 'en', { sensitivity: 'base', numeric: true });
    return c !== 0 ? sign * c : a.idx - b.idx;
  });
  return keyed.map((k) => k.row);
};

/** Next sort state when a header is activated: same column flips, a new column starts descending for numbers. */
export const nextSort = (current: SortState | null, field: FieldId): SortState => {
  if (current && current.field === field) return { field, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { field, dir: fieldDef(field).kind === 'text' ? 'asc' : 'desc' };
};

/* ---------------------------------------------------------- search and paging */

/** Case insensitive search across ticker, former tickers, company name and group names. */
export const searchRows = (rows: readonly ScreenerRow[], query: string): ScreenerRow[] => {
  const q = query.trim().toLowerCase();
  if (q === '') return [...rows];
  return rows.filter(
    (r) =>
      r.symbol.toLowerCase().includes(q) ||
      r.name.toLowerCase().includes(q) ||
      r.aliases.some((a) => a.toLowerCase().includes(q)) ||
      r.groups.some((g) => g.toLowerCase().includes(q)),
  );
};

export interface Page<T> {
  rows: T[];
  /** 1-based page actually shown, clamped into range. */
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
  /** 1-based positions of the first and last row shown. 0 when empty. */
  from: number;
  to: number;
}

export const paginate = <T>(rows: readonly T[], page: number, pageSize: number = SCREENER_DEFAULTS.pageSize.value): Page<T> => {
  const size = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(pageCount, Math.max(1, Math.floor(page) || 1));
  const start = (p - 1) * size;
  const slice = rows.slice(start, start + size);
  return { rows: slice, page: p, pageSize: size, pageCount, total: rows.length, from: slice.length ? start + 1 : 0, to: start + slice.length };
};

/** Page that contains a symbol in the current ordering, so a return visit lands on the same place. */
export const pageOfSymbol = (rows: readonly ScreenerRow[], symbol: string, pageSize: number = SCREENER_DEFAULTS.pageSize.value): number | null => {
  const i = rows.findIndex((r) => r.symbol === symbol);
  return i < 0 ? null : Math.floor(i / Math.max(1, pageSize)) + 1;
};

/* --------------------------------------------------------------------- filters */

export type Operator = 'gte' | 'lte' | 'gt' | 'lt' | 'eq' | 'between' | 'available' | 'missing' | 'in';

export interface Condition {
  field: FieldId;
  op: Operator;
  /** Display units: percent as a number of percent, cap, cash and FCF in billions. Text for text fields. */
  value?: number | string;
  /** Upper bound for `between`. */
  value2?: number;
  /** Values for `in`. */
  values?: string[];
}

export interface OrGroup {
  any: Condition[];
}

export type Clause = Condition | OrGroup;

/** All clauses must hold (AND). An OrGroup holds when any of its conditions holds. */
export interface FilterSet {
  clauses: Clause[];
}

export const emptyFilter = (): FilterSet => ({ clauses: [] });
export const isOrGroup = (c: Clause): c is OrGroup => (c as OrGroup).any !== undefined;

const OP_WORDS: Record<Operator, string> = {
  gte: 'at least',
  lte: 'at most',
  gt: 'above',
  lt: 'below',
  eq: 'is',
  between: 'between',
  available: 'is available',
  missing: 'is missing',
  in: 'is one of',
};

const fmtNum = (v: number): string => {
  const r = Math.round(v * 1e6) / 1e6;
  return String(Object.is(r, -0) ? 0 : r);
};

const fmtValue = (f: FieldDef, v: number | string): string => {
  if (typeof v === 'string') return v;
  switch (f.unit) {
    case 'percent': return `${fmtNum(v)}%`;
    case 'billions': return v < 0 ? `-$${fmtNum(-v)}B` : `$${fmtNum(v)}B`;
    case 'price': return `$${fmtNum(v)}`;
    case 'multiple': return `${fmtNum(v)}x`;
    default: return fmtNum(v);
  }
};

/** Readable chip label for one condition, for example "Market cap at least $50B". */
export const conditionLabel = (c: Condition): string => {
  const f = fieldDef(c.field);
  if (c.op === 'available' || c.op === 'missing') return `${f.label} ${OP_WORDS[c.op]}`;
  if (c.op === 'between') return `${f.label} between ${fmtValue(f, c.value ?? 0)} and ${fmtValue(f, c.value2 ?? 0)}`;
  if (c.op === 'in') return `${f.label} is one of ${(c.values ?? []).join(', ')}`;
  return `${f.label} ${OP_WORDS[c.op]} ${fmtValue(f, c.value ?? '')}`;
};

export const clauseLabel = (c: Clause): string => (isOrGroup(c) ? c.any.map(conditionLabel).join(' or ') : conditionLabel(c));

export interface FilterChip {
  /** Index of the clause in the filter set. */
  clause: number;
  /** Index inside an OR group, when the clause is one. */
  or?: number;
  label: string;
}

/** One chip per condition, addressable for "clear one". */
export const filterChips = (set: FilterSet): FilterChip[] => {
  const chips: FilterChip[] = [];
  set.clauses.forEach((c, i) => {
    if (isOrGroup(c)) c.any.forEach((cond, j) => chips.push({ clause: i, or: j, label: (j > 0 ? 'or ' : '') + conditionLabel(cond) }));
    else chips.push({ clause: i, label: conditionLabel(c) });
  });
  return chips;
};

export const addCondition = (set: FilterSet, c: Clause): FilterSet => ({ clauses: [...set.clauses, c] });

/** Remove one condition. An OR group left with one condition becomes a plain condition, an empty one is dropped. */
export const removeCondition = (set: FilterSet, clause: number, or?: number): FilterSet => {
  const clauses: Clause[] = [];
  set.clauses.forEach((c, i) => {
    if (i !== clause) clauses.push(c);
    else if (isOrGroup(c) && or !== undefined) {
      const rest = c.any.filter((_, j) => j !== or);
      if (rest.length === 1) clauses.push(rest[0]!);
      else if (rest.length > 1) clauses.push({ any: rest });
    }
  });
  return { clauses };
};

export interface FilterOptions {
  /**
   * Price derived fields on a row whose close is stale or absent count as missing. Default true:
   * filters act only on fresh observations.
   */
  requireFresh?: boolean;
}

const nearlyEqual = (a: number, b: number): boolean => Math.abs(a - b) <= SCREENER_DEFAULTS.epsilon * Math.max(1, Math.abs(a), Math.abs(b));

const textValues = (row: ScreenerRow, f: FieldDef): string[] => {
  if (f.id === 'group') return row.groups;
  const v = f.get(row);
  return typeof v === 'string' && v !== '' ? [v] : [];
};

/** Evaluate one condition. Missing data fails every operator except `missing`. */
export const evaluateCondition = (row: ScreenerRow, c: Condition, opts: FilterOptions = {}): boolean => {
  const f = fieldDef(c.field);
  if (f.kind === 'text') {
    const have = textValues(row, f).map((s) => s.toLowerCase());
    if (c.op === 'available') return have.length > 0;
    if (c.op === 'missing') return have.length === 0;
    if (c.op === 'eq') return typeof c.value === 'string' && have.includes(c.value.trim().toLowerCase());
    if (c.op === 'in') return (c.values ?? []).some((v) => have.includes(v.trim().toLowerCase()));
    return false;
  }
  const fresh = !(opts.requireFresh ?? true) || !f.priceDerived || row.quoteCondition === 'completed-close';
  const raw = fresh ? f.get(row) : null;
  const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  if (c.op === 'available') return v !== null;
  if (c.op === 'missing') return v === null;
  if (v === null) return false;
  const a = typeof c.value === 'number' && Number.isFinite(c.value) ? toInternal(f, c.value) : null;
  if (a === null) return false;
  switch (c.op) {
    case 'gte': return v > a || nearlyEqual(v, a);
    case 'lte': return v < a || nearlyEqual(v, a);
    case 'gt': return v > a && !nearlyEqual(v, a);
    case 'lt': return v < a && !nearlyEqual(v, a);
    case 'eq': return nearlyEqual(v, a);
    case 'between': {
      if (typeof c.value2 !== 'number' || !Number.isFinite(c.value2)) return false;
      const b = toInternal(f, c.value2);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      return (v > lo || nearlyEqual(v, lo)) && (v < hi || nearlyEqual(v, hi));
    }
    default: return false;
  }
};

export const evaluateClause = (row: ScreenerRow, c: Clause, opts: FilterOptions = {}): boolean =>
  isOrGroup(c) ? c.any.some((x) => evaluateCondition(row, x, opts)) : evaluateCondition(row, c, opts);

export const applyFilters = (rows: readonly ScreenerRow[], set: FilterSet, opts: FilterOptions = {}): ScreenerRow[] =>
  set.clauses.length === 0 ? [...rows] : rows.filter((r) => set.clauses.every((c) => evaluateClause(r, c, opts)));

/* ----------------------------------------------------------- quick rule parser */

export interface RuleError {
  /** The piece of the rule that could not be read. */
  text: string;
  message: string;
}

export type ParseResult = { ok: true; filter: FilterSet } | { ok: false; errors: RuleError[] };

/** Split on a separator outside quotes and square brackets. */
const splitTopLevel = (s: string, isSep: (s: string, i: number) => number): string[] => {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '[') depth++;
    if (ch === ']') depth = Math.max(0, depth - 1);
    const len = depth === 0 ? isSep(s, i) : 0;
    if (len > 0) {
      out.push(cur);
      cur = '';
      i += len - 1;
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x !== '');
};

const commaSep = (s: string, i: number): number => (s[i] === ',' ? 1 : 0);
const orSep = (s: string, i: number): number => {
  if (s[i] === '|') return 1;
  const m = /^\s+or\s+/i.exec(s.slice(i));
  return m ? m[0].length : 0;
};

const unquote = (s: string): string => {
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"') && t.length >= 2) || (t.startsWith("'") && t.endsWith("'") && t.length >= 2) ? t.slice(1, -1) : t;
};

const knownFields = (): string => SCREENER_FIELDS.map((f) => f.aliases[0] ?? f.id).join(', ');

/** Parse a number in display units, honoring %, x and money suffixes where the field allows them. */
const parseRuleNumber = (f: FieldDef, text: string): number | string => {
  const m = /^([+-]?)\s*\$?\s*(\d+(?:\.\d+)?|\.\d+)\s*(%|x|k|mm|m|bn|b|tn|t)?$/i.exec(text.trim());
  if (!m) return `"${text.trim()}" is not a number`;
  let v = Number(m[2]) * (m[1] === '-' ? -1 : 1);
  const suffix = m[3]?.toLowerCase();
  if (suffix === '%') {
    if (f.unit !== 'percent') return `${f.label} is not a percent. Remove the % sign.`;
  } else if (suffix === 'x') {
    if (f.unit !== 'multiple') return `${f.label} is not a multiple. Remove the x.`;
  } else if (suffix) {
    if (f.unit !== 'billions') return `${f.label} does not take a ${suffix} suffix`;
    v *= suffixToBillions(suffix);
  }
  return v;
};

const OP_SYMBOLS: Record<string, Operator> = { '>=': 'gte', '=>': 'gte', '≥': 'gte', '<=': 'lte', '=<': 'lte', '≤': 'lte', '>': 'gt', '<': 'lt', '=': 'eq', '==': 'eq' };

const parseCondition = (text: string): Condition | string => {
  const s = text.trim();
  const field = (name: string): FieldDef | string => fieldByAlias(name) ?? `Unknown field "${name}". Fields: ${knownFields()}.`;
  let m = /^(has|no)\s+([\w]+)$/i.exec(s);
  if (m) {
    const f = field(m[2]!);
    return typeof f === 'string' ? f : { field: f.id, op: m[1]!.toLowerCase() === 'has' ? 'available' : 'missing' };
  }
  m = /^([\w]+)\s+(?:is\s+)?(available|missing)$/i.exec(s);
  if (m) {
    const f = field(m[1]!);
    return typeof f === 'string' ? f : { field: f.id, op: m[2]!.toLowerCase() as Operator };
  }
  m = /^([\w]+)\s+between\s+(.+?)\s+and\s+(.+)$/i.exec(s) ?? /^([\w]+)\s+(\S+?)\.\.(\S+)$/.exec(s);
  if (m) {
    const f = field(m[1]!);
    if (typeof f === 'string') return f;
    if (f.kind === 'text') return `${f.label} is text. Use = or in.`;
    const a = parseRuleNumber(f, m[2]!);
    const b = parseRuleNumber(f, m[3]!);
    if (typeof a === 'string') return a;
    if (typeof b === 'string') return b;
    return { field: f.id, op: 'between', value: Math.min(a, b), value2: Math.max(a, b) };
  }
  m = /^([\w]+)\s+in\s+\[(.*)\]$/i.exec(s);
  if (m) {
    const f = field(m[1]!);
    if (typeof f === 'string') return f;
    if (f.kind !== 'text') return `${f.label} is a number. Use >=, <=, >, <, = or between.`;
    const values = m[2]!.split(';').map(unquote).filter((v) => v !== '');
    if (values.length === 0) return `List at least one value for ${f.label}`;
    return { field: f.id, op: 'in', values };
  }
  m = /^([\w]+)\s*(>=|=>|≥|<=|=<|≤|==|=|>|<)\s*(.+)$/.exec(s);
  if (m) {
    const f = field(m[1]!);
    if (typeof f === 'string') return f;
    const op = OP_SYMBOLS[m[2]!]!;
    if (f.kind === 'text') {
      if (op !== 'eq') return `${f.label} is text. Use = or in.`;
      const v = unquote(m[3]!);
      return v === '' ? `Give a value for ${f.label}` : { field: f.id, op: 'eq', value: v };
    }
    const v = parseRuleNumber(f, m[3]!);
    return typeof v === 'string' ? v : { field: f.id, op, value: v };
  }
  return 'Use a field, an operator and a value, for example cap >= 50.';
};

/**
 * Parse a one line rule. Commas join conditions with AND, "or" or "|" builds an OR group.
 * Example: cap >= 50, sma200 <= -30, pe <= 25, fcf > 2b, ytd < -1
 */
export const parseQuickRule = (rule: string): ParseResult => {
  const clauses: Clause[] = [];
  const errors: RuleError[] = [];
  for (const part of splitTopLevel(rule, commaSep)) {
    const alts = splitTopLevel(part, orSep);
    const conds: Condition[] = [];
    for (const alt of alts) {
      const c = parseCondition(alt);
      if (typeof c === 'string') errors.push({ text: alt, message: c });
      else conds.push(c);
    }
    if (conds.length === 1 && alts.length === 1) clauses.push(conds[0]!);
    else if (conds.length > 0) clauses.push({ any: conds });
  }
  return errors.length ? { ok: false, errors } : { ok: true, filter: { clauses } };
};

/* -------------------------------------------------------------- URL round trip */

const encodeText = (s: string): string => encodeURIComponent(s);

const serializeCondition = (c: Condition): string => {
  switch (c.op) {
    case 'available':
    case 'missing':
      return `${c.field}:${c.op}`;
    case 'between':
      return `${c.field}:between:${fmtNum(Number(c.value))}:${fmtNum(Number(c.value2))}`;
    case 'in':
      return `${c.field}:in:${(c.values ?? []).map(encodeText).join(';')}`;
    default:
      return `${c.field}:${c.op}:${typeof c.value === 'number' ? fmtNum(c.value) : encodeText(String(c.value ?? ''))}`;
  }
};

/**
 * Compact text form of a filter set for a URL query value. Conditions are `field:op:value`,
 * AND clauses are joined by commas, OR alternatives by `|`.
 * Example: cap:gte:50,sma200:lte:-30,pe:lte:25
 */
export const serializeFilter = (set: FilterSet): string =>
  set.clauses.map((c) => (isOrGroup(c) ? c.any.map(serializeCondition).join('|') : serializeCondition(c))).join(',');

const OPERATORS: readonly Operator[] = ['gte', 'lte', 'gt', 'lt', 'eq', 'between', 'available', 'missing', 'in'];

const parseSerializedCondition = (text: string): Condition | string => {
  const parts = text.split(':');
  const f = FIELD_BY_ID.get(parts[0] ?? '');
  if (!f) return `Unknown field "${parts[0] ?? ''}"`;
  const op = parts[1] as Operator;
  if (!OPERATORS.includes(op)) return `Unknown operator "${parts[1] ?? ''}"`;
  if (op === 'available' || op === 'missing') return { field: f.id, op };
  if (op === 'in') {
    if (f.kind !== 'text') return `${f.label} does not support "in"`;
    const values = (parts[2] ?? '').split(';').filter((v) => v !== '').map(decodeURIComponent);
    return values.length ? { field: f.id, op, values } : `No values for ${f.label}`;
  }
  if (f.kind === 'text') {
    if (op !== 'eq') return `${f.label} is text`;
    return { field: f.id, op, value: decodeURIComponent(parts[2] ?? '') };
  }
  const a = Number(parts[2]);
  if (parts[2] === undefined || parts[2] === '' || !Number.isFinite(a)) return `"${parts[2] ?? ''}" is not a number`;
  if (op === 'between') {
    const b = Number(parts[3]);
    if (parts[3] === undefined || parts[3] === '' || !Number.isFinite(b)) return `"${parts[3] ?? ''}" is not a number`;
    return { field: f.id, op, value: a, value2: b };
  }
  return { field: f.id, op, value: a };
};

/** Inverse of `serializeFilter`. A malformed string returns errors instead of a partial filter. */
export const parseFilter = (text: string): ParseResult => {
  const clauses: Clause[] = [];
  const errors: RuleError[] = [];
  for (const part of text.split(',').filter((p) => p !== '')) {
    const conds: Condition[] = [];
    const alts = part.split('|').filter((p) => p !== '');
    for (const alt of alts) {
      let c: Condition | string;
      try {
        c = parseSerializedCondition(alt);
      } catch {
        c = 'Malformed value';
      }
      if (typeof c === 'string') errors.push({ text: alt, message: c });
      else conds.push(c);
    }
    if (conds.length === 1 && alts.length === 1) clauses.push(conds[0]!);
    else if (conds.length > 0) clauses.push({ any: conds });
  }
  return errors.length ? { ok: false, errors } : { ok: true, filter: { clauses } };
};

export type ScreenerTab = 'main' | 'cash' | 'drawdown' | 'groups';

/** Everything needed to restore the exact list after a Back navigation. */
export interface ScreenerState {
  minCapBillions: number;
  query: string;
  sort: SortState | null;
  page: number;
  pageSize: number;
  filter: FilterSet;
  tab: ScreenerTab;
}

export const defaultScreenerState = (): ScreenerState => ({
  minCapBillions: SCREENER_DEFAULTS.minCapBillions.value,
  query: '',
  sort: null,
  page: 1,
  pageSize: SCREENER_DEFAULTS.pageSize.value,
  filter: emptyFilter(),
  tab: 'main',
});

/** State to query parameters. Defaults are omitted so a clean list has a clean URL. */
export const screenerStateToParams = (s: ScreenerState): Record<string, string> => {
  const d = defaultScreenerState();
  const p: Record<string, string> = {};
  if (s.minCapBillions !== d.minCapBillions) p.cap = fmtNum(s.minCapBillions);
  if (s.query.trim() !== '') p.q = s.query.trim();
  if (s.sort) p.sort = `${s.sort.field}.${s.sort.dir}`;
  if (s.page !== d.page) p.page = String(s.page);
  if (s.pageSize !== d.pageSize) p.size = String(s.pageSize);
  if (s.filter.clauses.length) p.f = serializeFilter(s.filter);
  if (s.tab !== d.tab) p.tab = s.tab;
  return p;
};

/** Query parameters to state. Anything unreadable falls back to its default and is reported. */
export const screenerStateFromParams = (params: Readonly<Record<string, string | undefined>>): { state: ScreenerState; errors: RuleError[] } => {
  const state = defaultScreenerState();
  const errors: RuleError[] = [];
  if (params.cap !== undefined) {
    const v = parseCapInput(params.cap);
    if (isNa(v)) errors.push({ text: params.cap, message: v.detail ?? 'Invalid market cap' });
    else state.minCapBillions = v;
  }
  if (params.q !== undefined) state.query = params.q;
  if (params.sort !== undefined) {
    const [field, dir] = params.sort.split('.');
    if (field && FIELD_BY_ID.has(field) && (dir === 'asc' || dir === 'desc')) state.sort = { field: field as FieldId, dir };
    else errors.push({ text: params.sort, message: 'Unknown sort' });
  }
  if (params.page !== undefined) {
    const n = Number(params.page);
    if (Number.isInteger(n) && n >= 1) state.page = n;
    else errors.push({ text: params.page, message: 'Unknown page' });
  }
  if (params.size !== undefined) {
    const n = Number(params.size);
    if (Number.isInteger(n) && n >= 1 && n <= 500) state.pageSize = n;
    else errors.push({ text: params.size, message: 'Unknown page size' });
  }
  if (params.f !== undefined) {
    const r = parseFilter(params.f);
    if (r.ok) state.filter = r.filter;
    else errors.push(...r.errors);
  }
  if (params.tab !== undefined) {
    if (params.tab === 'main' || params.tab === 'cash' || params.tab === 'drawdown' || params.tab === 'groups') state.tab = params.tab;
    else errors.push({ text: params.tab, message: 'Unknown tab' });
  }
  return { state, errors };
};

/* ------------------------------------------------------------------- pipeline */

export interface ScreenerView {
  page: Page<ScreenerRow>;
  /** All rows after universe, filters and search, in sort order. */
  matched: ScreenerRow[];
  universe: UniverseResult['counts'];
  /** Rows in the universe before filters and search. */
  universeCount: number;
  chips: FilterChip[];
}

/** Universe floor, then filters, then search, then sort, then paging. One call for the main list. */
export const runScreener = (rows: readonly ScreenerRow[], state: ScreenerState, opts: FilterOptions = {}): ScreenerView => {
  const uni = applyUniverse(rows, state.minCapBillions);
  let matched = searchRows(applyFilters(uni.rows, state.filter, opts), state.query);
  if (state.sort) matched = sortRows(matched, state.sort.field, state.sort.dir);
  return {
    page: paginate(matched, state.page, state.pageSize),
    matched,
    universe: uni.counts,
    universeCount: uni.rows.length,
    chips: filterChips(state.filter),
  };
};

/* -------------------------------------------------------------- drawdown board */

export interface DrawdownEntry {
  symbol: string;
  name: string;
  group: string | null;
  price: number;
  priceDate: ISODate;
  high: number;
  highDate: ISODate | null;
  /** C / H - 1, zero or negative. */
  drawdown: number;
  /** H / C - 1. */
  requiredGain: number;
  dayChange: Maybe<number>;
  /** Bar length on the common scale, 0 to 1, drawdown divided by the deepest drawdown shown. */
  bar: number;
  /** True when the high covers fewer than 252 sessions. */
  shortHistory: boolean;
  highSource: string;
}

export interface DrawdownBoard {
  entries: DrawdownEntry[];
  /** Deepest drawdown on the board. The common scale runs from this value to zero. */
  scaleMin: number;
  highDefinition: string;
  unavailable: { symbol: string; reason: string }[];
}

/** Drawdown from the 52 week traded high across the given rows, deepest first, on one scale. */
export const drawdownBoard = (rows: readonly ScreenerRow[]): DrawdownBoard => {
  const entries: DrawdownEntry[] = [];
  const unavailable: DrawdownBoard['unavailable'] = [];
  for (const r of rows) {
    if (r.quoteCondition !== 'completed-close') {
      unavailable.push({ symbol: r.symbol, reason: r.quoteCondition === 'stale-close' ? `Close is stale, last ${r.priceDate ?? 'unknown'}` : 'No completed close' });
      continue;
    }
    if (!isNum(r.price) || !isNum(r.high52w) || !isNum(r.drawdown) || !isNum(r.requiredGain) || r.priceDate === null) {
      const why = isNa(r.high52w) ? r.high52w.detail ?? r.high52w.code : 'No 52 week high';
      unavailable.push({ symbol: r.symbol, reason: why });
      continue;
    }
    entries.push({
      symbol: r.symbol,
      name: r.name,
      group: r.group,
      price: r.price,
      priceDate: r.priceDate,
      high: r.high52w,
      highDate: r.high52wDate,
      drawdown: r.drawdown,
      requiredGain: r.requiredGain,
      dayChange: r.dayChange,
      bar: 0,
      shortHistory: r.high52wSessions < SCREENER_DEFAULTS.high52wSessions.value,
      highSource: r.high52wSource,
    });
  }
  const order = entries.map((e, idx) => ({ e, idx })).sort((a, b) => (a.e.drawdown !== b.e.drawdown ? a.e.drawdown - b.e.drawdown : a.idx - b.idx)).map((x) => x.e);
  const scaleMin = order.length ? Math.min(0, order[0]!.drawdown) : 0;
  for (const e of order) e.bar = scaleMin < 0 ? Math.min(1, Math.max(0, e.drawdown / scaleMin)) : 0;
  return {
    entries: order,
    scaleMin,
    highDefinition: '52 week traded high is the highest daily high of the last 252 completed sessions. It is not a closing high, a calendar year high or an all time high.',
    unavailable,
  };
};
