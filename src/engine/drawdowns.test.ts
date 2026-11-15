import { describe, expect, it } from 'vitest';
import { sessionsBetween } from './core/calendar';
import { sliceAsOf } from './core/series';
import { isNa, type Bar } from './core/types';
import { seriesFromCloses, syntheticDaily } from '../data/fixtures/synthetic';
import { INSTRUMENTS } from '../data/fixtures/universe';
import {
  benchmarkDrawdownTable, compareDrawdowns, currentDrawdown, currentSelloffStudy, deepestEpisodes, drawdownSeries, episodeAges,
  episodeDurationSummary, episodeIncidenceByThreshold, episodeYearIncidence, findDrawdownEpisodes, rangeFacts, DRAWDOWN_DEFAULTS, DRAWDOWN_SPEC,
} from './drawdowns';

/** One bar per exchange session in the range, close from a function of the date. */
const calendarSeries = (from: string, to: string, close: (d: string) => number): Bar[] =>
  sessionsBetween(from, to).map((date) => {
    const c = close(date);
    return { date, open: c, high: c, low: c, close: c, volume: 1000 };
  });

const scale = (bars: readonly Bar[], f: number): Bar[] => bars.map((b) => ({ ...b, open: b.open * f, high: b.high * f, low: b.low * f, close: b.close * f }));
const fixture = (sym: string) => syntheticDaily(INSTRUMENTS.find((i) => i.symbol === sym)!).bars;

describe('closing drawdown series', () => {
  const bars = seriesFromCloses([100, 110, 99, 104.5, 110, 120, 90]);
  const dd = drawdownSeries(bars);
  it('is zero at each new or equal peak and C/P - 1 below it', () => {
    expect(dd.map((p) => +p.drawdown.toFixed(10))).toEqual([0, 0, -0.1, -0.05, 0, 0, -0.25]);
    expect(dd[2]!.requiredGain).toBeCloseTo(110 / 99 - 1, 12);
    expect(dd[6]!.requiredGain).toBeCloseTo(120 / 90 - 1, 12);
  });
  it('dates the peak at the most recent close at the running high', () => {
    expect(dd[3]!.peakIndex).toBe(1);
    expect(dd[4]!.peakIndex).toBe(4);
    expect(dd[6]!.peakDate).toBe(bars[5]!.date);
  });
  it('reports an empty series as unavailable', () => {
    expect(isNa(currentDrawdown([]))).toBe(true);
  });
});

describe('drawdown episodes', () => {
  const bars = seriesFromCloses([100, 90, 80, 85, 95, 100, 105, 94.5, 94, 100]);
  const eps = findDrawdownEpisodes(bars, 0.1);
  it('creates one episode per excursion, not one per day beyond the threshold', () => {
    expect(eps.length).toBe(2);
  });
  it('treats an exact threshold decline as a breach and an equal close as recovery', () => {
    const e = eps[0]!;
    expect([e.peakIndex, e.breachIndex, e.troughIndex, e.recoveryIndex]).toEqual([0, 1, 2, 5]);
    expect(e.depth).toBeCloseTo(-0.2, 12);
    expect(e.breachDrawdown).toBeCloseTo(-0.1, 12);
    expect([e.sessionsPeakToBreach, e.sessionsPeakToTrough, e.sessionsTroughToRecovery, e.sessionsPeakToRecovery]).toEqual([1, 2, 3, 5]);
    expect(e.active).toBe(false);
    expect(e.peakAtHistoryStart).toBe(true);
  });
  it('keeps an unrecovered episode active and right-censored with separate ages', () => {
    const e = eps[1]!;
    expect([e.peakIndex, e.breachIndex, e.troughIndex, e.recoveryIndex]).toEqual([6, 7, 8, null]);
    expect(e.active).toBe(true);
    expect(e.sessionsPeakToRecovery).toBeNull();
    expect(e.sessionsObserved).toBe(3);
    expect(e.depth).toBeCloseTo(94 / 105 - 1, 12);
    const ages = episodeAges(bars, e);
    expect(!isNa(ages) && [ages.sessionsSincePeak, ages.sessionsSinceBreach, ages.sessionsSinceTrough, ages.sessionsSinceRecovery]).toEqual([3, 2, 1, null]);
  });
  it('keeps the earliest trough on ties', () => {
    const t = findDrawdownEpisodes(seriesFromCloses([100, 80, 85, 80, 100]), 0.1);
    expect(t[0]!.troughIndex).toBe(1);
  });
  it('tags year crossing and episodes under way before the display window', () => {
    const b = seriesFromCloses([100, 85, 80, 90, 100, 101], '2025-12-29');
    expect(b.map((x) => x.date)).toEqual(['2025-12-29', '2025-12-30', '2025-12-31', '2026-01-02', '2026-01-05', '2026-01-06']);
    const [e] = findDrawdownEpisodes(b, 0.1);
    expect(e!.crossesYear).toBe(true);
    expect(e!.recoveryDate).toBe('2026-01-05');
    const win = findDrawdownEpisodes(b, 0.1, { windowStart: '2026-01-02' });
    expect(win.length).toBe(1);
    expect(win[0]!.startedBeforeWindow).toBe(true);
    expect(findDrawdownEpisodes(b, 0.1, { windowStart: '2026-01-06' }).length).toBe(0);
    expect(findDrawdownEpisodes(b, 0.1)[0]!.startedBeforeWindow).toBe(false);
  });
  it('rejects a non-positive threshold', () => {
    expect(findDrawdownEpisodes(bars, 0)).toEqual([]);
  });
});

describe('episode incidence per year', () => {
  const dips = new Set(['2024-03-05', '2024-08-06', '2025-05-06', '2026-02-10']);
  const bars = calendarSeries('2023-12-29', '2026-03-31', (d) => (dips.has(d) ? 85 : 100));
  const inc = episodeYearIncidence(bars, 0.1);
  it('counts by breach year and flags incomplete years', () => {
    expect(inc.rows).toEqual([
      { year: 2023, count: 0, complete: false, partialReason: 'history-starts-inside-year' },
      { year: 2024, count: 2, complete: true, partialReason: null },
      { year: 2025, count: 1, complete: true, partialReason: null },
      { year: 2026, count: 1, complete: false, partialReason: 'current-year' },
    ]);
  });
  it('builds the typical count from completed years only', () => {
    expect(inc.typical).toEqual({ median: 1.5, mean: 1.5, years: 2 });
    expect(inc.current).toEqual({ year: 2026, count: 1, asOf: '2026-03-31', versusMedian: -0.5 });
    expect(inc.truncatedPeaks).toBe(0);
  });
  it('supports several thresholds and reports no typical count without a completed year', () => {
    const many = episodeIncidenceByThreshold(bars);
    expect(many.map((m) => m.threshold)).toEqual([...DRAWDOWN_DEFAULTS.thresholds]);
    expect(many[3]!.rows.every((r) => r.count === 0)).toBe(true); // a 15% dip never reaches 20%
    const short = episodeYearIncidence(sliceAsOf(bars, '2024-06-28'), 0.1);
    expect(isNa(short.typical)).toBe(true);
    expect(short.current && isNa(short.current.versusMedian)).toBe(true);
  });
});

describe('durations and deepest episodes', () => {
  const bars = seriesFromCloses([100, 90, 80, 85, 95, 100, 100, 89, 100, 100, 90, 85, 80, 100, 105, 94]);
  const eps = findDrawdownEpisodes(bars, 0.1);
  const sum = episodeDurationSummary(eps);
  it('uses completed episodes for median and IQR and says what it excluded', () => {
    expect(eps.length).toBe(4);
    expect([sum.completed, sum.active]).toEqual([3, 1]);
    expect(sum.toTrough).toEqual({ n: 3, median: 2, p25: 1.5, p75: 2.5, mean: 2, max: 3 });
    expect(!isNa(sum.toRecovery) && [sum.toRecovery.median, sum.toRecovery.p25, sum.toRecovery.p75]).toEqual([4, 3, 4.5]);
    expect(!isNa(sum.troughToRecovery) && sum.troughToRecovery.median).toBe(1);
    expect(sum.note).toMatch(/1 active/);
  });
  it('censors the active episode in the survival median', () => {
    expect(sum.recoverySurvivalMedian).toBe(4);
    const onlyActive = episodeDurationSummary(eps.slice(3));
    expect(isNa(onlyActive.toRecovery)).toBe(true);
    expect(isNa(onlyActive.recoverySurvivalMedian)).toBe(true);
  });
  it('orders the deepest first with the earlier episode first on ties', () => {
    expect(deepestEpisodes(eps).map((e) => e.peakIndex)).toEqual([0, 9, 6, 14]);
    expect(deepestEpisodes(eps, 2).length).toBe(2);
  });
});

describe('current selloff study', () => {
  const closes = [
    100, 95, 90, 85, 88, 100, // A: anchor index 2, then lower
    100, 89, 92, 95, 100, // B: anchor index 7, then higher
    100, 90, 91, 93, 100, // C: anchor index 12, then higher
    100, 80, 70, 75, 100, // D: anchor index 17, then lower
    100, 95, 90, // active, now 10% below the peak
  ];
  const bars = seriesFromCloses(closes);

  it('matches each earlier selloff once at its first attainment of the current depth', () => {
    const s = currentSelloffStudy(bars, { horizons: [2], minMaturedCases: 3 });
    expect(isNa(s)).toBe(false);
    if (isNa(s)) return;
    expect(s.current.drawdown).toBeCloseTo(-0.1, 12);
    expect(s.analogs.map((a) => a.anchorIndex)).toEqual([2, 7, 12, 17]);
    expect(s.active.active).toBe(true);
    expect(s.activeAnchorDate).toBe(bars[23]!.date);
    expect(s.sessionsSinceActiveAnchor).toBe(0);
    expect(s.ages.sessionsSincePeak).toBe(2);
    const a = s.analogs[0]!;
    expect(a.additionalDecline).toBeCloseTo(85 / 90 - 1, 12);
    expect([a.sessionsAnchorToTrough, a.sessionsAnchorToRecovery]).toEqual([1, 3]);
    expect(a.path.map((p) => p.offset)).toEqual([-2, -1, 0, 1, 2, 3]);
    expect(a.path.map((p) => +p.value.toFixed(4))).toEqual([1, 0.95, 0.9, 0.85, 0.88, 1]);
    expect(s.activePath.map((p) => [p.offset, +p.value.toFixed(4)])).toEqual([[-2, 1], [-1, 0.95], [0, 0.9]]);
  });

  it('reports exact counts and passes the gate only with enough matured cases', () => {
    const s = currentSelloffStudy(bars, { horizons: [2], minMaturedCases: 3 });
    if (isNa(s)) throw new Error('unexpected');
    const h = s.horizons[0]!;
    expect([h.candidates, h.overlapExcluded, h.notMatured, h.summary.n]).toEqual([4, 0, 0, 4]);
    expect([h.summary.up, h.summary.down, h.summary.flat]).toEqual([2, 2, 0]);
    expect([h.furtherDeclineClose.hits, h.furtherDeclineClose.n]).toEqual([2, 4]);
    expect(!isNa(h.furtherDeclineClose.value) && h.furtherDeclineClose.value.rate).toBe(0.5);
    expect([h.furtherDeclineIntraday.hits, h.furtherDeclineIntraday.n]).toEqual([2, 4]);
    expect(!isNa(h.additionalAdverse) && h.additionalAdverse.median).toBeCloseTo((85 / 90 - 1 + (91 / 90 - 1)) / 2, 12);
    expect(!isNa(h.higherClose.value) && h.higherClose.value.hits).toBe(2);
  });

  it('withholds the frequency below the minimum while keeping hits and n visible', () => {
    const s = currentSelloffStudy(bars, { horizons: [2] });
    if (isNa(s)) throw new Error('unexpected');
    const h = s.horizons[0]!;
    expect(s.minMaturedCases).toBe(DRAWDOWN_DEFAULTS.minMaturedCases);
    expect([h.furtherDeclineClose.hits, h.furtherDeclineClose.n]).toEqual([2, 4]);
    expect(isNa(h.furtherDeclineClose.value) && h.furtherDeclineClose.value.code).toBe('sample-too-small');
    expect(isNa(h.additionalAdverse)).toBe(true);
  });

  it('excludes overlapping anchors and unmatured horizons and counts both', () => {
    const s = currentSelloffStudy(bars, { horizons: [5, 60] });
    if (isNa(s)) throw new Error('unexpected');
    const h5 = s.horizons[0]!;
    expect([h5.overlapExcluded, h5.summary.n, h5.summary.anchorDates.length]).toEqual([2, 2, 2]);
    expect(h5.summary.outcomes.map((o) => o.anchorIndex)).toEqual([2, 12]);
    const h60 = s.horizons[1]!;
    // A 61 session spacing keeps only the first anchor, and its 60 session window has not completed.
    expect([h60.overlapExcluded, h60.notMatured, h60.summary.n]).toEqual([3, 1, 0]);
    expect(isNa(h60.furtherDeclineClose.value)).toBe(true);
  });

  it('uses the specification horizons and further-decline level by default', () => {
    const s = currentSelloffStudy(bars);
    if (isNa(s)) throw new Error('unexpected');
    expect(s.horizons.map((h) => h.horizon)).toEqual([...DRAWDOWN_SPEC.horizons]);
    expect(s.furtherDeclineLevel).toBe(0.05);
  });

  it('is not applicable at a closing high', () => {
    const s = currentSelloffStudy(seriesFromCloses([1, 2, 3]));
    expect(isNa(s) && s.code).toBe('not-applicable');
  });

  it('never uses the active episode as its own analog', () => {
    const s = currentSelloffStudy(seriesFromCloses([100, 90, 80, 85]));
    if (isNa(s)) throw new Error('unexpected');
    expect(s.analogs.length).toBe(0);
    expect(s.activeAnchorDate).not.toBe(s.asOf); // the current 15% depth was first reached two sessions ago
    expect(s.sessionsSinceActiveAnchor).toBe(1);
  });
});

describe('range facts', () => {
  const bars = seriesFromCloses([10, 12, 12, 9, 11]);
  it('needs a full rolling window', () => {
    const r = rangeFacts(bars);
    if (isNa(r)) throw new Error('unexpected');
    expect(isNa(r.tradedHigh) && r.tradedHigh.code).toBe('insufficient-history');
    expect(isNa(r.fromTradedHigh)).toBe(true);
  });
  it('separates traded, closing, history and year levels with the earliest date on ties', () => {
    const r = rangeFacts(bars, 4, 3);
    if (isNa(r)) throw new Error('unexpected');
    expect(!isNa(r.tradedHigh) && [r.tradedHigh.value, r.tradedHigh.index]).toEqual([12, 2]);
    expect(!isNa(r.closingLow) && [r.closingLow.value, r.closingLow.index]).toEqual([9, 3]);
    expect(r.fromClosingHigh).toBeCloseTo(11 / 12 - 1, 12);
    expect(r.gainToTradedHigh).toBeCloseTo(12 / 11 - 1, 12);
    expect([r.historyClosingHigh.value, r.historyClosingHigh.index]).toEqual([12, 1]);
    expect(r.gainToHistoryClosingHigh).toBeCloseTo(12 / 11 - 1, 12);
    expect(r.historyLabel).toMatch(/Not a verified all time high/);
    expect(r.yearClosingLow.value).toBe(9);
    expect(r.yearStartsInsideHistory).toBe(false); // the series starts on the first session of 2024
  });
  it('flags year extremes that cover a partial year', () => {
    const r = rangeFacts(seriesFromCloses([5, 6, 7], '2024-03-04'));
    expect(!isNa(r) && r.yearStartsInsideHistory).toBe(true);
    expect(isNa(rangeFacts([]))).toBe(true);
  });
});

describe('comparative drawdowns', () => {
  const a = seriesFromCloses([100, 90, 95, 100, 80]);
  const b: Bar[] = [0, 2, 4].map((i, k) => ({ ...a[i]!, close: [50, 45, 40][k]! }));
  it('compares on common sessions and reports dropped rows', () => {
    const c = compareDrawdowns(a, b);
    if (isNa(c)) throw new Error('unexpected');
    expect(c.dates.length).toBe(3);
    expect(c.dropped).toBe(2);
    expect(c.a.map((x) => +x.toFixed(6))).toEqual([0, -0.05, -0.2]);
    expect(c.b.map((x) => +x.toFixed(6))).toEqual([0, -0.1, -0.2]);
    expect(c.differencePp).toBeCloseTo(0, 12);
    expect(isNa(compareDrawdowns(a, []))).toBe(true);
  });
  it('builds a same-date table and reports a series that lacks the common session', () => {
    const t = benchmarkDrawdownTable([{ symbol: 'A', bars: a }, { symbol: 'B', bars: b.slice(0, 2) }, { symbol: 'E', bars: [] }], a[4]!.date);
    expect(t.asOf).toBe(a[4]!.date);
    const [ra, rb, re] = t.rows;
    expect(!isNa(ra!.point) && ra!.point.drawdown).toBeCloseTo(-0.2, 12);
    expect(ra!.sessionsSincePeak).toBe(1); // the close of 100 on the fourth session equals the running peak
    expect(isNa(rb!.point) && rb!.point.code).toBe('missing-session');
    expect(isNa(re!.point) && re!.point.code).toBe('no-coverage');
    const auto = benchmarkDrawdownTable([{ symbol: 'A', bars: a }, { symbol: 'B', bars: b.slice(0, 2) }]);
    expect(auto.asOf).toBe(a[2]!.date);
    expect(!isNa(auto.rows[0]!.point) && auto.rows[0]!.point.drawdown).toBeCloseTo(-0.05, 12);
  });
});

describe('invariants and fixture smoke', () => {
  const nvda = fixture('NVDA');
  it('appending future rows does not change earlier results', () => {
    const cut = nvda.slice(0, 3000);
    expect(drawdownSeries(nvda).slice(0, 3000)).toEqual(drawdownSeries(cut));
    const done = findDrawdownEpisodes(cut, 0.1).filter((e) => !e.active);
    const full = findDrawdownEpisodes(nvda, 0.1);
    for (const e of done) expect(full).toContainEqual(e);
    const asOf = cut[cut.length - 1]!.date;
    expect(currentSelloffStudy(sliceAsOf(nvda, asOf))).toEqual(currentSelloffStudy(cut));
  });
  it('scaling every price by one factor does not change drawdowns or episodes', () => {
    const cut = nvda.slice(0, 2500);
    const scaled = scale(cut, 3.7);
    const a = findDrawdownEpisodes(cut, 0.1);
    const b = findDrawdownEpisodes(scaled, 0.1);
    expect(b.map((e) => [e.peakDate, e.breachDate, e.troughDate, e.recoveryDate])).toEqual(a.map((e) => [e.peakDate, e.breachDate, e.troughDate, e.recoveryDate]));
    b.forEach((e, i) => expect(e.depth).toBeCloseTo(a[i]!.depth, 9));
    const da = drawdownSeries(cut);
    drawdownSeries(scaled).forEach((p, i) => expect(p.drawdown).toBeCloseTo(da[i]!.drawdown, 9));
  });
  it('runs on a long and a short fixture history', () => {
    for (const sym of ['NVDA', 'SNDK']) {
      const bars = fixture(sym);
      const eps = findDrawdownEpisodes(bars, 0.1);
      expect(eps.length).toBeGreaterThan(0);
      eps.forEach((e, i) => {
        expect(e.peakIndex).toBeLessThan(e.breachIndex);
        expect(e.breachIndex).toBeLessThanOrEqual(e.troughIndex);
        expect(e.depth).toBeLessThanOrEqual(-0.1 + 1e-9);
        if (e.active) expect(i).toBe(eps.length - 1);
        else expect(e.recoveryIndex!).toBeGreaterThan(e.troughIndex);
      });
      const inc = episodeYearIncidence(bars, 0.1);
      expect(inc.rows[inc.rows.length - 1]).toMatchObject({ year: 2026, complete: false, partialReason: 'current-year' });
      expect(inc.rows.reduce((s, r) => s + r.count, 0)).toBe(eps.length);
      const r = rangeFacts(bars);
      expect(!isNa(r) && !isNa(r.tradedHigh)).toBe(true);
      const s = currentSelloffStudy(bars);
      if (!isNa(s)) {
        expect(s.horizons.length).toBe(4);
        for (const h of s.horizons) {
          expect(h.summary.n + h.notMatured + h.overlapExcluded).toBe(h.candidates);
          expect(h.furtherDeclineClose.hits).toBeLessThanOrEqual(h.furtherDeclineClose.n);
          if (h.summary.n < s.minMaturedCases) expect(isNa(h.furtherDeclineClose.value)).toBe(true);
        }
      } else expect(s.code).toBe('not-applicable');
    }
    expect(episodeYearIncidence(nvda, 0.1).rows[0]).toMatchObject({ year: 1999, complete: false, partialReason: 'history-starts-inside-year' });
  });
});
