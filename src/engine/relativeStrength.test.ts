import { describe, expect, it } from 'vitest';
import { nextSession, sessionOnOrAfter } from './core/calendar';
import { midrankPercentile } from './core/stats';
import { isNa, type Bar, type Unavailable } from './core/types';
import { seriesFromCloses, syntheticDaily } from '../data/fixtures/synthetic';
import { INSTRUMENTS } from '../data/fixtures/universe';
import {
  ALL_WINDOWS, STATE_THRESHOLDS, buildScanner, compressionAt, compressionRatioAt, dedupeEvents, distanceAttribution, earlyLeadership,
  emergentTransitions, isNewWindowHigh, rangeGauges, rangePositionSeries, rangeStats, relativeDivergences, relativeMatrix, scannerPresets,
  scannerRow, simulateShock, sortScanner, stateFor, strengthProfile, strengthSnapshot, swingPivots, transitionEvents, trendStructure,
  windowBase, type StrengthSnapshot,
} from './relativeStrength';

const fixture = (sym: string): Bar[] => syntheticDaily(INSTRUMENTS.find((i) => i.symbol === sym)!).bars;
const scale = (bars: readonly Bar[], f: number): Bar[] => bars.map((b) => ({ ...b, open: b.open * f, high: b.high * f, low: b.low * f, close: b.close * f }));
const must = <T,>(v: T): Exclude<T, Unavailable> => {
  if (isNa(v)) throw new Error(`unexpected unavailable: ${JSON.stringify(v)}`);
  return v as Exclude<T, Unavailable>;
};

/** 60 sessions at 200, a 150 session decline to 100, 60 sessions at 100, then one close at 120. */
const recoveryCloses = (): number[] => {
  const c: number[] = [];
  for (let k = 0; k < 60; k++) c.push(200);
  for (let k = 1; k <= 150; k++) c.push(200 - (100 * k) / 150);
  for (let k = 0; k < 60; k++) c.push(100);
  c.push(120);
  return c;
};

describe('ranges', () => {
  const bars = seriesFromCloses([10, 11, 12, 11, 13, 12]);

  it('computes a five session window by hand', () => {
    const r = must(rangeStats(bars, 5, '5D'));
    expect(r.baseClose).toBe(10);
    expect(r.sessions).toBe(5);
    expect(r.ret).toBeCloseTo(0.2, 12);
    expect(r.closing.high.value).toBe(13);
    expect(r.closing.high.sessionsSince).toBe(1);
    expect(r.closing.low.value).toBe(11);
    expect(r.closing.low.index).toBe(1); // earliest of the two equal lows
    expect(r.closing.low.sessionsSince).toBe(4);
    expect(r.closing.high.gap).toBeCloseTo(12 / 13 - 1, 12);
    expect(r.width).toBeCloseTo(2 / 12, 12);
    expect(r.rangePosition).toBeCloseTo(0.5, 12);
    expect(r.newHighCount).toBe(2);
    expect(r.newHighFrequency).toBeCloseTo(0.5, 12);
    expect(r.maxDrawdown).toBeCloseTo(11 / 12 - 1, 12);
    expect(r.inside).toBe(true);
  });

  it('keeps closing and traded extremes separate', () => {
    const r = must(rangeStats(bars, 5, '5D', { basis: 'traded' }));
    expect(r.traded.high.value).toBe(13);
    expect(r.traded.low.value).toBe(10); // the low of the first row is the prior close used as its open
    expect(r.rangePosition).toBeCloseTo(2 / 3, 12);
    expect(r.closing.low.value).toBe(11);
  });

  it('returns a reason instead of a number without enough history or range', () => {
    const short = rangeStats(bars, 4, '5D');
    expect(isNa(short) && short.code).toBe('insufficient-history');
    const flat = must(rangeStats(seriesFromCloses([10, 10, 10, 10, 10, 10]), 5, '5D'));
    expect(isNa(flat.rangePosition) && flat.rangePosition.code).toBe('flat-range');
    expect(isNa(flat.percentile)).toBe(true);
  });

  it('uses midrank over earlier anchors for the percentile', () => {
    const rising = seriesFromCloses(Array.from({ length: 30 }, (_, k) => 100 + k));
    const r = must(rangeStats(rising, 29, '5D'));
    expect(r.rangePosition).toBe(1);
    expect(r.percentileN).toBe(24);
    expect(r.percentile).toBe(0.5); // every earlier position equals 1
    const nv = fixture('NVDA').slice(-400);
    const i = nv.length - 1;
    const got = must(rangeStats(nv, i, '20D'));
    const prior = rangePositionSeries(nv.slice(0, i), '20D').filter((v): v is number => v !== null);
    expect(got.percentile).toBeCloseTo(midrankPercentile(prior, got.rangePosition as number), 12);
  });

  it('uses declared calendar boundaries for month and year windows', () => {
    const cal = seriesFromCloses(Array.from({ length: 100 }, (_, k) => 50 + (k % 7)), '2023-12-01');
    const i = cal.findIndex((b) => b.date === '2024-03-28');
    const m = must(rangeStats(cal, i, '1M', { withPercentile: false }));
    expect(m.baseDate).toBe('2024-02-28');
    expect(m.startDate).toBe('2024-02-29');
    const ytd = must(rangeStats(cal, i, 'YTD', { withPercentile: false }));
    expect(ytd.baseDate).toBe('2023-12-29');
    const yr = rangeStats(cal, i, '1Y');
    expect(isNa(yr) && yr.code).toBe('insufficient-history');
    expect(isNa(windowBase(cal, i, '5Y'))).toBe(true);
  });

  it('series extremes match the single anchor computation', () => {
    const nv = fixture('NVDA').slice(-700);
    const pos = rangePositionSeries(nv, '3M');
    for (const i of [200, 345, 512, 699]) {
      const r = must(rangeStats(nv, i, '3M', { withPercentile: false }));
      expect(pos[i]).toBeCloseTo(r.rangePosition as number, 12);
    }
  });

  it('new window high excludes the anchor bar and is strict', () => {
    expect(isNewWindowHigh(seriesFromCloses([10, 10, 10, 10, 10, 11]), 5, '5D')).toBe(true);
    expect(isNewWindowHigh(seriesFromCloses([10, 10, 11, 10, 10, 11]), 5, '5D')).toBe(false); // equal highs
  });
});

describe('relative matrix', () => {
  const stock = seriesFromCloses([100, 102, 104, 103, 105, 107, 110, 108]);
  const benchAll = seriesFromCloses([50, 51, 51.5, 52, 52, 53, 53, 55]);
  const bench = benchAll.filter((_, k) => k !== 2); // the benchmark misses one session

  it('compares only aligned sessions and discloses what was dropped', () => {
    const m = must(relativeMatrix(stock, { symbol: 'BM', bars: bench }, { windows: ['5D', '1Y'], lag: 1, lineWindow: '5D' }));
    expect(m.alignedSessions).toBe(7);
    expect(m.droppedRows).toBe(1);
    expect(m.anchorLagsStock).toBe(false);
    const row = must(m.rows[0]!.row);
    expect(row.baseDate).toBe(stock[1]!.date);
    expect(row.own).toBeCloseTo(108 / 102 - 1, 12);
    expect(row.benchmark).toBeCloseTo(55 / 51 - 1, 12);
    expect(row.excessPp).toBeCloseTo(108 / 102 - 55 / 51, 12);
    expect(row.relativeWealth).toBeCloseTo(108 / 102 / (55 / 51), 12);
    // One aligned session earlier: own 110/100 - 1, benchmark 53/50 - 1.
    expect(row.excessChange).toBeCloseTo(108 / 102 - 55 / 51 - (0.1 - 0.06), 12);
    expect(row.direction).toBe('weakening');
    expect(row.ratioHigh.date).toBe(stock[6]!.date);
    expect(row.ratioHigh.sessionsSince).toBe(1);
    expect(row.ratioLow.sessionsSince).toBe(0);
    expect(isNa(m.rows[1]!.row)).toBe(true);
    expect(m.line[0]!.wealth100).toBe(100);
    expect(m.line[m.line.length - 1]!.wealth100).toBeCloseTo((100 * (108 / 102)) / (55 / 51), 10);
    expect(m.line[m.line.length - 1]!.ratio).toBeCloseTo(108 / 55, 12);
  });

  it('flags a benchmark that does not reach the stock date and never borrows a later row', () => {
    const m = must(relativeMatrix(stock, { symbol: 'BM', bars: benchAll.slice(0, 7) }, { windows: ['5D'] }));
    expect(m.anchorLagsStock).toBe(true);
    expect(m.anchorDate).toBe(stock[6]!.date);
    const none = relativeMatrix(stock, { symbol: 'BM', bars: [] });
    expect(isNa(none) && none.code).toBe('no-coverage');
  });

  it('detects the relative leading divergence', () => {
    // Stock is 5% below its 3 month closing high while the ratio makes a new 3 month high.
    const n = 80;
    const s: number[] = Array.from({ length: n }, (_, k) => (k === 40 ? 100 : 90));
    s[n - 1] = 95;
    const b = new Array<number>(n).fill(100);
    b[n - 1] = 90; // ratio 95/90 exceeds every earlier ratio, including 100/100
    const d = must(relativeDivergences(seriesFromCloses(s), { symbol: 'BM', bars: seriesFromCloses(b) }));
    const lead = must(d.relativeLeading);
    expect(lead.ratioAtNewHigh).toBe(true);
    expect(lead.priceGapToHigh).toBeCloseTo(-0.05, 12);
    expect(lead.active).toBe(true);
    expect(STATE_THRESHOLDS.relativeLeadingPriceGap).toBe(0.01);
  });

  it('pairs confirmed swing lows with the ratio at each low', () => {
    //            0    1   2   3   4   5   6   7   8   9  10
    const s = [100, 98, 95, 98, 100, 97, 93, 96, 99, 101, 102];
    const b = [100, 98, 94, 98, 100, 95, 88, 94, 99, 101, 102];
    const d = must(relativeDivergences(seriesFromCloses(s), { symbol: 'BM', bars: seriesFromCloses(b) }, { swingK: 2 }));
    const low = must(d.lowerLowRatioImproving);
    expect(low.first.eventIndex).toBe(2);
    expect(low.second.eventIndex).toBe(6);
    expect(low.priceChange).toBeCloseTo(93 / 95 - 1, 12);
    expect(low.ratioChange).toBeCloseTo(93 / 88 / (95 / 94) - 1, 12);
    expect(low.active).toBe(true);
    expect(low.confirmDate).toBe(seriesFromCloses(s)[8]!.date);
    expect(isNa(d.higherHighRatioWeaker)).toBe(true); // only one confirmed swing high
  });
});

describe('swing pivots and trend', () => {
  const closes = [1, 2, 3, 2, 1, 2, 3, 4, 3, 2, 1];
  const bars = seriesFromCloses(closes);

  it('records event and confirm dates and hides unconfirmed pivots', () => {
    const p = swingPivots(bars, 2);
    expect(p.map((x) => [x.kind, x.eventIndex, x.confirmIndex])).toEqual([['high', 2, 4], ['low', 4, 6], ['high', 7, 9]]);
    expect(p[0]!.confirmDate).toBe(bars[4]!.date);
    // On session 8 the high of session 7 is not yet confirmed.
    expect(swingPivots(bars, 2, 8).map((x) => x.eventIndex)).toEqual([2, 4]);
    expect(swingPivots(bars, 3).map((x) => [x.kind, x.eventIndex, x.confirmIndex])).toEqual([['low', 4, 7], ['high', 7, 10]]);
  });

  it('keeps the earliest of equal highs', () => {
    const p = swingPivots(seriesFromCloses([1, 2, 3, 3, 2, 1, 0]), 2);
    expect(p.filter((x) => x.kind === 'high').map((x) => x.eventIndex)).toEqual([2]);
  });

  it('reports structure from confirmed pivots only', () => {
    const t = must(trendStructure(bars, 10, { swingK: 2 }));
    expect(t.higherHighs).toBe(true);
    expect(t.higherLows).toBeNull();
    expect(isNa(t.sma200)).toBe(true);
    expect(t.aboveSma200).toBeNull();
    expect(t.upDays).toBe(5);
    expect(t.downDays).toBe(5);
  });
});

describe('state precedence', () => {
  const st = (pos1M: number | null, pos1Y: number | null, above: boolean | null, d: number | null) =>
    stateFor({ pos1M, pos1Y, aboveSma200: above, highDistanceChange3M: d }).state;

  it('follows the specification order', () => {
    expect(st(null, 0.9, true, 0)).toBe('Coverage limited');
    expect(st(0.9, null, true, 0)).toBe('Coverage limited');
    expect(st(0.72, 0.8, true, -0.2)).toBe('Established uptrend');
    expect(st(0.72, 0.8, false, 0)).toBe('Mixed trend'); // strong positions but below the 200 session average
    expect(st(0.72, 0.8, null, 0)).toBe('Mixed trend'); // average unavailable is not "above"
    expect(st(0.72, 0.6499, true, 0.2)).toBe('Emerging strength');
    expect(st(0.72, 0.65, true, 0)).toBe('Mixed trend');
    expect(st(0.35, 0.4, false, 0.2)).toBe('Persistent weakness');
    expect(st(0.35, 0.65, true, 0.2)).toBe('Trend deterioration');
    expect(st(0.35, 0.5, true, -0.06)).toBe('Weakening momentum');
    expect(st(0.5, 0.5, true, -0.0599)).toBe('Mixed trend');
    expect(st(0.5, 0.5, true, 0.06)).toBe('Early stabilization');
    expect(st(0.5, 0.5, true, null)).toBe('Mixed trend');
    expect(st(0.7199, 0.9, true, 0.07)).toBe('Early stabilization');
  });

  it('classifies a recovery far below the year high as emerging strength and early leadership', () => {
    const bars = seriesFromCloses(recoveryCloses(), '2022-01-03');
    const i = bars.length - 1;
    const p = must(strengthProfile(bars, i));
    expect(p.pos1M).toBe(1);
    expect(p.pos1Y).toBeCloseTo(0.2, 12);
    expect(p.state).toBe('Emerging strength');
    const lead = must(earlyLeadership(bars, i));
    expect(lead.newHighWindows).toEqual(['1M', '3M']);
    expect(lead.distanceToYearHigh).toBeCloseTo(-0.4, 12);
    expect(lead.active).toBe(true);
    // One session earlier nothing has confirmed.
    expect(must(earlyLeadership(bars, i - 1)).active).toBe(false);
    // Without a covered 1 year window the flag is unavailable, not false.
    expect(isNa(earlyLeadership(bars.slice(-100), 99))).toBe(true);
  });
});

describe('momentum attribution', () => {
  it('splits a change into price and rollover parts that sum exactly', () => {
    const nv = fixture('NVDA').slice(-500);
    for (const i of [300, 400, 499]) {
      for (const side of ['high', 'low'] as const) {
        const a = must(distanceAttribution(nv, i, '3M', side, 5));
        expect(a.pricePart + a.rolloverPart).toBeCloseTo(a.change, 12);
        expect(a.change).toBeCloseTo(a.nowDistance - a.oldDistance, 12);
      }
    }
  });

  it('attributes a rolling expiry with a flat price entirely to rollover', () => {
    const bars = seriesFromCloses([10, 20, 12, 12, 12, 12, 12, 12]);
    const a = must(distanceAttribution(bars, 6, '5D', 'high', 1));
    expect(a.oldLevel).toBe(20);
    expect(a.nowLevel).toBe(12);
    expect(a.oldDistance).toBeCloseTo(-0.4, 12);
    expect(a.nowDistance).toBe(0);
    expect(a.pricePart).toBe(0);
    expect(a.rolloverPart).toBeCloseTo(0.4, 12);
    expect(a.oldLevelExpired).toBe(true);
    expect(a.newLevelSet).toBe(false);
  });

  it('attributes a price move under an unchanged level entirely to price', () => {
    const bars = seriesFromCloses([9, 9, 9, 9, 9, 10, 20, 12, 12, 12, 12, 15]);
    const r = must(distanceAttribution(bars, 11, '10D', 'high', 1));
    expect(r.oldLevel).toBe(20);
    expect(r.nowLevel).toBe(20);
    expect(r.rolloverPart).toBe(0);
    expect(r.pricePart).toBeCloseTo(15 / 20 - 12 / 20, 12);
    expect(r.oldLevelExpired).toBe(false);
  });
});

describe('compression and transitions', () => {
  const bars = seriesFromCloses(recoveryCloses(), '2022-01-03');
  const i = bars.length - 1;

  it('flags a one month range at most 45 percent of the three month range', () => {
    const c = must(compressionAt(bars, i - 1));
    expect(c.width1M).toBe(0);
    expect(c.width3M).toBeGreaterThan(0);
    expect(c.compressed).toBe(true);
    expect(c.threshold).toBe(0.45);
    expect(c.elapsedSessions).toBeGreaterThan(20);
    expect(c.ratio).toBe(must(compressionRatioAt(bars, i - 1)));
    expect(c.sensitivity.map((s) => s.compressed)).toEqual([true, true, true]);
    // The jump to 120 widens the one month range to the whole three month range.
    const after = must(compressionAt(bars, i));
    expect(after.compressed).toBe(false);
    expect(after.elapsedSessions).toBe(1);
  });

  it('fires observable transitions and grades them against own history', () => {
    const flat = seriesFromCloses(new Array(bars.length).fill(100), '2022-01-03');
    const t = must(emergentTransitions(bars, { benchmark: { symbol: 'BM', bars: flat } }));
    const by = Object.fromEntries(t.map((x) => [x.id, x]));
    expect(by['fresh-3m-high']!.active).toBe(true);
    expect(by['range-position-surge']!.active).toBe(true);
    expect(by['outperformance-gained']!.active).toBe(true);
    expect(by['outperformance-lost']!.active).toBe(false);
    expect(by['relative-weakening-run']!.active).toBe(false);
    expect(by['fresh-3m-high']!.ownHistory!.hits).toBe(0); // it never fired before the anchor
    expect(by['fresh-3m-high']!.ownHistory!.n).toBeGreaterThan(50);
    // One session earlier none of them fire.
    const before = must(emergentTransitions(bars.slice(0, i), { benchmark: { symbol: 'BM', bars: flat } }));
    expect(before.every((x) => !x.active)).toBe(true);
    // Without a benchmark only the price transitions are returned.
    expect(must(emergentTransitions(bars)).map((x) => x.id)).toEqual(['range-position-surge', 'fresh-3m-high']);
  });
});

describe('scanner', () => {
  const lead = seriesFromCloses(recoveryCloses(), '2022-01-03');
  const date = lead[lead.length - 1]!.date;
  const flat = seriesFromCloses(new Array(lead.length).fill(100), '2022-01-03');
  const stale = lead.slice(0, -1);
  const short = lead.slice(-30);

  it('builds rows on one common date and excludes series without that session', () => {
    const res = must(
      buildScanner(
        [
          { instrumentId: 'a', symbol: 'LEAD', bars: lead },
          { instrumentId: 'b', symbol: 'FLAT', bars: flat },
          { instrumentId: 'c', symbol: 'STALE', bars: stale },
          { instrumentId: 'd', symbol: 'SHORT', bars: short },
        ],
        { market: { symbol: 'MKT', bars: flat }, proximity: 0.05 },
      ),
    );
    expect(res.date).toBe(date);
    expect(res.excluded.map((e) => e.symbol)).toEqual(['STALE']);
    const row = res.rows.find((r) => r.symbol === 'LEAD')!;
    expect(row.newHigh['1M']).toBe(true);
    expect(row.nearHigh['1M']).toBe(true);
    expect(row.nearHigh['1Y']).toBe(false);
    expect(row.gapToHigh['1Y']).toBeCloseTo(-0.4, 12);
    expect(row.earlyStrength).toBe(true);
    expect(row.breakoutAfterCompression).toBe(true);
    expect(row.excessMarket1M).toBeCloseTo(0.2, 12);
    expect(row.excessSector1M).toBeNull(); // no sector reference is not a zero excess
    expect(row.validation.status).toBe('unscored');
    const sh = res.rows.find((r) => r.symbol === 'SHORT')!;
    expect(sh.state).toBe('Coverage limited');
    expect(sh.gapToHigh['1Y']).toBeNull();
    expect(sh.earlyStrength).toBeNull();
    expect(scannerPresets.earlyStrength(res.rows).map((r) => r.symbol)).toEqual(['LEAD']);
    expect(scannerPresets.breakoutAfterCompression(res.rows).map((r) => r.symbol)).toContain('LEAD');
    // Unavailable values sort last in both directions.
    const asc = sortScanner(res.rows, [{ value: (r) => r.gapToHigh['1Y'], dir: 'asc' }]).map((r) => r.symbol);
    const desc = sortScanner(res.rows, [{ value: (r) => r.gapToHigh['1Y'], dir: 'desc' }]).map((r) => r.symbol);
    expect(asc).toEqual(['LEAD', 'FLAT', 'SHORT']);
    expect(desc).toEqual(['FLAT', 'LEAD', 'SHORT']);
  });

  it('flags a rising stock with a falling ratio and a stock holding up in a falling market', () => {
    const n = 40;
    const up = seriesFromCloses(Array.from({ length: n }, (_, k) => 100 + k * 0.1));
    const mktUp = seriesFromCloses(Array.from({ length: n }, (_, k) => 100 + k));
    const mktDown = seriesFromCloses(Array.from({ length: n }, (_, k) => 100 - k * 0.5));
    const d = up[n - 1]!.date;
    const a = must(scannerRow({ instrumentId: 'x', symbol: 'X', bars: up }, d, { market: { symbol: 'M', bars: mktUp } }));
    expect(a.fallingRatioRisingStock).toBe(true);
    expect(a.holdingUpInDownMarket).toBe(false);
    const b = must(scannerRow({ instrumentId: 'x', symbol: 'X', bars: up }, d, { market: { symbol: 'M', bars: mktDown } }));
    expect(b.holdingUpInDownMarket).toBe(true);
    expect(b.fallingRatioRisingStock).toBe(false);
    const none = must(scannerRow({ instrumentId: 'x', symbol: 'X', bars: up }, d));
    expect(none.fallingRatioRisingStock).toBeNull();
    const miss = scannerRow({ instrumentId: 'x', symbol: 'X', bars: up.slice(0, -1) }, d);
    expect(isNa(miss) && miss.code).toBe('missing-session');
  });
});

describe('simulations', () => {
  it('marks results hypothetical and computes the stated quantities', () => {
    const bars = seriesFromCloses([10, 11, 12, 11, 13, 12]);
    const r = must(simulateShock(bars, 5, { stockShock: 0.1, benchmarkShock: -0.05, shares: 200, windows: ['5D', '1Y'] }));
    expect(r.hypothetical).toBe(true);
    expect(r.shockedClose).toBeCloseTo(13.2, 12);
    expect(r.positionDollars).toBeCloseTo(240, 9);
    expect(r.relativeWealthFactor).toBeCloseTo(1.1 / 0.95, 12);
    expect(r.relativeEffectPp).toBeCloseTo(0.15, 12);
    const w = must(r.windows[0]!.result);
    expect(w.moveToBreakHigh).toBeCloseTo(13 / 12 - 1, 12);
    expect(w.moveToTestLow).toBeCloseTo(11 / 12 - 1, 12);
    expect(w.breaksHigh).toBe(true);
    expect(w.positionAfter).toBe(1);
    expect(w.positionNow).toBeCloseTo(0.5, 12);
    expect(isNa(r.windows[1]!.result)).toBe(true);
    expect(isNa(r.atrBands)).toBe(true);
    const down = must(simulateShock(bars, 5, { stockShock: -0.1, windows: ['5D'] }));
    expect(must(down.windows[0]!.result).breaksLow).toBe(true);
    expect(isNa(down.positionDollars)).toBe(true);
    expect(isNa(down.relativeWealthFactor)).toBe(true);
    // The inputs are untouched.
    expect(bars[5]!.close).toBe(12);
  });
});

describe('watchlist transition events', () => {
  const snap = (over: Partial<StrengthSnapshot>): StrengthSnapshot => ({
    instrumentId: 'us:aaa',
    date: '2026-11-12',
    state: 'Mixed trend',
    newHigh: { '1M': false, '3M': false, '6M': false },
    earlyLeadership: false,
    relativeLeading: null,
    ...over,
  });

  it('emits confirmed close events with a dedup key', () => {
    const prev = snap({});
    const curr = snap({ date: '2026-11-13', state: 'Emerging strength', newHigh: { '1M': true, '3M': false, '6M': false }, earlyLeadership: true });
    const ev = transitionEvents(prev, curr);
    expect(ev.map((e) => e.event)).toEqual(['state-change', 'new-1m-high', 'early-leadership']);
    expect(ev[0]!.key).toBe('us:aaa|2026-11-13|state-change|Emerging strength');
    const first = dedupeEvents(ev, new Set());
    expect(first.fresh.length).toBe(3);
    // The same date, event and state arriving again produces nothing.
    expect(dedupeEvents(transitionEvents(prev, curr), first.seen).fresh).toEqual([]);
  });

  it('stays silent for first observations, ticker switches, provisional and hypothetical inputs', () => {
    const curr = snap({ date: '2026-11-13', state: 'Emerging strength' });
    expect(transitionEvents(null, curr)).toEqual([]);
    expect(transitionEvents(snap({ instrumentId: 'us:bbb' }), curr)).toEqual([]);
    expect(transitionEvents(snap({}), { ...curr, provisional: true })).toEqual([]);
    expect(transitionEvents(snap({}), { ...curr, hypothetical: true })).toEqual([]);
    expect(transitionEvents(snap({ date: '2026-11-13' }), curr)).toEqual([]); // the date did not advance
    // An unknown earlier flag is not a "no", so no event fires from it.
    expect(transitionEvents(snap({ relativeLeading: null }), snap({ date: '2026-11-13', relativeLeading: true }))).toEqual([]);
  });

  it('builds a snapshot from completed bars', () => {
    const bars = seriesFromCloses(recoveryCloses(), '2022-01-03');
    const s = must(strengthSnapshot('us:lead', bars));
    expect(s.state).toBe('Emerging strength');
    expect(s.newHigh['1M']).toBe(true);
    expect(s.earlyLeadership).toBe(true);
    expect(s.relativeLeading).toBeNull();
    const prev = must(strengthSnapshot('us:lead', bars, bars.length - 2));
    expect(transitionEvents(prev, s).map((e) => e.event)).toContain('new-1m-high');
  });
});

describe('invariants', () => {
  const nv = fixture('NVDA').slice(-900);
  const spy = fixture('SPY').slice(-900);

  it('future rows never change an earlier as-of result', () => {
    const i = 700;
    const cut = nv.slice(0, i + 1);
    expect(strengthProfile(nv, i)).toEqual(strengthProfile(cut, i));
    expect(rangeGauges(nv, i)).toEqual(rangeGauges(cut, i));
    expect(compressionAt(nv, i)).toEqual(compressionAt(cut, i));
    const asOf = nv[i]!.date;
    expect(relativeMatrix(nv, { symbol: 'SPY', bars: spy }, { asOf })).toEqual(relativeMatrix(cut, { symbol: 'SPY', bars: spy.slice(0, i + 1) }));
    expect(emergentTransitions(nv, { asOf, benchmark: { symbol: 'SPY', bars: spy } })).toEqual(
      emergentTransitions(cut, { benchmark: { symbol: 'SPY', bars: spy.slice(0, i + 1) } }),
    );
    expect(swingPivots(nv, 3, i)).toEqual(swingPivots(cut, 3));
  });

  it('scaling every price by one factor leaves returns and states unchanged', () => {
    const f = 0.25;
    const sc = scale(nv, f);
    const i = nv.length - 1;
    const a = must(strengthProfile(nv, i));
    const b = must(strengthProfile(sc, i));
    expect(b.state).toBe(a.state);
    expect(b.pos1M as number).toBeCloseTo(a.pos1M as number, 9);
    for (const key of ALL_WINDOWS) {
      const x = rangeStats(nv, i, key);
      const y = rangeStats(sc, i, key);
      expect(isNa(x)).toBe(isNa(y));
      if (isNa(x) || isNa(y)) continue;
      expect(y.ret).toBeCloseTo(x.ret, 9);
      expect(y.width).toBeCloseTo(x.width, 9);
      expect(y.maxDrawdown).toBeCloseTo(x.maxDrawdown, 9);
      expect(y.closing.high.date).toBe(x.closing.high.date);
      expect(y.percentile as number).toBeCloseTo(x.percentile as number, 9);
    }
    const m1 = must(relativeMatrix(nv, { symbol: 'SPY', bars: spy }));
    const m2 = must(relativeMatrix(sc, { symbol: 'SPY', bars: scale(spy, 3) }));
    m1.rows.forEach((r, k) => {
      const other = m2.rows[k]!.row;
      if (isNa(r.row) || isNa(other)) return;
      expect(other.excessPp).toBeCloseTo(r.row.excessPp, 9);
      expect(other.relativeWealth).toBeCloseTo(r.row.relativeWealth, 9);
    });
  });
});

describe('fixture smoke test', () => {
  const nvda = fixture('NVDA');
  const sndk = fixture('SNDK');
  const spy = fixture('SPY');

  it('covers a long history in full', () => {
    const g = rangeGauges(nvda, nvda.length - 1, { withPercentile: false });
    expect(g.length).toBe(12);
    expect(g.every((x) => !isNa(x.stats))).toBe(true);
    const p = must(strengthProfile(nvda));
    expect(typeof p.state).toBe('string');
    const m = must(relativeMatrix(nvda, { symbol: 'SPY', bars: spy, role: 'market' }));
    expect(m.droppedRows).toBe(0);
    expect(m.rows.every((r) => !isNa(r.row))).toBe(true);
    expect(isNa(relativeDivergences(nvda, { symbol: 'SPY', bars: spy }))).toBe(false);
    expect(must(emergentTransitions(nvda, { benchmark: { symbol: 'SPY', bars: spy } })).length).toBe(5);
  });

  it('reports limited coverage for a short history instead of numbers', () => {
    const g = rangeGauges(sndk, sndk.length - 1, { withPercentile: false });
    const na5 = g.filter((x) => isNa(x.stats)).map((x) => x.key);
    expect(na5).toEqual(['2Y', '3Y', '5Y']);
    const m = must(relativeMatrix(sndk, { symbol: 'SPY', bars: spy }));
    expect(m.commonFrom).toBe('2025-02-24');
    expect(isNa(m.rows.find((r) => r.key === '5Y')!.row)).toBe(true);
    const day3 = must(strengthProfile(sndk, 3));
    expect(day3.state).toBe('Coverage limited');
    const scan = must(buildScanner([{ instrumentId: 'n', symbol: 'NVDA', bars: nvda }, { instrumentId: 's', symbol: 'SNDK', bars: sndk }], { market: { symbol: 'SPY', bars: spy } }));
    expect(scan.date).toBe('2026-11-13');
    expect(scan.rows.length).toBe(2);
  });

  it('keeps session helpers consistent with the exchange calendar', () => {
    expect(sessionOnOrAfter('2024-01-01')).toBe('2024-01-02');
    expect(nextSession('2024-01-02')).toBe('2024-01-03');
  });
});
