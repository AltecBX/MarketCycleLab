import { describe, expect, it } from 'vitest';
import type { CashFlowPeriod, Fundamentals } from '../data/contracts';
import { GROUPS, INSTRUMENTS } from '../data/fixtures/universe';
import { seriesFromCloses, syntheticDaily, syntheticFundamentals } from '../data/fixtures/synthetic';
import { addSessions } from './core/calendar';
import { isNa, isNum, na, type Bar, type Instrument, type Maybe, type SourceCapture } from './core/types';
import {
  addCondition, applyFilters, applyUniverse, buildScreenerRow, capScaleSteps, clauseLabel, conditionLabel, defaultScreenerState, drawdownBoard,
  emptyFilter, evaluateCondition, fieldByAlias, filterChips, groupCounts, groupResearchMembers, nextSort, pageOfSymbol, paginate, parseCapInput,
  parseFilter, parseQuickRule, removeCondition, runScreener, screenerStateFromParams, screenerStateToParams, searchRows, serializeFilter,
  sortRows, SCREENER_FIELDS, type FilterSet, type ScreenerRow,
} from './screener';
import { forwardPe } from './valuation';

const src: SourceCapture = { provider: 'test', kind: 'synthetic-fixture', capturedAt: '2026-11-14T00:00:00Z', version: 't' };
const NA = na('no-coverage');

const inst = (symbol: string, over: Partial<Instrument> = {}): Instrument => ({
  id: `t:${symbol}`, symbol, name: `${symbol} Corp`, exchange: 'NASDAQ', currency: 'USD', type: 'stock', aliases: [], ...over,
});

const fund = (o: { cap?: number; eps?: number | null; epsAsOf?: string; cash?: number; periods?: CashFlowPeriod[] } = {}): Fundamentals => ({
  instrumentId: 'x',
  currency: 'USD',
  marketCap: o.cap === undefined ? NA : { value: o.cap, asOf: '2026-01-05', source: src },
  sharesOutstanding: NA,
  forwardEps: o.eps === null || o.eps === undefined ? NA : { value: o.eps, asOf: o.epsAsOf ?? '2026-01-05', horizon: 'FY1', fiscalYearEnd: '2026-12-31', currency: 'USD', source: src },
  cash: o.cash === undefined ? NA : { value: o.cash, asOf: '2025-12-31', source: src },
  cashFlow: o.periods ?? NA,
  beta: NA,
});

const q = (periodEnd: string, fcf: number | null): CashFlowPeriod => ({
  scope: 'quarter', periodEnd, filedAt: periodEnd, currency: 'USD', operatingCashFlow: (fcf ?? 0) + 1e9, capex: 1e9, freeCashFlow: fcf, source: src,
});

const bar = (date: string, c: number, h = c, l = c, o = c): Bar => ({ date, open: o, high: h, low: l, close: c, volume: 1000 });
const yearTurn: Bar[] = [bar('2025-12-30', 90, 95), bar('2025-12-31', 100, 120), bar('2026-01-02', 104, 106), bar('2026-01-05', 110, 112)];

/** Hand built row for table logic tests. */
const mk = (symbol: string, o: Partial<ScreenerRow> = {}): ScreenerRow => ({
  instrumentId: `t:${symbol}`, symbol, name: `${symbol} Corp`, type: 'stock', exchange: 'NASDAQ', currency: 'USD', country: null, aliases: [],
  group: null, groupId: null, groups: [], industry: null, sector: null,
  price: 100, priceDate: '2026-11-13', quoteCondition: 'completed-close', marketCap: 60e9,
  forwardPe: NA, forwardPeRecord: NA, rsi14: NA, sma200Dist: NA, buy10: NA, buy10Status: 'unavailable', weekMove: NA,
  dayChange: NA, wtd: NA, mtd: NA, qtd: NA, ytd: NA,
  high52w: NA, high52wDate: null, high52wSessions: 0, high52wSource: '', drawdown: NA, requiredGain: NA,
  cash: NA, cashRecord: NA, fcf: NA, fcfRecord: NA, basisNote: null, ...o,
});

describe('row builder', () => {
  it('computes period returns from the prior period close and the 52 week traded high', () => {
    const r = buildScreenerRow(inst('AAA'), yearTurn, fund({ cap: 5e10, eps: 5.5, cash: 3e9, periods: [q('2025-12-31', 2.5e9)] }), { groups: GROUPS });
    expect(r.price).toBe(110);
    expect(r.priceDate).toBe('2026-01-05');
    expect(r.quoteCondition).toBe('completed-close');
    expect(r.dayChange).toBeCloseTo(110 / 104 - 1, 12);
    expect(r.wtd).toBeCloseTo(110 / 104 - 1, 12); // January 5 2026 is a Monday, base is Friday January 2
    expect(r.mtd).toBeCloseTo(0.1, 12);
    expect(r.qtd).toBeCloseTo(0.1, 12);
    expect(r.ytd).toBeCloseTo(0.1, 12);
    expect(r.high52w).toBe(120);
    expect(r.high52wDate).toBe('2025-12-31');
    expect(r.high52wSessions).toBe(4);
    expect(r.high52wSource).toMatch(/since history starts 2025-12-30/);
    expect(r.drawdown).toBeCloseTo(110 / 120 - 1, 12);
    expect(r.requiredGain).toBeCloseTo(120 / 110 - 1, 12);
    expect(r.forwardPe).toBeCloseTo(20, 12);
    expect(r.marketCap).toBe(5e10);
    expect(r.cash).toBe(3e9);
    expect(r.fcf).toBe(2.5e9);
    expect(isNa(r.sma200Dist) && r.sma200Dist.code).toBe('insufficient-history');
    expect(isNa(r.rsi14) && r.rsi14.code).toBe('insufficient-history');
    expect(isNa(r.buy10) && r.buy10Status).toBe('unavailable');
    expect(r.group).toBeNull();
  });
  it('needs 200 consecutive sessions for the 200 day distance', () => {
    const closes = [...new Array(199).fill(100), 80];
    const bars = seriesFromCloses(closes);
    const r = buildScreenerRow(inst('BBB'), bars, null);
    expect(r.sma200Dist).toBeCloseTo(80 / 99.9 - 1, 12);
    expect(isNum(r.rsi14) && r.rsi14).toBe(0);
    expect(isNa(buildScreenerRow(inst('BBB'), bars.slice(1), null).sma200Dist)).toBe(true);
    const holed = [...bars.slice(0, 100), ...seriesFromCloses(new Array(101).fill(100), addSessions(bars[99]!.date, 2)).slice(0, 100)];
    const h = buildScreenerRow(inst('BBB'), holed, null);
    expect(isNa(h.sma200Dist) && h.sma200Dist.code).toBe('missing-session');
    expect(isNa(h.marketCap) && isNa(h.forwardPe) && isNa(h.cash) && isNa(h.fcf)).toBe(true);
  });
  it('does not bridge a missing previous session or a missing base close', () => {
    const gap = [yearTurn[0]!, yearTurn[2]!, yearTurn[3]!];
    const r = buildScreenerRow(inst('CCC'), gap, null);
    expect(isNa(r.ytd) && r.ytd.code).toBe('missing-session');
    const noPrev = buildScreenerRow(inst('CCC'), [yearTurn[1]!, yearTurn[3]!], null);
    expect(isNa(noPrev.dayChange) && noPrev.dayChange.code).toBe('missing-session');
    const empty = buildScreenerRow(inst('CCC'), [], null);
    expect(empty.quoteCondition).toBe('no-data');
    expect(isNa(empty.price)).toBe(true);
  });
  it('uses the one canonical forward P/E record and withholds a bad estimate', () => {
    const f = fund({ cap: 5e10, eps: 5.5 });
    const r = buildScreenerRow(inst('AAA'), yearTurn, f);
    const direct = forwardPe({ price: 110, priceDate: '2026-01-05', priceCurrency: 'USD', estimate: f.forwardEps });
    expect(r.forwardPeRecord).toEqual(direct);
    const loss = buildScreenerRow(inst('AAA'), yearTurn, fund({ eps: -2 }));
    expect(isNa(loss.forwardPe) && loss.forwardPe.code).toBe('not-applicable');
    const stale = buildScreenerRow(inst('AAA'), yearTurn, fund({ eps: 5, epsAsOf: '2025-11-01' }));
    expect(isNa(stale.forwardPe) && stale.forwardPe.code).toBe('stale-source');
  });
  it('keeps a prior period FCF on the record but out of the current value', () => {
    const r = buildScreenerRow(inst('AAA'), yearTurn, fund({ periods: [q('2025-12-31', null), q('2025-09-30', 4e9)] }));
    expect(isNa(r.fcf) && r.fcf.code).toBe('stale-source');
    expect(!isNa(r.fcfRecord) && r.fcfRecord.value).toBe(4e9);
    expect(!isNa(r.fcfRecord) && r.fcfRecord.isLatestPeriod).toBe(false);
  });
  it('takes optional model inputs and flags a stale close', () => {
    const r = buildScreenerRow(inst('AAA'), yearTurn, null, { buy10: { value: 0.58, status: 'valid' }, weekMove: 0.045, asOf: '2026-01-07' });
    expect(r.buy10).toBe(0.58);
    expect(r.buy10Status).toBe('valid');
    expect(r.weekMove).toBe(0.045);
    expect(r.quoteCondition).toBe('stale-close');
    const weekend = buildScreenerRow(inst('AAA'), yearTurn.slice(0, 3), null, { asOf: '2026-01-04' });
    expect(weekend.quoteCondition).toBe('completed-close'); // a weekend does not make Friday's close stale
  });
  it('cuts history at a basis boundary', () => {
    const r = buildScreenerRow(inst('SPN', { basisBoundary: { date: '2026-01-02', reason: 'Spin off.' } }), yearTurn, null);
    expect(r.high52w).toBe(112);
    expect(isNa(r.ytd) && r.ytd.code).toBe('missing-base-close');
    expect(r.basisNote).toMatch(/2026-01-02/);
  });
  it('is unchanged by later rows and by a price scale factor', () => {
    const nvda = INSTRUMENTS.find((i) => i.symbol === 'NVDA')!;
    const bars = syntheticDaily(nvda).bars;
    const cut = '2025-08-15';
    const asOf = buildScreenerRow(nvda, bars, null, { asOf: cut });
    const trimmed = buildScreenerRow(nvda, bars.filter((b) => b.date <= cut), null);
    expect(asOf).toEqual(trimmed);
    const scaled = buildScreenerRow(nvda, bars.filter((b) => b.date <= cut).map((b) => ({ ...b, open: b.open * 3, high: b.high * 3, low: b.low * 3, close: b.close * 3 })), null);
    for (const k of ['dayChange', 'wtd', 'mtd', 'qtd', 'ytd', 'sma200Dist', 'rsi14', 'drawdown', 'requiredGain'] as const) {
      expect(isNum(trimmed[k])).toBe(true);
      expect(scaled[k] as number).toBeCloseTo(trimmed[k] as number, 9);
    }
    expect(scaled.high52wDate).toBe(trimmed.high52wDate);
  });
});

describe('universe and market cap floor', () => {
  const rows = [mk('A', { marketCap: 2e9 }), mk('B', { marketCap: 9.99e9 }), mk('C', { marketCap: 10e9 }), mk('D', { marketCap: 15e9 }), mk('E', { marketCap: 20e9 }),
    mk('F', { marketCap: 50e9 }), mk('G', { marketCap: 55e9 }), mk('H', { marketCap: 1.9e9 }), mk('I', { marketCap: NA }), mk('J', { type: 'etf', marketCap: NA }), mk('K', { type: 'adr', marketCap: 80e9 })];
  it('applies exact numeric thresholds, including the boundary', () => {
    const count = (b: number) => applyUniverse(rows, b).rows.map((r) => r.symbol).join('');
    expect(count(2)).toBe('ABCDEFGK');
    expect(count(10)).toBe('CDEFGK');
    expect(count(15)).toBe('DEFGK');
    expect(count(20)).toBe('EFGK');
    expect(count(50)).toBe('FGK');
    expect(count(55)).toBe('GK');
    expect(count(55.01)).toBe('K');
    const u = applyUniverse(rows);
    expect(u.minCapBillions).toBe(2);
    expect(u.counts).toEqual({ candidates: 11, included: 8, belowFloor: 1, noMarketCap: 1, notEligibleType: 1 });
  });
  it('offers a broad step scale and exact typed entry', () => {
    const steps = capScaleSteps();
    for (const v of [2, 10, 15, 20, 50, 55, 100, 1000]) expect(steps).toContain(v);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(parseCapInput('55')).toBe(55);
    expect(parseCapInput('$12.5B')).toBe(12.5);
    expect(parseCapInput('1.5t')).toBe(1500);
    expect(parseCapInput('2500m')).toBe(2.5);
    expect(isNa(parseCapInput('1'))).toBe(true);
    expect(isNa(parseCapInput('abc'))).toBe(true);
  });
  it('labels group members that sit outside the universe', () => {
    const members = groupResearchMembers({ members: ['G', 'B', 'J', 'I', 'Z'] }, rows, 10);
    expect(members.map((m) => m.status)).toEqual(['in-universe', 'below-floor', 'etf', 'no-market-cap', 'not-loaded']);
    expect(members[1]!.label).toBe('Below the $10B minimum');
    expect(groupCounts([mk('A', { groups: ['X', 'Y'] }), mk('B', { groups: ['Y'] })])).toEqual([{ group: 'X', count: 1 }, { group: 'Y', count: 2 }]);
  });
});

describe('sorting, search and paging', () => {
  const rows = [mk('B', { ytd: -0.2, group: 'beta' }), mk('A', { ytd: NA, group: null }), mk('D', { ytd: 0.105, group: 'Alpha' }), mk('C', { ytd: -0.2, group: 'alpha' }), mk('E', { ytd: 0.1 }), mk('F', { ytd: NaN as unknown as Maybe<number> })];
  it('sorts signed decimals with missing values last in both directions and stable ties', () => {
    expect(sortRows(rows, 'ytd', 'asc').map((r) => r.symbol)).toEqual(['B', 'C', 'E', 'D', 'A', 'F']);
    expect(sortRows(rows, 'ytd', 'desc').map((r) => r.symbol)).toEqual(['D', 'E', 'B', 'C', 'A', 'F']);
    expect(rows.map((r) => r.symbol)).toEqual(['B', 'A', 'D', 'C', 'E', 'F']); // input untouched
  });
  it('sorts text case insensitively with missing last', () => {
    expect(sortRows(rows, 'symbol', 'desc').map((r) => r.symbol)).toEqual(['F', 'E', 'D', 'C', 'B', 'A']);
    expect(sortRows(rows, 'group', 'asc').map((r) => r.symbol)).toEqual(['D', 'C', 'B', 'A', 'E', 'F']);
    expect(sortRows(rows, 'group', 'desc').map((r) => r.symbol)).toEqual(['B', 'D', 'C', 'A', 'E', 'F']);
  });
  it('every registered column sorts without throwing', () => {
    for (const f of SCREENER_FIELDS) {
      expect(sortRows(rows, f.id, 'asc').length).toBe(rows.length);
      expect(sortRows(rows, f.id, 'desc').length).toBe(rows.length);
    }
    expect(nextSort(null, 'ytd')).toEqual({ field: 'ytd', dir: 'desc' });
    expect(nextSort({ field: 'ytd', dir: 'desc' }, 'ytd')).toEqual({ field: 'ytd', dir: 'asc' });
    expect(nextSort({ field: 'ytd', dir: 'desc' }, 'symbol')).toEqual({ field: 'symbol', dir: 'asc' });
  });
  it('searches ticker, former ticker, name and group', () => {
    const s = [mk('INFQ', { aliases: ['CCCX'], name: 'Infleqtion, Inc.', groups: ['Quantum'] }), mk('NVDA', { name: 'NVIDIA Corporation', groups: ['AI Chips and Processors'] })];
    expect(searchRows(s, 'cccx').map((r) => r.symbol)).toEqual(['INFQ']);
    expect(searchRows(s, 'nvid').map((r) => r.symbol)).toEqual(['NVDA']);
    expect(searchRows(s, 'QUANT').map((r) => r.symbol)).toEqual(['INFQ']);
    expect(searchRows(s, '  ').length).toBe(2);
    expect(searchRows(s, 'zzz')).toEqual([]);
  });
  it('pages with clamping and finds a symbol again', () => {
    const many = Array.from({ length: 23 }, (_, i) => mk(`S${i}`));
    const p = paginate(many, 3, 10);
    expect(p).toMatchObject({ page: 3, pageCount: 3, total: 23, from: 21, to: 23 });
    expect(paginate(many, 99, 10).page).toBe(3);
    expect(paginate(many, 0, 10).page).toBe(1);
    expect(paginate([], 1, 10)).toMatchObject({ page: 1, pageCount: 1, from: 0, to: 0 });
    expect(pageOfSymbol(many, 'S15', 10)).toBe(2);
    expect(pageOfSymbol(many, 'nope', 10)).toBeNull();
  });
});

describe('filters', () => {
  const ownerRule = 'cap >= 50, sma200 <= -30, pe <= 25, pe > 0, fcf > 2b, ytd < -1';
  const pass = mk('CAT', { marketCap: 60e9, sma200Dist: -0.35, forwardPe: 20, fcf: 3e9, ytd: -0.1 });
  const candidates = [
    pass,
    mk('CAPLOW', { marketCap: 49.9e9, sma200Dist: -0.35, forwardPe: 20, fcf: 3e9, ytd: -0.1 }),
    mk('NEAR', { marketCap: 60e9, sma200Dist: -0.29, forwardPe: 20, fcf: 3e9, ytd: -0.1 }),
    mk('NOPE', { marketCap: 60e9, sma200Dist: -0.35, forwardPe: NA, fcf: 3e9, ytd: -0.1 }),
    mk('RICH', { marketCap: 60e9, sma200Dist: -0.35, forwardPe: 25.5, fcf: 3e9, ytd: -0.1 }),
    mk('PRIOR', { marketCap: 60e9, sma200Dist: -0.35, forwardPe: 20, fcf: na('stale-source'), ytd: -0.1 }),
    mk('LOWFCF', { marketCap: 60e9, sma200Dist: -0.35, forwardPe: 20, fcf: 2e9, ytd: -0.1 }),
    mk('UPYTD', { marketCap: 60e9, sma200Dist: -0.35, forwardPe: 20, fcf: 3e9, ytd: 0.05 }),
    mk('EDGE', { marketCap: 50e9, sma200Dist: -0.3, forwardPe: 25, fcf: 2.000001e9, ytd: -0.0100001 }),
  ];
  it('runs the owner example and lets it be empty', () => {
    const r = parseQuickRule(ownerRule);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(applyFilters(candidates, r.filter).map((x) => x.symbol)).toEqual(['CAT', 'EDGE']);
    expect(applyFilters(candidates.slice(1, 8), r.filter)).toEqual([]);
    expect(filterChips(r.filter).map((c) => c.label)).toEqual([
      'Market cap at least $50B', '% from 200 day average at most -30%', 'Forward P/E at most 25x', 'Forward P/E above 0x', 'Free cash flow above $2B', 'Year to date below -1%',
    ]);
  });
  it('never lets missing data pass a numeric condition', () => {
    const missing = mk('M');
    for (const op of ['gte', 'lte', 'gt', 'lt', 'eq'] as const) {
      expect(evaluateCondition(missing, { field: 'pe', op, value: 0 })).toBe(false);
      expect(evaluateCondition(missing, { field: 'ytd', op, value: -100 })).toBe(false);
    }
    expect(evaluateCondition(missing, { field: 'pe', op: 'between', value: -1e9, value2: 1e9 })).toBe(false);
    expect(evaluateCondition(missing, { field: 'pe', op: 'missing' })).toBe(true);
    expect(evaluateCondition(missing, { field: 'pe', op: 'available' })).toBe(false);
    expect(evaluateCondition(pass, { field: 'pe', op: 'available' })).toBe(true);
  });
  it('treats inclusive bounds robustly and strict bounds strictly', () => {
    const r = mk('R', { sma200Dist: 0.1 + 0.2 - 0.6, ytd: 0.07 }); // -0.29999999999999993
    expect(evaluateCondition(r, { field: 'sma200', op: 'lte', value: -30 })).toBe(true);
    expect(evaluateCondition(r, { field: 'sma200', op: 'lt', value: -30 })).toBe(false);
    expect(evaluateCondition(r, { field: 'sma200', op: 'eq', value: -30 })).toBe(true);
    expect(evaluateCondition(r, { field: 'ytd', op: 'between', value: 7, value2: 10 })).toBe(true);
    expect(evaluateCondition(r, { field: 'ytd', op: 'between', value: 10, value2: 7 })).toBe(true);
    expect(evaluateCondition(r, { field: 'ytd', op: 'gt', value: 7 })).toBe(false);
  });
  it('filters only on fresh price derived observations', () => {
    const stale = mk('S', { quoteCondition: 'stale-close', ytd: -0.5, marketCap: 60e9 });
    expect(evaluateCondition(stale, { field: 'ytd', op: 'lt', value: -1 })).toBe(false);
    expect(evaluateCondition(stale, { field: 'ytd', op: 'lt', value: -1 }, { requireFresh: false })).toBe(true);
    expect(evaluateCondition(stale, { field: 'cap', op: 'gte', value: 50 })).toBe(true);
    expect(evaluateCondition(stale, { field: 'ytd', op: 'missing' })).toBe(true);
  });
  it('matches groups exactly, case insensitively, across memberships', () => {
    const m = mk('MRVL', { group: 'AI Chips and Processors', groups: ['AI Chips and Processors', 'Chip Design and Connectivity'], industry: 'Semiconductors', type: 'stock' });
    expect(evaluateCondition(m, { field: 'group', op: 'eq', value: 'chip design and connectivity' })).toBe(true);
    expect(evaluateCondition(m, { field: 'group', op: 'eq', value: 'Chip Design' })).toBe(false);
    expect(evaluateCondition(m, { field: 'group', op: 'in', values: ['Quantum', 'ai chips and processors'] })).toBe(true);
    expect(evaluateCondition(m, { field: 'industry', op: 'eq', value: 'SEMICONDUCTORS' })).toBe(true);
    expect(evaluateCondition(mk('X'), { field: 'group', op: 'missing' })).toBe(true);
    expect(evaluateCondition(m, { field: 'group', op: 'gte', value: 1 })).toBe(false);
  });
  it('supports grouped OR, clear one and clear all', () => {
    const r = parseQuickRule('cap >= 50, ytd < -20 or drawdown <= -40 | rsi < 30');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.filter.clauses.length).toBe(2);
    expect(clauseLabel(r.filter.clauses[1]!)).toBe('Year to date below -20% or From 52 week high at most -40% or RSI 14 below 30');
    const rows = [mk('A', { ytd: -0.3 }), mk('B', { drawdown: -0.5 }), mk('C', { rsi14: 25 }), mk('D', { ytd: -0.1, drawdown: -0.1, rsi14: 50 }), mk('E', { marketCap: 1e9, ytd: -0.9 })];
    expect(applyFilters(rows, r.filter).map((x) => x.symbol)).toEqual(['A', 'B', 'C']);
    const chips = filterChips(r.filter);
    expect(chips.length).toBe(4);
    let f: FilterSet = removeCondition(r.filter, 1, 0);
    expect(filterChips(f).length).toBe(3);
    f = removeCondition(f, 1, 0);
    expect(f.clauses.length).toBe(2);
    expect('any' in f.clauses[1]!).toBe(false);
    f = removeCondition(f, 0);
    expect(f.clauses.length).toBe(1);
    expect(applyFilters(rows, emptyFilter()).length).toBe(5);
    expect(addCondition(emptyFilter(), { field: 'pe', op: 'lte', value: 25 }).clauses.length).toBe(1);
  });
  it('parses units, between, lists and availability', () => {
    const r = parseQuickRule('fcf > 500m, cap between 10 and 1.5t, pe 10..25, ytd <= -5%, has cash, no pe, group = "Power, Cooling and Electrical Infrastructure", sector in [Technology; Industrials], price >= $20');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.filter.clauses).toEqual([
      { field: 'fcf', op: 'gt', value: 0.5 },
      { field: 'cap', op: 'between', value: 10, value2: 1500 },
      { field: 'pe', op: 'between', value: 10, value2: 25 },
      { field: 'ytd', op: 'lte', value: -5 },
      { field: 'cash', op: 'available' },
      { field: 'pe', op: 'missing' },
      { field: 'group', op: 'eq', value: 'Power, Cooling and Electrical Infrastructure' },
      { field: 'sector', op: 'in', values: ['Technology', 'Industrials'] },
      { field: 'price', op: 'gte', value: 20 },
    ]);
    expect(conditionLabel({ field: 'cap', op: 'between', value: 10, value2: 1500 })).toBe('Market cap between $10B and $1500B');
    expect(conditionLabel({ field: 'cash', op: 'available' })).toBe('Cash on hand is available');
    expect(fieldByAlias('MA200')?.id).toBe('sma200');
  });
  it('explains what it could not read', () => {
    const r = parseQuickRule('cap >= 50, foo > 3, pe <= abc, ytd, rsi < 30%, group > 5, pe in [a; b], pe > 2b');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.text)).toEqual(['foo > 3', 'pe <= abc', 'ytd', 'rsi < 30%', 'group > 5', 'pe in [a; b]', 'pe > 2b']);
    expect(r.errors[0]!.message).toMatch(/Unknown field "foo"/);
    expect(r.errors[1]!.message).toMatch(/"abc" is not a number/);
    expect(r.errors[2]!.message).toMatch(/for example cap >= 50/);
    expect(r.errors[3]!.message).toMatch(/not a percent/);
    expect(r.errors[4]!.message).toMatch(/is text/);
    expect(r.errors[5]!.message).toMatch(/is a number/);
    expect(r.errors[6]!.message).toMatch(/does not take a b suffix/);
  });
});

describe('URL round trip', () => {
  it('serializes a filter compactly and parses it back exactly', () => {
    const r = parseQuickRule('cap >= 50, sma200 <= -30, pe <= 25.5, fcf > 2b, ytd < -1 or drawdown <= -40, pe between 5 and 30, has cash, group = "Power, Cooling and Electrical Infrastructure", sector in [Technology; A|B:C]');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = serializeFilter(r.filter);
    expect(text.startsWith('cap:gte:50,sma200:lte:-30,pe:lte:25.5,fcf:gt:2,ytd:lt:-1|drawdown:lte:-40,pe:between:5:30,cash:available,group:eq:Power%2C%20Cooling')).toBe(true);
    const back = parseFilter(text);
    expect(back.ok && back.filter).toEqual(r.filter);
    // Survives a real query string.
    const params = new URLSearchParams({ f: text });
    const again = parseFilter(new URLSearchParams(params.toString()).get('f')!);
    expect(again.ok && again.filter).toEqual(r.filter);
    expect(parseFilter('').ok && serializeFilter(emptyFilter())).toBe('');
    const bad = parseFilter('cap:gte:x,nope:gte:1,pe:zz:1');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.length).toBe(3);
  });
  it('restores the whole list state and keeps defaults out of the URL', () => {
    expect(screenerStateToParams(defaultScreenerState())).toEqual({});
    const f = parseQuickRule('cap >= 50, ytd < -1');
    const state = { ...defaultScreenerState(), minCapBillions: 55, query: 'chips', sort: { field: 'sma200' as const, dir: 'asc' as const }, page: 3, pageSize: 25, filter: f.ok ? f.filter : emptyFilter(), tab: 'cash' as const };
    const params = screenerStateToParams(state);
    expect(params).toEqual({ cap: '55', q: 'chips', sort: 'sma200.asc', page: '3', size: '25', f: 'cap:gte:50,ytd:lt:-1', tab: 'cash' });
    const qs = new URLSearchParams(params).toString();
    const restored = screenerStateFromParams(Object.fromEntries(new URLSearchParams(qs)));
    expect(restored.errors).toEqual([]);
    expect(restored.state).toEqual(state);
    const broken = screenerStateFromParams({ cap: '1', sort: 'zzz.up', page: '-2', f: 'x:y', tab: 'nope' });
    expect(broken.errors.length).toBe(5);
    expect(broken.state).toEqual(defaultScreenerState());
  });
});

describe('pipeline and drawdown board', () => {
  it('applies floor, filters, search, sort and paging in one pass', () => {
    const rows = [mk('A', { marketCap: 60e9, ytd: -0.2, name: 'Alpha Chips' }), mk('B', { marketCap: 60e9, ytd: -0.4, name: 'Beta Chips' }), mk('C', { marketCap: 5e9, ytd: -0.5, name: 'Gamma Chips' }), mk('D', { marketCap: 60e9, ytd: 0.2, name: 'Delta Chips' }), mk('E', { marketCap: 60e9, ytd: -0.3, name: 'Other' })];
    const f = parseQuickRule('ytd < -1');
    const view = runScreener(rows, { ...defaultScreenerState(), minCapBillions: 10, query: 'chips', sort: { field: 'ytd', dir: 'asc' }, filter: f.ok ? f.filter : emptyFilter(), pageSize: 1, page: 2 });
    expect(view.universeCount).toBe(4);
    expect(view.universe.belowFloor).toBe(1);
    expect(view.matched.map((r) => r.symbol)).toEqual(['B', 'A']);
    expect(view.page.rows.map((r) => r.symbol)).toEqual(['A']);
    expect(view.page.pageCount).toBe(2);
    expect(view.chips.length).toBe(1);
  });
  it('orders drawdowns deepest first on one scale and lists what it cannot place', () => {
    const rows = [
      mk('A', { price: 80, high52w: 100, high52wDate: '2026-06-01', high52wSessions: 252, drawdown: -0.2, requiredGain: 0.25 }),
      mk('B', { price: 50, high52w: 100, high52wDate: '2026-02-01', high52wSessions: 252, drawdown: -0.5, requiredGain: 1 }),
      mk('C', { price: 100, high52w: 100, high52wDate: '2026-11-13', high52wSessions: 40, drawdown: 0, requiredGain: 0 }),
      mk('D', { quoteCondition: 'stale-close', price: 10, high52w: 100, drawdown: -0.9, requiredGain: 9 }),
      mk('E'),
    ];
    const board = drawdownBoard(rows);
    expect(board.entries.map((e) => e.symbol)).toEqual(['B', 'A', 'C']);
    expect(board.scaleMin).toBe(-0.5);
    expect(board.entries.map((e) => e.bar)).toEqual([1, 0.4, 0]);
    expect(board.entries[0]!.requiredGain).toBe(1);
    expect(board.entries[2]!.shortHistory).toBe(true);
    expect(board.unavailable.map((u) => u.symbol)).toEqual(['D', 'E']);
    expect(board.highDefinition).toMatch(/not a closing high/);
    expect(drawdownBoard([]).scaleMin).toBe(0);
  });
});

describe('fixture universe smoke test', () => {
  it('builds every row quickly and consistently', () => {
    const data = INSTRUMENTS.map((i) => ({ i, bars: syntheticDaily(i).bars, fund: syntheticFundamentals(i) }));
    const t0 = performance.now();
    const rows = data.map((d) => buildScreenerRow(d.i, d.bars, d.fund, { groups: GROUPS, asOf: '2026-11-14' }));
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(3000);
    expect(rows.length).toBe(INSTRUMENTS.length);
    expect(rows.every((r) => r.quoteCondition === 'completed-close' && r.priceDate === '2026-11-13')).toBe(true);
    const nvda = rows.find((r) => r.symbol === 'NVDA')!;
    for (const k of ['dayChange', 'wtd', 'mtd', 'qtd', 'ytd', 'sma200Dist', 'rsi14', 'drawdown', 'requiredGain', 'marketCap'] as const) expect(isNum(nvda[k])).toBe(true);
    expect(nvda.group).toBe('AI Chips and Processors');
    const sndk = rows.find((r) => r.symbol === 'SNDK')!;
    expect(isNum(sndk.sma200Dist) && isNum(sndk.ytd)).toBe(true);
    const cbrs = rows.find((r) => r.symbol === 'CBRS')!;
    expect(isNa(cbrs.sma200Dist) && cbrs.sma200Dist.code).toBe('insufficient-history');
    expect(isNa(cbrs.ytd) && cbrs.ytd.code).toBe('missing-base-close');
    expect(cbrs.high52wSessions).toBeLessThan(252);
    const spy = rows.find((r) => r.symbol === 'SPY')!;
    expect(isNa(spy.marketCap) && spy.marketCap.code).toBe('not-applicable');
    for (const r of rows) {
      if (isNum(r.drawdown)) expect(r.drawdown).toBeLessThanOrEqual(0);
      if (isNum(r.drawdown) && isNum(r.requiredGain)) expect((1 + r.drawdown) * (1 + r.requiredGain)).toBeCloseTo(1, 10);
      if (isNum(r.forwardPe)) expect(r.forwardPe).toBeGreaterThan(0);
    }
    const uni = applyUniverse(rows, 2);
    expect(uni.counts.notEligibleType).toBe(INSTRUMENTS.filter((i) => i.type === 'etf').length);
    expect(uni.rows.every((r) => isNum(r.marketCap) && r.marketCap >= 2e9)).toBe(true);
    expect(applyUniverse(rows, 55).rows.length).toBeLessThanOrEqual(applyUniverse(rows, 50).rows.length);
    const board = drawdownBoard(uni.rows);
    expect(board.entries.length + board.unavailable.length).toBe(uni.rows.length);
    const memory = groupResearchMembers(GROUPS.find((g) => g.id === 'memory-storage')!, rows, 2);
    expect(memory.find((m) => m.symbol === 'DRAM')!.status).toBe('etf');
  });
});
