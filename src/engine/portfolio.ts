/**
 * Portfolio math: marking positions, exposure, correlation, scenarios, import reconciliation and
 * the week ahead queue.
 *
 * Rules (owner specification sections 5 and 14):
 * - Only actual positions carry dollars. Watch only rows never contribute exposure.
 * - An unknown price or date is Unavailable. It never contributes a false zero and it never
 *   lets a total claim to be fully covered.
 * - Share value uses quantity x a dated completed close.
 * - A replay of a past window with today's holdings is a current weight counterfactual, not the
 *   actual historical track.
 * - An import is previewed and reconciled against the current revision. Nothing is deleted:
 *   positions missing from an accepted import are archived with the receipt that removed them.
 */
import { fridayOf, isIsoDate, nextSession, sessionOnOrBefore } from './core/calendar';
import { alignBars, indexOnOrBefore } from './core/series';
import { pearson } from './core/stats';
import { isNa, na, type Bar, type EarningsEvent, type ISODate, type Maybe, type Unavailable } from './core/types';

export type PositionSource = 'google-positions' | 'csv' | 'manual';
export type PositionKind = 'position' | 'watch';

export interface Position {
  instrumentId: string;
  /** Current display ticker. */
  symbol: string;
  /** Signed share quantity. Negative is a short position. Ignored for watch rows. */
  shares: number;
  /** Cost per share when known. */
  cost?: number | null;
  acquiredOn?: ISODate | null;
  kind?: PositionKind;
  source: PositionSource;
  /** Book revision in which this row last changed. */
  revision: number;
}

export interface ArchivedPosition extends Position {
  archivedAt: string;
  receiptId: string;
}

export interface PositionBook {
  /** Monotonic revision, used for compare and swap. */
  revision: number;
  updatedAt: string;
  positions: Position[];
  archived: ArchivedPosition[];
}

export const emptyBook = (updatedAt: string): PositionBook => ({ revision: 0, updatedAt, positions: [], archived: [] });

export interface Mark {
  close: number;
  date: ISODate;
}

export type QuantityState = 'long' | 'short' | 'zero' | 'watch';

export interface MarkedPosition {
  position: Position;
  state: QuantityState;
  mark: Maybe<Mark>;
  /** Signed market value: shares x close. Unavailable without a dated close. */
  value: Maybe<number>;
  /** Signed unrealized P and L versus cost. Unavailable without both a mark and a cost. */
  pnl: Maybe<number>;
  pnlPct: Maybe<number>;
  costValue: Maybe<number>;
}

export interface MarkedBook {
  rows: MarkedPosition[];
  /** Sum of signed value over rows that have a dated close. */
  coveredValue: number;
  /** Sum of absolute value over covered rows. */
  coveredGross: number;
  coveredCount: number;
  /** Positions with shares but no dated close. */
  missing: { symbol: string; reason: Unavailable }[];
  /** True only when every share holding position has a dated close. */
  allCovered: boolean;
  /** Total signed value. Unavailable when any holding is unmarked. */
  totalValue: Maybe<number>;
  /** P and L over rows with both mark and cost, and how many rows that covers. */
  coveredPnl: number;
  pnlCoveredCount: number;
  /** Oldest and newest mark dates among covered rows. Differing dates are disclosed, not hidden. */
  markDates: { oldest: ISODate; newest: ISODate } | null;
  watchCount: number;
}

const stateOf = (p: Position): QuantityState => {
  if (p.kind === 'watch') return 'watch';
  if (!Number.isFinite(p.shares) || p.shares === 0) return 'zero';
  return p.shares > 0 ? 'long' : 'short';
};

/** Mark positions with dated closes keyed by instrument id. */
export const markPositions = (positions: readonly Position[], marks: ReadonlyMap<string, Maybe<Mark>>): MarkedBook => {
  const rows: MarkedPosition[] = [];
  const missing: MarkedBook['missing'] = [];
  let coveredValue = 0;
  let coveredGross = 0;
  let coveredCount = 0;
  let coveredPnl = 0;
  let pnlCoveredCount = 0;
  let oldest: ISODate | null = null;
  let newest: ISODate | null = null;
  let watchCount = 0;
  for (const p of positions) {
    const state = stateOf(p);
    const raw = marks.get(p.instrumentId);
    const mark: Maybe<Mark> = raw === undefined ? na('no-coverage', `No dated close for ${p.symbol}`) : raw;
    const badMark = !isNa(mark) && (!Number.isFinite(mark.close) || mark.close <= 0);
    const usable: Maybe<Mark> = badMark ? na('invalid-input', `Close for ${p.symbol} is not a positive price`) : mark;
    if (state === 'watch' || state === 'zero') {
      if (state === 'watch') watchCount++;
      const why = na('not-applicable', state === 'watch' ? 'Watch only. No shares held.' : 'Zero quantity');
      rows.push({ position: p, state, mark: usable, value: why, pnl: why, pnlPct: why, costValue: why });
      continue;
    }
    if (isNa(usable)) {
      missing.push({ symbol: p.symbol, reason: usable });
      rows.push({ position: p, state, mark: usable, value: usable, pnl: usable, pnlPct: usable, costValue: usable });
      continue;
    }
    const value = p.shares * usable.close;
    coveredValue += value;
    coveredGross += Math.abs(value);
    coveredCount++;
    if (oldest === null || usable.date < oldest) oldest = usable.date;
    if (newest === null || usable.date > newest) newest = usable.date;
    const hasCost = typeof p.cost === 'number' && Number.isFinite(p.cost) && p.cost > 0;
    const noCost = na('no-coverage', 'No cost recorded');
    const pnl: Maybe<number> = hasCost ? p.shares * (usable.close - p.cost!) : noCost;
    if (!isNa(pnl)) {
      coveredPnl += pnl;
      pnlCoveredCount++;
    }
    rows.push({
      position: p,
      state,
      mark: usable,
      value,
      pnl,
      pnlPct: hasCost ? (usable.close / p.cost! - 1) * Math.sign(p.shares) : noCost,
      costValue: hasCost ? p.shares * p.cost! : noCost,
    });
  }
  const allCovered = missing.length === 0 && coveredCount > 0;
  return {
    rows,
    coveredValue,
    coveredGross,
    coveredCount,
    missing,
    allCovered,
    totalValue: missing.length > 0 ? na('no-coverage', `No dated close for ${missing.map((m) => m.symbol).join(', ')}`) : coveredCount === 0 ? na('no-coverage', 'No marked positions') : coveredValue,
    coveredPnl,
    pnlCoveredCount,
    markDates: oldest && newest ? { oldest, newest } : null,
    watchCount,
  };
};

export interface HoldingDrawdown {
  /** Highest close in the inspected window, with its date. */
  closingHigh: number;
  highDate: ISODate;
  /** C / high - 1, zero or negative. */
  drawdown: number;
  /** high / C - 1. */
  gainToRegain: number;
  asOf: ISODate;
  /** What the high refers to. */
  reference: string;
  sessions: number;
}

/** Decline of the latest close from the highest close in the last `window` sessions (all history when omitted). */
export const holdingDrawdown = (bars: readonly Bar[], window?: number): Maybe<HoldingDrawdown> => {
  if (bars.length === 0) return na('insufficient-history', 'No completed sessions');
  const start = window && window > 0 ? Math.max(0, bars.length - window) : 0;
  let hi = start;
  for (let i = start; i < bars.length; i++) if (bars[i]!.close > bars[hi]!.close) hi = i;
  const last = bars[bars.length - 1]!;
  const high = bars[hi]!;
  return {
    closingHigh: high.close,
    highDate: high.date,
    drawdown: last.close / high.close - 1,
    gainToRegain: high.close / last.close - 1,
    asOf: last.date,
    reference: window && window > 0 && start > 0 ? `Closing high of the last ${window} sessions` : 'Closing high within available history',
    sessions: bars.length - start,
  };
};

export interface ExposureGroup {
  key: string;
  /** Signed value of members with a dated close. */
  value: number;
  gross: number;
  /** Share of covered gross exposure. */
  weight: number;
  symbols: string[];
}

export interface ExposureBreakdown {
  byGroup: ExposureGroup[];
  bySector: ExposureGroup[];
  /** Single names by gross weight, largest first. */
  names: { symbol: string; value: number; weight: number }[];
  /** Sum of squared single name weights. 1 is one name, 1/n is equal weight across n names. */
  herfindahl: number | null;
  topWeight: number | null;
  /** Holdings left out because they have no dated close. */
  missing: string[];
  coveredGross: number;
  note: string;
}

const UNCLASSIFIED = 'Unclassified';

/** Exposure by trading group and sector over marked holdings. Weights are shares of covered gross exposure. */
export const exposureBreakdown = (book: MarkedBook, classify: (symbol: string) => { group?: string | null; sector?: string | null }): ExposureBreakdown => {
  const groups = new Map<string, ExposureGroup>();
  const sectors = new Map<string, ExposureGroup>();
  const names: ExposureBreakdown['names'] = [];
  const add = (m: Map<string, ExposureGroup>, key: string, symbol: string, value: number) => {
    const g = m.get(key) ?? { key, value: 0, gross: 0, weight: 0, symbols: [] };
    g.value += value;
    g.gross += Math.abs(value);
    g.symbols.push(symbol);
    m.set(key, g);
  };
  for (const r of book.rows) {
    if (isNa(r.value)) continue;
    const c = classify(r.position.symbol);
    add(groups, c.group ?? UNCLASSIFIED, r.position.symbol, r.value);
    add(sectors, c.sector ?? UNCLASSIFIED, r.position.symbol, r.value);
    names.push({ symbol: r.position.symbol, value: r.value, weight: 0 });
  }
  const gross = book.coveredGross;
  const finish = (m: Map<string, ExposureGroup>) =>
    [...m.values()].map((g) => ({ ...g, weight: gross > 0 ? g.gross / gross : 0 })).sort((a, b) => b.gross - a.gross || a.key.localeCompare(b.key));
  for (const n of names) n.weight = gross > 0 ? Math.abs(n.value) / gross : 0;
  names.sort((a, b) => b.weight - a.weight || a.symbol.localeCompare(b.symbol));
  return {
    byGroup: finish(groups),
    bySector: finish(sectors),
    names,
    herfindahl: names.length ? names.reduce((s, n) => s + n.weight * n.weight, 0) : null,
    topWeight: names[0]?.weight ?? null,
    missing: book.missing.map((m) => m.symbol),
    coveredGross: gross,
    note: 'Direct holdings only. Weights are shares of gross exposure with a dated close. Fund look through needs a dated constituent capture.',
  };
};

export interface PairCorrelation {
  a: string;
  b: string;
  /** Pearson correlation of same date daily returns. Unavailable when the overlap is too thin. */
  correlation: Maybe<number>;
  observations: number;
  from: ISODate | null;
  to: ISODate | null;
}

export const CORRELATION_DEFAULTS = {
  provenance: 'spec',
  window: 252,
  /** Minimum comparable returns: max(30, ceil(0.8 x window)). */
  minObservations: (window: number): number => Math.max(30, Math.ceil(0.8 * window)),
} as const;

/** Pairwise correlation of daily close to close returns on common dates, over the last `window` common returns. */
export const pairCorrelation = (a: { symbol: string; bars: readonly Bar[] }, b: { symbol: string; bars: readonly Bar[] }, window: number = CORRELATION_DEFAULTS.window): PairCorrelation => {
  const al = alignBars(a.bars, b.bars);
  const ra: number[] = [];
  const rb: number[] = [];
  const dates: ISODate[] = [];
  for (let k = 1; k < al.dates.length; k++) {
    // A return is comparable only when both legs moved between the same two consecutive rows of each series.
    if (al.ia[k]! - al.ia[k - 1]! !== 1 || al.ib[k]! - al.ib[k - 1]! !== 1) continue;
    ra.push(a.bars[al.ia[k]!]!.close / a.bars[al.ia[k - 1]!]!.close - 1);
    rb.push(b.bars[al.ib[k]!]!.close / b.bars[al.ib[k - 1]!]!.close - 1);
    dates.push(al.dates[k]!);
  }
  const xa = ra.slice(-window);
  const xb = rb.slice(-window);
  const ds = dates.slice(-window);
  const need = CORRELATION_DEFAULTS.minObservations(window);
  const base = { a: a.symbol, b: b.symbol, observations: xa.length, from: ds[0] ?? null, to: ds[ds.length - 1] ?? null };
  if (xa.length < need) return { ...base, correlation: na('sample-too-small', `Needs ${need} comparable returns, has ${xa.length}`) };
  const c = pearson(xa, xb);
  return { ...base, correlation: Number.isFinite(c) ? c : na('flat-range', 'A series has no variation in the window') };
};

/** All pairs among the supplied holdings. */
export const correlationMatrix = (series: readonly { symbol: string; bars: readonly Bar[] }[], window: number = CORRELATION_DEFAULTS.window): PairCorrelation[] => {
  const out: PairCorrelation[] = [];
  for (let i = 0; i < series.length; i++) for (let j = i + 1; j < series.length; j++) out.push(pairCorrelation(series[i]!, series[j]!, window));
  return out;
};

export interface ScenarioRow {
  symbol: string;
  /** Shock applied to this holding as a fraction. Unavailable when it could not be derived. */
  shock: Maybe<number>;
  /** How the shock was derived. */
  basis: 'stock' | 'beta x market' | 'none';
  /** Signed dollar change: value x shock. */
  change: Maybe<number>;
}

export interface ScenarioResult {
  label: 'Hypothetical shock. Not a forecast.';
  rows: ScenarioRow[];
  /** Sum of dollar changes over rows where both value and shock are known. */
  coveredChange: number;
  coveredCount: number;
  missing: string[];
  /** Total change. Unavailable when any holding could not be shocked. */
  totalChange: Maybe<number>;
}

/**
 * Stock and market shocks in dollars. A holding uses its own stock shock when given, otherwise
 * beta x market shock. A holding with neither, or without a dated value, is listed as missing.
 */
export const scenarioShock = (
  book: MarkedBook,
  shocks: { stock?: Readonly<Record<string, number>>; market?: number; betas?: Readonly<Record<string, Maybe<number>>> },
): ScenarioResult => {
  const rows: ScenarioRow[] = [];
  const missing: string[] = [];
  let coveredChange = 0;
  let coveredCount = 0;
  for (const r of book.rows) {
    if (r.state === 'watch' || r.state === 'zero') continue;
    const sym = r.position.symbol;
    let shock: Maybe<number>;
    let basis: ScenarioRow['basis'] = 'none';
    const own = shocks.stock?.[sym];
    if (own !== undefined && Number.isFinite(own)) {
      shock = own;
      basis = 'stock';
    } else if (shocks.market !== undefined && Number.isFinite(shocks.market)) {
      const beta = shocks.betas?.[sym];
      if (beta === undefined || isNa(beta) || !Number.isFinite(beta)) shock = na('no-coverage', `No beta for ${sym}`);
      else {
        shock = beta * shocks.market;
        basis = 'beta x market';
      }
    } else shock = na('not-applicable', 'No shock applies to this holding');
    const change: Maybe<number> = isNa(r.value) ? r.value : isNa(shock) ? shock : r.value * shock;
    if (isNa(change)) missing.push(sym);
    else {
      coveredChange += change;
      coveredCount++;
    }
    rows.push({ symbol: sym, shock, basis, change });
  }
  return {
    label: 'Hypothetical shock. Not a forecast.',
    rows,
    coveredChange,
    coveredCount,
    missing,
    totalChange: missing.length ? na('no-coverage', `Could not shock ${missing.join(', ')}`) : coveredCount === 0 ? na('no-coverage', 'No holdings to shock') : coveredChange,
  };
};

export interface ReplayRow {
  symbol: string;
  /** Close to close return over the window on the holding's own series. */
  ret: Maybe<number>;
  baseDate: ISODate | null;
  endDate: ISODate | null;
  /** Today's value x that return. */
  change: Maybe<number>;
}

export interface ReplayResult {
  label: 'Current weight counterfactual. Today\'s holdings applied to a past window. Not the actual historical track.';
  from: ISODate;
  to: ISODate;
  rows: ReplayRow[];
  coveredChange: number;
  coveredCount: number;
  missing: string[];
  totalChange: Maybe<number>;
}

/**
 * Replay a past window with today's fixed holdings. Base is the last close on or before `from`.
 * End is the last close on or before `to`. A holding whose history does not cover the whole
 * window is missing.
 */
export const replayEvent = (book: MarkedBook, seriesBySymbol: Readonly<Record<string, readonly Bar[]>>, from: ISODate, to: ISODate): ReplayResult => {
  const rows: ReplayRow[] = [];
  const missing: string[] = [];
  let coveredChange = 0;
  let coveredCount = 0;
  for (const r of book.rows) {
    if (r.state === 'watch' || r.state === 'zero') continue;
    const sym = r.position.symbol;
    const bars = seriesBySymbol[sym];
    let ret: Maybe<number>;
    let baseDate: ISODate | null = null;
    let endDate: ISODate | null = null;
    if (!bars || bars.length === 0) ret = na('no-coverage', `No history for ${sym}`);
    else {
      const bi = indexOnOrBefore(bars, from);
      const ei = indexOnOrBefore(bars, to);
      if (bi < 0) ret = na('insufficient-history', `History for ${sym} starts after ${from}`);
      else if (ei <= bi) ret = na('invalid-input', 'Window has no sessions');
      else if (bars[bars.length - 1]!.date < sessionOnOrBefore(to)) ret = na('insufficient-history', `History for ${sym} ends before ${to}`);
      else {
        baseDate = bars[bi]!.date;
        endDate = bars[ei]!.date;
        ret = bars[ei]!.close / bars[bi]!.close - 1;
      }
    }
    const change: Maybe<number> = isNa(r.value) ? r.value : isNa(ret) ? ret : r.value * ret;
    if (isNa(change)) missing.push(sym);
    else {
      coveredChange += change;
      coveredCount++;
    }
    rows.push({ symbol: sym, ret, baseDate, endDate, change });
  }
  return {
    label: "Current weight counterfactual. Today's holdings applied to a past window. Not the actual historical track.",
    from,
    to,
    rows,
    coveredChange,
    coveredCount,
    missing,
    totalChange: missing.length ? na('no-coverage', `No covered replay for ${missing.join(', ')}`) : coveredCount === 0 ? na('no-coverage', 'No holdings to replay') : coveredChange,
  };
};

// ---------------------------------------------------------------------------------------------
// Import and reconciliation
// ---------------------------------------------------------------------------------------------

export interface IncomingRow {
  /** 1-based row number in the source, for error messages. */
  row: number;
  symbol: string;
  shares: number;
  cost?: number | null;
  acquiredOn?: ISODate | null;
}

export interface CsvError {
  row: number;
  message: string;
}

const splitCsvLine = (line: string): string[] => {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
};

const parseNumber = (s: string): number | null => {
  const t = s.replace(/[$,\s]/g, '');
  if (t === '') return null;
  const neg = /^\(.*\)$/.test(t);
  const n = Number(neg ? t.slice(1, -1) : t);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
};

const HEADER_ALIASES: Record<'symbol' | 'shares' | 'cost' | 'acquired', string[]> = {
  symbol: ['symbol', 'ticker'],
  shares: ['shares', 'quantity', 'qty', 'units'],
  cost: ['cost', 'cost per share', 'avg cost', 'average cost', 'cost basis per share', 'price paid'],
  acquired: ['acquired', 'acquired on', 'date', 'purchase date', 'acquisition date'],
};

/**
 * Parse a positions CSV. Needs a header row with a symbol and a shares column. Cost per share and
 * acquisition date are optional. Returns the rows that parsed and an error per row that did not.
 */
export const parsePositionsCsv = (text: string): { rows: IncomingRow[]; errors: CsvError[] } => {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);
  const errors: CsvError[] = [];
  const rows: IncomingRow[] = [];
  const headerIdx = lines.findIndex((l) => l.trim() !== '');
  if (headerIdx < 0) return { rows, errors: [{ row: 0, message: 'The file is empty.' }] };
  const header = splitCsvLine(lines[headerIdx]!).map((h) => h.toLowerCase());
  const col = (k: keyof typeof HEADER_ALIASES): number => header.findIndex((h) => HEADER_ALIASES[k].includes(h));
  const cSym = col('symbol');
  const cSh = col('shares');
  const cCost = col('cost');
  const cAcq = col('acquired');
  if (cSym < 0 || cSh < 0) return { rows, errors: [{ row: headerIdx + 1, message: 'Header needs a symbol column and a shares column.' }] };
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const rowNo = i + 1;
    const f = splitCsvLine(line);
    const symbol = (f[cSym] ?? '').toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(symbol)) {
      errors.push({ row: rowNo, message: symbol === '' ? 'Missing symbol.' : `"${f[cSym]}" is not a valid symbol.` });
      continue;
    }
    const shares = parseNumber(f[cSh] ?? '');
    if (shares === null) {
      errors.push({ row: rowNo, message: `Shares for ${symbol} is not a number.` });
      continue;
    }
    const row: IncomingRow = { row: rowNo, symbol, shares };
    if (cCost >= 0 && (f[cCost] ?? '') !== '') {
      const cost = parseNumber(f[cCost]!);
      if (cost === null || cost < 0) {
        errors.push({ row: rowNo, message: `Cost for ${symbol} is not a valid price.` });
        continue;
      }
      row.cost = cost;
    }
    if (cAcq >= 0 && (f[cAcq] ?? '') !== '') {
      const d = f[cAcq]!;
      if (!isIsoDate(d)) {
        errors.push({ row: rowNo, message: `Date for ${symbol} must be YYYY-MM-DD.` });
        continue;
      }
      row.acquiredOn = d;
    }
    rows.push(row);
  }
  return { rows, errors };
};

export interface FieldChange {
  field: 'shares' | 'cost' | 'acquiredOn' | 'symbol';
  from: number | string | null;
  to: number | string | null;
}

export interface ReconcilePreview {
  baseRevision: number;
  source: PositionSource;
  adds: Position[];
  changes: { before: Position; after: Position; fields: FieldChange[] }[];
  /** Current positions absent from the import. Archived on accept, never deleted. */
  removals: Position[];
  unchanged: Position[];
  /** Several incoming rows resolve to one instrument. Held for owner review, not summed. */
  duplicates: { instrumentId: string; symbol: string; rows: IncomingRow[] }[];
  /** Incoming symbols that did not resolve to an instrument. */
  unmapped: { row: IncomingRow; reason: Unavailable }[];
  /** Zero quantity rows. Treated as a statement that nothing is held. */
  zeroQuantity: IncomingRow[];
  /** Negative quantity rows. Imported as short positions and flagged. */
  shorts: IncomingRow[];
  /** Rows that resolved through a former ticker. */
  aliasMapped: { row: IncomingRow; symbol: string }[];
  /** True when something needs the owner's attention before or after accepting. */
  needsReview: boolean;
  summary: string;
}

export type SymbolResolver = (symbol: string) => Maybe<{ instrumentId: string; symbol: string }>;

/**
 * Diff an incoming position list against the current book. Pure preview. Nothing is changed.
 * Semantics:
 * - zero quantity: the instrument is treated as not held (a removal when it is in the book).
 * - negative quantity: a short position, imported and flagged.
 * - duplicates: held out entirely. The existing position for that instrument is left untouched.
 * - unmapped: skipped and listed. They never remove an existing position.
 * Watch rows in the book are not touched by an import.
 */
export const reconcileImport = (book: PositionBook, incoming: readonly IncomingRow[], resolve: SymbolResolver, source: PositionSource): ReconcilePreview => {
  const unmapped: ReconcilePreview['unmapped'] = [];
  const aliasMapped: ReconcilePreview['aliasMapped'] = [];
  const byInstrument = new Map<string, { symbol: string; rows: IncomingRow[] }>();
  for (const row of incoming) {
    if (!Number.isFinite(row.shares)) {
      unmapped.push({ row, reason: na('invalid-input', 'Shares is not a number') });
      continue;
    }
    const r = resolve(row.symbol);
    if (isNa(r)) {
      unmapped.push({ row, reason: r });
      continue;
    }
    if (r.symbol !== row.symbol.toUpperCase()) aliasMapped.push({ row, symbol: r.symbol });
    const e = byInstrument.get(r.instrumentId) ?? { symbol: r.symbol, rows: [] };
    e.rows.push(row);
    byInstrument.set(r.instrumentId, e);
  }
  const duplicates: ReconcilePreview['duplicates'] = [];
  const zeroQuantity: IncomingRow[] = [];
  const shorts: IncomingRow[] = [];
  const adds: Position[] = [];
  const changes: ReconcilePreview['changes'] = [];
  const unchanged: Position[] = [];
  const current = new Map(book.positions.filter((p) => p.kind !== 'watch').map((p) => [p.instrumentId, p]));
  const seen = new Set<string>();
  for (const [instrumentId, e] of byInstrument) {
    if (e.rows.length > 1) {
      duplicates.push({ instrumentId, symbol: e.symbol, rows: e.rows });
      seen.add(instrumentId); // unresolved, so it must not be archived as a removal
      continue;
    }
    const row = e.rows[0]!;
    if (row.shares === 0) {
      zeroQuantity.push(row);
      continue; // not marked seen: an existing position becomes a removal
    }
    if (row.shares < 0) shorts.push(row);
    seen.add(instrumentId);
    const before = current.get(instrumentId);
    const after: Position = {
      instrumentId,
      symbol: e.symbol,
      shares: row.shares,
      cost: row.cost === undefined ? (before?.cost ?? null) : row.cost,
      acquiredOn: row.acquiredOn === undefined ? (before?.acquiredOn ?? null) : row.acquiredOn,
      kind: 'position',
      source,
      revision: book.revision + 1,
    };
    if (!before) {
      adds.push(after);
      continue;
    }
    const fields: FieldChange[] = [];
    if (before.shares !== after.shares) fields.push({ field: 'shares', from: before.shares, to: after.shares });
    if ((before.cost ?? null) !== (after.cost ?? null)) fields.push({ field: 'cost', from: before.cost ?? null, to: after.cost ?? null });
    if ((before.acquiredOn ?? null) !== (after.acquiredOn ?? null)) fields.push({ field: 'acquiredOn', from: before.acquiredOn ?? null, to: after.acquiredOn ?? null });
    if (before.symbol !== after.symbol) fields.push({ field: 'symbol', from: before.symbol, to: after.symbol });
    if (fields.length) changes.push({ before, after, fields });
    else unchanged.push(before);
  }
  const removals = [...current.values()].filter((p) => !seen.has(p.instrumentId));
  const needsReview = duplicates.length > 0 || unmapped.length > 0 || removals.length > 0 || shorts.length > 0 || zeroQuantity.length > 0;
  const parts = [`${adds.length} added`, `${changes.length} changed`, `${removals.length} removed`, `${unchanged.length} unchanged`];
  if (duplicates.length) parts.push(`${duplicates.length} duplicated`);
  if (unmapped.length) parts.push(`${unmapped.length} not recognized`);
  return { baseRevision: book.revision, source, adds, changes, removals, unchanged, duplicates, unmapped, zeroQuantity, shorts, aliasMapped, needsReview, summary: `${parts.join(', ')}.` };
};

export interface ReconcileReceipt {
  id: string;
  decision: 'accepted' | 'rejected';
  decidedAt: string;
  source: PositionSource;
  fromRevision: number;
  /** Equal to fromRevision when rejected. */
  toRevision: number;
  added: string[];
  changed: { symbol: string; fields: FieldChange[] }[];
  archived: string[];
  /** Rows that were not applied and why. */
  skipped: { symbol: string; row: number; reason: string }[];
  summary: string;
}

/**
 * Apply or reject a previewed import. Compare and swap on the revision: when the book moved since
 * the preview, nothing is applied and the caller must preview again. Accepting applies the clean
 * rows, archives removals and records what was skipped. Rejecting records a receipt and leaves
 * the book untouched. The input book is never mutated.
 */
export const applyReconciliation = (
  book: PositionBook,
  preview: ReconcilePreview,
  decision: { accept: boolean; decidedAt: string; receiptId: string },
): Maybe<{ book: PositionBook; receipt: ReconcileReceipt }> => {
  if (book.revision !== preview.baseRevision) {
    return na('invalid-input', `Revision conflict. The preview was made against revision ${preview.baseRevision}, the book is at ${book.revision}. Preview again.`);
  }
  const skipped: ReconcileReceipt['skipped'] = [
    ...preview.duplicates.flatMap((d) => d.rows.map((r) => ({ symbol: d.symbol, row: r.row, reason: 'Duplicate rows for one instrument. Not summed.' }))),
    ...preview.unmapped.map((u) => ({ symbol: u.row.symbol, row: u.row.row, reason: u.reason.detail ?? 'Symbol not recognized.' })),
  ];
  if (!decision.accept) {
    return {
      book,
      receipt: {
        id: decision.receiptId,
        decision: 'rejected',
        decidedAt: decision.decidedAt,
        source: preview.source,
        fromRevision: book.revision,
        toRevision: book.revision,
        added: [],
        changed: [],
        archived: [],
        skipped,
        summary: 'Import rejected. Nothing changed.',
      },
    };
  }
  const next = book.revision + 1;
  const removed = new Set(preview.removals.map((p) => p.instrumentId));
  const changed = new Map(preview.changes.map((c) => [c.before.instrumentId, c.after]));
  const positions: Position[] = [];
  for (const p of book.positions) {
    if (p.kind !== 'watch' && removed.has(p.instrumentId)) continue;
    const c = p.kind !== 'watch' ? changed.get(p.instrumentId) : undefined;
    positions.push(c ? { ...c, revision: next } : { ...p });
  }
  for (const a of preview.adds) positions.push({ ...a, revision: next });
  const archived: ArchivedPosition[] = [
    ...book.archived.map((a) => ({ ...a })),
    ...preview.removals.map((p) => ({ ...p, archivedAt: decision.decidedAt, receiptId: decision.receiptId })),
  ];
  return {
    book: { revision: next, updatedAt: decision.decidedAt, positions, archived },
    receipt: {
      id: decision.receiptId,
      decision: 'accepted',
      decidedAt: decision.decidedAt,
      source: preview.source,
      fromRevision: book.revision,
      toRevision: next,
      added: preview.adds.map((p) => p.symbol),
      changed: preview.changes.map((c) => ({ symbol: c.after.symbol, fields: c.fields })),
      archived: preview.removals.map((p) => p.symbol),
      skipped,
      summary: preview.summary,
    },
  };
};

/** Apply one manual correction as a new revision, with compare and swap. Shares 0 archives the position. */
export const applyManualEdit = (
  book: PositionBook,
  edit: { expectedRevision: number; position: Omit<Position, 'revision' | 'source'>; decidedAt: string; receiptId: string },
): Maybe<PositionBook> => {
  if (book.revision !== edit.expectedRevision) return na('invalid-input', `Revision conflict. Expected ${edit.expectedRevision}, the book is at ${book.revision}.`);
  if (!Number.isFinite(edit.position.shares)) return na('invalid-input', 'Shares is not a number');
  if (edit.position.cost != null && (!Number.isFinite(edit.position.cost) || edit.position.cost < 0)) return na('invalid-input', 'Cost must be zero or more');
  const next = book.revision + 1;
  const existing = book.positions.find((p) => p.instrumentId === edit.position.instrumentId);
  const others = book.positions.filter((p) => p.instrumentId !== edit.position.instrumentId).map((p) => ({ ...p }));
  const archived = book.archived.map((a) => ({ ...a }));
  if (edit.position.shares === 0 && edit.position.kind !== 'watch') {
    if (existing) archived.push({ ...existing, archivedAt: edit.decidedAt, receiptId: edit.receiptId });
    return { revision: next, updatedAt: edit.decidedAt, positions: others, archived };
  }
  return { revision: next, updatedAt: edit.decidedAt, positions: [...others, { ...edit.position, source: 'manual', revision: next }], archived };
};

// ---------------------------------------------------------------------------------------------
// Week ahead
// ---------------------------------------------------------------------------------------------

export interface OptionMagnitude {
  /** Option implied magnitude per share through `expiry`, in dollars. Covers the whole period to expiry, not the report alone. */
  perShare: number;
  expiry: ISODate;
  quoteDate: ISODate;
}

export interface WeekAheadRow {
  symbol: string;
  instrumentId: string;
  date: ISODate;
  time: EarningsEvent['time'];
  status: EarningsEvent['status'];
  state: QuantityState;
  /** Quantity x completed close. Unavailable for watch rows and unmarked holdings. */
  exposure: Maybe<number>;
  /** Option magnitude per share x shares, a hypothetical holding scale move through the option's expiry. */
  hypotheticalMove: Maybe<number>;
  magnitudeExpiry: ISODate | null;
}

export interface WeekAhead {
  /** Inclusive window: the next session through the Friday of its week. */
  from: ISODate;
  through: ISODate;
  rows: WeekAheadRow[];
  knownReports: number;
  /** Sum of exposure over reporting holdings with a dated close. */
  coveredExposure: number;
  coveredCount: number;
  /** Reporting holdings whose exposure could not be computed. */
  exposureMissing: string[];
  /** Stock holdings whose next earnings date is unknown. They are not counted as not reporting. */
  unknownDates: string[];
  /** Total exposure of reporting holdings. Unavailable when any is unmarked. */
  totalExposure: Maybe<number>;
  note: string;
}

/**
 * Holdings and watch names with a known report from the next session through that week's Friday.
 * Exposure is quantity x completed close. The hypothetical move is the dated option magnitude per
 * share x shares through the option's actual expiry. It is not an isolated earnings move, a
 * probability or a direction.
 */
export const weekAhead = (
  book: MarkedBook,
  input: {
    asOf: ISODate;
    earnings: ReadonlyMap<string, Maybe<EarningsEvent[]>>;
    magnitudes?: ReadonlyMap<string, Maybe<OptionMagnitude>>;
  },
): WeekAhead => {
  const from = nextSession(input.asOf);
  const through = fridayOf(from);
  const rows: WeekAheadRow[] = [];
  const unknownDates: string[] = [];
  const exposureMissing: string[] = [];
  let coveredExposure = 0;
  let coveredCount = 0;
  for (const r of book.rows) {
    const p = r.position;
    const ev = input.earnings.get(p.instrumentId);
    if (ev === undefined || (isNa(ev) && ev.code !== 'not-applicable')) {
      unknownDates.push(p.symbol);
      continue;
    }
    if (isNa(ev)) continue; // funds do not report
    const upcoming = ev.filter((e) => e.date > input.asOf).sort((a, b) => (a.date < b.date ? -1 : 1));
    if (upcoming.length === 0) {
      unknownDates.push(p.symbol);
      continue;
    }
    for (const e of upcoming) {
      if (e.date < from || e.date > through) continue;
      const holds = r.state === 'long' || r.state === 'short';
      const exposure: Maybe<number> = holds ? r.value : na('not-applicable', r.state === 'watch' ? 'Watch only. No shares held.' : 'Zero quantity');
      if (holds) {
        if (isNa(exposure)) exposureMissing.push(p.symbol);
        else {
          coveredExposure += exposure;
          coveredCount++;
        }
      }
      const mag = input.magnitudes?.get(p.instrumentId);
      let move: Maybe<number>;
      let magnitudeExpiry: ISODate | null = null;
      if (!holds) move = na('not-applicable', 'No shares held');
      else if (mag === undefined) move = na('no-coverage', 'No dated option magnitude');
      else if (isNa(mag)) move = mag;
      else if (!Number.isFinite(mag.perShare) || mag.perShare < 0) move = na('invalid-input', 'Option magnitude is not a valid amount');
      else if (mag.expiry < e.date) move = na('not-applicable', `Option expiry ${mag.expiry} is before the report on ${e.date}`);
      else {
        move = mag.perShare * Math.abs(p.shares);
        magnitudeExpiry = mag.expiry;
      }
      rows.push({ symbol: p.symbol, instrumentId: p.instrumentId, date: e.date, time: e.time, status: e.status, state: r.state, exposure, hypotheticalMove: move, magnitudeExpiry });
    }
  }
  rows.sort((a, b) => (a.date === b.date ? a.symbol.localeCompare(b.symbol) : a.date < b.date ? -1 : 1));
  return {
    from,
    through,
    rows,
    knownReports: rows.length,
    coveredExposure,
    coveredCount,
    exposureMissing,
    unknownDates,
    totalExposure: exposureMissing.length
      ? na('no-coverage', `No dated close for ${exposureMissing.join(', ')}`)
      : coveredCount === 0
        ? na('not-applicable', 'No held position reports in the window')
        : coveredExposure,
    note: 'Counts known report dates only. A holding with an unknown date is listed separately and is not treated as not reporting.',
  };
};
