/**
 * Synthetic sentiment score for fixture mode.
 *
 * NOT the CNN Fear and Greed index and not market data. It is a deterministic 0 to 100 proxy
 * derived from the synthetic SPY series so the sentiment study can be exercised end to end:
 * zones, swing scores, extreme clusters and their outcomes.
 *
 * Every component is past only at each session:
 * - momentum: close versus its 125 session average, ranked against the trailing 252 sessions,
 * - calm: 20 session realized volatility, ranked against the trailing 252 sessions and inverted,
 * - drawdown: close versus the highest close of the trailing 252 sessions, mapped linearly so a
 *   new high scores 100 and a 12% decline scores 0.
 * The blend is stretched around 50, averaged over five sessions and clamped to 0..100.
 */
import { rollingReturnStd, sma } from '../../engine/core/indicators';
import { midrankPercentile } from '../../engine/core/stats';
import type { Bar, ISODate, SourceCapture } from '../../engine/core/types';
import { FIXTURE_NOW, FIXTURE_VERSION } from './synthetic';

export const SENTIMENT_FIXTURE_LABEL = 'Synthetic sentiment proxy. Not the CNN index.';

export interface SentimentFixture {
  points: { date: ISODate; score: number }[];
  /** Shown wherever the score appears. */
  label: string;
  benchmarkLabel: string;
  method: string;
  source: SourceCapture;
}

const RANK_WINDOW = 252;
const MIN_RANK_OBS = 60;
const SMOOTH = 5;
const clamp = (x: number): number => Math.max(0, Math.min(100, x));

/** Midrank of the value at i within the trailing window ending at i. Null below the minimum sample. */
const trailingRank = (values: readonly (number | null)[], i: number): number | null => {
  const v = values[i];
  if (v === null || v === undefined) return null;
  const ref: number[] = [];
  for (let j = Math.max(0, i - RANK_WINDOW + 1); j <= i; j++) {
    const x = values[j];
    if (x !== null && x !== undefined) ref.push(x);
  }
  if (ref.length < MIN_RANK_OBS) return null;
  return midrankPercentile(ref, v) * 100;
};

const cache = new WeakMap<readonly Bar[], SentimentFixture>();

/** Deterministic synthetic score series from the synthetic SPY bars. Same bars, same scores. */
export const syntheticSentiment = (spyBars: readonly Bar[]): SentimentFixture => {
  const hit = cache.get(spyBars);
  if (hit) return hit;
  const closes = spyBars.map((b) => b.close);
  const avg = sma(closes, 125);
  const mom = closes.map((c, i) => (avg[i] === null || avg[i] === undefined ? null : c / avg[i]! - 1));
  const vol = rollingReturnStd(closes, 20);
  const raw: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    const m = trailingRank(mom, i);
    const v = trailingRank(vol, i);
    if (m === null || v === null) continue;
    let peak = -Infinity;
    for (let j = Math.max(0, i - RANK_WINDOW + 1); j <= i; j++) if (closes[j]! > peak) peak = closes[j]!;
    const dd = clamp(100 * (1 + (closes[i]! / peak - 1) / 0.12));
    const blend = 0.45 * m + 0.3 * (100 - v) + 0.25 * dd;
    raw[i] = clamp(50 + (blend - 50) * 1.3);
  }
  const points: SentimentFixture['points'] = [];
  for (let i = SMOOTH - 1; i < closes.length; i++) {
    let s = 0;
    let ok = true;
    for (let j = i - SMOOTH + 1; j <= i; j++) {
      const x = raw[j];
      if (x === null || x === undefined) {
        ok = false;
        break;
      }
      s += x;
    }
    if (ok) points.push({ date: spyBars[i]!.date, score: Math.round((s / SMOOTH) * 10) / 10 });
  }
  const out: SentimentFixture = {
    points,
    label: SENTIMENT_FIXTURE_LABEL,
    benchmarkLabel: 'SPY, synthetic fixture closes',
    method:
      'Blend of momentum versus the 125 session average, inverted 20 session volatility rank and drawdown from the 252 session closing high, each past only, averaged over five sessions.',
    source: {
      provider: FIXTURE_VERSION,
      kind: 'synthetic-fixture',
      capturedAt: FIXTURE_NOW,
      version: `${FIXTURE_VERSION}-sentiment-1`,
      note: `${SENTIMENT_FIXTURE_LABEL} Generated from the synthetic SPY series for testing.`,
    },
  };
  cache.set(spyBars, out);
  return out;
};
