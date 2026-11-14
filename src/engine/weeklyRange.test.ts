import { describe, expect, it } from 'vitest';
import { addDays, sessionsBetween } from './core/calendar';
import { mulberry32, normCdf, normInv } from './core/stats';
import { isNa, na, type Bar, type ISODate, type SourceCapture } from './core/types';
import { INSTRUMENTS } from '../data/fixtures/universe';
import { syntheticDaily } from '../data/fixtures/synthetic';
import {
  WEEKLY_RANGE_SPEC,
  blendScale,
  brownianStayInside,
  buildTrainingRow,
  checkImpliedMove,
  engineBScale,
  evaluateRange,
  fitEngineB,
  fitRidge,
  forecastContext,
  freezeForecast,
  inspectStrike,
  ivScale,
  nextForecastWeek,
  normalTouch,
  realizedScale,
  refitDateFor,
  reliabilityWindows,
  ridgePredict,
  selectStrangleStrikes,
  selectTrainingRows,
  settleForecast,
  strangleExpiryPnl,
  trainingTarget,
  weekOutcome,
  weeklyRangeForecast,
  type EvaluationRow,
  type FrozenForecast,
  type ImpliedMoveInput,
  type RangeTrainingRow,
  type TrackedOptionLeg,
  type WeeklyRangeForecast,
} from './weeklyRange';

const SRC: SourceCapture = { provider: 'test', kind: 'synthetic-fixture', capturedAt: '2026-11-14T00:00:00Z', version: 't' };

const gauss = (rnd: () => number): number => {
  let u = 0;
  while (u === 0) u = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
};

/** Bars on the consecutive sessions ending at `end`, each day built from fixed log moves. */
const patternBars = (end: ISODate, n: number, start = 100, moves = { on: 0.01, up: 0.02, dn: 0.01, co: 0.005 }): Bar[] => {
  const dates = sessionsBetween(addDays(end, -Math.ceil(n * 1.6) - 10), end).slice(-n);
  const bars: Bar[] = [];
  let pc = start;
  for (const date of dates) {
    const open = pc * Math.exp(moves.on);
    const close = open * Math.exp(moves.co);
    bars.push({ date, open, high: open * Math.exp(moves.up), low: open * Math.exp(-moves.dn), close, volume: 1 });
    pc = close;
  }
  return bars;
};

const PATTERN_V = 0.01 ** 2 + 0.5 * 0.03 ** 2 - (2 * Math.log(2) - 1) * 0.005 ** 2;

const implied = (ctx: { anchorDate: ISODate; weekEnd: ISODate }, fraction = 0.04): ImpliedMoveInput => ({
  impliedMoveFraction: fraction,
  expiry: ctx.weekEnd,
  quoteDate: ctx.anchorDate,
  verified: true,
  source: SRC,
});

describe('constants', () => {
  it('k multipliers equal the inverse normal of 1 - odds / 2', () => {
    for (const { odds, k } of WEEKLY_RANGE_SPEC.touchLevels) {
      expect(k).toBeCloseTo(normInv(1 - odds / 2), 7);
      expect(normalTouch(k)).toBeCloseTo(odds, 7);
    }
    expect(WEEKLY_RANGE_SPEC.absNormalMean).toBeCloseTo(Math.sqrt(2 / Math.PI), 4);
  });
});

describe('forecast context', () => {
  it('targets the next week after a Friday close', () => {
    const bars = patternBars('2026-11-13', 30);
    const ctx = forecastContext(bars);
    expect(isNa(ctx)).toBe(false);
    if (isNa(ctx)) return;
    expect(ctx.anchorDate).toBe('2026-11-13');
    expect(ctx.weekStart).toBe('2026-11-16');
    expect(ctx.nominalFriday).toBe('2026-11-20');
    expect(ctx.sessionCount).toBe(5);
    expect(ctx.weekEnd).toBe('2026-11-20');
    expect(ctx.weekInProgress).toBe(false);
    expect(ctx.close).toBe(bars[bars.length - 1]!.close);
    expect(nextForecastWeek('2026-11-13')).toBe('2026-11-16');
  });
  it('counts a holiday week as four sessions and records the early close', () => {
    const ctx = forecastContext(patternBars('2026-11-20', 30));
    expect(isNa(ctx)).toBe(false);
    if (isNa(ctx)) return;
    expect(ctx.sessions).toEqual(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27']);
    expect(ctx.sessionCount).toBe(4);
    expect(ctx.earlyCloses).toEqual(['2026-11-27']);
  });
  it('anchors on the prior actual close when Friday is a holiday', () => {
    // Good Friday 2026-04-03 is closed. The last close of that week is Thursday.
    const ctx = forecastContext(patternBars('2026-04-02', 30));
    expect(isNa(ctx)).toBe(false);
    if (isNa(ctx)) return;
    expect(ctx.anchorDate).toBe('2026-04-02');
    expect(ctx.weekStart).toBe('2026-04-06');
    // And a week whose own Friday is closed ends on Thursday.
    const prior = forecastContext(patternBars('2026-03-27', 30));
    expect(!isNa(prior) && prior.weekEnd).toBe('2026-04-02');
    expect(!isNa(prior) && prior.sessionCount).toBe(4);
  });
  it('does not relabel a mid week close as the weekly anchor', () => {
    const bars = patternBars('2026-11-17', 30); // Tuesday
    const ctx = forecastContext(bars);
    expect(isNa(ctx)).toBe(false);
    if (isNa(ctx)) return;
    expect(ctx.anchorDate).toBe('2026-11-13');
    expect(ctx.weekStart).toBe('2026-11-16');
    expect(ctx.weekInProgress).toBe(true);
  });
  it('requires 21 consecutive valid rows and a completed prior week close', () => {
    const short = forecastContext(patternBars('2026-11-13', 20));
    expect(isNa(short) && short.code).toBe('insufficient-history');
    const bars = patternBars('2026-11-13', 30);
    const gap = bars.filter((b) => b.date !== '2026-11-04');
    const g = forecastContext(gap);
    expect(isNa(g) && g.code).toBe('missing-session');
    const notYet = forecastContext(patternBars('2026-11-12', 30), '2026-11-16');
    expect(isNa(notYet) && notYet.code).toBe('missing-session');
    const bad = bars.map((b) => (b.date === '2026-11-10' ? { ...b, high: b.low * 0.9 } : b));
    const v = forecastContext(bad);
    expect(isNa(v) && v.code).toBe('invalid-input');
  });
});

describe('realized scale', () => {
  it('matches the hand formula', () => {
    const bars = patternBars('2026-11-13', 30);
    const s = realizedScale(bars, bars.length - 1, 5);
    expect(s).toBeCloseTo(Math.sqrt(5 * PATTERN_V), 12);
    const s4 = realizedScale(bars, bars.length - 1, 4);
    expect(s4).toBeCloseTo(Math.sqrt(4 * PATTERN_V), 12);
  });
  it('is unavailable for a flat series', () => {
    const flat = patternBars('2026-11-13', 30, 100, { on: 0, up: 0, dn: 0, co: 0 });
    const s = realizedScale(flat, flat.length - 1, 5);
    expect(isNa(s) && s.code).toBe('flat-range');
  });
});

describe('engine A', () => {
  const bars = patternBars('2026-11-13', 30);
  const ctx = forecastContext(bars);
  if (isNa(ctx)) throw new Error('context');
  const f = weeklyRangeForecast({ bars, impliedMove: implied(ctx) });

  it('blends realized and option scale and builds closed form levels', () => {
    expect(isNa(f)).toBe(false);
    if (isNa(f)) return;
    const sReal = Math.sqrt(5 * PATTERN_V);
    const sOpt = 0.04 / 0.7979;
    const S = (sReal + sOpt) / 2;
    expect(f.engine).toBe('A');
    expect(f.scale).toBeCloseTo(S, 12);
    expect(f.sOpt).toBeCloseTo(sOpt, 12);
    expect(f.expectedHigh).toBeCloseTo(ctx.close * Math.exp(0.7979 * S), 9);
    expect(f.expectedLow).toBeCloseTo(ctx.close * Math.exp(-0.7979 * S), 9);
    expect(f.expectedMoveDown).toBeLessThan(0);
    const l20 = f.levels.find((l) => l.odds === 0.2)!;
    expect(l20.upper).toBeCloseTo(ctx.close * Math.exp(1.28155157 * S), 9);
    expect(l20.lower).toBeCloseTo(ctx.close * Math.exp(-1.28155157 * S), 9);
    expect(l20.upper * l20.lower).toBeCloseTo(ctx.close ** 2, 6); // symmetric in log price
    expect(f.inputs.impliedMove?.dte).toBe(7);
  });
  it('inspects a strike: touch, finish above and finish below', () => {
    if (isNa(f)) return;
    const at = inspectStrike(f, f.close);
    expect(!isNa(at) && at.touch).toBe(1);
    expect(!isNa(at) && at.finishAbove).toBeCloseTo(0.5, 12);
    const l20 = f.levels.find((l) => l.odds === 0.2)!;
    const up = inspectStrike(f, l20.upper);
    expect(isNa(up)).toBe(false);
    if (isNa(up)) return;
    expect(up.side).toBe('above');
    expect(up.touch).toBeCloseTo(0.2, 6);
    expect(up.finishAbove).toBeCloseTo(0.1, 6);
    expect(up.finishBelow).toBeCloseTo(0.9, 6);
    expect(up.pctFromClose).toBeCloseTo(l20.upperPct, 12);
    const dn = inspectStrike(f, l20.lower);
    expect(!isNa(dn) && dn.touch).toBeCloseTo(0.2, 6);
    expect(!isNa(dn) && dn.finishBelow).toBeCloseTo(0.1, 6);
    expect(isNa(inspectStrike(f, -1))).toBe(true);
  });
  it('names the inside range model and keeps it distinct from one sided touches', () => {
    if (isNa(f)) return;
    expect(f.inside10.model).toMatch(/Brownian/);
    expect(f.inside10.exclusions).toMatch(/jumps/);
    expect(f.inside10.probability).toBeGreaterThan(0.8);
    expect(f.inside10.probability).toBeLessThan(0.81);
  });
  it('refuses an option input that is unverified, stale, off week or outside the DTE range', () => {
    const base = implied(ctx);
    const reason = (i: ImpliedMoveInput | null, c = ctx) => {
      const r = checkImpliedMove(c, i);
      return isNa(r) ? r.code : 'ok';
    };
    expect(reason(null)).toBe('no-coverage');
    expect(reason({ ...base, verified: false })).toBe('not-validated');
    expect(reason({ ...base, quoteDate: '2026-11-10' })).toBe('stale-source'); // a Tuesday quote is not a Friday quote
    expect(reason({ ...base, expiry: '2026-11-18' })).toBe('invalid-input');
    expect(reason({ ...base, expiry: '2026-11-27' })).toBe('invalid-input');
    expect(reason({ ...base, impliedMoveFraction: 0 })).toBe('invalid-input');
    expect(reason(base, { ...ctx, anchorDate: '2026-11-11' })).toBe('stale-source');
    expect(reason({ ...base, quoteDate: '2026-11-11' }, { ...ctx, anchorDate: '2026-11-11' })).toBe('invalid-input'); // 9 days
    expect(reason(base)).toBe('ok');
  });
  it('is unavailable with no option and no IV, and says why for both engines', () => {
    const r = weeklyRangeForecast({ bars });
    expect(isNa(r)).toBe(true);
    if (isNa(r)) {
      expect(r.detail).toMatch(/Engine A/);
      expect(r.detail).toMatch(/Engine B/);
    }
  });
});

describe('two barrier Brownian probability', () => {
  const bruteImage = (up: number, down: number, sigma: number): number => {
    const L = up + down;
    let s = 0;
    for (let k = -400; k <= 400; k++) {
      const sh = 2 * k * L;
      s += normCdf((up - sh) / sigma) - normCdf((-down - sh) / sigma) - normCdf((-up - sh) / sigma) + normCdf((-down - 2 * up - sh) / sigma);
    }
    return s;
  };
  it('agrees with a brute force reflection sum in both regimes', () => {
    for (const [u, d, s] of [[1, 1, 0.5], [1, 1, 0.59], [1, 1, 0.61], [1, 1, 1], [0.5, 0.5, 1], [0.3, 0.9, 0.7], [2, 0.4, 0.3], [1.6449, 1.6449, 1]] as const) {
      expect(brownianStayInside(u, d, s)).toBeCloseTo(bruteImage(u, d, s), 9);
    }
  });
  it('reduces to the one sided reflection result when one barrier is far away', () => {
    expect(brownianStayInside(1, 60, 1)).toBeCloseTo(1 - 2 * (1 - normCdf(1)), 9);
    expect(Number.isNaN(brownianStayInside(0, 1, 1))).toBe(true);
  });
  it('a correctly specified scale gives touch and inside frequencies near nominal in simulation', () => {
    const rnd = mulberry32(42);
    const S = 0.05;
    const steps = 400;
    const paths = 4000;
    const sd = S / Math.sqrt(steps);
    const hitsUp = WEEKLY_RANGE_SPEC.touchLevels.map(() => 0);
    let inside = 0;
    const k10 = WEEKLY_RANGE_SPEC.touchLevels[2].k * S;
    for (let p = 0; p < paths; p++) {
      let x = 0;
      let mx = 0;
      let mn = 0;
      for (let i = 0; i < steps; i++) {
        x += sd * gauss(rnd);
        if (x > mx) mx = x;
        if (x < mn) mn = x;
      }
      WEEKLY_RANGE_SPEC.touchLevels.forEach(({ k }, j) => {
        if (mx >= k * S) hitsUp[j]!++;
      });
      if (mx < k10 && -mn < k10) inside++;
    }
    WEEKLY_RANGE_SPEC.touchLevels.forEach(({ odds }, j) => {
      // Discrete steps touch slightly less often than the continuous model.
      expect(hitsUp[j]! / paths).toBeGreaterThan(odds - 0.045);
      expect(hitsUp[j]! / paths).toBeLessThan(odds + 0.02);
    });
    expect(inside / paths).toBeCloseTo(brownianStayInside(k10, k10, S), 1);
  });
});

describe('ridge', () => {
  it('matches a hand solved one feature system', () => {
    // x = [-1, 0, 1], population std sqrt(2/3). y = [1, 2, 6], mean 3.
    // Standardized z'z = 3 and z'(y - 3) x z(1) = 7.5, so the prediction at x = 1 is 3 + 7.5 / (3 + 5).
    const fit = fitRidge([[-1], [0], [1]], [1, 2, 6], 5);
    expect(isNa(fit)).toBe(false);
    if (isNa(fit)) return;
    expect(fit.intercept).toBe(3);
    expect(fit.stds[0]).toBeCloseTo(Math.sqrt(2 / 3), 12);
    expect(ridgePredict(fit, [1])).toBeCloseTo(3.9375, 12);
    expect(ridgePredict(fit, [0])).toBeCloseTo(3, 12);
    const ols = fitRidge([[-1], [0], [1]], [1, 2, 6], 0);
    expect(!isNa(ols) && ridgePredict(ols, [1])).toBeCloseTo(5.5, 12);
  });
  it('recovers an exact linear relation without penalty and ignores a constant feature', () => {
    const X = [[1, 2, 7], [2, 1, 7], [3, 5, 7], [4, 3, 7], [5, 8, 7]];
    const y = X.map(([a, b]) => 2 + 3 * a! - b!);
    const fit = fitRidge(X, y, 0);
    expect(isNa(fit)).toBe(false);
    if (isNa(fit)) return;
    expect(ridgePredict(fit, [10, 4, 7])).toBeCloseTo(2 + 30 - 4, 9);
    expect(fit.coef[2]).toBe(0);
    const shrunk = fitRidge(X, y, 5);
    expect(!isNa(shrunk) && Math.abs(shrunk.coef[0]!)).toBeLessThan(Math.abs(fit.coef[0]!));
    expect(isNa(fitRidge([], []))).toBe(true);
  });
});

/** Synthetic pooled stock weeks from a known scale rule, on Fridays ending before `lastFriday`. */
const trainingPool = (tickers: string[], weeks: number, lastWeekEnd: ISODate, seed = 7): RangeTrainingRow[] => {
  const rnd = mulberry32(seed);
  const rows: RangeTrainingRow[] = [];
  for (const ticker of tickers) {
    for (let w = 0; w < weeks; w++) {
      const weekEnd = addDays(lastWeekEnd, -7 * w);
      const sReal = 0.02 + 0.06 * rnd();
      const sIv = 0.02 + 0.06 * rnd();
      const earningsWeek = rnd() < 0.1;
      const trueS = (0.5 * sReal + 0.5 * sIv) * (earningsWeek ? 1.4 : 1);
      // Random walk in 60 steps for a realistic paired high, low and close.
      let x = 0;
      let mx = 0;
      let mn = 0;
      for (let i = 0; i < 60; i++) {
        x += (trueS / Math.sqrt(60)) * gauss(rnd);
        mx = Math.max(mx, x);
        mn = Math.min(mn, x);
      }
      rows.push({ ticker, forecastDate: addDays(weekEnd, -7), weekEnd, sReal, sIv, earningsWeek, up: mx, down: -mn, closeChange: x });
    }
  }
  return rows;
};

describe('engine B', () => {
  it('computes the IV scale, target and refit schedule', () => {
    expect(ivScale(0.5, 5)).toBeCloseTo(0.5 * Math.sqrt(5 / 252), 12);
    expect(trainingTarget({ up: 0.04, down: 0.02 })).toBeCloseTo(Math.log(0.03), 12);
    expect(trainingTarget({ up: 0.00005, down: 0.00005 })).toBeCloseTo(Math.log(0.0001), 12);
    expect(blendScale(0.04, 0.06)).toBeCloseTo(0.05, 12);
    expect(refitDateFor('2024-12-27')).toBe('2024-12-27');
    expect(refitDateFor('2025-01-17')).toBe('2024-12-27');
    expect(refitDateFor('2025-01-23')).toBe('2025-01-24'); // Thursday forecast buckets by its Friday
    expect(refitDateFor('2026-11-13')).toBe('2026-10-30');
  });
  it('enforces the strict forecast date embargo', () => {
    // 2026-10-30 is a refit Friday. A training week ending that same Friday must be rejected.
    const row = (weekEnd: ISODate): RangeTrainingRow => ({ ticker: 'AAA', forecastDate: addDays(weekEnd, -7), weekEnd, sReal: 0.04, sIv: 0.05, earningsWeek: false, up: 0.03, down: 0.02, closeChange: 0.01 });
    const rows = [row('2026-10-16'), row('2026-10-23'), row('2026-10-30')];
    const strict = selectTrainingRows(rows, '2026-10-30');
    expect(strict.cutoff).toBe('2026-10-23');
    expect(strict.rows.map((r) => r.weekEnd)).toEqual(['2026-10-16', '2026-10-23']);
    expect(strict.excludedByEmbargo).toBe(1);
    // The original evaluation's cutoff (target week end minus seven) admits the forecast Friday row.
    const repro = selectTrainingRows(rows, '2026-10-30', 'reproduction-week-end-minus-seven', '2026-11-06');
    expect(repro.cutoff).toBe('2026-10-30');
    expect(repro.rows.length).toBe(3);
    // Between refits the cutoff does not advance.
    expect(selectTrainingRows(rows, '2026-11-13').cutoff).toBe('2026-10-23');
    const invalid = selectTrainingRows([{ ...row('2026-10-16'), sIv: 0 }], '2026-10-30');
    expect(invalid.excludedInvalid).toBe(1);
  });
  it('needs 100 eligible earlier stock weeks and three tickers', () => {
    const small = fitEngineB(trainingPool(['A', 'B', 'C'], 30, '2026-10-23'), '2026-11-13');
    expect(isNa(small) && small.code).toBe('sample-too-small');
    const two = fitEngineB(trainingPool(['A', 'B'], 80, '2026-10-23'), '2026-11-13');
    expect(isNa(two) && two.code).toBe('sample-too-small');
    expect(isNa(two) && two.detail).toMatch(/tickers/);
  });
  const pool = trainingPool(['A', 'B', 'C', 'D'], 90, '2026-10-23');
  it('fits a scale model and empirical tails', () => {
    const model = fitEngineB(pool, '2026-11-13');
    expect(isNa(model)).toBe(false);
    if (isNa(model)) return;
    expect(model.weeks).toBe(360);
    expect(model.tickers).toEqual(['A', 'B', 'C', 'D']);
    expect(model.tails.pairs.length).toBe(360);
    const s = engineBScale(model, 0.05, 0.05, false);
    expect(s).toBeGreaterThan(0.03);
    expect(s).toBeLessThan(0.07);
    expect(engineBScale(model, 0.05, 0.05, true)).toBeGreaterThan(s);
    expect(engineBScale(model, 0.07, 0.07, false)).toBeGreaterThan(s);
  });
  it('training rows after the cutoff never change the model', () => {
    const later = trainingPool(['A', 'B', 'C', 'D'], 3, '2026-11-13', 99);
    const a = fitEngineB(pool, '2026-11-13');
    const b = fitEngineB([...pool, ...later], '2026-11-13');
    expect(isNa(a) || isNa(b)).toBe(false);
    if (isNa(a) || isNa(b)) return;
    expect(b.ridge.coef).toEqual(a.ridge.coef);
    expect(b.excludedByEmbargo).toBe(12);
  });
  it('is used only as the fallback, with dated IV and known earnings status', () => {
    const bars = patternBars('2026-11-13', 30);
    const iv30 = { iv30: 0.45, quoteDate: '2026-11-13', source: SRC };
    const f = weeklyRangeForecast({ bars, iv30, earningsWeek: false, training: pool });
    expect(isNa(f)).toBe(false);
    if (isNa(f)) return;
    expect(f.engine).toBe('B');
    expect(f.tailModel).toBe('empirical-training');
    expect(f.engineAReason?.code).toBe('no-coverage');
    expect(f.inputs.training?.cutoff).toBe('2026-10-23');
    const ups = f.levels.map((l) => l.upper);
    expect([...ups].sort((x, y) => x - y)).toEqual(ups); // 50% level is nearest, 5% farthest
    const l20 = f.levels.find((l) => l.odds === 0.2)!;
    const up = inspectStrike(f, l20.upper);
    expect(!isNa(up) && Math.abs(up.touch - 0.2)).toBeLessThan(0.02);
    expect(!isNa(up) && up.n).toBe(360);
    const dn = inspectStrike(f, l20.lower);
    expect(!isNa(dn) && Math.abs(dn.touch - 0.2)).toBeLessThan(0.02);
    expect(f.inside10.probability).toBeGreaterThan(0.7);
    expect(f.inside10.probability).toBeLessThan(0.92);
    expect(f.inside10.n).toBe(360);
    // Engine A wins when a verified same week option input exists.
    const ctx = forecastContext(bars);
    if (isNa(ctx)) return;
    const a = weeklyRangeForecast({ bars, iv30, earningsWeek: false, training: pool, impliedMove: implied(ctx) });
    expect(!isNa(a) && a.engine).toBe('A');
    // Unknown earnings coverage, stale IV and a thin pool each withhold Engine B.
    expect(isNa(weeklyRangeForecast({ bars, iv30, earningsWeek: na('no-coverage', 'No earnings source'), training: pool }))).toBe(true);
    expect(isNa(weeklyRangeForecast({ bars, iv30: { ...iv30, quoteDate: '2026-11-10' }, earningsWeek: false, training: pool }))).toBe(true);
    const thin = weeklyRangeForecast({ bars, iv30, earningsWeek: false, training: pool.slice(0, 50) });
    expect(isNa(thin) && thin.code).toBe('sample-too-small');
  });
  it('builds a training row only from a completed week and a quote dated on the anchor', () => {
    const bars = patternBars('2026-11-20', 40);
    const iv = { iv30: 0.4, quoteDate: '2026-11-13', source: SRC };
    const row = buildTrainingRow('AAA', bars, '2026-11-16', iv, false);
    expect(isNa(row)).toBe(false);
    if (isNa(row)) return;
    expect(row.forecastDate).toBe('2026-11-13');
    expect(row.weekEnd).toBe('2026-11-20');
    expect(row.sIv).toBeCloseTo(0.4 * Math.sqrt(5 / 252), 12);
    expect(row.up).toBeGreaterThan(0);
    const pending = buildTrainingRow('AAA', bars.slice(0, -2), '2026-11-16', iv, false);
    expect(isNa(pending) && pending.code).toBe('not-matured');
    const stale = buildTrainingRow('AAA', bars, '2026-11-16', { ...iv, quoteDate: '2026-11-17' }, false);
    expect(isNa(stale) && stale.code).toBe('stale-source');
  });
});

describe('frozen forecasts and settlement', () => {
  const history = patternBars('2026-11-13', 30);
  const ctx = forecastContext(history);
  if (isNa(ctx)) throw new Error('context');
  const f = weeklyRangeForecast({ bars: history, impliedMove: implied(ctx) }) as WeeklyRangeForecast;
  const meta = { instrumentId: 'us:aaa', symbol: 'AAA', basis: 'split-adjusted' as const, capturedAt: '2026-11-13T21:30:00Z', priceSource: SRC };
  const frozen = freezeForecast([], f, meta);
  if (isNa(frozen)) throw new Error('freeze');
  const rec: FrozenForecast = frozen.record;
  const C = ctx.close;
  const week = (rows: [ISODate, number, number, number][]): Bar[] => [
    ...history,
    ...rows.map(([date, high, low, close]) => ({ date, open: close, high, low, close, volume: 1 })),
  ];

  it('stores one immutable record per instrument and forecast date', () => {
    expect(rec.id).toBe('us:aaa:2026-11-13');
    expect(rec.expectedSessions.length).toBe(5);
    expect(Object.isFrozen(rec)).toBe(true);
    expect(Object.isFrozen(rec.levels[0])).toBe(true);
    expect(() => {
      (rec as { close: number }).close = 1;
    }).toThrow();
    const again = freezeForecast(frozen.archive, f, { ...meta, capturedAt: '2026-11-14T10:00:00Z' });
    expect(isNa(again) && again.code).toBe('invalid-input');
    expect(frozen.archive.length).toBe(1);
  });
  it('is pending until every expected session is present', () => {
    const s = settleForecast(rec, { bars: week([['2026-11-16', C * 1.01, C * 0.99, C], ['2026-11-17', C * 1.01, C * 0.99, C]]), basis: 'split-adjusted' });
    expect(isNa(s)).toBe(false);
    if (isNa(s)) return;
    expect(s.status).toBe('pending');
    expect(s.missingSessions).toEqual(['2026-11-18', '2026-11-19', '2026-11-20']);
    expect(s.high).toBeUndefined();
  });
  it('settles on the full week high, low and close', () => {
    const l20 = rec.levels.find((l) => l.odds === 0.2)!;
    const l10 = rec.levels.find((l) => l.odds === 0.1)!;
    const hi = (l20.upper + l10.upper) / 2; // through the 20% level, short of the 10% level
    const bars = week([
      ['2026-11-16', C * 1.005, C * 0.995, C],
      ['2026-11-17', hi, C * 0.999, C * 1.01],
      ['2026-11-18', C * 1.01, C * 0.99, C],
      ['2026-11-19', C * 1.002, C * 0.98, C * 0.99],
      ['2026-11-20', C * 1.0, C * 0.985, C * 0.99],
    ]);
    const s = settleForecast(rec, { bars, basis: 'split-adjusted' });
    expect(isNa(s)).toBe(false);
    if (isNa(s)) return;
    expect(s.status).toBe('settled');
    expect(s.high).toBeCloseTo(hi, 9);
    expect(s.low).toBeCloseTo(C * 0.98, 9);
    expect(s.weekClose).toBeCloseTo(C * 0.99, 9);
    expect(s.up).toBeCloseTo(Math.log(hi / C), 12);
    expect(s.levels!.find((l) => l.odds === 0.2)!.upperTouched).toBe(true);
    expect(s.levels!.find((l) => l.odds === 0.1)!.upperTouched).toBe(false);
    expect(s.levels!.find((l) => l.odds === 0.5)!.closedAboveUpper).toBe(false);
    expect(s.inside10).toBe(true);
    // weekOutcome is the same computation.
    const out = weekOutcome(bars, { sessions: [...rec.expectedSessions], close: C });
    expect(!isNa(out) && out.high).toBeCloseTo(hi, 9);
  });
  it('does not settle across an unproven basis change', () => {
    const full = week([
      ['2026-11-16', C, C, C], ['2026-11-17', C, C, C], ['2026-11-18', C, C, C], ['2026-11-19', C, C, C], ['2026-11-20', C * 1.2, C, C * 1.2],
    ]);
    const other = settleForecast(rec, { bars: full, basis: 'total-return' });
    expect(isNa(other) && other.code).toBe('basis-mismatch');
    const halved = full.map((b) => ({ ...b, open: b.open / 2, high: b.high / 2, low: b.low / 2, close: b.close / 2 }));
    const split = settleForecast(rec, { bars: halved, basis: 'split-adjusted' });
    expect(isNa(split) && split.code).toBe('basis-mismatch');
    const proven = settleForecast(rec, { bars: halved, basis: 'split-adjusted' }, { provenSplitFactor: 2 });
    expect(isNa(proven)).toBe(false);
    if (isNa(proven)) return;
    expect(proven.status).toBe('settled');
    expect(proven.up).toBeCloseTo(Math.log(1.2), 9);
    expect(proven.levels!.find((l) => l.odds === 0.05)!.upperTouched).toBe(true);
  });
});

describe('evaluation', () => {
  it('scores Brier at symmetric log levels with separate touch and close denominators', () => {
    const row: EvaluationRow = { ticker: 'A', forecastDate: '2026-11-06', scale: 0.05, up: 0.06, down: 0.01, closeChange: 0.04 };
    const ev = evaluateRange([row]);
    const d3 = ev.byLevel[0]!;
    const L = Math.log(1.03);
    const pt = 2 * (1 - normCdf(L / 0.05));
    const pc = 1 - normCdf(L / 0.05);
    expect(d3.logLevel).toBeCloseTo(L, 12);
    expect(d3.touch.n).toBe(2);
    expect(d3.touch.brier).toBeCloseTo(((pt - 1) ** 2 + pt ** 2) / 2, 12); // up touched, down did not
    expect(d3.close.brier).toBeCloseTo(((pc - 1) ** 2 + pc ** 2) / 2, 12);
    expect(d3.observedTouch?.hits).toBe(1);
    expect(ev.touch.n).toBe(8);
    expect(ev.close.n).toBe(8);
    expect(ev.weeks).toBe(1);
  });
  it('uses C / (1 + d) for the lower level, not C (1 - d)', () => {
    // A low of C / 1.05 is a decline of 4.76%. It touches the 5% level under the symmetric log rule.
    const row: EvaluationRow = { ticker: 'A', forecastDate: '2026-11-06', scale: 0.05, up: 0, down: Math.log(1.05) + 1e-12, closeChange: 0 };
    const d5 = evaluateRange([row]).byLevel.find((l) => l.d === 0.05)!;
    expect(d5.observedTouch?.hits).toBe(1);
    const shy: EvaluationRow = { ...row, down: Math.log(1.05) - 1e-9 };
    expect(evaluateRange([shy]).byLevel.find((l) => l.d === 0.05)!.observedTouch?.hits).toBe(0);
  });
  const simulated = (weeks: number, tickers: string[], S: number, seed: number): EvaluationRow[] => {
    const rnd = mulberry32(seed);
    const rows: EvaluationRow[] = [];
    for (let w = 0; w < weeks; w++) {
      for (const ticker of tickers) {
        let x = 0;
        let mx = 0;
        let mn = 0;
        for (let i = 0; i < 300; i++) {
          x += (S / Math.sqrt(300)) * gauss(rnd);
          mx = Math.max(mx, x);
          mn = Math.min(mn, x);
        }
        rows.push({ ticker, forecastDate: addDays('2026-11-06', -7 * w), scale: S, up: mx, down: -mn, closeChange: x });
      }
    }
    return rows;
  };
  it('a correct scale scores better than a misspecified one and hits nominal frequencies', () => {
    const rows = simulated(60, ['A', 'B', 'C', 'D', 'E'], 0.05, 11);
    const good = evaluateRange(rows);
    const wide = evaluateRange(rows.map((r) => ({ ...r, scale: 0.1 })));
    const tight = evaluateRange(rows.map((r) => ({ ...r, scale: 0.025 })));
    expect(good.touch.brier).toBeLessThan(wide.touch.brier);
    expect(good.touch.brier).toBeLessThan(tight.touch.brier);
    expect(good.close.brier).toBeLessThan(wide.close.brier);
    for (const n of good.nominal) {
      expect(n.observed!.n).toBe(600); // two one sided outcomes per stock week
      expect(Math.abs(n.observed!.rate - n.odds)).toBeLessThan(0.06);
    }
    // The interval is based on stock weeks, so it is wider than one from 600 independent outcomes.
    const n20 = good.nominal.find((n) => n.odds === 0.2)!.observed!;
    expect(n20.hi - n20.lo).toBeGreaterThan(0.07);
    expect(good.tickers).toBe(5);
    expect(good.notes.join(' ')).toMatch(/two one sided/);
  });
  it('reports 26 and 52 week reliability windows with their actual coverage', () => {
    const rows = simulated(60, ['A', 'B'], 0.05, 3);
    const [w26, w52] = reliabilityWindows(rows);
    expect(w26!.weeksCounted).toBe(26);
    expect(w26!.complete).toBe(true);
    expect(w26!.evaluation.weeks).toBe(52);
    expect(w26!.evaluation.from).toBe(addDays('2026-11-06', -7 * 25));
    expect(w52!.weeksCounted).toBe(52);
    const short = reliabilityWindows(simulated(30, ['A'], 0.05, 4));
    expect(short[1]!.weeksCounted).toBe(30);
    expect(short[1]!.complete).toBe(false);
    expect(evaluateRange([]).touch.n).toBe(0);
  });
});

describe('far out of the money premium tracker', () => {
  const leg = (kind: 'call' | 'put', strike: number, bid: number): TrackedOptionLeg => ({ contractId: `${kind}${strike}`, underlying: 'AAA', kind, strike, expiry: '2026-11-20', multiplier: 100, bid, bidVerified: true });
  const settle = (close: number) => ({ underlying: 'AAA', date: '2026-11-20', close, basisVerified: true });
  it('computes the hypothetical expiry P and L for one standard pair', () => {
    const inside = strangleExpiryPnl(leg('call', 110, 0.35), leg('put', 90, 0.4), settle(101));
    expect(!isNa(inside) && inside.pnl).toBeCloseTo(75, 9);
    expect(!isNa(inside) && inside.uncoveredRisk).toBe(true);
    const above = strangleExpiryPnl(leg('call', 110, 0.35), leg('put', 90, 0.4), settle(112.5));
    expect(!isNa(above) && above.pnl).toBeCloseTo(100 * (0.75 - 2.5), 9);
    const below = strangleExpiryPnl(leg('call', 110, 0.35), leg('put', 90, 0.4), settle(85));
    expect(!isNa(below) && below.pnl).toBeCloseTo(100 * (0.75 - 5), 9);
  });
  it('never invents a premium or settles on an unsupported basis', () => {
    const call = leg('call', 110, 0.35);
    const put = leg('put', 90, 0.4);
    const code = (r: ReturnType<typeof strangleExpiryPnl>) => (isNa(r) ? r.code : 'ok');
    expect(code(strangleExpiryPnl({ ...call, bid: na('no-coverage') }, put, settle(100)))).toBe('no-coverage');
    expect(code(strangleExpiryPnl({ ...call, bidVerified: false }, put, settle(100)))).toBe('not-validated');
    expect(code(strangleExpiryPnl({ ...call, multiplier: 10 }, put, settle(100)))).toBe('not-applicable');
    expect(code(strangleExpiryPnl(call, { ...put, expiry: '2026-11-27' }, settle(100)))).toBe('invalid-input');
    expect(code(strangleExpiryPnl(call, put, { ...settle(100), date: '2026-11-19' }))).toBe('not-matured');
    expect(code(strangleExpiryPnl(call, put, { ...settle(100), basisVerified: false }))).toBe('basis-mismatch');
    expect(code(strangleExpiryPnl(call, put, { ...settle(100), close: na('missing-session') }))).toBe('missing-session');
    expect(code(strangleExpiryPnl(call, put, { ...settle(100), underlying: 'BBB' }))).toBe('invalid-input');
  });
  it('selects real listed strikes at or beyond the range', () => {
    const listing = [105, 107.5, 110, 112.5].flatMap((strike) => [
      { contractId: `c${strike}`, kind: 'call' as const, strike, expiry: '2026-11-20', multiplier: 100 },
    ]).concat([95, 92.5, 90, 87.5].map((strike) => ({ contractId: `p${strike}`, kind: 'put' as const, strike, expiry: '2026-11-20', multiplier: 100 })) as never);
    const pick = selectStrangleStrikes(listing, { upper: 108.2, lower: 91.1, expiry: '2026-11-20' });
    expect(!isNa(pick) && pick.call.strike).toBe(110);
    expect(!isNa(pick) && pick.put.strike).toBe(90);
    expect(isNa(selectStrangleStrikes(listing, { upper: 120, lower: 91, expiry: '2026-11-20' }))).toBe(true);
    expect(isNa(selectStrangleStrikes(listing, { upper: 108, lower: 91, expiry: '2026-11-27' }))).toBe(true);
  });
});

describe('invariants and fixture smoke', () => {
  it('scaling every price by one factor does not change the scale or percent levels', () => {
    const bars = patternBars('2026-11-13', 30);
    const scaled = bars.map((b) => ({ ...b, open: b.open * 4, high: b.high * 4, low: b.low * 4, close: b.close * 4 }));
    const ctx = forecastContext(bars);
    if (isNa(ctx)) throw new Error('context');
    const a = weeklyRangeForecast({ bars, impliedMove: implied(ctx) });
    const b = weeklyRangeForecast({ bars: scaled, impliedMove: implied(ctx) });
    expect(isNa(a) || isNa(b)).toBe(false);
    if (isNa(a) || isNa(b)) return;
    expect(b.scale).toBeCloseTo(a.scale, 12);
    expect(b.levels.map((l) => l.upperPct)).toEqual(a.levels.map((l) => expect.closeTo(l.upperPct, 12)));
    expect(b.expectedHigh).toBeCloseTo(a.expectedHigh * 4, 8);
  });
  it('appending later rows does not change a forecast for a fixed week', () => {
    const later = patternBars('2026-11-27', 40);
    const cut = later.filter((b) => b.date <= '2026-11-13');
    const ctx = forecastContext(cut);
    if (isNa(ctx)) throw new Error('context');
    const a = weeklyRangeForecast({ bars: cut, forecastWeek: '2026-11-16', impliedMove: implied(ctx) });
    const b = weeklyRangeForecast({ bars: later, forecastWeek: '2026-11-16', impliedMove: implied(ctx) });
    expect(isNa(a) || isNa(b)).toBe(false);
    if (isNa(a) || isNa(b)) return;
    expect(b.scale).toBe(a.scale);
    expect(b.levels).toEqual(a.levels);
    expect(b.context.weekInProgress).toBe(true);
  });
  it('runs on the synthetic fixture for a long and a short history', () => {
    for (const sym of ['NVDA', 'SNDK']) {
      const s = syntheticDaily(INSTRUMENTS.find((i) => i.symbol === sym)!);
      const ctx = forecastContext(s.bars);
      expect(isNa(ctx)).toBe(false);
      if (isNa(ctx)) continue;
      expect(ctx.anchorDate).toBe('2026-11-13');
      const sReal = realizedScale(s.bars, ctx.anchorIndex, ctx.sessionCount);
      expect(!isNa(sReal) && sReal > 0 && sReal < 1).toBe(true);
      // No option capture exists for the fixture, so no forecast is produced.
      expect(isNa(weeklyRangeForecast({ bars: s.bars }))).toBe(true);
      // With an explicitly hypothetical test input the engine runs end to end.
      const f = weeklyRangeForecast({ bars: s.bars, impliedMove: implied(ctx, 0.06) });
      expect(!isNa(f) && f.levels.length).toBe(4);
      expect(!isNa(f) && f.expectedHigh > f.close && f.expectedLow < f.close).toBe(true);
    }
  });
});
