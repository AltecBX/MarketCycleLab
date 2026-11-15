/**
 * Live market data routes. Server side only: the browser never calls a provider and never sees a key.
 *
 * - Daily history: Yahoo Finance chart endpoint (unofficial, no key). Quote OHLC is split
 *   adjusted and not dividend adjusted, which is the basis every price study expects.
 * - Earnings dates and results: Unusual Whales `/api/earnings/{ticker}`, authorized with
 *   UW_API_KEY from the server environment.
 * - Fundamentals: Yahoo Finance quote summary (FY1 estimate, market cap, beta) and the
 *   fundamentals timeseries (quarterly cash, operating cash flow, capex, free cash flow).
 *
 * Every response is validated. A history that is not daily, has bad rows, or includes a session
 * that has not closed yet is cut or rejected, never passed through.
 */
import { isSession, latestCompletedSession } from '../src/engine/core/calendar.ts';
import type { Bar } from '../src/engine/core/types.ts';

const UA = 'Mozilla/5.0 (compatible; research-client)';
const memory = new Map<string, { at: number; body: string }>();

/** Edge cache when running on Cloudflare, in-process map elsewhere. Only 200 responses are kept. */
const edgeCache = (): Cache | undefined => (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;

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

const cached = async (key: string, ttlSec: number, load: () => Promise<Response>): Promise<Response> => {
  const edge = edgeCache();
  const cacheKey = `https://market-cache.internal/${encodeURIComponent(key)}`;
  if (edge) {
    const hit = await edge.match(cacheKey);
    if (hit) return json(JSON.parse(await hit.text()));
  } else {
    const hit = memory.get(key);
    if (hit && Date.now() - hit.at < ttlSec * 1000) return json(JSON.parse(hit.body));
  }
  const res = await load();
  if (res.status === 200) {
    const body = await res.clone().text();
    if (edge) await edge.put(cacheKey, new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ttlSec}` } }));
    else memory.set(key, { at: Date.now(), body });
  }
  return res;
};

/* ---------------------------------------------------------------- Yahoo session (crumb) */

let yahooSession: { cookie: string; crumb: string; at: number } | null = null;

const readSetCookies = (h: Headers): string[] => {
  const all = (h as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  if (all && all.length) return all;
  const one = h.get('set-cookie');
  return one ? one.split(/,(?=\s*[A-Za-z0-9_]+=)/) : [];
};

/** Yahoo's quote summary needs a cookie and a matching crumb. Both are cached for an hour. */
const yahooCrumb = async (force = false): Promise<{ cookie: string; crumb: string }> => {
  if (!force && yahooSession && Date.now() - yahooSession.at < 60 * 60 * 1000) return yahooSession;
  const r = await fetch('https://fc.yahoo.com/', { headers: { 'user-agent': UA }, redirect: 'manual' });
  const cookie = readSetCookies(r.headers).map((c) => c.split(';')[0]!.trim()).filter(Boolean).join('; ');
  if (!cookie) throw new Error('Estimate source did not issue a session cookie');
  const c = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'user-agent': UA, cookie } });
  const crumb = (await c.text()).trim();
  if (!c.ok || !crumb || crumb.length > 40 || crumb.includes('<')) throw new Error(`Estimate source refused a session (${c.status})`);
  yahooSession = { cookie, crumb, at: Date.now() };
  return yahooSession;
};

const raw = (v: unknown): number | null => {
  const x = (v as { raw?: unknown } | null | undefined)?.raw;
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
};

export interface FundamentalsPayload {
  symbol: string;
  currency: string;
  asOf: string;
  marketCap: number | null;
  beta: number | null;
  sharesOutstanding: number | null;
  /** FY1 (current fiscal year) consensus EPS and the fiscal year end it refers to. */
  forwardEps: { value: number; fiscalYearEnd: string; analysts: number | null } | null;
  /** Cash and cash equivalents at the latest quarter end. */
  cash: { value: number; asOf: string } | null;
  /** Standalone quarters, newest first. Capex is a positive outflow. */
  quarters: { periodEnd: string; operatingCashFlow: number | null; capex: number | null; freeCashFlow: number | null }[];
  provider: string;
  capturedAt: string;
}

export const parseYahooFundamentals = (summary: unknown, series: unknown, symbol: string, asOf: string, nowIso: string): FundamentalsPayload | { error: string } => {
  const res = (summary as { quoteSummary?: { result?: Record<string, unknown>[] } })?.quoteSummary?.result?.[0];
  if (!res) return { error: 'No fundamentals for this symbol' };
  const price = (res.price ?? {}) as Record<string, unknown>;
  const stats = (res.defaultKeyStatistics ?? {}) as Record<string, unknown>;
  const trend = ((res.earningsTrend as { trend?: Record<string, unknown>[] } | undefined)?.trend ?? []).find((t) => t.period === '0y');
  const est = trend ? raw((trend.earningsEstimate as Record<string, unknown> | undefined)?.avg) : null;
  const fye = trend && typeof trend.endDate === 'string' ? trend.endDate.slice(0, 10) : null;
  const byType = new Map<string, Map<string, number>>();
  for (const r of ((series as { timeseries?: { result?: Record<string, unknown>[] } })?.timeseries?.result ?? [])) {
    const type = ((r.meta as { type?: string[] } | undefined)?.type ?? [])[0];
    if (!type) continue;
    const m = new Map<string, number>();
    for (const row of ((r[type] as ({ asOfDate?: string; periodType?: string; reportedValue?: { raw?: number } } | null)[] | undefined) ?? [])) {
      if (row && row.periodType === '3M' && typeof row.asOfDate === 'string' && typeof row.reportedValue?.raw === 'number') m.set(row.asOfDate, row.reportedValue.raw);
    }
    byType.set(type, m);
  }
  const g = (t: string, d: string) => byType.get(t)?.get(d) ?? null;
  const ends = new Set<string>();
  for (const t of ['quarterlyOperatingCashFlow', 'quarterlyFreeCashFlow', 'quarterlyCapitalExpenditure']) for (const d of byType.get(t)?.keys() ?? []) ends.add(d);
  const quarters = [...ends].sort().reverse().map((d) => {
    const capexSigned = g('quarterlyCapitalExpenditure', d);
    return { periodEnd: d, operatingCashFlow: g('quarterlyOperatingCashFlow', d), capex: capexSigned === null ? null : Math.abs(capexSigned), freeCashFlow: g('quarterlyFreeCashFlow', d) };
  });
  const cashDates = [...(byType.get('quarterlyCashAndCashEquivalents')?.keys() ?? [])].sort();
  const cashDate = cashDates[cashDates.length - 1];
  return {
    symbol,
    currency: typeof price.currency === 'string' ? price.currency : 'USD',
    asOf,
    marketCap: raw(price.marketCap),
    beta: raw(stats.beta),
    sharesOutstanding: raw(stats.sharesOutstanding),
    forwardEps: est !== null && fye ? { value: est, fiscalYearEnd: fye, analysts: raw((trend!.earningsEstimate as Record<string, unknown>).numberOfAnalysts) } : null,
    cash: cashDate ? { value: g('quarterlyCashAndCashEquivalents', cashDate)!, asOf: cashDate } : null,
    quarters,
    provider: 'Yahoo Finance quote summary and fundamentals timeseries',
    capturedAt: nowIso,
  };
};

const loadFundamentals = async (symbol: string, now: string): Promise<Response> => {
  const sym = encodeURIComponent(symbol);
  const summary = async (force: boolean) => {
    const { cookie, crumb } = await yahooCrumb(force);
    return fetch(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=price,defaultKeyStatistics,earningsTrend&crumb=${encodeURIComponent(crumb)}`, { headers: { 'user-agent': UA, cookie } });
  };
  let s = await summary(false);
  if (s.status === 401 || s.status === 403) s = await summary(true);
  if (s.status === 404) return json({ error: `${symbol} has no fundamentals at the source` }, 404);
  if (!s.ok) return json({ error: `Fundamentals source answered ${s.status}` }, 502);
  const types = ['quarterlyOperatingCashFlow', 'quarterlyCapitalExpenditure', 'quarterlyFreeCashFlow', 'quarterlyCashAndCashEquivalents'].join(',');
  const t = await fetch(`https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${sym}?symbol=${sym}&type=${types}&period1=${Math.floor(Date.now() / 1000) - 3 * 366 * 86400}&period2=${Math.floor(Date.now() / 1000)}`, { headers: { 'user-agent': UA } });
  const seriesBody = t.ok ? await t.json() : null;
  const out = parseYahooFundamentals(await s.json(), seriesBody, symbol, latestCompletedSession(now), now);
  return 'error' in out ? json(out, 502) : json(out);
};

/** Handle a `/api/market/*` request. Returns null for any other path. */
export const handleMarket = async (url: URL, env: { UW_API_KEY?: string }): Promise<Response | null> => {
  if (!url.pathname.startsWith('/api/market/')) return null;
  const symbol = (url.searchParams.get('symbol') ?? '').toUpperCase();
  if (!SYMBOL.test(symbol)) return json({ error: 'Invalid symbol' }, 400);
  const now = new Date().toISOString();
  try {
    if (url.pathname === '/api/market/daily') {
      return await cached(`daily:${symbol}`, 30 * 60, async () => {
        const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=0&period2=9999999999&interval=1d&events=split`, { headers: { 'user-agent': UA } });
        if (r.status === 404) return json({ error: `${symbol} is not known to the price source` }, 404);
        if (!r.ok) return json({ error: `Price source answered ${r.status}` }, 502);
        const out = parseYahooDaily((await r.json()) as YahooChart, symbol, now);
        return 'error' in out ? json(out, 502) : json(out);
      });
    }
    if (url.pathname === '/api/market/earnings') {
      if (!env.UW_API_KEY) return json({ error: 'UW_API_KEY is not set on the server' }, 503);
      return await cached(`earnings:${symbol}`, 60 * 60, async () => {
        const r = await fetch(`https://api.unusualwhales.com/api/earnings/${encodeURIComponent(symbol)}`, { headers: { authorization: `Bearer ${env.UW_API_KEY}`, accept: 'application/json' } });
        if (!r.ok) return json({ error: `Earnings source answered ${r.status}` }, 502);
        const out = parseUwEarnings(await r.json(), symbol, now);
        return 'error' in out ? json(out, 502) : json(out);
      });
    }
    if (url.pathname === '/api/market/fundamentals') {
      return await cached(`fund:${symbol}`, 6 * 60 * 60, () => loadFundamentals(symbol, now));
    }
    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Provider request failed' }, 502);
  }
};
