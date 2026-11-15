/**
 * Live market data routes. Server side only: the browser never calls a provider and never sees a key.
 *
 * - Daily history: Yahoo Finance chart endpoint (unofficial, no key). Quote OHLC is split
 *   adjusted and not dividend adjusted, which is the basis every price study expects.
 * - Earnings dates and results: Unusual Whales `/api/earnings/{ticker}`, authorized with
 *   UW_API_KEY from the server environment.
 *
 * Every response is validated. A history that is not daily, has bad rows, or includes a session
 * that has not closed yet is cut or rejected, never passed through.
 */
import { isSession, latestCompletedSession } from '../src/engine/core/calendar.ts';
import type { Bar } from '../src/engine/core/types.ts';

const UA = 'Mozilla/5.0 (compatible; research-client)';
const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; body: unknown }>();

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const SYMBOL = /^[A-Z0-9][A-Z0-9.\-^=]{0,14}$/;

const etDate = (epochSec: number): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(epochSec * 1000));

interface YahooChart {
  chart: {
    error?: { description?: string } | null;
    result?: {
      meta: Record<string, unknown>;
      timestamp?: number[];
      indicators: { quote: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }[] };
    }[];
  };
}

export interface DailyPayload {
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  type: 'stock' | 'etf' | 'index';
  bars: Bar[];
  /** Rows the provider returned that were dropped, by reason. */
  dropped: { nullRow: number; notSession: number; incompleteSession: number; badOhlc: number };
  provider: string;
  capturedAt: string;
}

export const parseYahooDaily = (raw: YahooChart, symbol: string, nowIso: string): DailyPayload | { error: string } => {
  const r = raw.chart?.result?.[0];
  if (!r) return { error: raw.chart?.error?.description ?? 'No data for this symbol' };
  if (r.meta.dataGranularity !== '1d') return { error: `Provider returned ${String(r.meta.dataGranularity)} bars, not daily` };
  const q = r.indicators.quote[0];
  const ts = r.timestamp ?? [];
  if (!q || ts.length === 0) return { error: 'No daily rows for this symbol' };
  const lastDone = latestCompletedSession(nowIso);
  const dropped = { nullRow: 0, notSession: 0, incompleteSession: 0, badOhlc: 0 };
  const bars: Bar[] = [];
  let prevDate = '';
  for (let i = 0; i < ts.length; i++) {
    const o = q.open[i];
    const h = q.high[i];
    const l = q.low[i];
    const c = q.close[i];
    if (o == null || h == null || l == null || c == null) { dropped.nullRow++; continue; }
    const date = etDate(ts[i]!);
    if (date > lastDone) { dropped.incompleteSession++; continue; }
    if (!isSession(date) || date <= prevDate) { dropped.notSession++; continue; }
    if (!(o > 0 && h > 0 && l > 0 && c > 0)) { dropped.badOhlc++; continue; }
    // Provider rounding can leave high or low a hair inside open or close. Widen, never narrow.
    const r4 = (x: number) => Math.round(x * 1e4) / 1e4; // provider floats are single precision
    const hi = r4(Math.max(h, o, c));
    const lo = r4(Math.min(l, o, c));
    const v = q.volume[i];
    bars.push({ date, open: r4(o), high: hi, low: lo, close: r4(c), volume: v == null ? null : v });
    prevDate = date;
  }
  if (bars.length === 0) return { error: 'No completed daily sessions for this symbol' };
  const it = String(r.meta.instrumentType ?? 'EQUITY');
  return {
    symbol,
    name: String(r.meta.longName ?? r.meta.shortName ?? symbol),
    exchange: String(r.meta.fullExchangeName ?? r.meta.exchangeName ?? ''),
    currency: String(r.meta.currency ?? 'USD'),
    type: it === 'ETF' ? 'etf' : it === 'INDEX' ? 'index' : 'stock',
    bars,
    dropped,
    provider: 'Yahoo Finance chart history',
    capturedAt: nowIso,
  };
};

export interface EarningsPayload {
  symbol: string;
  events: { date: string; time: 'bmo' | 'amc' | 'unknown'; status: 'confirmed' | 'estimated'; fiscalPeriodEnd: string | null; epsActual: number | null; epsEstimate: number | null }[];
  provider: string;
  capturedAt: string;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const parseUwEarnings = (raw: unknown, symbol: string, nowIso: string): EarningsPayload | { error: string } => {
  const rows = (raw as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return { error: 'Unexpected earnings response' };
  const events: EarningsPayload['events'] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const date = typeof row.report_date === 'string' ? row.report_date.slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const t = String(row.report_time ?? '');
    events.push({
      date,
      time: t === 'premarket' ? 'bmo' : t === 'postmarket' ? 'amc' : 'unknown',
      status: row.source === 'company' ? 'confirmed' : 'estimated',
      fiscalPeriodEnd: typeof row.ending_fiscal_quarter === 'string' ? row.ending_fiscal_quarter.slice(0, 10) : null,
      epsActual: num(row.actual_eps),
      epsEstimate: num(row.street_mean_est),
    });
  }
  events.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { symbol, events, provider: 'Unusual Whales earnings', capturedAt: nowIso };
};

const cached = async (key: string, load: () => Promise<Response>): Promise<Response> => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return json(hit.body);
  const res = await load();
  if (res.status === 200) cache.set(key, { at: Date.now(), body: await res.clone().json() });
  return res;
};

/** Handle a `/api/market/*` request. Returns null for any other path. */
export const handleMarket = async (url: URL, env: { UW_API_KEY?: string }): Promise<Response | null> => {
  if (!url.pathname.startsWith('/api/market/')) return null;
  const symbol = (url.searchParams.get('symbol') ?? '').toUpperCase();
  if (!SYMBOL.test(symbol)) return json({ error: 'Invalid symbol' }, 400);
  const now = new Date().toISOString();
  try {
    if (url.pathname === '/api/market/daily') {
      return await cached(`daily:${symbol}`, async () => {
        const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=0&period2=9999999999&interval=1d&events=split`, { headers: { 'user-agent': UA } });
        if (r.status === 404) return json({ error: `${symbol} is not known to the price source` }, 404);
        if (!r.ok) return json({ error: `Price source answered ${r.status}` }, 502);
        const out = parseYahooDaily((await r.json()) as YahooChart, symbol, now);
        return 'error' in out ? json(out, 502) : json(out);
      });
    }
    if (url.pathname === '/api/market/earnings') {
      if (!env.UW_API_KEY) return json({ error: 'UW_API_KEY is not set on the server' }, 503);
      return await cached(`earnings:${symbol}`, async () => {
        const r = await fetch(`https://api.unusualwhales.com/api/earnings/${encodeURIComponent(symbol)}`, { headers: { authorization: `Bearer ${env.UW_API_KEY}`, accept: 'application/json' } });
        if (!r.ok) return json({ error: `Earnings source answered ${r.status}` }, 502);
        const out = parseUwEarnings(await r.json(), symbol, now);
        return 'error' in out ? json(out, 502) : json(out);
      });
    }
    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Provider request failed' }, 502);
  }
};
