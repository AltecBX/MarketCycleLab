/**
 * Client data access. One provider, a keyed promise cache with in-flight dedupe, and a hook that
 * ignores responses for a key the view has already left. A failed load never stays in the cache.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { sliceAsOf } from '../engine/core/series';
import { isNa, na, type Bar, type DailySeries, type EarningsEvent, type Instrument, type Maybe } from '../engine/core/types';
import type { Clock, DataProvider, Fundamentals, ResolvedSymbol, SourceHealth } from './contracts';
import { FixtureProvider } from './fixtureProvider';
import { LiveProvider } from './liveProvider';

const fixture = new FixtureProvider();
/** Production builds and `npm run dev:live` use live data (.env.production). `--mode fixture` uses synthetic data. */
const provider: DataProvider = import.meta.env?.VITE_DATA === 'live' ? new LiveProvider() : fixture;
export const getProvider = (): DataProvider => provider;
export const getFixtureProvider = (): FixtureProvider => fixture;
export const isFixtureMode = (): boolean => provider.kind === 'synthetic-fixture';

const cache = new Map<string, Promise<unknown>>();
let epoch = 0;
const epochListeners = new Set<() => void>();

/** Drop cached entries whose key starts with the prefix. Views reload on the next render. */
export const invalidate = (prefix = ''): void => {
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
  epoch++;
  epochListeners.forEach((l) => l());
};
fixture.subscribe(() => invalidate());

const useEpoch = (): number =>
  useSyncExternalStore(
    (l) => {
      epochListeners.add(l);
      return () => epochListeners.delete(l);
    },
    () => epoch,
  );

export const cached = <T,>(key: string, loader: () => Promise<T>): Promise<T> => {
  const hit = cache.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const p = loader().catch((e: unknown) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, p);
  return p;
};

export type AsyncState<T> =
  | { status: 'loading'; data: undefined; error: undefined }
  | { status: 'ready'; data: T; error: undefined }
  | { status: 'error'; data: undefined; error: Error };

/**
 * Load a keyed resource. When the key changes the previous result is dropped at once, so a view
 * can never show another symbol's numbers under the new name.
 */
export function useAsync<T>(key: string | null, loader: () => Promise<T>): AsyncState<T> & { reload: () => void } {
  const ep = useEpoch();
  const [state, setState] = useState<{ key: string | null; s: AsyncState<T> }>({ key: null, s: { status: 'loading', data: undefined, error: undefined } });
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    setState((prev) => (prev.key === key && prev.s.status === 'ready' ? prev : { key, s: { status: 'loading', data: undefined, error: undefined } }));
    cached(key, () => loaderRef.current()).then(
      (data) => live && setState({ key, s: { status: 'ready', data, error: undefined } }),
      (error: unknown) => live && setState({ key, s: { status: 'error', data: undefined, error: error instanceof Error ? error : new Error(String(error)) } }),
    );
    return () => {
      live = false;
    };
  }, [key, nonce, ep]);
  const reload = useCallback(() => {
    if (key) cache.delete(key);
    setNonce((n) => n + 1);
  }, [key]);
  const s: AsyncState<T> = state.key === key ? state.s : { status: 'loading', data: undefined, error: undefined };
  return { ...s, reload };
}

export interface StockBundle {
  resolved: ResolvedSymbol;
  instrument: Instrument;
  series: Maybe<DailySeries>;
  earnings: Maybe<EarningsEvent[]>;
  fundamentals: Maybe<Fundamentals>;
  clock: Clock;
}

/** Identity first, then the three independent sources. One source failing does not fail the others. */
export const loadBundle = async (symbol: string): Promise<Maybe<StockBundle>> => {
  const p = getProvider();
  const resolved = await cached(`resolve:${symbol.toUpperCase()}`, () => p.resolve(symbol));
  if (isNa(resolved)) return resolved;
  const id = resolved.instrument.id;
  const settle = async <T,>(key: string, f: () => Promise<Maybe<T>>): Promise<Maybe<T>> => {
    try {
      return await cached(key, f);
    } catch (e) {
      return na('source-failed', e instanceof Error ? e.message : String(e));
    }
  };
  const [series, earnings, fundamentals] = await Promise.all([
    settle(`daily:${id}`, () => p.getDaily(id)),
    settle(`earnings:${id}`, () => p.getEarnings(id)),
    settle(`fund:${id}`, () => p.getFundamentals(id)),
  ]);
  return { resolved, instrument: resolved.instrument, series, earnings, fundamentals, clock: p.clock() };
};

export const useBundle = (symbol: string | null) => useAsync(symbol ? `bundle:${symbol.toUpperCase()}` : null, () => loadBundle(symbol!));

/** Daily bars for a comparison symbol (benchmark, sector ETF, peer), cut at an optional as-of date. */
export const loadBars = async (symbol: string, asOf?: string): Promise<Maybe<Bar[]>> => {
  const p = getProvider();
  const r = await cached(`resolve:${symbol.toUpperCase()}`, () => p.resolve(symbol));
  if (isNa(r)) return r;
  try {
    const s = await cached(`daily:${r.instrument.id}`, () => p.getDaily(r.instrument.id));
    if (isNa(s)) return s;
    return asOf ? sliceAsOf(s.bars, asOf) : s.bars;
  } catch (e) {
    return na('source-failed', e instanceof Error ? e.message : String(e));
  }
};

export const useBars = (symbol: string | null, asOf?: string) => useAsync(symbol ? `bars:${symbol.toUpperCase()}:${asOf ?? ''}` : null, () => loadBars(symbol!, asOf));

export const useInstruments = () => useAsync('instruments', () => getProvider().listInstruments());
export const useGroups = () => useAsync('groups', () => getProvider().getGroups());
export const useHealth = () => useAsync<SourceHealth[]>('health', () => getProvider().health());
