/**
 * Live provider. Talks only to this app's own `/api/market` routes. The server holds provider
 * access. Identity and curated groups come from the same universe file as fixture mode.
 *
 * Built so far: daily history (Yahoo Finance chart) and earnings (Unusual Whales). Fundamentals,
 * estimates and the cross-stock earnings calendar have no live source yet and say so.
 */
import { latestCompletedSession } from '../engine/core/calendar';
import { buildCoverage } from '../engine/core/series';
import { na, type DailySeries, type EarningsEvent, type Instrument, type Maybe, type SourceCapture } from '../engine/core/types';
import type { CalendarEntry, Clock, DataProvider, Fundamentals, ResolvedSymbol, SourceHealth, TradingGroup } from './contracts';
import { GROUPS, INSTRUMENTS } from './fixtures/universe';

interface DailyPayload {
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  type: 'stock' | 'etf' | 'index';
  bars: DailySeries['bars'];
  provider: string;
  capturedAt: string;
}
interface EarningsPayload {
  events: { date: string; time: 'bmo' | 'amc' | 'unknown'; status: 'confirmed' | 'estimated'; fiscalPeriodEnd: string | null; epsActual: number | null; epsEstimate: number | null }[];
  provider: string;
  capturedAt: string;
}

const get = async <T,>(path: string): Promise<{ ok: true; value: T } | { ok: false; status: number; error: string }> => {
  try {
    const r = await fetch(path);
    const body = (await r.json()) as T & { error?: string };
    if (!r.ok) return { ok: false, status: r.status, error: body.error ?? `Request failed with ${r.status}` };
    return { ok: true, value: body };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : 'Network error' };
  }
};

export class LiveProvider implements DataProvider {
  readonly id = 'live-v1';
  readonly kind = 'provider' as const;
  readonly label = 'Live data';
  private extra = new Map<string, Instrument>();
  private daily = new Map<string, Promise<Maybe<DailySeries>>>();
  private status = new Map<string, { ok: boolean; at: string; error?: string; through?: string }>();

  clock(): Clock {
    const now = new Date().toISOString();
    return { now, lastCompletedSession: latestCompletedSession(now) };
  }

  async listInstruments(): Promise<Instrument[]> {
    return [...INSTRUMENTS, ...this.extra.values()];
  }

  private find(pred: (i: Instrument) => boolean): Instrument | undefined {
    return INSTRUMENTS.find(pred) ?? [...this.extra.values()].find(pred);
  }

  async resolve(symbol: string): Promise<Maybe<ResolvedSymbol>> {
    const q = symbol.trim().toUpperCase();
    if (!q) return na('unknown-symbol', 'Enter a ticker');
    const direct = this.find((i) => i.symbol === q);
    if (direct) return { instrument: direct };
    for (const inst of INSTRUMENTS) {
      const alias = inst.aliases.find((a) => a.symbol === q);
      if (alias) return { instrument: inst, viaAlias: { symbol: alias.symbol, evidence: alias.evidence } };
    }
    // Any other ticker the price source knows becomes researchable, with identity from that source.
    const r = await get<DailyPayload>(`/api/market/daily?symbol=${encodeURIComponent(q)}`);
    if (!r.ok) return na(r.status === 404 ? 'unknown-symbol' : 'source-failed', r.error);
    const inst: Instrument = { id: `us:${q.toLowerCase()}`, symbol: q, name: r.value.name, exchange: r.value.exchange, currency: r.value.currency, type: r.value.type, aliases: [] };
    this.extra.set(inst.id, inst);
    this.daily.set(inst.id, Promise.resolve(this.toSeries(inst, r.value)));
    return { instrument: inst };
  }

  private toSeries(inst: Instrument, p: DailyPayload): DailySeries {
    // History before a basis boundary belongs to a different security and is cut, never spliced.
    const bars = inst.basisBoundary && inst.symbol === 'SNDK' ? p.bars.filter((b) => b.date >= inst.basisBoundary!.date) : p.bars;
    const source: SourceCapture = { provider: p.provider, kind: 'provider', capturedAt: p.capturedAt, version: 'yahoo-chart-v8', note: `${p.provider}. Unofficial source, delayed, may be revised.` };
    this.status.set('prices', { ok: true, at: p.capturedAt, through: bars[bars.length - 1]?.date });
    return { instrumentId: inst.id, symbol: inst.symbol, currency: p.currency, basis: 'split-adjusted', bars, coverage: buildCoverage(bars), source };
  }

  getDaily(instrumentId: string): Promise<Maybe<DailySeries>> {
    const hit = this.daily.get(instrumentId);
    if (hit) return hit;
    const inst = this.find((i) => i.id === instrumentId);
    if (!inst) return Promise.resolve(na('unknown-symbol'));
    const p = get<DailyPayload>(`/api/market/daily?symbol=${encodeURIComponent(inst.symbol)}`).then((r): Maybe<DailySeries> => {
      if (!r.ok) {
        this.daily.delete(instrumentId);
        this.status.set('prices', { ok: false, at: new Date().toISOString(), error: r.error });
        return na('source-failed', r.error);
      }
      return this.toSeries(inst, r.value);
    });
    this.daily.set(instrumentId, p);
    return p;
  }

  async getEarnings(instrumentId: string): Promise<Maybe<EarningsEvent[]>> {
    const inst = this.find((i) => i.id === instrumentId);
    if (!inst) return na('unknown-symbol');
    if (inst.type !== 'stock' && inst.type !== 'adr') return na('not-applicable', 'Funds do not report earnings');
    const r = await get<EarningsPayload>(`/api/market/earnings?symbol=${encodeURIComponent(inst.symbol)}`);
    if (!r.ok) {
      this.status.set('earnings', { ok: false, at: new Date().toISOString(), error: r.error });
      return na('source-failed', r.error);
    }
    this.status.set('earnings', { ok: true, at: r.value.capturedAt });
    const source: SourceCapture = { provider: r.value.provider, kind: 'provider', capturedAt: r.value.capturedAt, version: 'uw-earnings-v1' };
    // The source does not say when each date became known, so `knownAt` stays unset. Point in time
    // model inputs treat these events as not known in advance.
    return r.value.events.map((e) => ({
      instrumentId: inst.id,
      symbol: inst.symbol,
      date: e.date,
      time: e.time,
      status: e.status,
      fiscalPeriod: e.fiscalPeriodEnd ? `Quarter ended ${e.fiscalPeriodEnd}` : undefined,
      epsActual: e.epsActual,
      epsEstimate: e.epsEstimate,
      revenueActual: null,
      revenueEstimate: null,
      source,
    }));
  }

  async getFundamentals(instrumentId: string): Promise<Maybe<Fundamentals>> {
    const inst = this.find((i) => i.id === instrumentId);
    if (inst && inst.type !== 'stock' && inst.type !== 'adr') return na('not-applicable', 'Funds have no issuer fundamentals here');
    return na('no-coverage', 'No live fundamentals source is connected yet');
  }

  async getGroups(): Promise<TradingGroup[]> {
    return GROUPS;
  }

  async getEarningsCalendar(): Promise<Maybe<CalendarEntry[]>> {
    return na('no-coverage', 'The cross-stock earnings calendar has no live source yet');
  }

  async health(): Promise<SourceHealth[]> {
    const row = (id: string, label: string, feeds: string[], fallback: string): SourceHealth => {
      const s = this.status.get(id);
      return { id, label, kind: 'provider', state: !s ? 'degraded' : s.ok ? 'ok' : 'failed', feeds, lastSuccess: s?.ok ? s.at : null, lastAttempt: s?.at ?? null, dataThrough: s?.through ?? null, error: s ? s.error : 'Not requested yet in this session', fallback };
    };
    return [
      row('prices', 'Daily price history (Yahoo Finance chart)', ['Quote strip', 'Every price study'], 'No price study can run.'),
      row('earnings', 'Earnings dates and results (Unusual Whales)', ['Next earnings', 'Reaction studies'], 'Price studies stay usable.'),
      { id: 'fundamentals', label: 'Fundamentals and estimates', kind: 'provider', state: 'failed', feeds: ['Forward P/E', 'Cash and free cash flow', 'Market cap filter', 'Screener'], lastSuccess: null, lastAttempt: null, dataThrough: null, error: 'No live source connected', fallback: 'Valuation, cash and the cap filter show as unavailable.' },
    ];
  }
}
