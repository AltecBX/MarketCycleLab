/**
 * Shared data helpers for Today and the Portfolio views: load several symbols without blocking
 * the main thread, resolve tickers (including former tickers), and bridge the workspace
 * positions to the portfolio engine's revisioned book.
 */
import { useEffect, useMemo, useState } from 'react';
import { loadBundle, useAsync, useInstruments, type StockBundle } from '../../../data/client';
import { getWorkspaceStore, type Workspace, type WorkspacePosition } from '../../../data/workspace';
import { isNa, na, type Bar, type ISODate, type Instrument, type Maybe } from '../../../engine/core/types';
import type { Mark, Position, PositionBook, PositionSource, SymbolResolver } from '../../../engine/portfolio';
import { DEFAULT_ALERT_CONFIG, type AlertConfig, type AlertRule } from '../../../engine/today';
import type { SectionId } from '../../../app/routes';

/** Exchange-local calendar date (America/New_York) of an instant. */
export const etDate = (isoInstant: string): ISODate => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(isoInstant));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}`;
};

export type BundleMap = Map<string, Maybe<StockBundle>>;

const loadMany = async (symbols: readonly string[]): Promise<BundleMap> => {
  const out: BundleMap = new Map();
  for (const s of symbols) {
    try {
      out.set(s, await loadBundle(s));
    } catch (e) {
      out.set(s, na('source-failed', e instanceof Error ? e.message : String(e)));
    }
    // Yield between symbols so loading a long list never blocks input or paint.
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
};

/** Bundles for a list of symbols, keyed by the symbol as given. One symbol failing does not fail the rest. */
export const useBundles = (symbols: readonly string[]) => {
  const key = symbols.length ? `pf-bundles:${symbols.join(',')}` : null;
  return useAsync<BundleMap>(key, () => loadMany(symbols));
};

export const barsOf = (b: Maybe<StockBundle> | undefined): Maybe<readonly Bar[]> => {
  if (b === undefined) return na('no-coverage', 'Not loaded');
  if (isNa(b)) return b;
  return isNa(b.series) ? b.series : b.series.bars;
};

export const markOf = (b: Maybe<StockBundle> | undefined): Maybe<Mark> => {
  const bars = barsOf(b);
  if (isNa(bars)) return bars;
  const last = bars[bars.length - 1];
  return last ? { close: last.close, date: last.date } : na('no-coverage', 'No completed sessions');
};

/** Ticker resolver over the loaded universe. A former ticker resolves to the current instrument. */
export const useResolver = (): { ready: boolean; instruments: readonly Instrument[]; bySymbol: Map<string, Instrument>; resolve: SymbolResolver; error: Error | null } => {
  const all = useInstruments();
  return useMemo(() => {
    const list = all.status === 'ready' ? all.data : [];
    const bySymbol = new Map<string, Instrument>();
    for (const i of list) bySymbol.set(i.symbol, i);
    const alias = new Map<string, Instrument>();
    for (const i of list) for (const a of i.aliases) if (!bySymbol.has(a.symbol)) alias.set(a.symbol, i);
    const resolve: SymbolResolver = (symbol) => {
      const q = symbol.trim().toUpperCase();
      const hit = bySymbol.get(q) ?? alias.get(q);
      return hit ? { instrumentId: hit.id, symbol: hit.symbol } : na('unknown-symbol', `${q} is not in the loaded universe`);
    };
    return { ready: all.status === 'ready', instruments: list, bySymbol, resolve, error: all.status === 'error' ? all.error : null };
  }, [all]);
};

const ENGINE_SOURCE: Record<WorkspacePosition['source'], PositionSource> = { manual: 'manual', csv: 'csv', import: 'csv', demo: 'manual' };

/** Engine position for a workspace row. The instrument id falls back to a symbol key when unresolved. */
export const toEnginePosition = (p: WorkspacePosition, resolve: SymbolResolver, revision: number): Position => {
  const r = resolve(p.symbol);
  return {
    instrumentId: isNa(r) ? `unresolved:${p.symbol}` : r.instrumentId,
    symbol: isNa(r) ? p.symbol : r.symbol,
    shares: p.shares,
    cost: p.cost,
    acquiredOn: p.acquiredOn,
    kind: 'position',
    source: ENGINE_SOURCE[p.source],
    revision,
  };
};

/** The workspace positions as the engine's revisioned book. The workspace revision is the book revision. */
export const toBook = (ws: Workspace, resolve: SymbolResolver): PositionBook => ({
  revision: ws.revision,
  updatedAt: ws.updatedAt,
  positions: ws.positions.map((p) => toEnginePosition(p, resolve, ws.revision)),
  archived: [],
});

export const alertConfigOf = (ws: Workspace): AlertConfig => {
  const r = ws.settings.alertRules;
  return {
    ...DEFAULT_ALERT_CONFIG,
    earningsWithinDays: r.earningsDays,
    downSessionPct: r.downSession,
    drawdownPct: r.drawdown,
    enabled: { ...DEFAULT_ALERT_CONFIG.enabled, 'sma200-breach': r.ma200Breach },
  };
};

/** The research section that explains each alert rule, and any tab inside it. */
export const ALERT_TARGET: Record<AlertRule, { section: SectionId; params?: Record<string, string>; label: string }> = {
  drawdown: { section: 'selloffs', label: 'Compare with earlier selloffs' },
  'down-session': { section: 'selloffs', params: { tab: 'declines' }, label: 'See similar declines' },
  'sma200-breach': { section: 'trend', label: 'See 200 day runs' },
  'earnings-soon': { section: 'earnings', label: 'See past reactions' },
};

export const RULE_LABEL: Record<AlertRule, string> = {
  drawdown: 'Drawdown',
  'down-session': 'Down session',
  'sma200-breach': '200 day breach',
  'earnings-soon': 'Earnings',
};

export const storageScopeText = (): string => (getWorkspaceStore().scope === 'this-browser' ? 'Stored in this browser only.' : 'Stored in your owner account.');

/** True when the viewport is at most `max` pixels wide. Used to swap a table for a compact list. */
export const useIsNarrow = (max = 760): boolean => {
  const query = `(max-width: ${max}px)`;
  const [narrow, setNarrow] = useState(() => (typeof matchMedia === 'function' ? matchMedia(query).matches : false));
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const m = matchMedia(query);
    const on = () => setNarrow(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return narrow;
};

/** Parse a user typed number. Empty or invalid text is null, never zero. */
export const parseNum = (text: string): number | null => {
  const t = text.replace(/[$,\s%]/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
