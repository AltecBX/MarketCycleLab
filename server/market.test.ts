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

describe('yahoo fundamentals parser', () => {
  it('takes the FY1 estimate, signs capex as an outflow and keeps only quarters', async () => {
    const { parseYahooFundamentals } = await import('./market');
    const summary = { quoteSummary: { result: [{
      price: { currency: 'USD', marketCap: { raw: 3.9e12 } },
      defaultKeyStatistics: { beta: { raw: 2.1 }, sharesOutstanding: { raw: 24e9 } },
      earningsTrend: { trend: [
        { period: '0q', endDate: '2026-10-31', earningsEstimate: { avg: { raw: 2.47 } } },
        { period: '0y', endDate: '2027-01-31', earningsEstimate: { avg: { raw: 9.33 }, numberOfAnalysts: { raw: 55 } } },
        { period: '+1y', endDate: '2028-01-31', earningsEstimate: { avg: { raw: 15.85 } } },
      ] },
    }] } };
    const series = { timeseries: { result: [
      { meta: { type: ['quarterlyCapitalExpenditure'] }, quarterlyCapitalExpenditure: [{ asOfDate: '2026-07-31', periodType: '3M', reportedValue: { raw: -2.677e9 } }, null] },
      { meta: { type: ['quarterlyOperatingCashFlow'] }, quarterlyOperatingCashFlow: [{ asOfDate: '2026-07-31', periodType: '3M', reportedValue: { raw: 24.077e9 } }, { asOfDate: '2026-01-31', periodType: '12M', reportedValue: { raw: 1 } }] },
      { meta: { type: ['quarterlyFreeCashFlow'] }, quarterlyFreeCashFlow: [{ asOfDate: '2026-07-31', periodType: '3M', reportedValue: { raw: 21.4e9 } }] },
      { meta: { type: ['quarterlyCashAndCashEquivalents'] }, quarterlyCashAndCashEquivalents: [{ asOfDate: '2026-04-30', periodType: '3M', reportedValue: { raw: 13e9 } }, { asOfDate: '2026-07-31', periodType: '3M', reportedValue: { raw: 22.4e9 } }] },
    ] } };
    const out = parseYahooFundamentals(summary, series, 'NVDA', '2026-11-13', 'now');
    if ('error' in out) throw new Error(out.error);
    expect(out.forwardEps).toEqual({ value: 9.33, fiscalYearEnd: '2027-01-31', analysts: 55 });
    expect(out.marketCap).toBe(3.9e12);
    expect(out.cash).toEqual({ value: 22.4e9, asOf: '2026-07-31' });
    expect(out.quarters).toEqual([{ periodEnd: '2026-07-31', operatingCashFlow: 24.077e9, capex: 2.677e9, freeCashFlow: 21.4e9 }]);
  });
  it('reports missing data instead of inventing it', async () => {
    const { parseYahooFundamentals } = await import('./market');
    expect(parseYahooFundamentals({ quoteSummary: { result: [] } }, null, 'X', 'd', 'n')).toEqual({ error: 'No fundamentals for this symbol' });
    const out = parseYahooFundamentals({ quoteSummary: { result: [{}] } }, null, 'X', 'd', 'n');
    if ('error' in out) throw new Error(out.error);
    expect(out.forwardEps).toBeNull();
    expect(out.cash).toBeNull();
    expect(out.quarters).toEqual([]);
  });
});
