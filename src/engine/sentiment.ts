/**
 * Fear and Greed study: a sourced 0 to 100 sentiment score overlaid on a declared benchmark.
 *
 * Definitions:
 * - Zones use thresholds 25, 45, 55, 75. Inclusivity convention (proposed, the provider's own
 *   convention was not verified): a boundary value belongs to the less extreme zone.
 *     score < 25          Extreme fear
 *     25 <= score < 45    Fear
 *     45 <= score <= 55   Neutral
 *     55 < score <= 75    Greed
 *     score > 75          Extreme greed
 * - Overlay rows exist only on dates present in both the score series and the benchmark series.
 * - A swing high is a close followed by a decline of at least the reversal threshold (default 5%)
 *   measured on closes. A swing low mirrors it. The turning date is the extreme close. The
 *   confirmation date is the first later close that completes the reversal. A swing is known only
 *   from its confirmation date. The latest unconfirmed extreme is reported separately as pending.
 * - The score on a swing is the same session score. A more extreme score nearby is reported as a
 *   labeled alternative with its own date. It never replaces the same session field.
 * - An extreme cluster is anchored at the first session a score enters the extreme zone after a
 *   known non extreme prior session. Later consecutive extreme days belong to the same cluster.
 * - Cluster outcomes enter at the next session (open by default) and end at the last completed
 *   close on or before the entry date plus 1, 3, 6 or 12 calendar months.
 */
import { nextSession, sessionOnOrBefore } from './core/calendar';
import { indexOfDate, minusMonths } from './core/series';
import { distribution, wilson, yearClusterEffectiveN } from './core/stats';
import { na, type Bar, type Distribution, type ISODate, type Maybe, type Proportion } from './core/types';

export type Zone = 'extreme-fear' | 'fear' | 'neutral' | 'greed' | 'extreme-greed';

export const SENTIMENT_DEFAULTS = {
  thresholds: [25, 45, 55, 75] as const,
  /** Boundary convention. See the header. */
  boundary: 'boundary-belongs-to-less-extreme-zone' as const,
  thresholdsProvenance: 'spec' as const,
  boundaryProvenance: 'proposed' as const,
  /** Minimum close to close reversal that confirms a swing. */
  minReversal: 0.05,
  minReversalProvenance: 'spec' as const,
  /** Sessions on each side of a swing searched for a more extreme alternative score. */
  nearbySessions: 5,
  nearbyProvenance: 'proposed' as const,
  horizonsMonths: [1, 3, 6, 12] as const,
  horizonsProvenance: 'spec' as const,
};

export const zoneOf = (score: number): Zone => {
  if (score < 25) return 'extreme-fear';
  if (score < 45) return 'fear';
  if (score <= 55) return 'neutral';
  if (score <= 75) return 'greed';
  return 'extreme-greed';
};

export interface ZoneLegendItem {
  zone: Zone;
  label: string;
  /** Plain statement of the interval, including which ends are inside. */
  range: string;
  min: number;
  max: number;
}

export const ZONE_LEGEND: readonly ZoneLegendItem[] = [
  { zone: 'extreme-fear', label: 'Extreme fear', range: 'Below 25', min: 0, max: 25 },
  { zone: 'fear', label: 'Fear', range: '25 up to, not including, 45', min: 25, max: 45 },
  { zone: 'neutral', label: 'Neutral', range: '45 through 55', min: 45, max: 55 },
  { zone: 'greed', label: 'Greed', range: 'Above 55 through 75', min: 55, max: 75 },
  { zone: 'extreme-greed', label: 'Extreme greed', range: 'Above 75', min: 75, max: 100 },
];

export const zoneLabel = (z: Zone): string => ZONE_LEGEND.find((l) => l.zone === z)!.label;

export interface ScorePoint {
  date: ISODate;
  score: number;
}

export interface OverlayRow {
  date: ISODate;
  score: number;
  zone: Zone;
  close: number;
  /** Index of this date in the benchmark bars. */
  barIndex: number;
  /** True when the previous overlay row is the previous exchange session, so the prior state is known. */
  priorKnown: boolean;
}

export interface Overlay {
  rows: OverlayRow[];
  /** Label of the score series, for example a primary archive or a proxy. Shown wherever the study appears. */
  scoreLabel: string;
  /** Label of the benchmark, for example an index or an ETF proxy. */
  benchmarkLabel: string;
  /** Score dates with no benchmark bar, and benchmark sessions inside the score range with no score. */
  scoresWithoutBar: number;
  barsWithoutScore: number;
  invalidScores: number;
  first: ISODate | null;
  last: ISODate | null;
}

/** Same date join of the score series and the benchmark closes. Nothing is carried across a gap. */
export const buildOverlay = (scores: readonly ScorePoint[], bars: readonly Bar[], scoreLabel: string, benchmarkLabel: string): Overlay => {
  const sorted = [...scores].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const rows: OverlayRow[] = [];
  let scoresWithoutBar = 0;
  let invalidScores = 0;
  const seen = new Set<ISODate>();
  for (const s of sorted) {
    if (!Number.isFinite(s.score) || s.score < 0 || s.score > 100 || seen.has(s.date)) {
      invalidScores++;
      continue;
    }
    seen.add(s.date);
    const bi = indexOfDate(bars, s.date);
    if (bi < 0) {
      scoresWithoutBar++;
      continue;
    }
    const prev = rows[rows.length - 1];
    rows.push({
      date: s.date,
      score: s.score,
      zone: zoneOf(s.score),
      close: bars[bi]!.close,
      barIndex: bi,
      priorKnown: prev !== undefined && nextSession(prev.date) === s.date,
    });
  }
  const first = rows[0]?.date ?? null;
  const last = rows[rows.length - 1]?.date ?? null;
  let barsWithoutScore = 0;
  if (first && last) {
    const have = new Set(rows.map((r) => r.date));
    for (const b of bars) if (b.date >= first && b.date <= last && !have.has(b.date)) barsWithoutScore++;
  }
  return { rows, scoreLabel, benchmarkLabel, scoresWithoutBar, barsWithoutScore, invalidScores, first, last };
};

/* --------------------------------------------------------------------- swings */

export interface Swing {
  kind: 'high' | 'low';
  /** Index, date and close of the extreme. */
  turnIndex: number;
  turnDate: ISODate;
  turnClose: number;
  /** First later session whose close completed the reversal. The swing is known from this date. */
  confirmIndex: number;
  confirmDate: ISODate;
  confirmClose: number;
  /** Close to close move from the turn to the confirmation. */
  reversal: number;
  /** True for the first swing: the leg into it began before the series and was not observed. */
  leading: boolean;
}

export interface PendingExtreme {
  kind: 'high' | 'low';
  index: number;
  date: ISODate;
  close: number;
  /** Move from the extreme to the last close. Has not reached the reversal threshold. */
  moveSoFar: number;
}

export interface SwingResult {
  swings: Swing[];
  /** The latest extreme that no later close has confirmed. Not a swing. */
  pending: PendingExtreme | null;
  minReversal: number;
}

/**
 * Confirmed swing highs and lows on closes. Past only: a swing appears when its confirming close
 * prints and never earlier. Ties keep the earliest extreme.
 */
export const confirmedSwings = (closes: readonly number[], dates: readonly ISODate[], minReversal: number = SENTIMENT_DEFAULTS.minReversal): SwingResult => {
  const swings: Swing[] = [];
  const n = Math.min(closes.length, dates.length);
  if (n === 0 || !(minReversal > 0)) return { swings, pending: null, minReversal };
  let dir: 'up' | 'down' | null = null;
  let hiIdx = 0;
  let loIdx = 0;
  const push = (kind: 'high' | 'low', turn: number, confirm: number) => {
    swings.push({
      kind,
      turnIndex: turn,
      turnDate: dates[turn]!,
      turnClose: closes[turn]!,
      confirmIndex: confirm,
      confirmDate: dates[confirm]!,
      confirmClose: closes[confirm]!,
      reversal: closes[confirm]! / closes[turn]! - 1,
      leading: swings.length === 0,
    });
  };
  for (let i = 1; i < n; i++) {
    const c = closes[i]!;
    if (dir === null) {
      if (c > closes[hiIdx]!) hiIdx = i;
      if (c < closes[loIdx]!) loIdx = i;
      if (c <= closes[hiIdx]! * (1 - minReversal) && hiIdx < i) {
        push('high', hiIdx, i);
        dir = 'down';
        loIdx = i;
      } else if (c >= closes[loIdx]! * (1 + minReversal) && loIdx < i) {
        push('low', loIdx, i);
        dir = 'up';
        hiIdx = i;
      }
    } else if (dir === 'up') {
      if (c > closes[hiIdx]!) hiIdx = i;
      else if (c <= closes[hiIdx]! * (1 - minReversal)) {
        push('high', hiIdx, i);
        dir = 'down';
        loIdx = i;
      }
    } else {
      if (c < closes[loIdx]!) loIdx = i;
      else if (c >= closes[loIdx]! * (1 + minReversal)) {
        push('low', loIdx, i);
        dir = 'up';
        hiIdx = i;
      }
    }
  }
  let pending: PendingExtreme | null = null;
  const last = closes[n - 1]!;
  if (dir === 'up') pending = { kind: 'high', index: hiIdx, date: dates[hiIdx]!, close: closes[hiIdx]!, moveSoFar: last / closes[hiIdx]! - 1 };
  else if (dir === 'down') pending = { kind: 'low', index: loIdx, date: dates[loIdx]!, close: closes[loIdx]!, moveSoFar: last / closes[loIdx]! - 1 };
  return { swings, pending, minReversal };
};

/** Swings whose confirmation had printed by the given date. Use this for any as-of view. */
export const swingsKnownAsOf = (swings: readonly Swing[], asOf: ISODate): Swing[] => swings.filter((s) => s.confirmDate <= asOf);

export interface SwingWithScore extends Swing {
  /** Score on the turning session itself. */
  sameSessionScore: Maybe<number>;
  sameSessionZone: Maybe<Zone>;
  /**
   * The most extreme score within the nearby window (lowest for a low, highest for a high) when it
   * falls on a different date. Shown as an alternative, never as the turning day score.
   */
  nearbyAlternative: { date: ISODate; score: number; zone: Zone; sessionsFromTurn: number } | null;
}

/**
 * Benchmark swings from the overlay's closes, each with its same session score and a labeled
 * nearby alternative. Swings are computed on overlay rows so every swing date has a score.
 */
export const swingsWithScores = (
  overlay: Overlay,
  minReversal: number = SENTIMENT_DEFAULTS.minReversal,
  nearbySessions: number = SENTIMENT_DEFAULTS.nearbySessions,
): { swings: SwingWithScore[]; pending: PendingExtreme | null; minReversal: number } => {
  const rows = overlay.rows;
  const res = confirmedSwings(rows.map((r) => r.close), rows.map((r) => r.date), minReversal);
  const swings = res.swings.map((s): SwingWithScore => {
    const row = rows[s.turnIndex];
    let alt: SwingWithScore['nearbyAlternative'] = null;
    if (row) {
      let best = s.turnIndex;
      const from = Math.max(0, s.turnIndex - nearbySessions);
      const to = Math.min(rows.length - 1, s.turnIndex + nearbySessions);
      for (let j = from; j <= to; j++) {
        const cand = rows[j]!.score;
        const cur = rows[best]!.score;
        if (s.kind === 'low' ? cand < cur : cand > cur) best = j;
      }
      if (best !== s.turnIndex) {
        const b = rows[best]!;
        alt = { date: b.date, score: b.score, zone: b.zone, sessionsFromTurn: best - s.turnIndex };
      }
    }
    return {
      ...s,
      sameSessionScore: row ? row.score : na('no-coverage', 'No score on the turning session'),
      sameSessionZone: row ? row.zone : na('no-coverage', 'No score on the turning session'),
      nearbyAlternative: alt,
    };
  });
  return { swings, pending: res.pending, minReversal };
};

/* ------------------------------------------------------------------- clusters */

export type ExtremeKind = 'fear' | 'greed';

export interface ExtremeCluster {
  kind: ExtremeKind;
  /** First session inside the extreme zone after a known non extreme session. */
  anchorDate: ISODate;
  anchorScore: number;
  anchorBarIndex: number;
  /** Last consecutive extreme session observed. */
  endDate: ISODate;
  sessions: number;
  /** Most extreme score inside the cluster and its date. */
  extremeScore: number;
  extremeDate: ISODate;
  /** True when the cluster reaches the last overlay row and may still be running. */
  open: boolean;
}

export interface ClusterResult {
  clusters: ExtremeCluster[];
  /** Extreme stretches skipped because the prior session's state is unknown (series start or a gap). */
  unknownPriorExcluded: number;
}

/** Extreme fear or extreme greed clusters anchored at the first entry after a known prior state. */
export const extremeClusters = (overlay: Overlay, kind: ExtremeKind): ClusterResult => {
  const target: Zone = kind === 'fear' ? 'extreme-fear' : 'extreme-greed';
  const rows = overlay.rows;
  const clusters: ExtremeCluster[] = [];
  let unknownPriorExcluded = 0;
  let i = 0;
  while (i < rows.length) {
    const r = rows[i]!;
    if (r.zone !== target) {
      i++;
      continue;
    }
    // Extend through consecutive sessions that stay in the zone.
    let j = i;
    while (j + 1 < rows.length && rows[j + 1]!.zone === target && rows[j + 1]!.priorKnown) j++;
    const prior = rows[i - 1];
    const anchored = r.priorKnown && prior !== undefined && prior.zone !== target;
    if (anchored) {
      let ext = i;
      for (let k = i; k <= j; k++) {
        const better = kind === 'fear' ? rows[k]!.score < rows[ext]!.score : rows[k]!.score > rows[ext]!.score;
        if (better) ext = k;
      }
      clusters.push({
        kind,
        anchorDate: r.date,
        anchorScore: r.score,
        anchorBarIndex: r.barIndex,
        endDate: rows[j]!.date,
        sessions: j - i + 1,
        extremeScore: rows[ext]!.score,
        extremeDate: rows[ext]!.date,
        open: j === rows.length - 1,
      });
    } else unknownPriorExcluded++;
    i = j + 1;
  }
  return { clusters, unknownPriorExcluded };
};

export type ClusterEntry = 'next-open' | 'signal-close';

export interface ClusterOutcome {
  anchorDate: ISODate;
  entryDate: ISODate;
  entryPrice: number;
  endDate: ISODate;
  /** C(end) / entry - 1. */
  ret: number;
  /** Lowest and highest close inside the window relative to the entry price. */
  maxDrawdown: number;
  maxRunup: number;
}

export interface ClusterHorizonSummary {
  months: number;
  /** Matured, non overlapping anchors. The denominator. */
  n: number;
  notMatured: number;
  overlapDropped: number;
  /** Anchors with no tradable entry session or a missing bar. */
  unavailable: number;
  win: Proportion | null;
  returns: Distribution | null;
  drawdowns: Distribution | null;
  runups: Distribution | null;
  outcomes: ClusterOutcome[];
}

export interface ClusterStudy {
  kind: ExtremeKind;
  entry: ClusterEntry;
  clusters: ExtremeCluster[];
  unknownPriorExcluded: number;
  horizons: ClusterHorizonSummary[];
  scoreLabel: string;
  benchmarkLabel: string;
  note: string;
}

export interface ClusterStudyOptions {
  entry?: ClusterEntry;
  horizonsMonths?: readonly number[];
  level?: number;
}

/**
 * Outcomes after extreme clusters. Fear and greed are studied separately. For each horizon the
 * anchors are thinned chronologically so no two outcome windows overlap, and anchors whose window
 * has not completed are counted as not matured and left out of the denominator.
 */
export const clusterStudy = (overlay: Overlay, bars: readonly Bar[], kind: ExtremeKind, opts: ClusterStudyOptions = {}): ClusterStudy => {
  const entry = opts.entry ?? 'next-open';
  const months = opts.horizonsMonths ?? SENTIMENT_DEFAULTS.horizonsMonths;
  const level = opts.level ?? 0.95;
  const { clusters, unknownPriorExcluded } = extremeClusters(overlay, kind);
  const lastDate = bars.length ? bars[bars.length - 1]!.date : '';
  const horizons = months.map((m): ClusterHorizonSummary => {
    const outcomes: ClusterOutcome[] = [];
    let notMatured = 0;
    let overlapDropped = 0;
    let unavailable = 0;
    let lastEnd: ISODate = '';
    for (const c of clusters) {
      const ei = entry === 'signal-close' ? c.anchorBarIndex : c.anchorBarIndex + 1;
      const eb = bars[ei];
      if (!eb) {
        notMatured++;
        continue;
      }
      if (entry === 'next-open' && eb.date !== nextSession(c.anchorDate)) {
        unavailable++;
        continue;
      }
      const endDate = sessionOnOrBefore(minusMonths(eb.date, -m));
      if (endDate > lastDate) {
        notMatured++;
        continue;
      }
      if (lastEnd !== '' && eb.date < lastEnd) {
        overlapDropped++;
        continue;
      }
      const xi = indexOfDate(bars, endDate);
      if (xi < 0 || xi <= ei) {
        unavailable++;
        continue;
      }
      const entryPrice = entry === 'signal-close' ? eb.close : eb.open;
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = entry === 'signal-close' ? ei + 1 : ei; k <= xi; k++) {
        const cl = bars[k]!.close;
        if (cl < lo) lo = cl;
        if (cl > hi) hi = cl;
      }
      outcomes.push({
        anchorDate: c.anchorDate,
        entryDate: eb.date,
        entryPrice,
        endDate,
        ret: bars[xi]!.close / entryPrice - 1,
        maxDrawdown: lo / entryPrice - 1,
        maxRunup: hi / entryPrice - 1,
      });
      lastEnd = endDate;
    }
    const rets = outcomes.map((o) => o.ret);
    return {
      months: m,
      n: outcomes.length,
      notMatured,
      overlapDropped,
      unavailable,
      win: wilson(rets.filter((r) => r > 0).length, rets.length, level, yearClusterEffectiveN(outcomes.map((o) => o.anchorDate))),
      returns: distribution(rets),
      drawdowns: distribution(outcomes.map((o) => o.maxDrawdown)),
      runups: distribution(outcomes.map((o) => o.maxRunup)),
      outcomes,
    };
  });
  return {
    kind,
    entry,
    clusters,
    unknownPriorExcluded,
    horizons,
    scoreLabel: overlay.scoreLabel,
    benchmarkLabel: overlay.benchmarkLabel,
    note:
      entry === 'next-open'
        ? 'Entry at the open of the session after the score first entered the zone. Historical frequencies, not a forecast.'
        : 'Entry at the close of the session the score first entered the zone. Historical frequencies, not a forecast.',
  };
};
