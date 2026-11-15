/**
 * Big declines and selling exhaustion (owner specification section 9).
 *
 * Definitions
 * - A decline is measured on one of four separately labeled bases:
 *     close vs previous close   C(i) / C(i-1) - 1
 *     close vs open             C(i) / O(i) - 1      (a drop from the open is not a gap down)
 *     close vs intraday high    C(i) / H(i) - 1
 *     low vs previous close     L(i) / C(i-1) - 1    (the current or low measure)
 *   High to low alone does not prove that the high came before the low. The order inside one daily
 *   bar is reported as indeterminate.
 * - A session qualifies when its measure is at or below minus the threshold.
 * - Repeated qualifying days are grouped into chronological episodes. An episode starts at its
 *   first qualifying day and absorbs later qualifying days that follow within the episode gap.
 *   Inference uses episode anchors, thinned to horizon plus one spacing. The raw list is kept.
 * - Outcomes use sessions i+1 .. i+h after the event close. An endpoint return is not a touch.
 *   Every touch says close only or intraday.
 * - A lasting bottom needs an explicit horizon: the event low holds for the whole window and a
 *   threshold rebound occurs inside it. The prospective confirm date is separate from the event.
 * - A pattern that needs later sessions becomes usable on its confirm date. Outcomes after a
 *   pattern are measured from that confirm anchor, never from the earlier event day.
 * - Position of an event inside a drawdown (front, middle, late) is an ex post description of a
 *   fully observed drawdown. It is never an event day input.
 *
 * Thresholds stated by the specification are tagged provenance spec. The rest are proposed and
 * must be reconciled with the reference source before a parity claim.
 */
import { addDays, sessionOnOrAfter } from './core/calendar';
import { relativeVolume, rollingExtreme, rsiWilder, sma, type Series } from './core/indicators';
import { firstTouch, forwardOutcome, selectNonOverlapping, type ForwardOutcome, type TouchMode } from './core/outcomes';
import { distribution, kaplanMeier, kmMedian, midrankPercentile, wilson, yearClusterEffectiveN, type SurvivalObservation } from './core/stats';
import { isNa, na, type Bar, type Distribution, type EarningsEvent, type ISODate, type Maybe, type Proportion } from './core/types';

export type DeclineBasis = 'close-vs-prev-close' | 'close-vs-open' | 'close-vs-high' | 'low-vs-prev-close';

export const DECLINE_BASES: readonly DeclineBasis[] = ['close-vs-prev-close', 'close-vs-open', 'close-vs-high', 'low-vs-prev-close'];

export const DECLINE_BASIS_LABELS: Readonly<Record<DeclineBasis, string>> = {
  'close-vs-prev-close': 'Close vs previous close',
  'close-vs-open': 'Close vs open',
  'close-vs-high': 'Close vs intraday high',
  'low-vs-prev-close': 'Low vs previous close',
};

export const DECLINE_DEFAULTS = {
  spec: {
    provenance: 'spec' as const,
    horizons: [1, 2, 3, 5, 10, 15, 20, 30, 60, 90] as readonly number[],
    bounceLevels: [0.03, 0.05, 0.1] as readonly number[],
    /** Gap down of at least 3%. */
    gapDownMin: 0.03,
    /** Lower wick at least one half of the day's range. */
    lowerWickMin: 0.5,
    /** RSI14 below 30. */
    rsiMax: 30,
    /** Volume at least 2x the mean of the previous 20 sessions. */
    volumeMultiple: 2,
    /** New low versus the previous 20 sessions. */
    newLowLookback: 20,
    /** Top quartile close: close in range at or above 0.75. */
    topQuartileClose: 0.75,
    /** Retest within 1% of the event low, then +3% within five sessions. */
    retestTolerance: 0.01,
    retestRecovery: 0.03,
    retestRecoverySessions: 5,
    /** Horizon plus one spacing between anchors used for inference. */
    spacingExtra: 1,
  },
  proposed: {
    provenance: 'proposed' as const,
    /** A qualifying day within this many sessions of the previous one joins the same episode. */
    episodeGapSessions: 5,
    /** Below this many cases a frequency keeps its counts and withholds the rate. */
    minCases: 10,
    level: 0.95,
    lastingBottomHorizon: 20,
    lastingBottomRebound: 0.05,
    /** Sessions after the event in which a new 20 session low can form. */
    patternLookahead: 5,
    /** Sessions after the event in which a retest can occur. */
    retestWindow: 10,
    multiDayMinDownCloses: 3,
    delayedBottomWindow: 20,
    delayedBottomHold: 10,
    delayedBottomRebound: 0.05,
    /** Minimum gap down for the gap recovery pattern. */
    gapRecoveryMin: 0.01,
    /** Earnings cohort window: the reacting session plus this many later sessions. */
    earningsWindowSessions: 0,
  },
};

/** A count with its denominator. The rate and Wilson interval appear only at or above the sample gate. */
export interface Frequency {
  hits: number;
  n: number;
  proportion: Maybe<Proportion>;
}

/**
 * Build a Frequency. `dates` (one per case) turn on the conservative year cluster effective
 * sample size for the Wilson interval. Below `minCases` the counts stay and the rate is withheld.
 */
export const makeFrequency = (hits: number, n: number, dates: readonly ISODate[] | null, level: number, minCases: number): Frequency => {
  if (n < Math.max(1, minCases)) return { hits, n, proportion: na('sample-too-small', `${n} cases, needs ${Math.max(1, minCases)}`) };
  const w = wilson(hits, n, level, dates ? yearClusterEffectiveN(dates) : undefined);
  return { hits, n, proportion: w ?? na('sample-too-small', 'No cases') };
};

const dist = (xs: readonly number[]): Maybe<Distribution> => distribution(xs) ?? na('sample-too-small', 'No cases');

/* ------------------------------------------------------------------------------------------------
 * Prepared past-only arrays, memoized per series identity.
 * ---------------------------------------------------------------------------------------------- */

interface Prepared {
  closes: number[];
  rsi: Series;
  relVol: Series;
  sma50: Series;
  sma200: Series;
  /** Lowest low of the 20 sessions before i, excluding i. */
  priorLow20: Series;
  dateIndex: Map<ISODate, number>;
}

const prepCache = new WeakMap<readonly Bar[], Prepared>();

const prepare = (bars: readonly Bar[]): Prepared => {
  const hit = prepCache.get(bars);
  if (hit) return hit;
  const closes = bars.map((b) => b.close);
  const p: Prepared = {
    closes,
    rsi: rsiWilder(closes, 14),
    relVol: relativeVolume(bars, 20),
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    priorLow20: rollingExtreme(bars.map((b) => b.low), DECLINE_DEFAULTS.spec.newLowLookback, 'min', true).value,
    dateIndex: new Map(bars.map((b, i) => [b.date, i])),
  };
  prepCache.set(bars, p);
  return p;
};

/* ------------------------------------------------------------------------------------------------
 * Session measures
 * ---------------------------------------------------------------------------------------------- */

export interface SessionMeasures {
  index: number;
  date: ISODate;
  closeVsPrevClose: Maybe<number>;
  closeVsOpen: number;
  closeVsHigh: number;
  lowVsPrevClose: Maybe<number>;
  /** Open vs previous close. A gap down is a different event from a drop from the open. */
  gap: Maybe<number>;
  /** Low / high - 1. Says nothing about which came first. */
  highToLow: number;
  intradayOrder: 'indeterminate';
  /** (close - low) / (high - low). */
  closeInRange: Maybe<number>;
  /** (min(open, close) - low) / (high - low). */
  lowerWick: Maybe<number>;
}

const rawMeasure = (bars: readonly Bar[], i: number, basis: DeclineBasis): number | null => {
  const b = bars[i];
  if (!b) return null;
  switch (basis) {
    case 'close-vs-open':
      return b.close / b.open - 1;
    case 'close-vs-high':
      return b.close / b.high - 1;
    case 'close-vs-prev-close': {
      const p = bars[i - 1];
      return p ? b.close / p.close - 1 : null;
    }
    case 'low-vs-prev-close': {
      const p = bars[i - 1];
      return p ? b.low / p.close - 1 : null;
    }
  }
};

/** One session's decline on a chosen basis, or the reason it is missing. */
export const declineMeasure = (bars: readonly Bar[], i: number, basis: DeclineBasis): Maybe<number> => {
  if (!bars[i]) return na('invalid-input', 'index outside series');
  const m = rawMeasure(bars, i, basis);
  return m === null ? na('missing-base-close', 'No previous close for the first session') : m;
};

export const sessionMeasures = (bars: readonly Bar[], i: number): Maybe<SessionMeasures> => {
  const b = bars[i];
  if (!b) return na('invalid-input', 'index outside series');
  const p = bars[i - 1];
  const noPrev = na('missing-base-close', 'No previous close for the first session');
  const range = b.high - b.low;
  const flat = na('flat-range', 'High equals low');
  return {
    index: i,
    date: b.date,
    closeVsPrevClose: p ? b.close / p.close - 1 : noPrev,
    closeVsOpen: b.close / b.open - 1,
    closeVsHigh: b.close / b.high - 1,
    lowVsPrevClose: p ? b.low / p.close - 1 : noPrev,
    gap: p ? b.open / p.close - 1 : noPrev,
    highToLow: b.low / b.high - 1,
    intradayOrder: 'indeterminate',
    closeInRange: range > 0 ? (b.close - b.low) / range : flat,
    lowerWick: range > 0 ? (Math.min(b.open, b.close) - b.low) / range : flat,
  };
};

export interface MoveRarity {
  basis: DeclineBasis;
  date: ISODate;
  measure: number;
  /** Earlier sessions with a defined measure. The session itself is excluded. */
  priorEligible: number;
  /** Earlier sessions at least as severe (measure at or below this one). */
  atLeastAsSevere: Frequency;
  /** Midrank percentile of the measure among earlier sessions. Low means unusually severe. */
  percentile: Maybe<number>;
  from: ISODate | null;
  to: ISODate | null;
}

/** How rare the move at session i is against the stock's own earlier history on the same basis. */
export const moveRarity = (bars: readonly Bar[], i: number, basis: DeclineBasis): Maybe<MoveRarity> => {
  const m = declineMeasure(bars, i, basis);
  if (isNa(m)) return m;
  const prior: number[] = [];
  let first: ISODate | null = null;
  let last: ISODate | null = null;
  for (let k = 0; k < i; k++) {
    const v = rawMeasure(bars, k, basis);
    if (v === null) continue;
    prior.push(v);
    first ??= bars[k]!.date;
    last = bars[k]!.date;
  }
  const hits = prior.filter((v) => v <= m).length;
  return {
    basis,
    date: bars[i]!.date,
    measure: m,
    priorEligible: prior.length,
    atLeastAsSevere: makeFrequency(hits, prior.length, null, DECLINE_DEFAULTS.proposed.level, 1),
    percentile: prior.length ? midrankPercentile(prior, m) : na('insufficient-history', 'No earlier sessions'),
    from: first,
    to: last,
  };
};

/* ------------------------------------------------------------------------------------------------
 * Earnings cohorts
 * ---------------------------------------------------------------------------------------------- */

export type EarningsCohort = 'earnings' | 'ordinary' | 'unknown';

interface EarningsMap {
  sessions: Map<ISODate, 'earnings' | 'ambiguous'>;
  coverageFrom: ISODate | null;
}

/**
 * Map releases to reacting sessions. Before the open or during the session reacts the same day.
 * After the close reacts the next session. An unknown time cannot be mapped, so both candidate
 * sessions are marked ambiguous and classified unknown.
 */
const earningsMap = (bars: readonly Bar[], events: readonly EarningsEvent[] | undefined, window: number): EarningsMap => {
  const sessions = new Map<ISODate, 'earnings' | 'ambiguous'>();
  if (!events || events.length === 0) return { sessions, coverageFrom: null };
  const idx = prepare(bars).dateIndex;
  let coverageFrom: ISODate | null = null;
  const mark = (d: ISODate, kind: 'earnings' | 'ambiguous') => {
    const start = idx.get(d);
    if (start === undefined) {
      if (kind === 'ambiguous' || !sessions.has(d)) sessions.set(d, kind);
      return;
    }
    for (let k = 0; k <= window; k++) {
      const b = bars[start + k];
      if (!b) break;
      if (kind === 'ambiguous' || sessions.get(b.date) !== 'ambiguous') sessions.set(b.date, kind);
    }
  };
  for (const e of events) {
    if (coverageFrom === null || e.date < coverageFrom) coverageFrom = e.date;
    const same = sessionOnOrAfter(e.date);
    const next = sessionOnOrAfter(addDays(e.date, 1));
    if (e.time === 'bmo' || e.time === 'during') mark(same, 'earnings');
    else if (e.time === 'amc') mark(next, 'earnings');
    else {
      mark(same, 'ambiguous');
      mark(next, 'ambiguous');
    }
  }
  return { sessions, coverageFrom };
};

/** Resolver from a session date to its earnings cohort, using the shared reaction timing rule. */
export const earningsCohortResolver = (bars: readonly Bar[], events: readonly EarningsEvent[] | undefined, windowSessions = DECLINE_DEFAULTS.proposed.earningsWindowSessions): ((date: ISODate) => EarningsCohort) => {
  const map = earningsMap(bars, events, windowSessions);
  return (date) => cohortOf(map, date);
};

const cohortOf = (map: EarningsMap, date: ISODate): EarningsCohort => {
  if (map.coverageFrom === null || date < map.coverageFrom) return 'unknown';
  const k = map.sessions.get(date);
  if (k === 'earnings') return 'earnings';
  if (k === 'ambiguous') return 'unknown';
  return 'ordinary';
};

/* ------------------------------------------------------------------------------------------------
 * Finding declines
 * ---------------------------------------------------------------------------------------------- */

export interface TrendContext {
  /** Close above the 200 session SMA on the signal date. */
  aboveSma200: Maybe<boolean>;
  /** Close above the 50 session SMA on the signal date. */
  aboveSma50: Maybe<boolean>;
  /** Close to close return on the signal date. */
  dayReturn: Maybe<number>;
}

export interface DeclineEvent {
  index: number;
  date: ISODate;
  basis: DeclineBasis;
  measure: number;
  open: number;
  high: number;
  low: number;
  close: number;
  prevClose: number | null;
  volume: number | null;
  /** Volume vs the mean of the previous 20 sessions. */
  relativeVolume: Maybe<number>;
  measures: SessionMeasures;
  rsi14: Maybe<number>;
  stock: TrendContext;
  market: Maybe<TrendContext>;
  sector: Maybe<TrendContext>;
  earnings: EarningsCohort;
}

export interface DeclineEpisode {
  anchorIndex: number;
  anchorDate: ISODate;
  lastIndex: number;
  lastDate: ISODate;
  /** Qualifying sessions inside the episode. */
  indices: number[];
  days: number;
  worstMeasure: number;
  worstDate: ISODate;
}

export interface DeclineOptions {
  /** Positive fraction. 0.05 means a 5% decline or worse. */
  threshold: number;
  basis?: DeclineBasis;
  /** Restrict the output period. Earlier bars still warm up indicators. */
  from?: ISODate;
  to?: ISODate;
  market?: readonly Bar[];
  sector?: readonly Bar[];
  earnings?: readonly EarningsEvent[];
  episodeGapSessions?: number;
  earningsWindowSessions?: number;
}

export interface DeclineStudy {
  basis: DeclineBasis;
  basisLabel: string;
  threshold: number;
  /** Sessions in the period with a defined measure. The rarity denominator. */
  eligibleSessions: number;
  from: ISODate | null;
  to: ISODate | null;
  occurrences: DeclineEvent[];
  rarity: Frequency;
  episodes: DeclineEpisode[];
  perYear: { year: number; occurrences: number; episodes: number }[];
  earningsCohorts: Record<EarningsCohort, number>;
  /** True when the caller supplied earnings events. Without them every event is unknown. */
  earningsCoverage: boolean;
}

const trendAt = (bars: readonly Bar[], i: number): TrendContext => {
  const p = prepare(bars);
  const b = bars[i]!;
  const s200 = p.sma200[i] ?? null;
  const s50 = p.sma50[i] ?? null;
  const prev = bars[i - 1];
  return {
    aboveSma200: s200 === null ? na('insufficient-history', 'Fewer than 200 completed sessions') : b.close > s200,
    aboveSma50: s50 === null ? na('insufficient-history', 'Fewer than 50 completed sessions') : b.close > s50,
    dayReturn: prev ? b.close / prev.close - 1 : na('missing-base-close', 'No previous close'),
  };
};

const contextOn = (series: readonly Bar[] | undefined, date: ISODate, label: string): Maybe<TrendContext> => {
  if (!series) return na('no-coverage', `No ${label} series supplied`);
  const i = prepare(series).dateIndex.get(date);
  if (i === undefined) return na('missing-session', `${label} series has no session on ${date}`);
  return trendAt(series, i);
};

/** Group qualifying sessions into chronological episodes. */
export const groupEpisodes = (bars: readonly Bar[], indices: readonly number[], measures: readonly number[], gap: number): DeclineEpisode[] => {
  const out: DeclineEpisode[] = [];
  let cur: DeclineEpisode | null = null;
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k]!;
    const m = measures[k]!;
    const date = bars[i]!.date;
    if (cur && i - cur.lastIndex <= gap) {
      cur.lastIndex = i;
      cur.lastDate = date;
      cur.indices.push(i);
      cur.days++;
      if (m < cur.worstMeasure) {
        cur.worstMeasure = m;
        cur.worstDate = date;
      }
    } else {
      cur = { anchorIndex: i, anchorDate: date, lastIndex: i, lastDate: date, indices: [i], days: 1, worstMeasure: m, worstDate: date };
      out.push(cur);
    }
  }
  return out;
};

/** Every same stock session at least as severe as the threshold on the chosen basis. */
export const findDeclines = (bars: readonly Bar[], opts: DeclineOptions): DeclineStudy => {
  const basis = opts.basis ?? 'close-vs-prev-close';
  const threshold = Math.abs(opts.threshold);
  const p = prepare(bars);
  const eMap = earningsMap(bars, opts.earnings, opts.earningsWindowSessions ?? DECLINE_DEFAULTS.proposed.earningsWindowSessions);
  const occurrences: DeclineEvent[] = [];
  let eligible = 0;
  let from: ISODate | null = null;
  let to: ISODate | null = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (opts.from && b.date < opts.from) continue;
    if (opts.to && b.date > opts.to) break;
    const m = rawMeasure(bars, i, basis);
    if (m === null) continue;
    eligible++;
    from ??= b.date;
    to = b.date;
    if (m > -threshold) continue;
    const measures = sessionMeasures(bars, i);
    if (isNa(measures)) continue;
    const rv = p.relVol[i] ?? null;
    const rsi = p.rsi[i] ?? null;
    occurrences.push({
      index: i,
      date: b.date,
      basis,
      measure: m,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      prevClose: bars[i - 1]?.close ?? null,
      volume: b.volume,
      relativeVolume: rv === null ? na('insufficient-history', 'Needs 20 earlier sessions with verified volume') : rv,
      measures,
      rsi14: rsi === null ? na('insufficient-history', 'Needs 15 completed sessions') : rsi,
      stock: trendAt(bars, i),
      market: contextOn(opts.market, b.date, 'market'),
      sector: contextOn(opts.sector, b.date, 'sector'),
      earnings: cohortOf(eMap, b.date),
    });
  }
  const episodes = groupEpisodes(
    bars,
    occurrences.map((o) => o.index),
    occurrences.map((o) => o.measure),
    opts.episodeGapSessions ?? DECLINE_DEFAULTS.proposed.episodeGapSessions,
  );
  const years = new Map<number, { occurrences: number; episodes: number }>();
  const bump = (d: ISODate, key: 'occurrences' | 'episodes') => {
    const y = Number(d.slice(0, 4));
    const row = years.get(y) ?? { occurrences: 0, episodes: 0 };
    row[key]++;
    years.set(y, row);
  };
  for (const o of occurrences) bump(o.date, 'occurrences');
  for (const e of episodes) bump(e.anchorDate, 'episodes');
  const cohorts: Record<EarningsCohort, number> = { earnings: 0, ordinary: 0, unknown: 0 };
  for (const o of occurrences) cohorts[o.earnings]++;
  return {
    basis,
    basisLabel: DECLINE_BASIS_LABELS[basis],
    threshold,
    eligibleSessions: eligible,
    from,
    to,
    occurrences,
    rarity: makeFrequency(occurrences.length, eligible, null, DECLINE_DEFAULTS.proposed.level, 1),
    episodes,
    perYear: [...years.entries()].sort((a, b) => a[0] - b[0]).map(([year, v]) => ({ year, ...v })),
    earningsCohorts: cohorts,
    earningsCoverage: eMap.coverageFrom !== null,
  };
};

/* ------------------------------------------------------------------------------------------------
 * Horizon outcomes
 * ---------------------------------------------------------------------------------------------- */

export interface BounceStats {
  /** Fraction above the anchor close, for example 0.05. */
  level: number;
  /** Intraday high reached the level at least once inside the window. */
  touch: Frequency;
  /** A close at or above the level at least once inside the window. */
  close: Frequency;
  /** Endpoint close at or above the level. Distinct from ever reaching it. */
  endpoint: Frequency;
  /** Sessions to the first intraday touch, among cases that touched. */
  sessionsToTouch: Maybe<Distribution>;
}

export interface DeclineHorizonStats {
  horizon: number;
  /** Minimum sessions between anchors used here (horizon plus one). */
  spacing: number;
  anchorsConsidered: number;
  /** Anchors dropped because they overlap an earlier kept anchor's window. */
  excludedOverlap: number;
  /** Kept anchors whose horizon has not completed. Not in any denominator. */
  notMatured: number;
  /** Matured, non-overlapping cases. */
  n: number;
  up: number;
  flat: number;
  down: number;
  /** Endpoint close above the anchor close. */
  positive: Frequency;
  returns: Maybe<Distribution>;
  /** Lowest close inside the window vs the anchor close. Close only. */
  worstClose: Maybe<Distribution>;
  /** Lowest intraday low inside the window vs the anchor close. Intraday. */
  worstLow: Maybe<Distribution>;
  /** An intraday low below the event low inside the window. Intraday. */
  tradedBelowEventLow: Frequency;
  /** A close below the event low inside the window. Close only. */
  closedBelowEventLow: Frequency;
  /** No intraday trade below the event low inside the window. Intraday. */
  eventLowHeld: Frequency;
  bounces: BounceStats[];
  /** Sessions ahead of the lowest close and of the lowest intraday low inside the window. */
  troughCloseOffset: Maybe<Distribution>;
  troughLowOffset: Maybe<Distribution>;
  anchorDates: ISODate[];
  outcomes: ForwardOutcome[];
}

export interface HorizonOptions {
  bounceLevels?: readonly number[];
  level?: number;
  minCases?: number;
  /** Set false to skip horizon plus one thinning, for example when anchors are already spaced. */
  nonOverlap?: boolean;
  /** Low used for the event low tests. Defaults to the anchor bar's low. */
  eventLowOf?: (anchorIndex: number) => number;
}

/** Outcomes after decline anchors for one horizon, with outcome specific denominators. */
export const declineHorizonStats = (bars: readonly Bar[], anchors: readonly number[], h: number, opts: HorizonOptions = {}): DeclineHorizonStats => {
  const level = opts.level ?? DECLINE_DEFAULTS.proposed.level;
  const minCases = opts.minCases ?? DECLINE_DEFAULTS.proposed.minCases;
  const levels = opts.bounceLevels ?? DECLINE_DEFAULTS.spec.bounceLevels;
  const spacing = h + DECLINE_DEFAULTS.spec.spacingExtra;
  const sel = opts.nonOverlap === false ? { kept: [...anchors].sort((a, b) => a - b), dropped: [] as number[] } : selectNonOverlapping(anchors, spacing);
  const outcomes: ForwardOutcome[] = [];
  let notMatured = 0;
  for (const i of sel.kept) {
    const o = forwardOutcome(bars, i, h);
    if (isNa(o)) notMatured++;
    else outcomes.push(o);
  }
  const dates = outcomes.map((o) => o.anchorDate);
  const n = outcomes.length;
  const f = (hits: number) => makeFrequency(hits, n, dates, level, minCases);
  const up = outcomes.filter((o) => o.ret > 0).length;
  const down = outcomes.filter((o) => o.ret < 0).length;
  let tradedBelow = 0;
  let closedBelow = 0;
  for (const o of outcomes) {
    const low = opts.eventLowOf ? opts.eventLowOf(o.anchorIndex) : bars[o.anchorIndex]!.low;
    if (o.anchorClose * (1 + o.minLowRet) < low) tradedBelow++;
    if (o.anchorClose * (1 + o.minCloseRet) < low) closedBelow++;
  }
  const bounces: BounceStats[] = levels.map((lv) => {
    const touchOffsets: number[] = [];
    let closeHits = 0;
    let endHits = 0;
    for (const o of outcomes) {
      const target = o.anchorClose * (1 + lv);
      const t = firstTouch(bars, o.anchorIndex, h, target, 'above', 'intraday');
      if (t.offset !== null) touchOffsets.push(t.offset);
      if (firstTouch(bars, o.anchorIndex, h, target, 'above', 'close').offset !== null) closeHits++;
      if (o.ret >= lv) endHits++;
    }
    return { level: lv, touch: f(touchOffsets.length), close: f(closeHits), endpoint: f(endHits), sessionsToTouch: dist(touchOffsets) };
  });
  return {
    horizon: h,
    spacing,
    anchorsConsidered: anchors.length,
    excludedOverlap: sel.dropped.length,
    notMatured,
    n,
    up,
    flat: n - up - down,
    down,
    positive: f(up),
    returns: dist(outcomes.map((o) => o.ret)),
    worstClose: dist(outcomes.map((o) => o.minCloseRet)),
    worstLow: dist(outcomes.map((o) => o.minLowRet)),
    tradedBelowEventLow: f(tradedBelow),
    closedBelowEventLow: f(closedBelow),
    eventLowHeld: f(n - tradedBelow),
    bounces,
    troughCloseOffset: dist(outcomes.map((o) => o.minCloseOffset)),
    troughLowOffset: dist(outcomes.map((o) => o.minLowOffset)),
    anchorDates: dates,
    outcomes,
  };
};

/** Horizon stats for every standard horizon (1, 2, 3, 5, 10, 15, 20, 30, 60, 90) or a custom list. */
export const declineHorizonTable = (bars: readonly Bar[], anchors: readonly number[], horizons: readonly number[] = DECLINE_DEFAULTS.spec.horizons, opts: HorizonOptions = {}): DeclineHorizonStats[] =>
  horizons.map((h) => declineHorizonStats(bars, anchors, h, opts));

export interface FollowThrough {
  /** Further consecutive lower closes right after the event: at least 1, 2 and 3. */
  one: Frequency;
  two: Frequency;
  three: Frequency;
  /** The next close is above the event close. */
  immediateBounce: Frequency;
}

/** Continued selling right after the event. Each count has its own matured denominator. */
export const followThrough = (bars: readonly Bar[], anchors: readonly number[], opts: { level?: number; minCases?: number } = {}): FollowThrough => {
  const level = opts.level ?? DECLINE_DEFAULTS.proposed.level;
  const minCases = opts.minCases ?? DECLINE_DEFAULTS.proposed.minCases;
  const run = (k: number): Frequency => {
    const kept = selectNonOverlapping(anchors, k + 1).kept.filter((i) => i + k < bars.length);
    let hits = 0;
    for (const i of kept) {
      let ok = true;
      for (let j = 1; j <= k; j++) if (!(bars[i + j]!.close < bars[i + j - 1]!.close)) ok = false;
      if (ok) hits++;
    }
    return makeFrequency(hits, kept.length, kept.map((i) => bars[i]!.date), level, minCases);
  };
  const next = selectNonOverlapping(anchors, 2).kept.filter((i) => i + 1 < bars.length);
  const bounce = next.filter((i) => bars[i + 1]!.close > bars[i]!.close).length;
  return { one: run(1), two: run(2), three: run(3), immediateBounce: makeFrequency(bounce, next.length, next.map((i) => bars[i]!.date), level, minCases) };
};

/* ------------------------------------------------------------------------------------------------
 * Time to recovery
 * ---------------------------------------------------------------------------------------------- */

export type RecoveryTarget =
  | { kind: 'previous-close' }
  | { kind: 'event-open' }
  | { kind: 'event-high' }
  | { kind: 'above-event-close'; pct: number }
  | { kind: 'price'; price: number };

export const recoveryTargetLabel = (t: RecoveryTarget): string => {
  switch (t.kind) {
    case 'previous-close':
      return 'Close before the event';
    case 'event-open':
      return 'Event day open';
    case 'event-high':
      return 'Event day high';
    case 'above-event-close':
      return `${(t.pct * 100).toFixed(1)}% above the event close`;
    case 'price':
      return `Price ${t.price}`;
  }
};

const targetPrice = (bars: readonly Bar[], i: number, t: RecoveryTarget): number | null => {
  const b = bars[i]!;
  switch (t.kind) {
    case 'previous-close':
      return bars[i - 1]?.close ?? null;
    case 'event-open':
      return b.open;
    case 'event-high':
      return b.high;
    case 'above-event-close':
      return b.close * (1 + t.pct);
    case 'price':
      return t.price;
  }
};

export interface RecoveryCase {
  anchorIndex: number;
  anchorDate: ISODate;
  target: number;
  /** Sessions to the first return, or null. */
  sessions: number | null;
  /** True when data ended before the horizon without a return. Excluded from the rate. */
  censored: boolean;
}

export interface RecoveryStats {
  targetLabel: string;
  mode: TouchMode;
  horizon: number;
  anchorsConsidered: number;
  excludedOverlap: number;
  /** Anchors already at or above the target at the event close. Not part of the study. */
  alreadyAtTarget: number;
  /** Anchors with no defined target, for example no previous close. */
  noTarget: number;
  recovered: number;
  notRecovered: number;
  censored: number;
  /** recovered / (recovered + notRecovered). Censored cases are excluded and counted. */
  withinHorizon: Frequency;
  /** Sessions to the return among recovered cases only. */
  sessions: Maybe<Distribution>;
  /** Kaplan Meier median sessions over all cases, or null when censoring hides the median. */
  kmMedianSessions: number | null;
  cases: RecoveryCase[];
}

/** Earliest return to a chosen level after each anchor. The study starts with cases below the level. */
export const recoveryStats = (
  bars: readonly Bar[],
  anchors: readonly number[],
  h: number,
  target: RecoveryTarget,
  mode: TouchMode = 'close',
  opts: { level?: number; minCases?: number } = {},
): RecoveryStats => {
  const sel = selectNonOverlapping(anchors, h + DECLINE_DEFAULTS.spec.spacingExtra);
  const cases: RecoveryCase[] = [];
  let already = 0;
  let noTarget = 0;
  for (const i of sel.kept) {
    const t = targetPrice(bars, i, target);
    if (t === null) {
      noTarget++;
      continue;
    }
    if (bars[i]!.close >= t) {
      already++;
      continue;
    }
    const r = firstTouch(bars, i, h, t, 'above', mode);
    cases.push({ anchorIndex: i, anchorDate: bars[i]!.date, target: t, sessions: r.offset, censored: r.censored });
  }
  const rec = cases.filter((c) => c.sessions !== null);
  const not = cases.filter((c) => c.sessions === null && !c.censored);
  const cens = cases.filter((c) => c.sessions === null && c.censored);
  const decided = [...rec, ...not];
  const obs: SurvivalObservation[] = cases.map((c) => {
    if (c.sessions !== null) return { duration: c.sessions, ended: true };
    return { duration: c.censored ? Math.max(0, bars.length - 1 - c.anchorIndex) : h, ended: false };
  });
  return {
    targetLabel: recoveryTargetLabel(target),
    mode,
    horizon: h,
    anchorsConsidered: anchors.length,
    excludedOverlap: sel.dropped.length,
    alreadyAtTarget: already,
    noTarget,
    recovered: rec.length,
    notRecovered: not.length,
    censored: cens.length,
    withinHorizon: makeFrequency(rec.length, decided.length, decided.map((c) => c.anchorDate), opts.level ?? DECLINE_DEFAULTS.proposed.level, opts.minCases ?? DECLINE_DEFAULTS.proposed.minCases),
    sessions: dist(rec.map((c) => c.sessions!)),
    kmMedianSessions: kmMedian(kaplanMeier(obs)),
    cases,
  };
};

/* ------------------------------------------------------------------------------------------------
 * Lasting bottom
 * ---------------------------------------------------------------------------------------------- */

export type BottomStatus = 'held-and-rebounded' | 'low-broken' | 'no-rebound' | 'not-matured' | 'indeterminate';

export interface LastingBottom {
  anchorIndex: number;
  anchorDate: ISODate;
  eventLow: number;
  horizon: number;
  rebound: number;
  reboundMode: TouchMode;
  status: BottomStatus;
  /** First session where the rebound had occurred and the low had held so far. Prospective. */
  provisionalConfirmDate: ISODate | null;
  /** Session that completes the horizon. The status is final only from this date. */
  finalConfirmDate: ISODate | null;
  /** Session that traded below the event low, when it did. */
  brokenDate: ISODate | null;
  note: string;
}

/**
 * Lasting bottom over an explicit horizon: no session in i+1 .. i+H trades below the event low,
 * and a rebound of at least `rebound` above the event close occurs inside the window.
 * With an intraday rebound, a bar that both breaks the low and reaches the rebound level before
 * either was settled is indeterminate because the order inside the bar is unknown.
 */
export const lastingBottom = (
  bars: readonly Bar[],
  i: number,
  opts: { horizon?: number; rebound?: number; reboundMode?: TouchMode; eventLow?: number } = {},
): Maybe<LastingBottom> => {
  const a = bars[i];
  if (!a) return na('invalid-input', 'index outside series');
  const horizon = opts.horizon ?? DECLINE_DEFAULTS.proposed.lastingBottomHorizon;
  const rebound = opts.rebound ?? DECLINE_DEFAULTS.proposed.lastingBottomRebound;
  const mode = opts.reboundMode ?? 'close';
  const low = opts.eventLow ?? a.low;
  const target = a.close * (1 + rebound);
  const base = { anchorIndex: i, anchorDate: a.date, eventLow: low, horizon, rebound, reboundMode: mode };
  const last = Math.min(bars.length - 1, i + horizon);
  let reboundAt: number | null = null;
  for (let k = i + 1; k <= last; k++) {
    const b = bars[k]!;
    const breaks = b.low < low;
    const reaches = mode === 'close' ? b.close >= target : b.high >= target;
    if (breaks) {
      if (mode === 'intraday' && reaches && reboundAt === null) {
        return { ...base, status: 'indeterminate', provisionalConfirmDate: null, finalConfirmDate: null, brokenDate: b.date, note: 'The low broke and the rebound level traded in the same session. The order inside the bar is unknown.' };
      }
      return {
        ...base,
        status: 'low-broken',
        provisionalConfirmDate: reboundAt === null ? null : bars[reboundAt]!.date,
        finalConfirmDate: null,
        brokenDate: b.date,
        note: reboundAt === null ? 'The event low was undercut before any rebound.' : 'A rebound occurred first, then the event low was undercut inside the window.',
      };
    }
    if (reaches && reboundAt === null) reboundAt = k;
  }
  if (last < i + horizon) {
    return { ...base, status: 'not-matured', provisionalConfirmDate: reboundAt === null ? null : bars[reboundAt]!.date, finalConfirmDate: null, brokenDate: null, note: `Needs ${horizon} completed sessions after the event.` };
  }
  const finalDate = bars[i + horizon]!.date;
  if (reboundAt === null) return { ...base, status: 'no-rebound', provisionalConfirmDate: null, finalConfirmDate: finalDate, brokenDate: null, note: 'The low held but no rebound reached the threshold inside the window.' };
  return { ...base, status: 'held-and-rebounded', provisionalConfirmDate: bars[reboundAt]!.date, finalConfirmDate: finalDate, brokenDate: null, note: 'The low held for the whole window and the rebound threshold was reached.' };
};

export interface LastingBottomStats {
  horizon: number;
  rebound: number;
  reboundMode: TouchMode;
  counts: Record<BottomStatus, number>;
  /** held-and-rebounded / decided. Not matured and indeterminate cases are excluded and counted. */
  held: Frequency;
  cases: LastingBottom[];
}

export const lastingBottomStats = (
  bars: readonly Bar[],
  anchors: readonly number[],
  opts: { horizon?: number; rebound?: number; reboundMode?: TouchMode; level?: number; minCases?: number } = {},
): LastingBottomStats => {
  const horizon = opts.horizon ?? DECLINE_DEFAULTS.proposed.lastingBottomHorizon;
  const kept = selectNonOverlapping(anchors, horizon + DECLINE_DEFAULTS.spec.spacingExtra).kept;
  const counts: Record<BottomStatus, number> = { 'held-and-rebounded': 0, 'low-broken': 0, 'no-rebound': 0, 'not-matured': 0, indeterminate: 0 };
  const cases: LastingBottom[] = [];
  for (const i of kept) {
    const r = lastingBottom(bars, i, opts);
    if (isNa(r)) continue;
    counts[r.status]++;
    cases.push(r);
  }
  const decided = cases.filter((c) => c.status === 'held-and-rebounded' || c.status === 'low-broken' || c.status === 'no-rebound');
  return {
    horizon,
    rebound: opts.rebound ?? DECLINE_DEFAULTS.proposed.lastingBottomRebound,
    reboundMode: opts.reboundMode ?? 'close',
    counts,
    held: makeFrequency(counts['held-and-rebounded'], decided.length, decided.map((c) => c.anchorDate), opts.level ?? DECLINE_DEFAULTS.proposed.level, opts.minCases ?? DECLINE_DEFAULTS.proposed.minCases),
    cases,
  };
};

/* ------------------------------------------------------------------------------------------------
 * Ex post position inside a fully observed drawdown
 * ---------------------------------------------------------------------------------------------- */

export type DrawdownStage = 'front' | 'middle' | 'late' | 'after-trough';

export interface DrawdownPosition {
  /** Always true. This is a description made after the drawdown finished. */
  exPost: true;
  peakDate: ISODate;
  troughDate: ISODate;
  recoveryDate: ISODate;
  /** Trough close / peak close - 1. */
  depth: number;
  /** Sessions from peak to the event divided by sessions from peak to trough. Above 1 after the trough. */
  fractionToTrough: number;
  stage: DrawdownStage;
}

/**
 * Where a session sat inside its closing drawdown, described after the fact. Available only when
 * the drawdown is fully observed (the close later returned to the prior closing peak).
 */
export const drawdownPositions = (bars: readonly Bar[]): ((i: number) => Maybe<DrawdownPosition>) => {
  const n = bars.length;
  const peakOf = new Int32Array(n).fill(-1);
  const troughOf = new Int32Array(n).fill(-1);
  const recOf = new Int32Array(n).fill(-1);
  let p = 0;
  let trough = -1;
  for (let j = 1; j < n; j++) {
    if (bars[j]!.close >= bars[p]!.close) {
      if (trough >= 0) {
        for (let k = p + 1; k < j; k++) {
          peakOf[k] = p;
          troughOf[k] = trough;
          recOf[k] = j;
        }
      }
      p = j;
      trough = -1;
    } else {
      peakOf[j] = p;
      if (trough < 0 || bars[j]!.close < bars[trough]!.close) trough = j;
    }
  }
  return (i: number) => {
    if (i < 0 || i >= n) return na('invalid-input', 'index outside series');
    const pk = peakOf[i]!;
    if (pk < 0) return na('not-applicable', 'The session closed at a running closing high');
    const rc = recOf[i]!;
    if (rc < 0) return na('not-matured', 'The drawdown has not recovered, so its trough is not known');
    const tr = troughOf[i]!;
    const frac = (i - pk) / (tr - pk);
    const stage: DrawdownStage = i > tr ? 'after-trough' : frac < 1 / 3 ? 'front' : frac < 2 / 3 ? 'middle' : 'late';
    return {
      exPost: true,
      peakDate: bars[pk]!.date,
      troughDate: bars[tr]!.date,
      recoveryDate: bars[rc]!.date,
      depth: bars[tr]!.close / bars[pk]!.close - 1,
      fractionToTrough: frac,
      stage,
    };
  };
};

/* ------------------------------------------------------------------------------------------------
 * Selling exhaustion patterns
 * ---------------------------------------------------------------------------------------------- */

export interface PatternParams {
  gapDownMin: number;
  lowerWickMin: number;
  rsiMax: number;
  volumeMultiple: number;
  topQuartileClose: number;
  retestTolerance: number;
  retestRecovery: number;
  retestRecoverySessions: number;
  patternLookahead: number;
  retestWindow: number;
  multiDayMinDownCloses: number;
  delayedBottomWindow: number;
  delayedBottomHold: number;
  delayedBottomRebound: number;
  gapRecoveryMin: number;
}

export const DEFAULT_PATTERN_PARAMS: PatternParams = {
  gapDownMin: DECLINE_DEFAULTS.spec.gapDownMin,
  lowerWickMin: DECLINE_DEFAULTS.spec.lowerWickMin,
  rsiMax: DECLINE_DEFAULTS.spec.rsiMax,
  volumeMultiple: DECLINE_DEFAULTS.spec.volumeMultiple,
  topQuartileClose: DECLINE_DEFAULTS.spec.topQuartileClose,
  retestTolerance: DECLINE_DEFAULTS.spec.retestTolerance,
  retestRecovery: DECLINE_DEFAULTS.spec.retestRecovery,
  retestRecoverySessions: DECLINE_DEFAULTS.spec.retestRecoverySessions,
  patternLookahead: DECLINE_DEFAULTS.proposed.patternLookahead,
  retestWindow: DECLINE_DEFAULTS.proposed.retestWindow,
  multiDayMinDownCloses: DECLINE_DEFAULTS.proposed.multiDayMinDownCloses,
  delayedBottomWindow: DECLINE_DEFAULTS.proposed.delayedBottomWindow,
  delayedBottomHold: DECLINE_DEFAULTS.proposed.delayedBottomHold,
  delayedBottomRebound: DECLINE_DEFAULTS.proposed.delayedBottomRebound,
  gapRecoveryMin: DECLINE_DEFAULTS.proposed.gapRecoveryMin,
};

export type PatternId =
  | 'more-down-1'
  | 'more-down-2'
  | 'more-down-3'
  | 'immediate-bounce'
  | 'gap-down-close-above-open'
  | 'new-low-top-quartile-close'
  | 'gap-recovery-through-prev-close'
  | 'multi-day-decline-reversal'
  | 'volume-2x'
  | 'lower-wick'
  | 'rsi-oversold'
  | 'retest-then-recovery'
  | 'delayed-bottom';

interface PatternCtx {
  bars: readonly Bar[];
  prep: Prepared;
  params: PatternParams;
  threshold: number;
}

export interface ExhaustionPattern {
  id: PatternId;
  label: string;
  description: string;
  /** 'decline-event' patterns start from a qualifying decline. 'any-session' patterns scan every session. */
  scope: 'decline-event' | 'any-session';
  provenance: 'spec' | 'proposed' | 'mixed';
  /** Returns the confirm index (at or after i) using bars up to that index only, or null. */
  detect: (ctx: PatternCtx, i: number) => number | null;
}

const moreDown = (k: number) => (ctx: PatternCtx, i: number): number | null => {
  if (i + k >= ctx.bars.length) return null;
  for (let j = 1; j <= k; j++) if (!(ctx.bars[i + j]!.close < ctx.bars[i + j - 1]!.close)) return null;
  return i + k;
};

const gapOf = (bars: readonly Bar[], i: number): number | null => {
  const p = bars[i - 1];
  return p ? bars[i]!.open / p.close - 1 : null;
};

export const EXHAUSTION_PATTERNS: readonly ExhaustionPattern[] = [
  { id: 'more-down-1', label: 'One more lower close', description: 'The session after the selloff closes lower again. Usable from that close.', scope: 'decline-event', provenance: 'spec', detect: moreDown(1) },
  { id: 'more-down-2', label: 'Two more lower closes', description: 'Two further consecutive lower closes after the selloff. Usable from the second.', scope: 'decline-event', provenance: 'spec', detect: moreDown(2) },
  { id: 'more-down-3', label: 'Three more lower closes', description: 'Three further consecutive lower closes after the selloff. Usable from the third.', scope: 'decline-event', provenance: 'spec', detect: moreDown(3) },
  {
    id: 'immediate-bounce',
    label: 'Immediate bounce',
    description: 'The session after the selloff closes above the selloff close. Usable from that close.',
    scope: 'decline-event',
    provenance: 'spec',
    detect: (ctx, i) => (i + 1 < ctx.bars.length && ctx.bars[i + 1]!.close > ctx.bars[i]!.close ? i + 1 : null),
  },
  {
    id: 'gap-down-close-above-open',
    label: 'Gap down, close above open',
    description: 'Opens at least 3% below the previous close and closes above its open.',
    scope: 'any-session',
    provenance: 'spec',
    detect: (ctx, i) => {
      const g = gapOf(ctx.bars, i);
      const b = ctx.bars[i]!;
      return g !== null && g <= -ctx.params.gapDownMin && b.close > b.open ? i : null;
    },
  },
  {
    id: 'new-low-top-quartile-close',
    label: 'New 20 session low, top quartile close',
    description: 'On or after the selloff a session trades below the low of its previous 20 sessions and closes in the top quarter of its range.',
    scope: 'decline-event',
    provenance: 'mixed',
    detect: (ctx, i) => {
      const last = Math.min(ctx.bars.length - 1, i + ctx.params.patternLookahead);
      for (let k = i; k <= last; k++) {
        const b = ctx.bars[k]!;
        const prior = ctx.prep.priorLow20[k] ?? null;
        const range = b.high - b.low;
        if (prior !== null && b.low < prior && range > 0 && (b.close - b.low) / range >= ctx.params.topQuartileClose) return k;
      }
      return null;
    },
  },
  {
    id: 'gap-recovery-through-prev-close',
    label: 'Gap recovered through previous close',
    description: 'Opens below the previous close by the minimum gap and closes above the previous close.',
    scope: 'any-session',
    provenance: 'mixed',
    detect: (ctx, i) => {
      const g = gapOf(ctx.bars, i);
      return g !== null && g <= -ctx.params.gapRecoveryMin && ctx.bars[i]!.close > ctx.bars[i - 1]!.close ? i : null;
    },
  },
  {
    id: 'multi-day-decline-reversal',
    label: 'Multi day decline, then reversal',
    description: 'A run of consecutive lower closes whose total decline reaches the threshold, followed by a higher close. Usable from the higher close.',
    scope: 'any-session',
    provenance: 'proposed',
    detect: (ctx, i) => {
      // i is the last down close of the run. The reversal close at i + 1 confirms.
      const { bars } = ctx;
      if (i + 1 >= bars.length || !(bars[i + 1]!.close > bars[i]!.close)) return null;
      let k = i;
      let downs = 0;
      while (k > 0 && bars[k]!.close < bars[k - 1]!.close) {
        downs++;
        k--;
      }
      if (downs < ctx.params.multiDayMinDownCloses) return null;
      return bars[i]!.close / bars[k]!.close - 1 <= -ctx.threshold ? i + 1 : null;
    },
  },
  {
    id: 'volume-2x',
    label: 'Volume at least 2x',
    description: 'Selloff volume is at least twice the mean of the previous 20 sessions.',
    scope: 'decline-event',
    provenance: 'spec',
    detect: (ctx, i) => {
      const rv = ctx.prep.relVol[i] ?? null;
      return rv !== null && rv >= ctx.params.volumeMultiple ? i : null;
    },
  },
  {
    id: 'lower-wick',
    label: 'Long lower wick',
    description: 'The lower wick is at least half of the selloff day range.',
    scope: 'decline-event',
    provenance: 'spec',
    detect: (ctx, i) => {
      const b = ctx.bars[i]!;
      const range = b.high - b.low;
      return range > 0 && (Math.min(b.open, b.close) - b.low) / range >= ctx.params.lowerWickMin ? i : null;
    },
  },
  {
    id: 'rsi-oversold',
    label: 'RSI14 below 30',
    description: 'Wilder RSI14 is below 30 at the selloff close.',
    scope: 'decline-event',
    provenance: 'spec',
    detect: (ctx, i) => {
      const r = ctx.prep.rsi[i] ?? null;
      return r !== null && r < ctx.params.rsiMax ? i : null;
    },
  },
  {
    id: 'retest-then-recovery',
    label: 'Retest, then recovery',
    description: 'A later low comes within 1% of the selloff low, then a close at least 3% above the retest close follows within five sessions. Usable from that close.',
    scope: 'decline-event',
    provenance: 'mixed',
    detect: (ctx, i) => {
      const { bars, params } = ctx;
      const low = bars[i]!.low;
      const lastRetest = Math.min(bars.length - 1, i + params.retestWindow);
      for (let r = i + 1; r <= lastRetest; r++) {
        const b = bars[r]!;
        if (b.low < low * (1 - params.retestTolerance)) return null; // the low failed decisively before any valid retest recovery
        if (Math.abs(b.low / low - 1) > params.retestTolerance) continue;
        const lastRec = Math.min(bars.length - 1, r + params.retestRecoverySessions);
        for (let k = r + 1; k <= lastRec; k++) {
          if (bars[k]!.low < low * (1 - params.retestTolerance)) break;
          if (bars[k]!.close >= b.close * (1 + params.retestRecovery)) return k;
        }
      }
      return null;
    },
  },
  {
    id: 'delayed-bottom',
    label: 'Delayed bottom',
    description: 'The selloff low is undercut inside the window, then the later low holds for the hold period with a rebound. Usable only once the window and the hold period have both completed.',
    scope: 'decline-event',
    provenance: 'proposed',
    detect: (ctx, i) => {
      const { bars, params } = ctx;
      const windowEnd = i + params.delayedBottomWindow;
      if (windowEnd >= bars.length) return null;
      let m = -1;
      for (let k = i + 1; k <= windowEnd; k++) if (m < 0 || bars[k]!.low < bars[m]!.low) m = k;
      if (m < 0 || !(bars[m]!.low < bars[i]!.low)) return null;
      const confirm = Math.max(windowEnd, m + params.delayedBottomHold);
      if (confirm >= bars.length) return null;
      let rebound = false;
      for (let k = m + 1; k <= confirm; k++) {
        if (bars[k]!.low < bars[m]!.low) return null;
        if (bars[k]!.close >= bars[m]!.close * (1 + params.delayedBottomRebound)) rebound = true;
      }
      return rebound ? confirm : null;
    },
  },
];

export interface PatternOccurrence {
  patternId: PatternId;
  eventIndex: number;
  eventDate: ISODate;
  /** Low of the event session, used for event low tests after the confirm anchor. */
  eventLow: number;
  confirmIndex: number;
  confirmDate: ISODate;
  /** Sessions between the event and the date the pattern became usable. */
  confirmLag: number;
}

export interface PatternOptions {
  threshold: number;
  basis?: DeclineBasis;
  params?: Partial<PatternParams>;
  from?: ISODate;
  to?: ISODate;
}

const patternById = (id: PatternId): ExhaustionPattern => {
  const p = EXHAUSTION_PATTERNS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown pattern ${id}`);
  return p;
};

/** Every occurrence of a pattern, each with its event date and the later date it became usable. */
export const detectPattern = (bars: readonly Bar[], id: PatternId, opts: PatternOptions): PatternOccurrence[] => {
  const pattern = patternById(id);
  const threshold = Math.abs(opts.threshold);
  const ctx: PatternCtx = { bars, prep: prepare(bars), params: { ...DEFAULT_PATTERN_PARAMS, ...opts.params }, threshold };
  const candidates: number[] = [];
  if (pattern.scope === 'decline-event') {
    for (const o of findDeclines(bars, { threshold, basis: opts.basis, from: opts.from, to: opts.to }).occurrences) candidates.push(o.index);
  } else {
    for (let i = 1; i < bars.length; i++) {
      const d = bars[i]!.date;
      if (opts.from && d < opts.from) continue;
      if (opts.to && d > opts.to) break;
      candidates.push(i);
    }
  }
  const out: PatternOccurrence[] = [];
  for (const i of candidates) {
    const c = pattern.detect(ctx, i);
    if (c === null) continue;
    out.push({ patternId: id, eventIndex: i, eventDate: bars[i]!.date, eventLow: bars[i]!.low, confirmIndex: c, confirmDate: bars[c]!.date, confirmLag: c - i });
  }
  return out;
};

export interface PatternStudy {
  pattern: Pick<ExhaustionPattern, 'id' | 'label' | 'description' | 'scope' | 'provenance'>;
  occurrences: PatternOccurrence[];
  /** Distinct confirm anchors. Several events can confirm on one session. The earliest event is kept. */
  anchors: number;
  /** Outcomes measured from the confirm anchor, never from the event day. */
  horizons: DeclineHorizonStats[];
}

/** A pattern's occurrences and the outcomes that followed its confirm anchors. */
export const studyPattern = (
  bars: readonly Bar[],
  id: PatternId,
  opts: PatternOptions & { horizons?: readonly number[]; level?: number; minCases?: number; bounceLevels?: readonly number[] },
): PatternStudy => {
  const pattern = patternById(id);
  const occurrences = detectPattern(bars, id, opts);
  const lowAt = new Map<number, number>();
  for (const o of occurrences) if (!lowAt.has(o.confirmIndex)) lowAt.set(o.confirmIndex, o.eventLow);
  const anchors = [...lowAt.keys()].sort((a, b) => a - b);
  const horizons = (opts.horizons ?? DECLINE_DEFAULTS.spec.horizons).map((h) =>
    declineHorizonStats(bars, anchors, h, { level: opts.level, minCases: opts.minCases, bounceLevels: opts.bounceLevels, eventLowOf: (a) => lowAt.get(a) ?? bars[a]!.low }),
  );
  return {
    pattern: { id: pattern.id, label: pattern.label, description: pattern.description, scope: pattern.scope, provenance: pattern.provenance },
    occurrences,
    anchors: anchors.length,
    horizons,
  };
};

/* ------------------------------------------------------------------------------------------------
 * Hold, trim, add exposure scenarios
 * ---------------------------------------------------------------------------------------------- */

export interface ExposureAssumptions {
  /** Shares held at the anchor. */
  shares: number;
  /** Price used to size the position, normally the latest completed close. */
  price: number;
  /** Fraction of shares sold at the anchor close in the trim scenario. */
  trimFraction: number;
  /** Shares bought at the anchor close in the add scenario. */
  addShares: number;
}

export type ExposureScenarioId = 'hold' | 'trim' | 'add';

export interface ExposureScenario {
  id: ExposureScenarioId;
  label: string;
  /** Shares exposed after the anchor. */
  shares: number;
  /** Dollar change at the horizon endpoint across historical cases. */
  endpoint: Maybe<Distribution>;
  /** Dollar change at the worst close inside the window across historical cases. */
  worstClose: Maybe<Distribution>;
  /** Per case dollar change at the endpoint, in case order. */
  perCase: { anchorDate: ISODate; endpoint: number; worstClose: number }[];
}

export interface ExposureComparison {
  /** Always true. These are historical what if exposures, not recommendations. */
  hypothetical: true;
  horizon: number;
  n: number;
  assumptions: string[];
  scenarios: ExposureScenario[];
}

/**
 * Apply each historical case's returns to share exposures sized at one price. Proceeds from a trim
 * are held as cash with no return. An add is bought at the anchor close. No fees, taxes or slippage.
 */
export const exposureScenarios = (outcomes: readonly ForwardOutcome[], a: ExposureAssumptions): Maybe<ExposureComparison> => {
  if (!(a.shares >= 0) || !(a.price > 0) || !(a.trimFraction >= 0 && a.trimFraction <= 1) || !(a.addShares >= 0)) {
    return na('invalid-input', 'Shares and add shares must not be negative, price must be positive, trim fraction must be between 0 and 1');
  }
  const mk = (id: ExposureScenarioId, label: string, shares: number): ExposureScenario => {
    const perCase = outcomes.map((o) => ({ anchorDate: o.anchorDate, endpoint: shares * a.price * o.ret, worstClose: shares * a.price * o.minCloseRet }));
    return { id, label, shares, endpoint: dist(perCase.map((c) => c.endpoint)), worstClose: dist(perCase.map((c) => c.worstClose)), perCase };
  };
  return {
    hypothetical: true,
    horizon: outcomes[0]?.horizon ?? 0,
    n: outcomes.length,
    assumptions: [
      `Position sized at ${a.shares} shares and a price of ${a.price}.`,
      `Trim sells ${(a.trimFraction * 100).toFixed(0)}% of shares at the anchor close. Proceeds are held as cash with no return.`,
      `Add buys ${a.addShares} shares at the anchor close.`,
      'No fees, taxes, slippage or dividends.',
      'Each case applies the historical close to close path after its anchor to the same share count.',
    ],
    scenarios: [mk('hold', 'Hold', a.shares), mk('trim', 'Trim', a.shares * (1 - a.trimFraction)), mk('add', 'Add', a.shares + a.addShares)],
  };
};

export interface ExposurePathPoint {
  offset: number;
  date: ISODate;
  hold: number;
  trim: number;
  add: number;
}

/** Dollar path for one historical case from the anchor close through the horizon, as far as data exists. */
export const exposurePath = (bars: readonly Bar[], i: number, h: number, a: ExposureAssumptions): Maybe<ExposurePathPoint[]> => {
  const anchor = bars[i];
  if (!anchor) return na('invalid-input', 'index outside series');
  const out: ExposurePathPoint[] = [];
  const last = Math.min(bars.length - 1, i + h);
  for (let k = i; k <= last; k++) {
    const r = bars[k]!.close / anchor.close - 1;
    const v = a.price * r;
    out.push({ offset: k - i, date: bars[k]!.date, hold: a.shares * v, trim: a.shares * (1 - a.trimFraction) * v, add: (a.shares + a.addShares) * v });
  }
  return out;
};
