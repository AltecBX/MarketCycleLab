/**
 * Universe data for the Discover views. Builds one screener row per loaded instrument, once.
 * The result sits in the client cache, so every Discover tab shares it and a source retry
 * (which clears the cache) rebuilds it. Work is sliced so the main thread yields between symbols.
 */
import { cached, getProvider, useAsync } from '../../../data/client';
import type { Fundamentals, TradingGroup } from '../../../data/contracts';
import { isNa, na, type Bar, type DailySeries, type ISODate, type Instrument, type Maybe } from '../../../engine/core/types';
import { buildScreenerRow, type ScreenerRow } from '../../../engine/screener';

export interface DiscoverIssue {
  source: 'prices' | 'fundamentals' | 'groups';
  message: string;
  /** Symbols whose fields are degraded by this issue. */
  affected: number;
}

export interface DiscoverData {
  rows: ScreenerRow[];
  /** Completed daily bars per display symbol, cut at any basis boundary. */
  bars: Map<string, Bar[]>;
  instruments: Instrument[];
  groups: TradingGroup[];
  /** Latest completed session. Rows whose close is older are marked stale. */
  asOf: ISODate;
  issues: DiscoverIssue[];
}

const SLICE_MS = 12;
const yieldToMain = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const settle = async <T,>(key: string, load: () => Promise<Maybe<T>>): Promise<Maybe<T>> => {
  try {
    return await cached(key, load);
  } catch (e) {
    return na('source-failed', e instanceof Error ? e.message : String(e));
  }
};

const loadDiscover = async (): Promise<DiscoverData> => {
  const p = getProvider();
  const asOf = p.clock().lastCompletedSession;
  const instruments = await cached('instruments', () => p.listInstruments());
  const issues: DiscoverIssue[] = [];
  let groups: TradingGroup[] = [];
  try {
    groups = await cached('groups', () => p.getGroups());
  } catch (e) {
    issues.push({ source: 'groups', message: e instanceof Error ? e.message : String(e), affected: instruments.length });
  }
  const rows: ScreenerRow[] = [];
  const bars = new Map<string, Bar[]>();
  let priceFail = 0;
  let priceWhy = '';
  let fundFail = 0;
  let fundWhy = '';
  let t = now();
  for (const inst of instruments) {
    const series = await settle<DailySeries>(`daily:${inst.id}`, () => p.getDaily(inst.id));
    const fund = await settle<Fundamentals>(`fund:${inst.id}`, () => p.getFundamentals(inst.id));
    if (isNa(series)) {
      priceFail++;
      priceWhy ||= series.detail ?? 'Daily price history is unavailable';
    } else {
      const b = inst.basisBoundary ? series.bars.filter((x) => x.date >= inst.basisBoundary!.date) : series.bars;
      bars.set(inst.symbol, b);
    }
    if (isNa(fund) && fund.code === 'source-failed') {
      fundFail++;
      fundWhy ||= fund.detail ?? 'Fundamentals are unavailable';
    }
    rows.push(buildScreenerRow(inst, isNa(series) ? null : series.bars, fund, { asOf, groups }));
    if (now() - t > SLICE_MS) {
      await yieldToMain();
      t = now();
    }
  }
  if (priceFail) issues.push({ source: 'prices', message: priceWhy, affected: priceFail });
  if (fundFail) issues.push({ source: 'fundamentals', message: fundWhy, affected: fundFail });
  return { rows, bars, instruments, groups, asOf, issues };
};

/** One shared build of the universe rows for every Discover tab. */
export const useDiscoverData = () => useAsync<DiscoverData>('discover:universe', loadDiscover);
