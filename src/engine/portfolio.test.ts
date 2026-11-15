import { describe, expect, it } from 'vitest';
import { addDays, sessionsBetween } from './core/calendar';
import { sliceAsOf } from './core/series';
import { isNa, na, type Bar, type EarningsEvent, type ISODate, type Maybe, type SourceCapture } from './core/types';
import { INSTRUMENTS } from '../data/fixtures/universe';
import { syntheticDaily } from '../data/fixtures/synthetic';
import {
  applyManualEdit,
  applyReconciliation,
  correlationMatrix,
  emptyBook,
  exposureBreakdown,
  holdingDrawdown,
  markPositions,
  pairCorrelation,
  parsePositionsCsv,
  reconcileImport,
  replayEvent,
  scenarioShock,
  weekAhead,
  type Mark,
  type OptionMagnitude,
  type Position,
  type PositionBook,
  type SymbolResolver,
} from './portfolio';

const SRC: SourceCapture = { provider: 'test', kind: 'synthetic-fixture', capturedAt: '2026-11-14T00:00:00Z', version: 't' };
const pos = (symbol: string, shares: number, extra: Partial<Position> = {}): Position => ({ instrumentId: `us:${symbol.toLowerCase()}`, symbol, shares, source: 'manual', revision: 1, ...extra });
const marks = (m: Record<string, Maybe<Mark>>): Map<string, Maybe<Mark>> => new Map(Object.entries(m).map(([s, v]) => [`us:${s.toLowerCase()}`, v]));
const D = '2026-11-13';

const closesToBars = (closes: number[], end: ISODate = D): Bar[] => {
  const dates = sessionsBetween(addDays(end, -closes.length * 2 - 10), end).slice(-closes.length);
  return closes.map((c, i) => ({ date: dates[i]!, open: c, high: c, low: c, close: c, volume: 1 }));
};

describe('marking positions', () => {
  const book = markPositions(
    [pos('AAA', 100, { cost: 40 }), pos('BBB', -50, { cost: 20 }), pos('CCC', 10), pos('DDD', 0), pos('EEE', 0, { kind: 'watch' }), pos('FFF', 25)],
    marks({ AAA: { close: 50, date: D }, BBB: { close: 30, date: '2026-11-12' }, CCC: na('source-failed', 'Price source failed'), DDD: { close: 5, date: D }, EEE: { close: 9, date: D } }),
  );
  it('values each row and never invents a zero', () => {
    const [a, b, c, d, e, f] = book.rows;
    expect(a!.value).toBe(5000);
    expect(a!.pnl).toBe(1000);
    expect(a!.pnlPct).toBeCloseTo(0.25, 12);
    expect(b!.state).toBe('short');
    expect(b!.value).toBe(-1500);
    expect(b!.pnl).toBe(-500); // short 50 from 20 to 30
    expect(b!.pnlPct).toBeCloseTo(-0.5, 12);
    expect(isNa(c!.value) && c!.value.code).toBe('source-failed');
    expect(d!.state).toBe('zero');
    expect(isNa(d!.value) && d!.value.code).toBe('not-applicable');
    expect(e!.state).toBe('watch');
    expect(isNa(e!.value)).toBe(true);
    expect(isNa(f!.value) && f!.value.code).toBe('no-coverage');
  });
  it('reports covered and missing totals separately and refuses an all covered total', () => {
    expect(book.coveredValue).toBe(3500);
    expect(book.coveredGross).toBe(6500);
    expect(book.coveredCount).toBe(2);
    expect(book.missing.map((m) => m.symbol)).toEqual(['CCC', 'FFF']);
    expect(book.allCovered).toBe(false);
    expect(isNa(book.totalValue) && book.totalValue.detail).toMatch(/CCC, FFF/);
    expect(book.coveredPnl).toBe(500);
    expect(book.pnlCoveredCount).toBe(2);
    expect(book.markDates).toEqual({ oldest: '2026-11-12', newest: D });
    expect(book.watchCount).toBe(1);
    const full = markPositions([pos('AAA', 100)], marks({ AAA: { close: 50, date: D } }));
    expect(full.allCovered).toBe(true);
    expect(full.totalValue).toBe(5000);
    expect(isNa(full.rows[0]!.pnl)).toBe(true); // no cost recorded
    const bad = markPositions([pos('AAA', 100)], marks({ AAA: { close: 0, date: D } }));
    expect(bad.allCovered).toBe(false);
    expect(isNa(markPositions([], new Map()).totalValue)).toBe(true);
  });
  it('breaks exposure down by group and sector with single name concentration', () => {
    const b2 = markPositions([pos('AAA', 100), pos('BBB', 100), pos('CCC', 100), pos('ZZZ', 5)], marks({ AAA: { close: 60, date: D }, BBB: { close: 30, date: D }, CCC: { close: 10, date: D } }));
    const ex = exposureBreakdown(b2, (s) => ({ group: s === 'CCC' ? null : 'Chips', sector: 'Technology' }));
    expect(ex.byGroup.map((g) => [g.key, g.value])).toEqual([['Chips', 9000], ['Unclassified', 1000]]);
    expect(ex.byGroup[0]!.weight).toBeCloseTo(0.9, 12);
    expect(ex.bySector[0]!.symbols).toEqual(['AAA', 'BBB', 'CCC']);
    expect(ex.names[0]).toEqual({ symbol: 'AAA', value: 6000, weight: 0.6 });
    expect(ex.herfindahl).toBeCloseTo(0.36 + 0.09 + 0.01, 12);
    expect(ex.topWeight).toBe(0.6);
    expect(ex.missing).toEqual(['ZZZ']);
  });
});

describe('holding drawdown', () => {
  it('measures the decline from the closing high and the gain to regain it', () => {
    const bars = closesToBars([10, 20, 16, 18, 15]);
    const d = holdingDrawdown(bars);
    expect(isNa(d)).toBe(false);
    if (isNa(d)) return;
    expect(d.closingHigh).toBe(20);
    expect(d.highDate).toBe(bars[1]!.date);
    expect(d.drawdown).toBeCloseTo(-0.25, 12);
    expect(d.gainToRegain).toBeCloseTo(1 / 3, 12);
    expect(d.reference).toMatch(/within available history/);
    const w = holdingDrawdown(bars, 3);
    expect(!isNa(w) && w.closingHigh).toBe(18);
    expect(!isNa(w) && w.reference).toMatch(/last 3 sessions/);
    expect(isNa(holdingDrawdown([]))).toBe(true);
  });
});

describe('correlation', () => {
  const n = 80;
  const a = closesToBars(Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.1));
  const b = a.map((x) => ({ ...x, close: x.close * 2 }));
  const inv = a.map((x, i) => ({ ...x, close: i === 0 ? 100 : 0 }));
  for (let i = 1; i < n; i++) inv[i]!.close = inv[i - 1]!.close / (a[i]!.close / a[i - 1]!.close);
  it('uses same date returns and needs enough of them', () => {
    const same = pairCorrelation({ symbol: 'A', bars: a }, { symbol: 'B', bars: b }, 60);
    expect(same.correlation).toBeCloseTo(1, 10);
    expect(same.observations).toBe(60);
    expect(same.to).toBe(D);
    const opp = pairCorrelation({ symbol: 'A', bars: a }, { symbol: 'I', bars: inv }, 60);
    expect(opp.correlation as number).toBeLessThan(-0.99);
    const thin = pairCorrelation({ symbol: 'A', bars: a }, { symbol: 'B', bars: b }, 252);
    expect(isNa(thin.correlation) && thin.correlation.code).toBe('sample-too-small');
    expect(thin.observations).toBe(79);
  });
  it('drops returns that straddle a gap in either series', () => {
    const gapped = b.filter((_, i) => i !== 40);
    const r = pairCorrelation({ symbol: 'A', bars: a }, { symbol: 'B', bars: gapped }, 60);
    // 79 returns in all, minus the two that touch the missing session.
    const all = pairCorrelation({ symbol: 'A', bars: a }, { symbol: 'B', bars: gapped }, 1000);
    expect(all.observations).toBe(77);
    expect(r.correlation).toBeCloseTo(1, 10);
    expect(correlationMatrix([{ symbol: 'A', bars: a }, { symbol: 'B', bars: b }, { symbol: 'I', bars: inv }], 60).length).toBe(3);
  });
});

describe('scenarios and replay', () => {
  const book = markPositions([pos('AAA', 100), pos('BBB', 200), pos('CCC', 10), pos('WWW', 0, { kind: 'watch' })], marks({ AAA: { close: 50, date: D }, BBB: { close: 10, date: D }, CCC: { close: 100, date: D } }));
  it('applies stock and beta scaled market shocks in dollars', () => {
    const r = scenarioShock(book, { stock: { AAA: -0.1 }, market: -0.05, betas: { BBB: 1.5, CCC: 2 } });
    expect(r.rows.map((x) => [x.symbol, x.basis])).toEqual([
      ['AAA', 'stock'],
      ['BBB', 'beta x market'],
      ['CCC', 'beta x market'],
    ]);
    expect(r.rows[0]!.change).toBeCloseTo(-500, 9);
    expect(r.rows[1]!.change).toBeCloseTo(-150, 9); // 2000 x 1.5 x -5%
    expect(r.rows[2]!.change).toBeCloseTo(-100, 9); // 1000 x 2 x -5%
    expect(r.totalChange).toBeCloseTo(-750, 9);
    expect(r.label).toMatch(/Hypothetical/);
  });
  it('lists a holding it cannot shock instead of treating it as zero', () => {
    const r = scenarioShock(book, { market: -0.05, betas: { AAA: 1, BBB: na('no-coverage') } });
    expect(r.missing).toEqual(['BBB', 'CCC']);
    expect(r.coveredChange).toBe(-250);
    expect(isNa(r.totalChange)).toBe(true);
  });
  it('replays a past window with today\'s holdings as a labeled counterfactual', () => {
    const series = { AAA: closesToBars([40, 44, 50, 55, 50]), BBB: closesToBars([10, 9, 8, 9, 10]) };
    const dates = series.AAA.map((x) => x.date);
    const r = replayEvent(book, series, dates[0]!, dates[2]!);
    const row = (s: string) => r.rows.find((x) => x.symbol === s)!;
    expect(row('AAA').ret).toBeCloseTo(0.25, 12);
    expect(row('AAA').change).toBeCloseTo(1250, 9);
    expect(row('BBB').change).toBeCloseTo(-400, 9);
    expect(isNa(row('CCC').ret)).toBe(true);
    expect(r.missing).toEqual(['CCC']);
    expect(r.coveredChange).toBeCloseTo(850, 9);
    expect(isNa(r.totalChange)).toBe(true);
    expect(r.label).toMatch(/Current weight counterfactual/);
    // A window that starts before the history, or ends after it, is not covered.
    const early = replayEvent(book, series, addDays(dates[0]!, -30), dates[2]!);
    expect(isNa(early.rows[0]!.ret) && early.rows[0]!.ret.code).toBe('insufficient-history');
    const late = replayEvent(book, series, dates[0]!, addDays(D, 30));
    expect(isNa(late.rows[0]!.ret) && late.rows[0]!.ret.code).toBe('insufficient-history');
    // Appending later rows does not change a completed window.
    const longer = { ...series, AAA: [...series.AAA, { ...series.AAA[4]!, date: '2026-11-16', close: 99 }] };
    expect(replayEvent(book, longer, dates[0]!, dates[2]!).rows[0]!.change).toBeCloseTo(1250, 9);
  });
});

describe('CSV parsing', () => {
  it('reads common headers, quoted numbers and currency signs', () => {
    const csv = '﻿Ticker,Quantity,Avg Cost,Purchase Date\nnvda,"1,200",$45.50,2024-03-01\nMU,50,,\n\nBRK.B,(10),300,\n';
    const { rows, errors } = parsePositionsCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { row: 2, symbol: 'NVDA', shares: 1200, cost: 45.5, acquiredOn: '2024-03-01' },
      { row: 3, symbol: 'MU', shares: 50 },
      { row: 5, symbol: 'BRK.B', shares: -10, cost: 300 },
    ]);
  });
  it('reports errors by row and keeps the good rows', () => {
    const { rows, errors } = parsePositionsCsv('symbol,shares,cost,date\nAAA,ten,1,\n,5,1,\nBBB,5,-2,\nCCC,5,2,03/01/2024\nDDD,7,2,2024-03-01\n$$$,1,1,\n');
    expect(rows.map((r) => r.symbol)).toEqual(['DDD']);
    expect(errors.map((e) => e.row)).toEqual([2, 3, 4, 5, 7]);
    expect(errors[1]!.message).toMatch(/Missing symbol/);
    expect(parsePositionsCsv('name,amount\nx,1\n').errors[0]!.message).toMatch(/symbol column/);
    expect(parsePositionsCsv('').errors[0]!.message).toMatch(/empty/);
  });
});

describe('import reconciliation', () => {
  const resolve: SymbolResolver = (s) => {
    const u = s.toUpperCase();
    if (u === 'CCCX') return { instrumentId: 'us:infq', symbol: 'INFQ' };
    if (['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'INFQ'].includes(u)) return { instrumentId: `us:${u.toLowerCase()}`, symbol: u };
    return na('unknown-symbol', `${u} is not a recognized symbol`);
  };
  const book: PositionBook = {
    revision: 3,
    updatedAt: '2026-11-01T00:00:00Z',
    positions: [pos('AAA', 100, { cost: 40, revision: 1 }), pos('BBB', 50, { revision: 2 }), pos('CCC', 10, { revision: 3 }), pos('DDD', 5, { revision: 3 }), pos('WWW', 0, { kind: 'watch', revision: 3 })],
    archived: [],
  };
  const incoming = [
    { row: 2, symbol: 'AAA', shares: 100 }, // unchanged, cost carried forward
    { row: 3, symbol: 'BBB', shares: 75, cost: 12 }, // changed
    { row: 4, symbol: 'EEE', shares: 20 }, // added
    { row: 5, symbol: 'DDD', shares: 5 },
    { row: 6, symbol: 'DDD', shares: 7 }, // duplicate
    { row: 7, symbol: 'QQQQ', shares: 1 }, // unmapped
    { row: 8, symbol: 'CCCX', shares: -30 }, // former ticker, short
  ];
  const preview = reconcileImport(book, incoming, resolve, 'csv');

  it('previews adds, changes, removals, duplicates, unmapped rows and aliases', () => {
    expect(preview.adds.map((p) => [p.symbol, p.shares])).toEqual([['EEE', 20], ['INFQ', -30]]);
    expect(preview.changes.length).toBe(1);
    expect(preview.changes[0]!.fields).toEqual([{ field: 'shares', from: 50, to: 75 }, { field: 'cost', from: null, to: 12 }]);
    expect(preview.unchanged.map((p) => p.symbol)).toEqual(['AAA']);
    expect(preview.removals.map((p) => p.symbol)).toEqual(['CCC']); // DDD is held out, the watch row is untouched
    expect(preview.duplicates.map((d) => [d.symbol, d.rows.length])).toEqual([['DDD', 2]]);
    expect(preview.unmapped.map((u) => u.row.symbol)).toEqual(['QQQQ']);
    expect(preview.shorts.map((r) => r.symbol)).toEqual(['CCCX']);
    expect(preview.aliasMapped).toEqual([{ row: incoming[6], symbol: 'INFQ' }]);
    expect(preview.needsReview).toBe(true);
    expect(preview.summary).toBe('2 added, 1 changed, 1 removed, 1 unchanged, 1 duplicated, 1 not recognized.');
  });
  it('accepting applies clean rows, archives removals and leaves the input untouched', () => {
    const before = JSON.stringify(book);
    const res = applyReconciliation(book, preview, { accept: true, decidedAt: '2026-11-14T16:00:00Z', receiptId: 'r1' });
    expect(isNa(res)).toBe(false);
    if (isNa(res)) return;
    expect(JSON.stringify(book)).toBe(before);
    expect(res.book.revision).toBe(4);
    expect(res.book.positions.map((p) => [p.symbol, p.shares, p.revision])).toEqual([
      ['AAA', 100, 1],
      ['BBB', 75, 4],
      ['DDD', 5, 3],
      ['WWW', 0, 3],
      ['EEE', 20, 4],
      ['INFQ', -30, 4],
    ]);
    expect(res.book.positions.find((p) => p.symbol === 'AAA')!.cost).toBe(40);
    expect(res.book.archived).toEqual([{ ...book.positions[2]!, archivedAt: '2026-11-14T16:00:00Z', receiptId: 'r1' }]);
    expect(res.receipt.decision).toBe('accepted');
    expect(res.receipt.archived).toEqual(['CCC']);
    expect(res.receipt.skipped.map((s) => [s.symbol, s.row])).toEqual([['DDD', 5], ['DDD', 6], ['QQQQ', 7]]);
    expect([res.receipt.fromRevision, res.receipt.toRevision]).toEqual([3, 4]);
    // A second apply of the same preview hits the revision check.
    const again = applyReconciliation(res.book, preview, { accept: true, decidedAt: 'x', receiptId: 'r2' });
    expect(isNa(again) && again.detail).toMatch(/Revision conflict/);
  });
  it('rejecting records a receipt and changes nothing', () => {
    const res = applyReconciliation(book, preview, { accept: false, decidedAt: '2026-11-14T16:00:00Z', receiptId: 'r9' });
    expect(isNa(res)).toBe(false);
    if (isNa(res)) return;
    expect(res.book).toBe(book);
    expect(res.receipt.decision).toBe('rejected');
    expect(res.receipt.toRevision).toBe(3);
  });
  it('treats a zero quantity row as not held', () => {
    const p = reconcileImport(book, [{ row: 2, symbol: 'AAA', shares: 0 }, { row: 3, symbol: 'BBB', shares: 50 }, { row: 4, symbol: 'CCC', shares: 10 }, { row: 5, symbol: 'DDD', shares: 5 }], resolve, 'google-positions');
    expect(p.zeroQuantity.length).toBe(1);
    expect(p.removals.map((x) => x.symbol)).toEqual(['AAA']);
    expect(p.unchanged.length).toBe(3);
  });
  it('applies a manual correction with compare and swap', () => {
    const edited = applyManualEdit(book, { expectedRevision: 3, position: { instrumentId: 'us:aaa', symbol: 'AAA', shares: 120, cost: 41 }, decidedAt: 't', receiptId: 'm1' });
    expect(!isNa(edited) && edited.revision).toBe(4);
    expect(!isNa(edited) && edited.positions.find((p) => p.symbol === 'AAA')!.shares).toBe(120);
    expect(book.positions[0]!.shares).toBe(100);
    const closed = applyManualEdit(book, { expectedRevision: 3, position: { instrumentId: 'us:aaa', symbol: 'AAA', shares: 0 }, decidedAt: 't', receiptId: 'm2' });
    expect(!isNa(closed) && closed.archived.map((a) => a.symbol)).toEqual(['AAA']);
    expect(isNa(applyManualEdit(book, { expectedRevision: 2, position: { instrumentId: 'us:aaa', symbol: 'AAA', shares: 1 }, decidedAt: 't', receiptId: 'm3' }))).toBe(true);
    expect(emptyBook('t').revision).toBe(0);
  });
});

describe('week ahead', () => {
  const ev = (symbol: string, date: ISODate, time: EarningsEvent['time'] = 'amc'): EarningsEvent => ({ instrumentId: `us:${symbol.toLowerCase()}`, symbol, date, time, status: 'confirmed', source: SRC });
  const book = markPositions(
    [pos('AAA', 200), pos('BBB', 100), pos('CCC', 50), pos('DDD', 10), pos('ETF', 30), pos('WWW', 0, { kind: 'watch' }), pos('LATE', 10)],
    marks({ AAA: { close: 50, date: D }, CCC: { close: 20, date: D }, DDD: { close: 20, date: D }, ETF: { close: 100, date: D }, LATE: { close: 5, date: D } }),
  );
  const earnings = new Map<string, Maybe<EarningsEvent[]>>([
    ['us:aaa', [ev('AAA', '2026-08-19'), ev('AAA', '2026-11-18')]],
    ['us:bbb', [ev('BBB', '2026-11-20', 'bmo')]],
    ['us:ccc', na('source-failed', 'Earnings source failed')],
    ['us:etf', na('not-applicable', 'Funds do not report earnings')],
    ['us:www', [ev('WWW', '2026-11-17', 'unknown')]],
    ['us:late', [ev('LATE', '2026-11-23')]],
  ]);
  const magnitudes = new Map<string, Maybe<OptionMagnitude>>([
    ['us:aaa', { perShare: 12, expiry: '2026-11-20', quoteDate: D }],
    ['us:bbb', { perShare: 3, expiry: '2026-11-18', quoteDate: D }],
  ]);
  const w = weekAhead(book, { asOf: D, earnings, magnitudes });
  it('covers the next session through that Friday', () => {
    expect([w.from, w.through]).toEqual(['2026-11-16', '2026-11-20']);
    expect(w.rows.map((r) => r.symbol)).toEqual(['WWW', 'AAA', 'BBB']);
    expect(w.knownReports).toBe(3);
  });
  it('uses quantity x close for exposure and magnitude x shares for the hypothetical move', () => {
    const a = w.rows.find((r) => r.symbol === 'AAA')!;
    expect(a.exposure).toBe(10000);
    expect(a.hypotheticalMove).toBe(2400);
    expect(a.magnitudeExpiry).toBe('2026-11-20');
    const b = w.rows.find((r) => r.symbol === 'BBB')!;
    expect(isNa(b.exposure)).toBe(true);
    expect(isNa(b.hypotheticalMove) && b.hypotheticalMove.detail).toMatch(/before the report/);
    const watch = w.rows.find((r) => r.symbol === 'WWW')!;
    expect(isNa(watch.exposure) && watch.exposure.code).toBe('not-applicable');
    expect(watch.time).toBe('unknown');
  });
  it('never counts an unknown price or date as zero or as fully covered', () => {
    expect(w.coveredExposure).toBe(10000);
    expect(w.exposureMissing).toEqual(['BBB']);
    expect(isNa(w.totalExposure)).toBe(true);
    expect(w.unknownDates).toEqual(['CCC', 'DDD']); // failed source and no record at all. The fund is not listed.
    const clean = weekAhead(markPositions([pos('AAA', 200)], marks({ AAA: { close: 50, date: D } })), { asOf: D, earnings });
    expect(clean.totalExposure).toBe(10000);
    expect(isNa(clean.rows[0]!.hypotheticalMove)).toBe(true);
    // From a Tuesday the window runs through the same week's Friday.
    const mid = weekAhead(book, { asOf: '2026-11-17', earnings });
    expect([mid.from, mid.through]).toEqual(['2026-11-18', '2026-11-20']);
    expect(mid.rows.map((r) => r.symbol)).toEqual(['AAA', 'BBB']);
  });
});

describe('invariants and fixture smoke', () => {
  it('values are unchanged when prices scale by a factor and shares by its inverse', () => {
    const a = markPositions([pos('AAA', 100, { cost: 40 })], marks({ AAA: { close: 50, date: D } }));
    const b = markPositions([pos('AAA', 400, { cost: 10 })], marks({ AAA: { close: 12.5, date: D } }));
    expect(b.totalValue).toBe(a.totalValue);
    expect(b.coveredPnl).toBe(a.coveredPnl);
    const bars = closesToBars([10, 20, 16, 18, 15]);
    const scaled = bars.map((x) => ({ ...x, close: x.close * 3 }));
    const d1 = holdingDrawdown(bars);
    const d2 = holdingDrawdown(scaled);
    expect(!isNa(d1) && !isNa(d2) && d2.drawdown).toBeCloseTo(!isNa(d1) ? d1.drawdown : NaN, 12);
  });
  it('runs on the synthetic fixture and later rows do not change an as-of result', () => {
    const nvda = syntheticDaily(INSTRUMENTS.find((i) => i.symbol === 'NVDA')!);
    const sndk = syntheticDaily(INSTRUMENTS.find((i) => i.symbol === 'SNDK')!);
    const cut = '2026-06-30';
    const asOf = holdingDrawdown(sliceAsOf(nvda.bars, cut));
    const again = holdingDrawdown(sliceAsOf(sliceAsOf(nvda.bars, '2026-11-13'), cut));
    expect(asOf).toEqual(again);
    expect(!isNa(asOf) && asOf.drawdown <= 0).toBe(true);
    const pc = pairCorrelation({ symbol: 'NVDA', bars: nvda.bars }, { symbol: 'SNDK', bars: sndk.bars });
    expect(pc.observations).toBe(252);
    expect(typeof pc.correlation).toBe('number');
    const book = markPositions(
      [pos('NVDA', 100), pos('SNDK', 50)],
      marks({ NVDA: { close: nvda.bars[nvda.bars.length - 1]!.close, date: D }, SNDK: { close: sndk.bars[sndk.bars.length - 1]!.close, date: D } }),
    );
    expect(book.allCovered).toBe(true);
    // SNDK has no history before its basis boundary, so a 2020 replay cannot be fully covered.
    const replay = replayEvent(book, { NVDA: nvda.bars, SNDK: sndk.bars }, '2020-02-19', '2020-03-23');
    expect(replay.missing).toEqual(['SNDK']);
    expect(isNa(replay.totalChange)).toBe(true);
    expect(typeof replay.rows[0]!.change).toBe('number');
  });
});
