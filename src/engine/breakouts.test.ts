import { describe, expect, it } from 'vitest';
import { nextSession, sessionOnOrAfter } from './core/calendar';
import { isNa, type Bar, type Unavailable } from './core/types';
import { syntheticDaily } from '../data/fixtures/synthetic';
import { INSTRUMENTS } from '../data/fixtures/universe';
import {
  BREAKOUT_DEFAULTS, BREAK_HORIZONS, BREAK_WINDOWS, breakoutEpisodes, breakoutOutcomes, breakoutSignals, breakoutStudy, filterEpisodes,
  marketStress,
} from './breakouts';

type Row = number | { c: number; h?: number; l?: number; o?: number; v?: number | null };

/** Bars on consecutive sessions. A plain number is a bar with open = high = low = close. */
const mk = (rows: readonly Row[], start = '2024-01-02'): Bar[] => {
  const out: Bar[] = [];
  let d = sessionOnOrAfter(start);
  for (const r of rows) {
    const x = typeof r === 'number' ? { c: r } : r;
    const o = x.o ?? x.c;
    out.push({ date: d, open: o, high: x.h ?? Math.max(o, x.c), low: x.l ?? Math.min(o, x.c), close: x.c, volume: x.v === undefined ? 1000 : x.v });
    d = nextSession(d);
  }
  return out;
};
const fixture = (sym: string): Bar[] => syntheticDaily(INSTRUMENTS.find((i) => i.symbol === sym)!).bars;
const scale = (bars: readonly Bar[], f: number): Bar[] => bars.map((b) => ({ ...b, open: b.open * f, high: b.high * f, low: b.low * f, close: b.close * f }));
const must = <T,>(v: T): Exclude<T, Unavailable> => {
  if (isNa(v)) throw new Error(`unexpected unavailable: ${JSON.stringify(v)}`);
  return v as Exclude<T, Unavailable>;
};

describe('signals', () => {
  it('uses the prior window strictly excluding the signal bar', () => {
    const s = breakoutSignals(mk([10, 10, 10, 10, 10, 11]), '5D', 'up');
    expect(s.length).toBe(1);
    expect(s[0]!.index).toBe(5);
    expect(s[0]!.level).toBe(10); // not 11: the signal bar is outside its own reference window
    expect(s[0]!.levelIndex).toBe(0); // earliest of the equal prior highs
    expect(s[0]!.levelAge).toBe(5);
    expect(s[0]!.kind).toBe('confirmed-close');
    expect(s[0]!.closeVsLevel).toBeCloseTo(0.1, 12);
    expect(s[0]!.historyClosingExtreme).toBe(true);
    expect(s[0]!.yearExtreme).toBeNull(); // the 1 year window is not covered
    expect(s[0]!.distanceBelowYearHigh).toBeNull();
  });

  it('does not treat an equal high as a breakout, and separates touch from close', () => {
    expect(breakoutSignals(mk([10, 10, 10, 10, 10, 10]), '5D', 'up')).toEqual([]);
    const s = breakoutSignals(mk([10, 10, 10, 10, 10, { c: 10, h: 10.5 }]), '5D', 'up');
    expect(s.map((x) => x.kind)).toEqual(['intraday-failed']);
    expect(s[0]!.extreme).toBe(10.5);
    // On a traded basis the reference is the prior traded high, so the same bar is still only a touch.
    const t = breakoutSignals(mk([{ c: 10, h: 10.4 }, 10, 10, 10, 10, { c: 10.3, h: 10.5 }]), '5D', 'up', { basis: 'traded' });
    expect(t.map((x) => [x.kind, x.level])).toEqual([['intraday-failed', 10.4]]);
  });

  it('mirrors every comparison for the down side', () => {
    const s = breakoutSignals(mk([10, 10, 10, 10, 10, 9]), '5D', 'down');
    expect(s.map((x) => [x.index, x.kind, x.level])).toEqual([[5, 'confirmed-close', 10]]);
    expect(s[0]!.closeVsLevel).toBeCloseTo(-0.1, 12);
    const f = breakoutSignals(mk([10, 10, 10, 10, 10, { c: 10, l: 9.5 }]), '5D', 'down');
    expect(f.map((x) => x.kind)).toEqual(['intraday-failed']);
    expect(breakoutSignals(mk([10, 10, 10, 10, 10, 9]), '5D', 'up')).toEqual([]);
  });

  it('respects the as-of index', () => {
    const bars = mk([10, 10, 10, 10, 10, 11, 12]);
    expect(breakoutSignals(bars, '5D', 'up', { asOfIndex: 5 }).map((x) => x.index)).toEqual([5]);
    expect(breakoutSignals(bars, '5D', 'up').map((x) => x.index)).toEqual([5, 6]);
  });

  it('reports missing volume as null', () => {
    const rows: Row[] = Array.from({ length: 25 }, () => ({ c: 10, v: null }));
    rows.push({ c: 11, v: null });
    const s = breakoutSignals(mk(rows), '20D', 'up');
    expect(s[0]!.relativeVolume).toBeNull();
    const withVol: Row[] = Array.from({ length: 25 }, () => ({ c: 10, v: 100 }));
    withVol.push({ c: 11, v: 250 });
    expect(breakoutSignals(mk(withVol), '20D', 'up')[0]!.relativeVolume).toBe(2.5);
  });
});

describe('episodes and lifecycle', () => {
  it('clusters signals that are five sessions apart or closer', () => {
    //                 0   1   2   3   4   5   6     7     8   9..14          15
    const closes = [10, 10, 10, 10, 10, 11, 10.5, 10.5, 12, ...new Array(6).fill(11.5), 13];
    const eps = breakoutEpisodes(mk(closes), '5D', 'up');
    expect(eps.map((e) => e.signals.map((s) => s.index))).toEqual([[5, 8], [15]]);
    expect(eps[0]!.level).toBe(10); // the old level of the first attempt
    expect(eps[0]!.confirmIndex).toBe(5);
    expect(eps[0]!.attempts).toBe(2);
    expect(BREAKOUT_DEFAULTS.episodeGapSessions).toEqual({ value: 5, provenance: 'spec' });
    // A gap of exactly five sessions stays in the episode. Six starts a new one.
    const five = [10, 10, 10, 10, 10, 11, 10.5, 10.5, 10.5, 10.5, 12];
    expect(breakoutEpisodes(mk(five), '5D', 'up').length).toBe(1);
    const six = [10, 10, 10, 10, 10, 11, 10.5, 10.5, 10.5, 10.5, 10.5, 12];
    expect(breakoutEpisodes(mk(six), '5D', 'up').length).toBe(2);
  });

  it('keeps the first attempt, the failed attempt and the confirm close separate', () => {
    const bars = mk([10, 10, 10, 10, 10, { c: 10, h: 10.5 }, 10.6]);
    const [e] = breakoutEpisodes(bars, '5D', 'up');
    expect(e!.firstAttemptIndex).toBe(5);
    expect(e!.confirmIndex).toBe(6);
    expect(e!.failedAttempts).toBe(1);
    expect(e!.level).toBe(10);
    // As of the failed attempt nothing is confirmed.
    const [early] = breakoutEpisodes(bars, '5D', 'up', { asOfIndex: 5 });
    expect(early!.confirmIndex).toBeNull();
    expect(early!.status).toBe('unconfirmed');
    expect(early!.lifecycle).toBeNull();
  });

  it('dates the retest, hold, rebound, failure and false breakout as separate facts', () => {
    const bars = mk([10, 10, 10, 10, 10, 11, { c: 10.8, o: 11, l: 10.05 }, 11.2, 9.9]);
    const [e] = breakoutEpisodes(bars, '5D', 'up');
    const lc = e!.lifecycle!;
    expect(e!.confirmIndex).toBe(5);
    expect(lc.retestIndex).toBe(6); // low 10.05 is within 1% of the 10.00 level
    expect(lc.retestHeld).toBe(true); // the retest session closed above the level
    expect(lc.reboundIndex).toBe(7); // 11.2 is above the best close before the retest
    expect(lc.failureIndex).toBe(8); // first close back at or below 10
    expect(lc.falseBreakout).toBe(true); // three sessions after the confirm close
    expect(lc.matured).toBe(false);
    expect(e!.status).toBe('false-breakout');
    // The same episode read two sessions earlier knows nothing about the failure.
    const [before] = breakoutEpisodes(bars, '5D', 'up', { asOfIndex: 6 });
    expect(before!.lifecycle!.failureIndex).toBeNull();
    expect(before!.lifecycle!.falseBreakout).toBeNull(); // the false break window is still open
    expect(before!.status).toBe('active');
    // A tighter retest distance no longer counts 10.05 as a retest.
    const [tight] = breakoutEpisodes(bars, '5D', 'up', { retestPct: 0.0025 });
    expect(tight!.lifecycle!.retestIndex).toBe(8);
  });

  it('marks a breakout that holds through the follow window', () => {
    const closes = [10, 10, 10, 10, 10, 11, ...new Array(25).fill(11)];
    const [e] = breakoutEpisodes(mk(closes), '5D', 'up');
    expect(e!.lifecycle!.matured).toBe(true);
    expect(e!.lifecycle!.falseBreakout).toBe(false);
    expect(e!.lifecycle!.retestIndex).toBeNull();
    expect(e!.lifecycle!.retestHeld).toBeNull();
    expect(e!.status).toBe('held');
  });
});

describe('outcomes', () => {
  it('separates a touch from a close and defines adverse moves by side (up)', () => {
    const bars = mk([10, 10, 10, 10, 10, 10.1, { c: 10.15, o: 10.1, h: 10.25, l: 10.0 }, { c: 10.3, o: 10.15, l: 9.7 }, { c: 10.05, o: 10.3 }]);
    const eps = breakoutEpisodes(bars, '5D', 'up');
    expect(eps.length).toBe(1);
    const intraday = breakoutOutcomes(bars, eps, { horizons: [3], mode: 'intraday' })[0]!;
    const close = breakoutOutcomes(bars, eps, { horizons: [3], mode: 'close' })[0]!;
    const ci = intraday.cases[0]!;
    const cc = close.cases[0]!;
    expect(intraday.n).toBe(1);
    expect(ci.level).toBe(10);
    expect(ci.target).toBeCloseTo(10.2, 12);
    expect(ci.targetOffset).toBe(1); // the high of the first session reached 10.25
    expect(cc.targetOffset).toBe(2); // the first close at or above 10.20 came one session later
    expect(ci.adverseMove).toBeCloseTo(1 - 9.7 / 10.1, 12);
    expect(ci.adverseHit).toBe(true);
    expect(cc.adverseMove).toBeCloseTo(1 - 10.05 / 10.1, 12);
    expect(cc.adverseHit).toBe(false);
    expect(ci.ret).toBeCloseTo(10.05 / 10.1 - 1, 12);
    expect(ci.continued).toBe(false);
    expect(ci.closeBeyondLevel).toBe(true);
    expect(ci.closedBackInside).toBe(false);
    expect(intraday.continued).toMatchObject({ hits: 0, n: 1 });
    expect(intraday.reachedTarget).toMatchObject({ hits: 1, n: 1 });
    expect(intraday.medianSessionsToTarget).toBe(1);
    expect(intraday.sampleSufficient).toBe(false);
    expect(intraday.adverseThreshold).toBe(0.03);
  });

  it('flips direction for a breakdown', () => {
    const bars = mk([10, 10, 10, 10, 10, 9.9, { c: 9.85, o: 9.9, h: 10.2, l: 9.75 }, { c: 9.7, o: 9.85 }, { c: 9.95, o: 9.7 }]);
    const eps = breakoutEpisodes(bars, '5D', 'down');
    const o = breakoutOutcomes(bars, eps, { horizons: [3], mode: 'intraday' })[0]!;
    const c = o.cases[0]!;
    expect(o.side).toBe('down');
    expect(c.target).toBeCloseTo(9.8, 12);
    expect(c.targetOffset).toBe(1); // low 9.75
    expect(c.adverseMove).toBeCloseTo(10.2 / 9.9 - 1, 12); // the adverse move of a breakdown is upward
    expect(c.adverseHit).toBe(true);
    expect(c.favorableMove).toBeCloseTo(1 - 9.7 / 9.9, 12);
    expect(c.continued).toBe(false); // the endpoint close is above the anchor close
    expect(c.closeBeyondLevel).toBe(true); // 9.95 is still below the old low of 10
    const cm = breakoutOutcomes(bars, eps, { horizons: [3], mode: 'close' })[0]!.cases[0]!;
    expect(cm.targetOffset).toBe(2);
  });

  it('excludes a confirm close already beyond the target from the reach denominator', () => {
    const bars = mk([10, 10, 10, 10, 10, 11, 11, 11, 11]);
    const o = breakoutOutcomes(bars, breakoutEpisodes(bars, '5D', 'up'), { horizons: [3] })[0]!;
    expect(o.n).toBe(1);
    expect(o.alreadyBeyondTarget).toBe(1);
    expect(o.reachedTarget).toBeNull();
    expect(o.continued).toMatchObject({ hits: 0, n: 1 }); // a flat endpoint is not a continuation
  });

  it('counts overlap and unmatured exclusions and never requires later success', () => {
    const closes = [10, 10, 10, 10, 10, 11, ...new Array(9).fill(10.5), 12, ...new Array(14).fill(11.5)];
    const bars = mk(closes);
    const eps = breakoutEpisodes(bars, '5D', 'up');
    expect(eps.map((e) => e.confirmIndex)).toEqual([5, 15]);
    const by = Object.fromEntries(breakoutOutcomes(bars, eps, { horizons: [5, 10, 20, 60] }).map((h) => [h.horizon, h]));
    expect([by[5]!.n, by[5]!.droppedOverlap, by[5]!.notMatured]).toEqual([2, 0, 0]);
    expect([by[10]!.n, by[10]!.droppedOverlap, by[10]!.notMatured]).toEqual([1, 1, 0]);
    expect([by[20]!.n, by[20]!.droppedOverlap, by[20]!.notMatured]).toEqual([1, 1, 0]);
    expect([by[60]!.n, by[60]!.droppedOverlap, by[60]!.notMatured]).toEqual([0, 1, 1]);
    // Both episodes faded. They still count, as misses.
    expect(by[5]!.continued).toMatchObject({ hits: 0, n: 2 });
    expect(by[5]!.closedBackInside).toMatchObject({ hits: 0, n: 2 });
    // Baseline: every session with a matured five session endpoint.
    expect(by[5]!.baseline.n).toBe(bars.length - 5);
    expect(by[60]!.returns).toBeNull();
  });

  it('withholds the percentage when the sample cannot be validated', () => {
    const bars = mk([10, 10, 10, 10, 10, 11, 11.5, 12, 12.5]);
    const o = breakoutOutcomes(bars, breakoutEpisodes(bars, '5D', 'up'), { horizons: [1] })[0]!;
    expect(o.validation.status).toBe('insufficient-evidence');
    expect(isNa(o.probability) && o.probability.code).toBe('sample-too-small');
    expect(o.continued!.n).toBeGreaterThan(0); // the description stays
  });
});

describe('filters', () => {
  it('never lets missing data pass a filter', () => {
    const rows: Row[] = Array.from({ length: 25 }, () => ({ c: 10, v: null }));
    rows.push({ c: 11, v: null });
    const eps = breakoutEpisodes(mk(rows), '20D', 'up');
    const f = filterEpisodes(eps, { minRelativeVolume: 1.5 });
    expect(f.kept.length).toBe(0);
    expect(f.removedForMissingData).toBe(1);
    expect(filterEpisodes(eps, { confirmedOnly: true }).kept.length).toBe(1);
    expect(filterEpisodes(eps, { marketTrend: 'above-200' }).removedForMissingData).toBe(1);
    expect(filterEpisodes(eps, { minBelowYearHigh: 0.15 }).removedForMissingData).toBe(1);
    expect(filterEpisodes(eps, { maturedOnly: true })).toMatchObject({ removed: 1, removedForMissingData: 0 });
    expect(filterEpisodes(eps, { minLevelAge: 30 }).removed).toBe(1);
  });

  it('filters on volume, distance below the year high and market trend when they exist', () => {
    const nv = fixture('NVDA').slice(-1500);
    const spy = fixture('SPY').slice(-1500);
    const eps = breakoutEpisodes(nv, '1M', 'up', { market: spy });
    const withTrend = eps.filter((e) => e.context.marketAbove200 !== null);
    expect(withTrend.length).toBeGreaterThan(0);
    const vol = filterEpisodes(eps, { minRelativeVolume: 1.3 });
    expect(vol.kept.every((e) => e.context.relativeVolume! >= 1.3)).toBe(true);
    expect(vol.kept.length + vol.removed + vol.removedForMissingData).toBe(eps.length);
    const far = filterEpisodes(eps, { minBelowYearHigh: 0.15 });
    expect(far.kept.every((e) => e.context.distanceBelowYearHigh! <= -0.15)).toBe(true);
    const up = filterEpisodes(eps, { marketTrend: 'above-200' });
    expect(up.kept.every((e) => e.context.marketAbove200 === true)).toBe(true);
  });
});

describe('market stress', () => {
  const bench = mk([100, 101, 95, 93, 96, 101, 102, 103, 104]);
  const stock = mk([50, 50, 49, 48, 49, 51, 52, 52, 53]);

  it('aligns the stock to benchmark drawdown episodes', () => {
    const m = must(marketStress(stock, { symbol: 'BM', bars: bench }, { thresholds: [0.05, 0.1], confirmSessions: 2 }));
    const five = m.byThreshold[0]!;
    expect(five.episodes.length).toBe(1);
    const e = five.episodes[0]!;
    expect(e.peakDate).toBe(bench[1]!.date);
    expect(e.breachDate).toBe(bench[2]!.date);
    expect(e.troughDate).toBe(bench[3]!.date);
    expect(e.recoveryDate).toBe(bench[5]!.date);
    expect(e.benchmarkDrawdown).toBeCloseTo(93 / 101 - 1, 12);
    expect(e.stockReturn).toBeCloseTo(48 / 50 - 1, 12);
    expect(e.excessPp).toBeCloseTo(48 / 50 - 93 / 101, 12);
    expect(e.relativeWealth).toBeCloseTo(48 / 50 / (93 / 101), 12);
    expect(e.stockMaxDrawdown).toBeCloseTo(-0.04, 12);
    expect(e.resilient).toBe(true);
    expect(e.troughConfirmed).toBe(true);
    expect(e.troughConfirmDate).toBe(bench[5]!.date); // knowable two sessions after the trough, not on it
    expect(e.stockAfterTrough).toBeCloseTo(51 / 48 - 1, 12);
    expect(five.resilient).toMatchObject({ hits: 1, n: 1 });
    expect(m.byThreshold[1]!.episodes).toEqual([]);
    expect(m.byThreshold[1]!.resilient).toBeNull();
  });

  it('keeps an unfinished trough posterior and discloses dropped rows', () => {
    const m = must(marketStress(stock.slice(0, 5).filter((_, k) => k !== 0), { symbol: 'BM', bars: bench.slice(0, 5) }, { thresholds: [0.05], confirmSessions: 10 }));
    expect(m.droppedRows).toBe(0); // the missing first stock row is outside the common range
    expect(m.alignedSessions).toBe(4);
    const e = m.byThreshold[0]!.episodes[0]!;
    expect(e.active).toBe(true);
    expect(e.recoveryDate).toBeNull();
    expect(e.troughConfirmed).toBe(false);
    expect(e.troughConfirmDate).toBeNull();
    expect(e.stockAfterTrough).toBeNull();
    const gap = must(marketStress(stock.filter((_, k) => k !== 4), { symbol: 'BM', bars: bench }, { thresholds: [0.05] }));
    expect(gap.droppedRows).toBe(1);
    expect(gap.alignedSessions).toBe(8);
    expect(isNa(marketStress([], { symbol: 'BM', bars: bench }))).toBe(true);
  });
});

describe('invariants', () => {
  const nv = fixture('NVDA').slice(-1200);

  it('future rows never change an earlier as-of result', () => {
    const k = 900;
    const cut = nv.slice(0, k + 1);
    for (const side of ['up', 'down'] as const) {
      expect(breakoutEpisodes(nv, '20D', side, { asOfIndex: k })).toEqual(breakoutEpisodes(cut, '20D', side));
      expect(breakoutStudy(nv, '3M', side, { asOfIndex: k })).toEqual(breakoutStudy(cut, '3M', side));
    }
  });

  it('scaling every price by one factor leaves signals and outcomes unchanged', () => {
    const sc = scale(nv, 4);
    const a = must(breakoutStudy(nv, '20D', 'up'));
    const b = must(breakoutStudy(sc, '20D', 'up'));
    expect(b.signals).toBe(a.signals);
    expect(b.episodes.map((e) => [e.firstAttemptDate, e.confirmDate, e.status])).toEqual(a.episodes.map((e) => [e.firstAttemptDate, e.confirmDate, e.status]));
    a.horizons.forEach((h, i) => {
      const o = b.horizons[i]!;
      expect(o.n).toBe(h.n);
      expect(o.continued?.hits).toBe(h.continued?.hits);
      expect(o.returns!.median).toBeCloseTo(h.returns!.median, 9);
      expect(o.validation.status).toBe(h.validation.status);
    });
  });
});

describe('fixture smoke test', () => {
  const nvda = fixture('NVDA');
  const sndk = fixture('SNDK');
  const spy = fixture('SPY');

  it('runs every window and side on a long history with honest gating', () => {
    for (const w of BREAK_WINDOWS) {
      for (const side of ['up', 'down'] as const) {
        const s = must(breakoutStudy(nvda, w, side, { market: spy }));
        expect(s.horizons.map((h) => h.horizon)).toEqual([...BREAK_HORIZONS]);
        expect(s.confirmedSignals + s.intradayFailedSignals).toBe(s.signals);
        for (const h of s.horizons) {
          expect(h.n + h.notMatured + h.droppedOverlap).toBe(h.episodes);
          const v = h.validation;
          if (v.status === 'valid') {
            expect(v.brier!).toBeLessThan(v.baselineBrier!);
            expect(v.firstHalf!.brier).toBeLessThan(v.firstHalf!.baselineBrier);
            expect(v.secondHalf!.brier).toBeLessThan(v.secondHalf!.baselineBrier);
            expect(typeof h.probability).toBe('number');
          } else {
            // No validated edge: the description stays and the percentage is withheld.
            expect(isNa(h.probability)).toBe(true);
            expect(h.continued).not.toBeNull();
          }
        }
      }
    }
    const stress = must(marketStress(nvda, { symbol: 'SPY', bars: spy }));
    expect(stress.byThreshold.map((t) => t.threshold)).toEqual([0.02, 0.05, 0.1]);
    expect(stress.byThreshold[0]!.episodes.length).toBeGreaterThan(stress.byThreshold[2]!.episodes.length);
  });

  it('starts a short history only where the window is covered', () => {
    const y = must(breakoutStudy(sndk, '1Y', 'up'));
    // No one year signal can exist before a full year of history.
    expect(y.episodes.every((e) => e.firstAttemptDate > '2026-02-24')).toBe(true);
    const d = must(breakoutStudy(sndk, '20D', 'up', { market: spy }));
    expect(d.episodes.length).toBeGreaterThan(0);
    expect(d.episodes[0]!.firstAttemptIndex).toBeGreaterThanOrEqual(20);
    expect(d.episodes[0]!.context.distanceBelowYearHigh).toBeNull();
    expect(isNa(breakoutStudy([], '20D', 'up'))).toBe(true);
  });
});
