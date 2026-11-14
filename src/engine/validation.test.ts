import { describe, expect, it } from 'vitest';
import { mulberry32 } from './core/stats';
import { seriesFromCloses } from '../data/fixtures/synthetic';
import {
  applyCalibrator, assertNoLookAhead, bandOf, binaryUpLabels, calibrationBins, evaluateChronological, fitCalibrator, fitLogistic, gateModel,
  hierarchicalShrink, labelUsableAt, logit, makeEarlierBaseline, perturbFuture, predictLogistic, scaleBars, shrinkWeight, sigmoid, smoothedRate,
  type ChronoConfig, type Label, type PredictorFactory,
} from './validation';

const gauss = (r: () => number): number => {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
};

describe('shrinkage', () => {
  it('weights and smoothed rates follow the closed forms', () => {
    expect(shrinkWeight(10, 20)).toBeCloseTo(1 / 3, 12);
    expect(shrinkWeight(9, 20, 10)).toBe(0);
    expect(shrinkWeight(0, 20)).toBe(0);
    expect(smoothedRate(6, 10, 0.5, 4)).toBeCloseTo(8 / 14, 12);
    expect(smoothedRate(0, 0, 0.42, 0)).toBe(0.42);
  });
  it('stock shrinks to group and group shrinks to global', () => {
    const e = hierarchicalShrink({ stock: { hits: 8, n: 10 }, group: { hits: 30, n: 60 }, baseline: 0.5, priorMass: 20, minDirect: 10 });
    expect(e.rate).toBeCloseTo(0.6, 12);
    expect(e.weights.stock).toBeCloseTo(1 / 3, 12);
    expect(e.weights.group).toBeCloseTo(0.5, 12);
    expect(e.weights.global).toBeCloseTo(1 / 6, 12);
    expect(e.origin).toBe('stock');
    // Nine own cases have zero direct weight. The group carries the estimate.
    const g = hierarchicalShrink({ stock: { hits: 9, n: 9 }, group: { hits: 45, n: 60 }, baseline: 0.5, priorMass: 20, minDirect: 10 });
    expect(g.weights.stock).toBe(0);
    expect(g.rate).toBeCloseTo(0.75 * 0.75 + 0.25 * 0.5, 12);
    expect(g.origin).toBe('group');
    // A pool moves the global anchor: (70 + 20 x 0.5) / 120.
    const p = hierarchicalShrink({ stock: { hits: 0, n: 0 }, group: null, pool: { hits: 70, n: 100 }, baseline: 0.5, priorMass: 20, minDirect: 10 });
    expect(p.rate).toBeCloseTo(80 / 120, 12);
    expect(p.origin).toBe('pool');
    // Nothing direct anywhere returns the baseline and says so.
    const none = hierarchicalShrink({ stock: { hits: 3, n: 4 }, group: { hits: 1, n: 2 }, baseline: 0.55, priorMass: 20, minDirect: 10 });
    expect(none.direct).toBe(false);
    expect(none.rate).toBe(0.55);
    expect(none.origin).toBe('baseline');
  });
});

describe('logistic regression and calibration', () => {
  const sample = (n: number, seed: number, b0: number, b1: number) => {
    const r = mulberry32(seed);
    const X: number[][] = [];
    const y: (0 | 1)[] = [];
    for (let i = 0; i < n; i++) {
      const x = gauss(r);
      X.push([x]);
      y.push(r() < sigmoid(b0 + b1 * x) ? 1 : 0);
    }
    return { X, y };
  };
  it('recovers planted coefficients and is deterministic', () => {
    const { X, y } = sample(6000, 11, 0.3, 1.5);
    const fit = fitLogistic(X, y, { l2: 1e-6, fitIntercept: true })!;
    expect(fit.weights[0]!).toBeGreaterThan(1.35);
    expect(fit.weights[0]!).toBeLessThan(1.65);
    expect(fit.intercept).toBeGreaterThan(0.2);
    expect(fit.intercept).toBeLessThan(0.4);
    expect(fitLogistic(X, y, { l2: 1e-6, fitIntercept: true })).toEqual(fit);
    // A known offset replaces the intercept.
    const off = fitLogistic(X, y, { l2: 1e-6, offset: X.map(() => 0.3) })!;
    expect(off.intercept).toBe(0);
    expect(off.weights[0]!).toBeGreaterThan(1.35);
    expect(off.weights[0]!).toBeLessThan(1.65);
    expect(predictLogistic(off, [0], 0.3)).toBeCloseTo(sigmoid(0.3), 12);
  });
  it('the penalty shrinks weights toward zero and bounds separable data', () => {
    const { X, y } = sample(400, 5, 0, 1.5);
    const loose = fitLogistic(X, y, { l2: 0.001 })!;
    const tight = fitLogistic(X, y, { l2: 200 })!;
    expect(Math.abs(tight.weights[0]!)).toBeLessThan(Math.abs(loose.weights[0]!) / 2);
    const sep = fitLogistic([[-1], [-2], [1], [2]], [0, 0, 1, 1], { l2: 0.5 })!;
    expect(Number.isFinite(sep.weights[0]!)).toBe(true);
    expect(sep.weights[0]!).toBeGreaterThan(0);
    expect(fitLogistic([], [], { l2: 1 })).toBeNull();
    expect(fitLogistic([[1, 2], [1]], [0, 1], { l2: 1 })).toBeNull();
  });
  it('a calibrator needs both classes, enough rows and a positive slope', () => {
    const r = mulberry32(3);
    const z: number[] = [];
    const y: (0 | 1)[] = [];
    for (let i = 0; i < 300; i++) {
      const v = gauss(r) * 1.5;
      z.push(v * 0.5); // under confident raw log odds
      y.push(r() < sigmoid(v) ? 1 : 0);
    }
    const c = fitCalibrator(z, y)!;
    expect(c.slope).toBeGreaterThan(1.3);
    expect(applyCalibrator(c, 2)).toBeGreaterThan(sigmoid(2));
    expect(fitCalibrator(z.map((v) => -v), y)).toBeNull(); // inverted relation, slope not positive
    expect(fitCalibrator(z.slice(0, 10), y.slice(0, 10))).toBeNull(); // too few rows
    expect(fitCalibrator(z, y.map(() => 1 as const))).toBeNull(); // single class
  });
  it('logit and sigmoid invert and clamp', () => {
    expect(sigmoid(logit(0.37))).toBeCloseTo(0.37, 12);
    expect(Number.isFinite(logit(0))).toBe(true);
    expect(Number.isFinite(logit(1))).toBe(true);
  });
});

describe('labels, baseline and embargo', () => {
  it('a flat close is not a higher close and an unmatured horizon is null', () => {
    expect(binaryUpLabels([10, 10, 11, 9, 9], 1)).toEqual([0, 1, 0, 0, null]);
    expect(binaryUpLabels([10, 10, 11, 9, 9], 2)).toEqual([1, 0, 0, null, null]);
  });
  it('the earlier baseline uses only labels with j + horizon + embargo < t', () => {
    const labels: Label[] = [1, 1, 0, 1, 0, 0, 1, 1, null, null];
    const base = makeEarlierBaseline(labels, 2, 3);
    expect(base(5)).toBeNull(); // j < 0
    expect(base(6)).toEqual({ rate: 1, hits: 1, n: 1 }); // j = 0 only
    expect(base(8)).toEqual({ rate: 2 / 3, hits: 2, n: 3 }); // j = 0, 1, 2
    expect(labelUsableAt(0, 6, 2, 3)).toBe(true);
    expect(labelUsableAt(1, 6, 2, 3)).toBe(false); // 1 + 2 + 3 = 6 is not strictly before 6
  });
});

const dates = (n: number): string[] => seriesFromCloses(new Array(n).fill(1), '2015-01-02').map((b) => b.date);
const cfg: ChronoConfig = { burnIn: 40, blockSize: 20, spacing: 4, horizon: 2, embargo: 3, minForecastsPerBlock: 5, minBlocks: 3 };

describe('chronological block evaluation', () => {
  const n = 127;
  const d = dates(n);
  const labels: Label[] = Array.from({ length: n }, (_, i) => (i + 2 < n ? ((Math.floor(i / 4) % 2 === 0 ? 1 : 0) as 0 | 1) : null));

  it('scores complete blocks on the fixed grid against the earlier baseline on identical rows', () => {
    const seen: number[] = [];
    const oracle: PredictorFactory = (ctx) => {
      seen.push(ctx.blockStart);
      expect(ctx.labelUsableForBlock(ctx.blockStart - 6)).toBe(true);
      expect(ctx.labelUsableForBlock(ctx.blockStart - 5)).toBe(false);
      return { ready: true, predict: (t) => (labels[t] === 1 ? 0.9 : 0.1) };
    };
    const r = evaluateChronological({ dates: d, labels, config: cfg, makePredictor: oracle });
    expect(seen).toEqual([40, 60, 80, 100]); // 120 + 20 > 127, so the partial tail is not a block
    expect(r.trailingSessions).toBe(7);
    expect(r.blocks.map((b) => b.forecasts)).toEqual([5, 5, 5, 5]);
    expect(r.forecasts.every((f) => f.index % 4 === 0 && f.index >= 40)).toBe(true);
    expect(r.brier).toBeCloseTo(0.01, 12);
    expect(r.blocks.every((b) => b.ready && b.beatsBaseline)).toBe(true);
    expect(r.directionalHits?.hits).toBe(20);
    // Baseline Brier is computed on the same 20 rows.
    const manual = r.forecasts.reduce((s, f) => s + (f.baseline - f.y) ** 2, 0) / r.forecasts.length;
    expect(r.baselineBrier).toBeCloseTo(manual, 12);
    expect(r.blocks[0]!.startDate).toBe(d[40]);
    expect(r.blocks[0]!.endDate).toBe(d[59]);
  });

  it('a constant one half scores 0.25 and a block below the minimum is not ready', () => {
    const half = evaluateChronological({ dates: d, labels, config: cfg, makePredictor: () => ({ ready: true, predict: () => 0.5 }) });
    expect(half.brier).toBeCloseTo(0.25, 12);
    const sparse = evaluateChronological({ dates: d, labels, config: cfg, makePredictor: () => ({ ready: true, predict: (t) => (t % 8 === 0 ? 0.5 : null) }) });
    expect(sparse.blocks.every((b) => !b.ready && b.forecasts < 5 && b.skipped > 0)).toBe(true);
    const unfitted = evaluateChronological({ dates: d, labels, config: cfg, makePredictor: () => ({ ready: false, reason: 'No calibrator', predict: () => 0.5 }) });
    expect(unfitted.n).toBe(0);
    expect(unfitted.blocks[0]!.reason).toBe('No calibrator');
  });

  it('calibration bands are fixed tenths with exact counts', () => {
    expect(bandOf(0.9)).toBe(9);
    expect(bandOf(1)).toBe(9);
    expect(bandOf(0.0999)).toBe(0);
    const bins = calibrationBins([{ p: 0.91, y: 1 }, { p: 0.95, y: 1 }, { p: 0.99, y: 0 }, { p: 0.12, y: 0 }]);
    expect(bins[9]).toMatchObject({ n: 3, hits: 2 });
    expect(bins[9]!.meanPrediction).toBeCloseTo(0.95, 12);
    expect(bins[1]).toMatchObject({ n: 1, hits: 0 });
    expect(bins[5]!.observed).toBeNull();
  });

  describe('gate', () => {
    const oracle = evaluateChronological({ dates: d, labels, config: cfg, makePredictor: () => ({ ready: true, predict: (t) => (labels[t] === 1 ? 0.9 : 0.1) }) });
    it('passes a model that beats the baseline in every block with calibration support', () => {
      expect(gateModel({ result: oracle, minBlocks: 3, issuedProbability: 0.9, minBandSupport: 8 })).toEqual({ status: 'valid', reasons: [] });
    });
    it('data problems come first', () => {
      expect(gateModel({ data: { status: 'stale', reason: 'Check overdue' }, result: oracle, minBlocks: 3 })).toEqual({ status: 'stale', reasons: ['Check overdue'] });
      expect(gateModel({ data: { status: 'unavailable' }, result: oracle, minBlocks: 3 }).status).toBe('unavailable');
    });
    it('too few blocks, an unready block or a failed support check is insufficient evidence', () => {
      expect(gateModel({ result: oracle, minBlocks: 5 }).status).toBe('insufficient-evidence');
      expect(gateModel({ result: null, minBlocks: 3 }).status).toBe('insufficient-evidence');
      const sparse = evaluateChronological({ dates: d, labels, config: cfg, makePredictor: (c) => ({ ready: true, predict: (t) => (c.block === 2 && t % 8 === 0 ? null : labels[t] === 1 ? 0.9 : 0.1) }) });
      const g = gateModel({ result: sparse, minBlocks: 3 });
      expect(g.status).toBe('insufficient-evidence');
      expect(g.reasons[0]).toMatch(/Only \d spaced forecasts/);
      expect(gateModel({ result: oracle, minBlocks: 3, checks: [{ ok: false, status: 'insufficient-evidence', reason: 'Only 1 usable input' }] })).toEqual({ status: 'insufficient-evidence', reasons: ['Only 1 usable input'] });
      expect(gateModel({ result: oracle, minBlocks: 3, issuedProbability: 0.9, minBandSupport: 50 }).status).toBe('insufficient-evidence');
    });
    it('a block that does not strictly beat the baseline is not reliable', () => {
      // Equal to the baseline is not strictly better.
      const base = makeEarlierBaseline(labels, cfg.horizon, cfg.embargo);
      const same = evaluateChronological({ dates: d, labels, config: cfg, makePredictor: () => ({ ready: true, predict: (t) => base(t)!.rate }) });
      expect(same.blocks.every((b) => b.ready && !b.beatsBaseline)).toBe(true);
      expect(gateModel({ result: same, minBlocks: 3 }).status).toBe('not-reliable');
      // One bad block is enough.
      const oneBad = evaluateChronological({ dates: d, labels, config: cfg, makePredictor: (c) => ({ ready: true, predict: (t) => (c.block === 1 ? (labels[t] === 1 ? 0.1 : 0.9) : labels[t] === 1 ? 0.9 : 0.1) }) });
      const g = gateModel({ result: oneBad, minBlocks: 3 });
      expect(g.status).toBe('not-reliable');
      expect(g.reasons).toHaveLength(1);
    });
    it('an issued probability outside its band interval is not reliable', () => {
      // Predictions of 0.6 that always come true: the 60% band observes 10 of 10, interval above 0.6.
      const over = evaluateChronological({ dates: d, labels, config: cfg, makePredictor: () => ({ ready: true, predict: (t) => (labels[t] === 1 ? 0.6 : 0.05) }) });
      expect(over.blocks.every((b) => b.beatsBaseline)).toBe(true);
      expect(gateModel({ result: over, minBlocks: 3, issuedProbability: 0.6, minBandSupport: 5 }).status).toBe('not-reliable');
    });
  });
});

describe('metamorphic utilities', () => {
  const bars = seriesFromCloses([10, 11, 9, 12, 8, 13, 7, 14]);
  it('scaleBars multiplies prices only', () => {
    const s = scaleBars(bars, 4);
    expect(s[3]!.close).toBe(48);
    expect(s[3]!.volume).toBe(bars[3]!.volume);
    expect(s[3]!.date).toBe(bars[3]!.date);
  });
  it('perturbFuture leaves rows through the cut untouched', () => {
    const p = perturbFuture(bars, 3);
    expect(p.slice(0, 4)).toEqual(bars.slice(0, 4));
    expect(p[5]!.close).not.toBe(bars[5]!.close);
  });
  it('assertNoLookAhead accepts past only code and rejects a full series statistic', () => {
    const runningMax = (b: readonly { close: number }[]) => b.map((_, i) => Math.max(...b.slice(0, i + 1).map((x) => x.close)));
    const globalMax = (b: readonly { close: number }[]) => b.map(() => Math.max(...b.map((x) => x.close)));
    const project = (r: number[], cut: number) => r.slice(0, cut + 1);
    expect(() => assertNoLookAhead(runningMax, project, bars, 4)).not.toThrow();
    expect(() => assertNoLookAhead(globalMax, project, bars, 4)).toThrow(/Look ahead/);
  });
});
