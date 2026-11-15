/**
 * Moving average crossings, run age and distance (owner specification section 8).
 *
 * Definitions
 * - SMA(N) on a day is the mean of the last N completed, valid closes on consecutive exchange
 *   sessions through that day. Fewer than N sessions, a missing session inside the window or a
 *   corrupt close makes the SMA unavailable. A 200 session average is never produced from 199.
 * - Day state: above when close > SMA, below when close < SMA, touch when close equals SMA inside
 *   a relative tolerance, unavailable otherwise.
 * - A run is a maximal streak of consecutive sessions on one side. The strict crossing close is
 *   session 1. The exit close ends the run and is not part of the same side count.
 * - Touch policy. 'boundary' (default): a touch ends the run with exit kind touch and the touch
 *   session belongs to neither side. A run that begins right after a touch has start kind touch.
 *   'carry': a touch inherits the side of the session before it, so the run continues.
 * - Start kinds: cross (previous session was on the other side), touch (previous session was a
 *   touch), leading (first observable day already on one side, not a confirmed crossing),
 *   after-gap (first observable day after a gap or corrupt observation, unverified).
 * - Status: completed (ended by an observed cross or touch), active (the live unfinished run,
 *   right censored), interrupted (the next session had no usable SMA, right censored).
 * - Only runs with a cross or touch start AND a cross or touch exit count as confirmed completed
 *   runs. Leading and after-gap runs are excluded from duration statistics unless the caller sets
 *   `includeUnverified`.
 * - Farthest distance from the average: most negative C/SMA - 1 for a below run, most positive for
 *   an above run, using the SMA of each date. Extreme from crossing: most adverse (below run) or
 *   most favorable (above run) C/C(entry) - 1 over the same side sessions, entry included, exit
 *   excluded. Each extreme has its own date. Ties resolve to the earliest date.
 * - Sessions to exit after day a, for a completed run of length L >= a, is L + 1 - a.
 *   L = 3 and a = 3 gives 1. Runs that never reached day a do not enter.
 * - Survival. G(t) = P(L >= t) is estimated with Kaplan Meier over run length. A run known to have
 *   reached L sessions without an observed ending (active or interrupted) tells us L >= observed,
 *   so it stays in the risk sets for t < observed and leaves before t = observed.
 *   P(exit within the next k sessions | age a) = 1 - G(a + k) / G(a).
 */
import { nextSession } from './core/calendar';
import { sma as coreSma } from './core/indicators';
import { distribution, kaplanMeier, survivalAt, wilson, type SurvivalObservation, type SurvivalStep } from './core/stats';
import { isNa, na, type Bar, type ISODate, type Maybe, type ModelStatus, type Proportion } from './core/types';

export type Side = 'above' | 'below';
export type DayState = Side | 'touch' | 'unavailable';
export type RunStartKind = 'cross' | 'touch' | 'leading' | 'after-gap';
export type RunExitKind = 'cross' | 'touch' | 'gap';
export type RunStatus = 'completed' | 'active' | 'interrupted';
export type TouchPolicy = 'boundary' | 'carry';

export const MA_WINDOWS = [5, 10, 20, 50, 100, 200] as const;

/** Thresholds. `spec` values come from the owner specification, `proposed` values need reconciling with the reference. */
export const MA_DEFAULTS = {
  windows: { value: MA_WINDOWS, provenance: 'spec' },
  exitWindows: { value: [1, 3, 5] as readonly number[], provenance: 'spec' },
  histogramBins: { value: { target: 8, min: 7, max: 12 }, provenance: 'spec' },
  touchPolicy: { value: 'boundary' as TouchPolicy, provenance: 'proposed' },
  touchTolerance: { value: 1e-9, provenance: 'proposed' },
  /** Minimum runs at risk at the chosen age before conditional exit odds are shown. */
  minAtRisk: { value: 10, provenance: 'proposed' },
  /** Below this many comparable runs a descriptive table carries a small sample warning. */
  minDescriptive: { value: 10, provenance: 'proposed' },
} as const;

export interface MaRunOptions {
  touchPolicy?: TouchPolicy;
  /** Relative tolerance for close equal to SMA. */
  touchTolerance?: number;
  /** Count leading and after-gap runs that ended with a real exit as completed samples. Their length is a lower bound. */
  includeUnverified?: boolean;
}

export interface MaClassification {
  window: number;
  state: DayState[];
  sma: (number | null)[];
  /** Signed C/SMA - 1. Null when the SMA is unavailable. */
  distance: (number | null)[];
  /** First index with a usable SMA, or -1. */
  firstObservable: number;
  /** Indices whose bar does not follow the previous bar by exactly one exchange session, or whose close is corrupt. */
  breaks: number[];
}

export interface MaRun {
  window: number;
  side: Side;
  startKind: RunStartKind;
  status: RunStatus;
  /** True when both ends are observed boundaries. Only these are confirmed completed runs. */
  confirmed: boolean;
  entryIndex: number;
  entryDate: ISODate;
  entryClose: number;
  /** Consecutive same side sessions, entry included, exit excluded. */
  length: number;
  lastIndex: number;
  lastDate: ISODate;
  lastClose: number;
  /** Signed C/SMA - 1 on the last same side session. */
  lastDistance: number;
  exitKind: RunExitKind | null;
  exitIndex: number | null;
  exitDate: ISODate | null;
  exitClose: number | null;
  /** exitClose / entryClose - 1 for a run that ended with an observed exit. */
  moveToExit: Maybe<number>;
  /** Most negative (below) or most positive (above) C/SMA - 1 inside the run. */
  farthestDistance: number;
  farthestDistanceDate: ISODate;
  farthestDistanceIndex: number;
  /** Most adverse (below) or most favorable (above) C/C(entry) - 1 inside the run, entry included. */
  extremeFromEntry: number;
  extremeFromEntryDate: ISODate;
  extremeFromEntryIndex: number;
  /** True when both extremes fall on one date, so a view can show a single date. */
  extremeDatesCoincide: boolean;
}

export interface MaCurrentState {
  window: number;
  date: ISODate;
  close: number;
  sma: number;
  side: Side | 'touch';
  /** Same side sessions so far. 0 on a touch day. */
  age: number;
  /** Signed C/SMA - 1 on the last bar. */
  distance: number;
  /** The live run. Null on a touch day. */
  run: MaRun | null;
}

export interface MaRunSet {
  window: number;
  touchPolicy: TouchPolicy;
  includeUnverified: boolean;
  runs: MaRun[];
  current: Maybe<MaCurrentState>;
  firstObservableDate: ISODate | null;
  lastDate: ISODate | null;
  sessions: number;
  /** Runs by evidence class, so every exclusion can be shown. */
  counts: {
    total: number;
    confirmedCompleted: number;
    leading: number;
    afterGap: number;
    interrupted: number;
    active: number;
  };
}

export interface DurationStats {
  n: number;
  median: number;
  mean: number;
  p25: number;
  p75: number;
  longest: number;
  longestEntryDate: ISODate;
}

const validClose = (b: Bar): boolean => Number.isFinite(b.close) && b.close > 0;

/** Day by day state versus SMA(window). Windows never span a missing session or a corrupt close. */
export const classifySessions = (bars: readonly Bar[], window: number, opts: MaRunOptions = {}): MaClassification => {
  const n = bars.length;
  const tol = opts.touchTolerance ?? MA_DEFAULTS.touchTolerance.value;
  const policy = opts.touchPolicy ?? MA_DEFAULTS.touchPolicy.value;
  const smaOut: (number | null)[] = new Array(n).fill(null);
  const breaks: number[] = [];
  // Split into segments of consecutive exchange sessions with valid closes, then reuse the core SMA.
  let segStart = 0;
  const flush = (end: number) => {
    // Segment covers [segStart, end).
    const closes: number[] = [];
    for (let k = segStart; k < end; k++) closes.push(bars[k]!.close);
    const s = coreSma(closes, window);
    for (let k = 0; k < s.length; k++) smaOut[segStart + k] = s[k] ?? null;
  };
  for (let i = 0; i < n; i++) {
    const b = bars[i]!;
    if (!validClose(b)) {
      if (i > segStart) flush(i);
      breaks.push(i);
      segStart = i + 1;
      continue;
    }
    if (i > segStart && b.date !== nextSession(bars[i - 1]!.date)) {
      flush(i);
      breaks.push(i);
      segStart = i;
    }
  }
  if (n > segStart) flush(n);

  const state: DayState[] = new Array(n).fill('unavailable');
  const distance: (number | null)[] = new Array(n).fill(null);
  let firstObservable = -1;
  for (let i = 0; i < n; i++) {
    const m = smaOut[i];
    if (m === null || m === undefined || !(m > 0)) continue;
    if (firstObservable < 0) firstObservable = i;
    const c = bars[i]!.close;
    const d = c / m - 1;
    if (Math.abs(c - m) <= tol * m) {
      distance[i] = 0;
      const prev = i > 0 ? state[i - 1]! : 'unavailable';
      state[i] = policy === 'carry' && (prev === 'above' || prev === 'below') ? prev : 'touch';
    } else {
      distance[i] = d;
      state[i] = d > 0 ? 'above' : 'below';
    }
  }
  return { window, state, sma: smaOut, distance, firstObservable, breaks };
};

/** SMA(window) on bar i, or the reason it cannot be stated. */
export const smaAt = (bars: readonly Bar[], i: number, window: number): Maybe<number> => {
  if (i < 0 || i >= bars.length) return na('invalid-input', 'index outside series');
  const cls = classifySessions(bars, window);
  const v = cls.sma[i];
  if (typeof v === 'number') return v;
  return unavailableReason(bars, cls, i);
};

const unavailableReason = (bars: readonly Bar[], cls: MaClassification, i: number) => {
  const w = cls.window;
  const from = i - w + 1;
  const brk = cls.breaks.find((k) => k > Math.max(from, 0) - (validClose(bars[k]!) ? 0 : 1) && k <= i);
  if (brk !== undefined) {
    const b = bars[brk]!;
    return validClose(b)
      ? na('missing-session', `A session is missing before ${b.date}, inside the ${w} session window`)
      : na('invalid-input', `The close on ${b.date} is not a valid price`);
  }
  return na('insufficient-history', `${w} session average needs ${w} completed sessions, series has ${Math.min(i + 1, bars.length)}`);
};

/** Build every run above and below SMA(window), plus the current state on the last bar. */
export const buildRuns = (bars: readonly Bar[], window: number, opts: MaRunOptions = {}): MaRunSet => {
  const policy = opts.touchPolicy ?? MA_DEFAULTS.touchPolicy.value;
  const cls = classifySessions(bars, window, opts);
  const { state, distance } = cls;
  const n = bars.length;
  const runs: MaRun[] = [];
  let seenAvailable = false;
  for (let i = 0; i < n; ) {
    const s = state[i]!;
    if (s !== 'above' && s !== 'below') {
      if (s !== 'unavailable') seenAvailable = true;
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && state[j + 1] === s) j++;
    const prev: DayState = i > 0 ? state[i - 1]! : 'unavailable';
    const startKind: RunStartKind =
      prev === 'touch' ? 'touch' : prev === 'above' || prev === 'below' ? 'cross' : seenAvailable ? 'after-gap' : 'leading';
    const next: DayState | null = j + 1 < n ? state[j + 1]! : null;
    const exitKind: RunExitKind | null = next === null ? null : next === 'unavailable' ? 'gap' : next === 'touch' ? 'touch' : 'cross';
    const status: RunStatus = exitKind === null ? 'active' : exitKind === 'gap' ? 'interrupted' : 'completed';
    const entry = bars[i]!;
    let farIdx = i;
    let far = distance[i]!;
    let extIdx = i;
    let ext = 0;
    for (let k = i + 1; k <= j; k++) {
      const d = distance[k]!;
      const r = bars[k]!.close / entry.close - 1;
      if (s === 'below' ? d < far : d > far) {
        far = d;
        farIdx = k;
      }
      if (s === 'below' ? r < ext : r > ext) {
        ext = r;
        extIdx = k;
      }
    }
    const last = bars[j]!;
    const exitBar = status === 'completed' ? bars[j + 1]! : null;
    runs.push({
      window,
      side: s,
      startKind,
      status,
      confirmed: status === 'completed' && (startKind === 'cross' || startKind === 'touch'),
      entryIndex: i,
      entryDate: entry.date,
      entryClose: entry.close,
      length: j - i + 1,
      lastIndex: j,
      lastDate: last.date,
      lastClose: last.close,
      lastDistance: distance[j]!,
      exitKind,
      exitIndex: exitBar ? j + 1 : null,
      exitDate: exitBar ? exitBar.date : null,
      exitClose: exitBar ? exitBar.close : null,
      moveToExit: exitBar
        ? exitBar.close / entry.close - 1
        : status === 'active'
          ? na('not-matured', 'The run is still active')
          : na('missing-session', 'The run was interrupted by a missing or corrupt session, the exit was not observed'),
      farthestDistance: far,
      farthestDistanceDate: bars[farIdx]!.date,
      farthestDistanceIndex: farIdx,
      extremeFromEntry: ext,
      extremeFromEntryDate: bars[extIdx]!.date,
      extremeFromEntryIndex: extIdx,
      extremeDatesCoincide: farIdx === extIdx,
    });
    seenAvailable = true;
    i = j + 1;
  }

  let current: Maybe<MaCurrentState>;
  if (n === 0) current = na('no-coverage', 'No completed sessions');
  else {
    const li = n - 1;
    const st = state[li]!;
    const lastBar = bars[li]!;
    if (st === 'unavailable') current = unavailableReason(bars, cls, li);
    else if (st === 'touch') {
      current = { window, date: lastBar.date, close: lastBar.close, sma: cls.sma[li]!, side: 'touch', age: 0, distance: 0, run: null };
    } else {
      const run = runs[runs.length - 1]!;
      current = { window, date: lastBar.date, close: lastBar.close, sma: cls.sma[li]!, side: st, age: run.length, distance: distance[li]!, run };
    }
  }

  return {
    window,
    touchPolicy: policy,
    includeUnverified: opts.includeUnverified ?? false,
    runs,
    current,
    firstObservableDate: cls.firstObservable >= 0 ? bars[cls.firstObservable]!.date : null,
    lastDate: n ? bars[n - 1]!.date : null,
    sessions: n,
    counts: {
      total: runs.length,
      confirmedCompleted: runs.filter((r) => r.confirmed).length,
      leading: runs.filter((r) => r.startKind === 'leading').length,
      afterGap: runs.filter((r) => r.startKind === 'after-gap').length,
      interrupted: runs.filter((r) => r.status === 'interrupted').length,
      active: runs.filter((r) => r.status === 'active').length,
    },
  };
};

/** Runs that count as completed samples for one side under the set's evidence policy. */
export const completedRuns = (set: MaRunSet, side: Side): MaRun[] =>
  set.runs.filter((r) => r.side === side && r.status === 'completed' && (r.confirmed || set.includeUnverified));

/** Median, mean, IQR and longest length of completed runs on one side. Null with no completed runs. */
export const durationStats = (set: MaRunSet, side: Side): DurationStats | null => {
  const runs = completedRuns(set, side);
  const d = distribution(runs.map((r) => r.length));
  if (!d) return null;
  const longest = runs.reduce((a, b) => (b.length > a.length ? b : a));
  return { n: d.n, median: d.median, mean: d.mean, p25: d.p25, p75: d.p75, longest: d.max, longestEntryDate: longest.entryDate };
};

export interface MaOverviewCell {
  window: number;
  current: Maybe<MaCurrentState>;
  /** Typical finished run lengths. Null when no completed run exists on that side. */
  above: DurationStats | null;
  below: DurationStats | null;
  counts: MaRunSet['counts'];
  firstObservableDate: ISODate | null;
}

/** Compact overview for all six averages (or a chosen list): current side, age, distance and typical finished lengths. */
export const maOverview = (bars: readonly Bar[], opts: MaRunOptions & { windows?: readonly number[] } = {}): MaOverviewCell[] =>
  (opts.windows ?? MA_WINDOWS).map((w) => {
    const set = buildRuns(bars, w, opts);
    return {
      window: w,
      current: set.current,
      above: durationStats(set, 'above'),
      below: durationStats(set, 'below'),
      counts: set.counts,
      firstObservableDate: set.firstObservableDate,
    };
  });

export type StudySide = Side | 'current';

const resolveSide = (set: MaRunSet, side: StudySide): Maybe<Side> => {
  if (side !== 'current') return side;
  if (isNa(set.current)) return set.current;
  if (set.current.side === 'touch') return na('not-applicable', 'The last close sits on the average, so there is no current side');
  return set.current.side;
};

export interface AgeStudyRow {
  entryDate: ISODate;
  exitDate: ISODate;
  exitKind: RunExitKind;
  length: number;
  /** L + 1 - a. */
  sessionsToExit: number;
  moveToExit: number;
}

export interface AgeStudy {
  window: number;
  side: Side;
  /** Elapsed same side sessions the comparison starts from. */
  age: number;
  /** Completed runs on this side. */
  completed: number;
  /** Completed runs that reached day `age`. The denominator of every figure here. */
  reached: number;
  /** Completed runs that ended before day `age` and do not enter. */
  notReached: number;
  median: number | null;
  mean: number | null;
  p25: number | null;
  p75: number | null;
  longest: number | null;
  rows: AgeStudyRow[];
  /** Set when fewer comparable runs exist than the descriptive minimum. */
  warning: string | null;
  /** The live run on this side, when there is one. It is never a completed sample. */
  active: { age: number; entryDate: ISODate } | null;
}

/**
 * Sessions to exit after day `age`. Among completed same side runs with length L >= age the
 * answer is L + 1 - age. Runs that never reached day `age` are counted and left out.
 */
export const studyAfterAge = (set: MaRunSet, params: { side: StudySide; age: number }): Maybe<AgeStudy> => {
  const side = resolveSide(set, params.side);
  if (isNa(side)) return side;
  const age = params.age;
  if (!Number.isInteger(age) || age < 1) return na('invalid-input', 'Elapsed sessions must be a whole number of 1 or more');
  const done = completedRuns(set, side);
  const reachedRuns = done.filter((r) => r.length >= age);
  const rows: AgeStudyRow[] = reachedRuns.map((r) => ({
    entryDate: r.entryDate,
    exitDate: r.exitDate!,
    exitKind: r.exitKind!,
    length: r.length,
    sessionsToExit: r.length + 1 - age,
    moveToExit: r.moveToExit as number,
  }));
  const d = distribution(rows.map((r) => r.sessionsToExit));
  const live = set.runs[set.runs.length - 1];
  const min = MA_DEFAULTS.minDescriptive.value;
  return {
    window: set.window,
    side,
    age,
    completed: done.length,
    reached: reachedRuns.length,
    notReached: done.length - reachedRuns.length,
    median: d ? d.median : null,
    mean: d ? d.mean : null,
    p25: d ? d.p25 : null,
    p75: d ? d.p75 : null,
    longest: d ? d.max : null,
    rows,
    warning:
      reachedRuns.length === 0
        ? `No completed run reached day ${age}.`
        : reachedRuns.length < min
          ? `Small sample. Only ${reachedRuns.length} completed runs reached day ${age}.`
          : null,
    active: live && live.status === 'active' && live.side === side ? { age: live.length, entryDate: live.entryDate } : null,
  };
};

export interface RunSurvival {
  window: number;
  side: Side;
  /** Kaplan Meier steps over run length. survival at t is P(L > t). */
  steps: SurvivalStep[];
  /** Runs with an observed ending. */
  events: number;
  /** Active and interrupted runs that add risk set information. */
  censored: number;
  /** Censored runs of one session. They carry no information and are left out. */
  uninformative: number;
  /** Largest duration in the observations. Estimates beyond it have no support. */
  maxObserved: number;
}

const eligibleStart = (set: MaRunSet, r: MaRun): boolean => r.startKind === 'cross' || r.startKind === 'touch' || set.includeUnverified;

/** Kaplan Meier survival over run length for one side, with active and interrupted runs right censored. */
export const runSurvival = (set: MaRunSet, side: Side): RunSurvival => {
  const obs: SurvivalObservation[] = [];
  let events = 0;
  let censored = 0;
  let uninformative = 0;
  for (const r of set.runs) {
    if (r.side !== side || !eligibleStart(set, r)) continue;
    if (r.status === 'completed') {
      obs.push({ duration: r.length, ended: true });
      events++;
    } else if (r.length >= 2) {
      // Known L >= length. Not observed whether L equals length, so it leaves before t = length.
      obs.push({ duration: r.length - 1, ended: false });
      censored++;
    } else uninformative++;
  }
  return {
    window: set.window,
    side,
    steps: kaplanMeier(obs),
    events,
    censored,
    uninformative,
    maxObserved: obs.reduce((m, o) => Math.max(m, o.duration), 0),
  };
};

/** G(t) = P(L >= t) from Kaplan Meier steps. */
const reachProb = (steps: readonly SurvivalStep[], t: number): number => (t <= 1 ? 1 : survivalAt(steps, t - 1));

export interface ExitOddsRow {
  /** Exit inside the next `within` sessions. */
  within: number;
  /** Kaplan Meier estimate 1 - G(age + within) / G(age). Withheld unless the gate passes. */
  probability: Maybe<number>;
  /** Exact share of completed runs that reached the age and exited inside the window. */
  completedOnly: Proportion | null;
  /** Historical censored runs that reached the age and whose outcome inside the window is unknown. */
  unresolved: number;
  /** Conservative bounds treating every unresolved run as staying, then as exiting. */
  bounds: { lo: number; hi: number } | null;
}

export interface ExitOdds {
  window: number;
  side: Side;
  age: number;
  status: ModelStatus;
  /** Runs at risk at the chosen age (reached it with a known next step). */
  atRisk: number;
  minAtRisk: number;
  rows: ExitOddsRow[];
  /** Smallest number of further sessions by which at least half of comparable runs had exited. */
  typicalRemaining: Maybe<number>;
  survival: RunSurvival;
  note: string;
}

/**
 * Odds that a run of the given age exits inside the next 1, 3, 5 or chosen sessions.
 * The estimate is shown only with at least `minAtRisk` runs at risk at that age and with observed
 * support through the window. Descriptive counts stay available either way.
 */
export const exitOdds = (
  set: MaRunSet,
  params: { side: StudySide; age?: number; windows?: readonly number[]; minAtRisk?: number },
): Maybe<ExitOdds> => {
  const side = resolveSide(set, params.side);
  if (isNa(side)) return side;
  const live = set.runs[set.runs.length - 1];
  const liveSameSide = live && live.status === 'active' && live.side === side ? live : null;
  const age = params.age ?? liveSameSide?.length;
  if (age === undefined) return na('invalid-input', 'No live run on this side, so an elapsed session count is required');
  if (!Number.isInteger(age) || age < 1) return na('invalid-input', 'Elapsed sessions must be a whole number of 1 or more');
  const windows = params.windows ?? MA_DEFAULTS.exitWindows.value;
  const minAtRisk = params.minAtRisk ?? MA_DEFAULTS.minAtRisk.value;
  const surv = runSurvival(set, side);
  const steps = surv.steps;
  const step = steps.find((s) => s.t === age);
  // Runs whose duration reaches the age: the Kaplan Meier risk set at t = age.
  const atRisk = step ? step.atRisk : steps.filter((s) => s.t > age).reduce((m, s) => Math.max(m, s.atRisk), 0);
  const gA = reachProb(steps, age);
  const gated = atRisk >= minAtRisk && gA > 0;
  const done = completedRuns(set, side).filter((r) => r.length >= age);
  const censoredReached = set.runs.filter(
    (r) => r.side === side && r.status !== 'completed' && eligibleStart(set, r) && r.length >= age && r !== liveSameSide,
  );
  const lastStepEndsAtZero = steps.length > 0 && steps[steps.length - 1]!.survival === 0;
  const supported = (k: number): boolean => age + k - 1 <= surv.maxObserved || lastStepEndsAtZero;
  const prob = (k: number): number => 1 - reachProb(steps, age + k) / gA;

  const rows: ExitOddsRow[] = windows.map((k) => {
    const hits = done.filter((r) => r.length <= age + k - 1).length;
    const unresolved = censoredReached.filter((r) => r.length <= age + k - 1).length;
    const nB = done.length + censoredReached.length;
    let probability: Maybe<number>;
    if (!gated) probability = na('sample-too-small', `${atRisk} runs at risk at day ${age}, ${minAtRisk} needed`);
    else if (!supported(k)) probability = na('no-coverage', `No observed run length reaches day ${age + k - 1}`);
    else probability = prob(k);
    return {
      within: k,
      probability,
      completedOnly: wilson(hits, done.length),
      unresolved,
      bounds: nB > 0 ? { lo: hits / nB, hi: (hits + unresolved) / nB } : null,
    };
  });

  let typicalRemaining: Maybe<number> = na('sample-too-small', `${atRisk} runs at risk at day ${age}, ${minAtRisk} needed`);
  if (gated) {
    typicalRemaining = na('no-coverage', 'Half of comparable runs had not exited inside the observed lengths');
    for (let k = 1; supported(k) && k <= surv.maxObserved + 1; k++) {
      if (prob(k) >= 0.5) {
        typicalRemaining = k;
        break;
      }
    }
  }

  return {
    window: set.window,
    side,
    age,
    status: gated ? 'valid' : 'insufficient-evidence',
    atRisk,
    minAtRisk,
    rows,
    typicalRemaining,
    survival: surv,
    note: gated
      ? `Based on ${atRisk} runs that reached day ${age}. Unfinished runs stay in the risk sets until their last observed session.`
      : `Conditional odds withheld. ${atRisk} runs reached day ${age} and ${minAtRisk} are needed. Counts below are descriptive.`,
  };
};

export interface HistogramBin {
  lo: number;
  hi: number;
  /** "4" for a single session bin, "4 to 6" otherwise. Bins never share a boundary. */
  label: string;
  count: number;
}

/**
 * Histogram of run lengths with even integer bins. One bin per session count when the span is
 * short, otherwise the bin width that gives the count closest to eight inside 7 to 12.
 * Counts always sum to the number of lengths.
 */
export const runLengthHistogram = (lengths: readonly number[]): HistogramBin[] => {
  if (lengths.length === 0) return [];
  const { target, min: minBins, max: maxBins } = MA_DEFAULTS.histogramBins.value;
  const lo = Math.min(...lengths);
  const hi = Math.max(...lengths);
  const span = hi - lo + 1;
  let width = 1;
  if (span > maxBins) {
    width = Math.ceil(span / target);
    let best = Infinity;
    for (let w = 2; w <= span; w++) {
      const count = Math.ceil(span / w);
      if (count < minBins) break;
      if (count > maxBins) continue;
      const score = Math.abs(count - target);
      if (score < best) {
        best = score;
        width = w;
      }
    }
  }
  const nBins = Math.ceil(span / width);
  const bins: HistogramBin[] = [];
  for (let b = 0; b < nBins; b++) {
    const bl = lo + b * width;
    const bh = bl + width - 1;
    bins.push({ lo: bl, hi: bh, label: width === 1 ? `${bl}` : `${bl} to ${bh}`, count: 0 });
  }
  for (const L of lengths) bins[Math.floor((L - lo) / width)]!.count++;
  return bins;
};

/** Histogram of completed run lengths for one side. */
export const completedRunHistogram = (set: MaRunSet, side: Side): HistogramBin[] =>
  runLengthHistogram(completedRuns(set, side).map((r) => r.length));

export type RunSortKey = 'entryDate' | 'exitDate' | 'length' | 'farthestDistance' | 'extremeFromEntry' | 'moveToExit';

const sortValue = (r: MaRun, key: RunSortKey): number | string | null => {
  switch (key) {
    case 'entryDate':
      return r.entryDate;
    case 'exitDate':
      return r.exitDate;
    case 'length':
      return r.length;
    case 'farthestDistance':
      return r.farthestDistance;
    case 'extremeFromEntry':
      return r.extremeFromEntry;
    case 'moveToExit':
      return typeof r.moveToExit === 'number' ? r.moveToExit : null;
  }
};

/** Stable sort. Missing values sort last in both directions. */
export const sortRuns = (runs: readonly MaRun[], key: RunSortKey, dir: 'asc' | 'desc' = 'desc'): MaRun[] => {
  const sign = dir === 'asc' ? 1 : -1;
  return runs
    .map((r, i) => ({ r, i, v: sortValue(r, key) }))
    .sort((a, b) => {
      if (a.v === null && b.v === null) return a.i - b.i;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      if (a.v < b.v) return -sign;
      if (a.v > b.v) return sign;
      return a.i - b.i;
    })
    .map((x) => x.r);
};

export interface RunFilter {
  side?: Side;
  status?: RunStatus;
  startKind?: RunStartKind;
  minLength?: number;
  maxLength?: number;
  /** Keep runs that overlap the inclusive date range. */
  from?: ISODate;
  to?: ISODate;
  /** Free text matched against the run's dates, side, status and boundary kinds. */
  query?: string;
}

/** Filter the run list by side, status, length, date overlap and free text over dates and outcome. */
export const searchRuns = (runs: readonly MaRun[], f: RunFilter): MaRun[] => {
  const q = f.query?.trim().toLowerCase();
  return runs.filter((r) => {
    if (f.side && r.side !== f.side) return false;
    if (f.status && r.status !== f.status) return false;
    if (f.startKind && r.startKind !== f.startKind) return false;
    if (f.minLength !== undefined && r.length < f.minLength) return false;
    if (f.maxLength !== undefined && r.length > f.maxLength) return false;
    if (f.from && r.lastDate < f.from) return false;
    if (f.to && r.entryDate > f.to) return false;
    if (q) {
      const hay = [r.entryDate, r.lastDate, r.exitDate ?? '', r.farthestDistanceDate, r.extremeFromEntryDate, r.side, r.status, r.startKind, r.exitKind ?? '']
        .join(' ')
        .toLowerCase();
      if (!q.split(/\s+/).every((tok) => hay.includes(tok))) return false;
    }
    return true;
  });
};

/** Plain labels for run boundaries and status, for tables and tooltips. */
export const RUN_LABELS = {
  startKind: {
    cross: 'Observed cross',
    touch: 'Began after a close on the average',
    leading: 'Already on this side when history begins. Not a confirmed crossing',
    'after-gap': 'First usable session after missing data. Unverified start',
  } satisfies Record<RunStartKind, string>,
  status: {
    completed: 'Completed',
    active: 'Active. Still running',
    interrupted: 'Interrupted by missing data. Ending not observed',
  } satisfies Record<RunStatus, string>,
  exitKind: {
    cross: 'Closed across the average',
    touch: 'Closed on the average',
    gap: 'Missing or corrupt session',
  } satisfies Record<RunExitKind, string>,
} as const;
