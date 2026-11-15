import { describe, expect, it } from 'vitest';
import { handleMarket, parseUwEarnings, parseYahooDaily } from './market';

const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const chart = (granularity: string, ts: number[], closes: (number | null)[]) => ({
  chart: {
    result: [{
      meta: { dataGranularity: granularity, longName: 'Test Co', instrumentType: 'EQUITY', currency: 'USD', fullExchangeName: 'NasdaqGS' },
      timestamp: ts,
      indicators: { quote: [{ open: closes, high: closes.map((c) => (c === null ? null : c + 1)), low: closes.map((c) => (c === null ? null : c - 1)), close: closes, volume: closes.map(() => 100) }] },
    }],
  },
});

describe('yahoo daily parser', () => {
  const now = '2026-11-13T18:00:00Z'; // Friday 1pm ET, session still open
  it('drops the session that has not closed, null rows and non sessions', () => {
    const raw = chart('1d', [T('2026-11-11T14:30:00Z'), T('2026-11-12T14:30:00Z'), T('2026-11-13T14:30:00Z'), T('2026-11-14T14:30:00Z')], [10, null, 12, 13]);
    const out = parseYahooDaily(raw, 'TEST', now);
    if ('error' in out) throw new Error(out.error);
    expect(out.bars.map((b) => b.date)).toEqual(['2026-11-11']);
    expect(out.dropped).toEqual({ nullRow: 1, notSession: 0, incompleteSession: 2, badOhlc: 0 });
  });
  it('keeps the latest session once it has closed', () => {
    const raw = chart('1d', [T('2026-11-12T14:30:00Z'), T('2026-11-13T14:30:00Z')], [10, 12]);
    const out = parseYahooDaily(raw, 'TEST', '2026-11-13T21:05:00Z');
    expect('error' in out ? [] : out.bars.map((b) => b.date)).toEqual(['2026-11-12', '2026-11-13']);
  });
  it('rejects a history that is not daily', () => {
    const out = parseYahooDaily(chart('1mo', [T('2026-10-01T13:30:00Z')], [10]), 'TEST', now);
    expect('error' in out && out.error).toMatch(/not daily/);
  });
});

describe('earnings parser', () => {
  it('maps time of day and status without inventing values', () => {
    const out = parseUwEarnings({ data: [
      { source: 'company', report_date: '2026-11-17', report_time: 'postmarket', street_mean_est: '2.49', actual_eps: null, ending_fiscal_quarter: '2026-10-31' },
      { source: 'estimation', report_date: '2026-08-26', report_time: 'premarket', street_mean_est: '2.09', actual_eps: '2.22' },
      { source: 'company', report_date: 'bad' },
    ] }, 'TEST', 'now');
    if ('error' in out) throw new Error(out.error);
    expect(out.events).toEqual([
      { date: '2026-08-26', time: 'bmo', status: 'estimated', fiscalPeriodEnd: null, epsActual: 2.22, epsEstimate: 2.09 },
      { date: '2026-11-17', time: 'amc', status: 'confirmed', fiscalPeriodEnd: '2026-10-31', epsActual: null, epsEstimate: 2.49 },
    ]);
  });
});

describe('market routes', () => {
  it('validates the symbol and never needs a client key', async () => {
    expect(await handleMarket(new URL('http://x/api/other'), {})).toBeNull();
    expect((await handleMarket(new URL('http://x/api/market/daily?symbol=../etc'), {}))!.status).toBe(400);
    const r = await handleMarket(new URL('http://x/api/market/earnings?symbol=NVDA'), {});
    expect(r!.status).toBe(503);
    expect(await r!.text()).toMatch(/UW_API_KEY is not set/);
  });
});
