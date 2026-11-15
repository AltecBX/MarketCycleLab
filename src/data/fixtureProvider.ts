/**
 * Fixture provider. Serves the synthetic dataset through the same contract a live provider uses.
 * It can simulate a scoped source outage so the "what failed, what is still usable" path is real.
 */
import { addDays } from '../engine/core/calendar';
import { na, type DailySeries, type EarningsEvent, type Instrument, type Maybe } from '../engine/core/types';
import type { CalendarEntry, Clock, DataProvider, Fundamentals, ResolvedSymbol, SourceHealth, TradingGroup } from './contracts';
import { FIXTURE_AS_OF, FIXTURE_NOW, syntheticCalendar, syntheticDaily, syntheticEarnings, syntheticFundamentals } from './fixtures/synthetic';
import { GROUPS, INSTRUMENTS } from './fixtures/universe';

export type FixtureSourceId = 'prices' | 'earnings' | 'fundamentals' | 'groups';

const SOURCES: { id: FixtureSourceId; label: string; feeds: string[]; fallback: string }[] = [
  { id: 'prices', label: 'Daily price history', feeds: ['Quote strip', 'Every price study', 'Screener'], fallback: 'No price study can run. Identity and saved notes stay available.' },
  { id: 'earnings', label: 'Earnings dates and results', feeds: ['Next earnings', 'Earnings calendar', 'Reaction studies'], fallback: 'Price studies stay usable. Earnings fields show as unavailable.' },
  { id: 'fundamentals', label: 'Fundamentals and estimates', feeds: ['Forward P/E', 'Cash and free cash flow', 'Market cap filter'], fallback: 'Price studies stay usable. Valuation and cash fields show as unavailable.' },
  { id: 'groups', label: 'Trading groups', feeds: ['Group comparison', 'Peer context'], fallback: 'Single stock research stays usable. Group views show as unavailable.' },
];

const OUTAGE_KEY = 'mcl.fixture.outage';

const readOutage = (): Set<FixtureSourceId> => {
  try {
    const raw = globalThis.sessionStorage?.getItem(OUTAGE_KEY);
    return new Set(raw ? (JSON.parse(raw) as FixtureSourceId[]) : []);
  } catch {
    return new Set();
  }
};

export class FixtureProvider implements DataProvider {
  readonly id = 'synthetic-v1';
  readonly kind = 'synthetic-fixture' as const;
  readonly label = 'Synthetic fixture';
  private down = readOutage();
  private listeners = new Set<() => void>();

  /** Simulate or clear an outage for one source. Fixture mode only. */
  setOutage(id: FixtureSourceId, isDown: boolean): void {
    if (isDown) this.down.add(id);
    else this.down.delete(id);
    try {
      globalThis.sessionStorage?.setItem(OUTAGE_KEY, JSON.stringify([...this.down]));
    } catch {
      /* storage unavailable, the in-memory state still applies */
    }
    this.listeners.forEach((l) => l());
  }

  isDown(id: FixtureSourceId): boolean {
    return this.down.has(id);
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  clock(): Clock {
    return { now: FIXTURE_NOW, lastCompletedSession: FIXTURE_AS_OF };
  }

  async listInstruments(): Promise<Instrument[]> {
    return INSTRUMENTS;
  }

  async resolve(symbol: string): Promise<Maybe<ResolvedSymbol>> {
    const q = symbol.trim().toUpperCase();
    if (!q) return na('unknown-symbol', 'Enter a ticker');
    const direct = INSTRUMENTS.find((i) => i.symbol === q);
    if (direct) return { instrument: direct };
    for (const inst of INSTRUMENTS) {
      const alias = inst.aliases.find((a) => a.symbol === q);
      if (alias) return { instrument: inst, viaAlias: { symbol: alias.symbol, evidence: alias.evidence } };
    }
    return na('unknown-symbol', `${q} is not in the loaded universe`);
  }

  private byId(id: string): Instrument | undefined {
    return INSTRUMENTS.find((i) => i.id === id);
  }

  async getDaily(instrumentId: string): Promise<Maybe<DailySeries>> {
    if (this.down.has('prices')) return na('source-failed', 'Daily price history is unavailable. Simulated outage.');
    const inst = this.byId(instrumentId);
    if (!inst) return na('unknown-symbol');
    return syntheticDaily(inst);
  }

  async getEarnings(instrumentId: string): Promise<Maybe<EarningsEvent[]>> {
    const inst = this.byId(instrumentId);
    if (!inst) return na('unknown-symbol');
    if (inst.type === 'etf' || inst.type === 'index') return syntheticEarnings(inst);
    if (this.down.has('earnings')) return na('source-failed', 'Earnings source is unavailable. Simulated outage.');
    return syntheticEarnings(inst);
  }

  async getFundamentals(instrumentId: string): Promise<Maybe<Fundamentals>> {
    const inst = this.byId(instrumentId);
    if (!inst) return na('unknown-symbol');
    if (inst.type === 'etf' || inst.type === 'index') return syntheticFundamentals(inst);
    if (this.down.has('fundamentals')) return na('source-failed', 'Fundamentals source is unavailable. Simulated outage.');
    return syntheticFundamentals(inst);
  }

  async getGroups(): Promise<TradingGroup[]> {
    if (this.down.has('groups')) throw new Error('Trading group source is unavailable. Simulated outage.');
    return GROUPS;
  }

  async getEarningsCalendar(from: string, to: string): Promise<Maybe<CalendarEntry[]>> {
    if (this.down.has('earnings')) return na('source-failed', 'Earnings source is unavailable. Simulated outage.');
    return syntheticCalendar(from, to);
  }

  async health(): Promise<SourceHealth[]> {
    return SOURCES.map((s) => {
      const down = this.down.has(s.id);
      return {
        id: s.id,
        label: s.label,
        kind: 'synthetic-fixture',
        state: down ? 'failed' : 'ok',
        feeds: s.feeds,
        lastSuccess: down ? `${addDays(FIXTURE_AS_OF, -1)}T22:00:00Z` : FIXTURE_NOW,
        lastAttempt: FIXTURE_NOW,
        dataThrough: down ? addDays(FIXTURE_AS_OF, -1) : FIXTURE_AS_OF,
        error: down ? 'Simulated outage in fixture mode' : undefined,
        fallback: s.fallback,
      };
    });
  }
}
