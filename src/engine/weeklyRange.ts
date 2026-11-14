/**
 * Weekly Range Engine. Forecast levels and odds for the coming Monday to Friday trading week,
 * issued after the prior week's last completed regular close. Separate from the realized weekly
 * returns board.
 *
 * Definitions (owner specification section 17):
 * - C is the last completed close of the prior week. T is the number of exchange sessions in the
 *   forecast week. 21 consecutive valid split consistent rows through the anchor are required.
 * - Realized scale. Over the last 20 completed sessions
 *     v = ln(O/C_prev)^2 + 0.5 ln(H/L)^2 - (2 ln 2 - 1) ln(C/O)^2,  S_real = sqrt(T x mean(v)).
 * - Expected absolute log move is 0.7979 x S. Expected level references are C exp(+-0.7979 S).
 * - Engine A. S_opt = verified weekly implied move fraction / 0.7979, S = (S_real + S_opt) / 2.
 *   Per side touch boundaries C exp(+-kS). For a strike X, z = ln(X/C)/S, one sided touch
 *   2(1 - Phi(|z|)), finish above 1 - Phi(z), finish below Phi(z).
 * - Engine B. Fallback when no valid same week expiry move exists. S_iv = IV30 x sqrt(T/252).
 *   Standardized ridge (penalty 5) on ln(S_real), ln(S_iv), earnings week flag and flag x ln(S_iv)
 *   predicting ln(max((up + down)/2, 0.0001)). Scale = exp(prediction) / 0.7979. Tails are the
 *   empirical training distribution of up/S, down/S and signed close/S.
 * - A one sided touch is not a joint range probability and is not a close probability.
 * - Nothing here synthesizes an implied move, an IV or an option premium. A missing input is an
 *   Unavailable reason and the engine that needs it is not used.
 *
 * The supplied Python backtests and their CSVs were not available when this was written, so the
 * reference figures are not reproduced here. See docs/EVIDENCE.md.
 */
import { addDays, fridayOf, isEarlyClose, isSession, mondayOf, nextSession, prevSession, sessionsBetween, toDayNum, fromDayNum } from './core/calendar';
import { indexOfDate } from './core/series';
import { mean, normCdf, quantile, sortedCopy, wilson } from './core/stats';
import { isNa, na, type Bar, type ISODate, type Maybe, type PriceBasis, type Proportion, type SourceCapture, type Unavailable } from './core/types';

export const WEEKLY_RANGE_VERSION = 'weekly-range-v1';

/** Values stated in the owner specification. */
export const WEEKLY_RANGE_SPEC = {
  provenance: 'spec',
  /** E|Z| for a standard normal, as the specification rounds it. */
  absNormalMean: 0.7979,
  lookbackSessions: 20,
  requiredRows: 21,
  /** Per side touch odds and their multipliers k = Phi^-1(1 - odds / 2). */
  touchLevels: [
    { odds: 0.5, k: 0.67448975 },
    { odds: 0.2, k: 1.28155157 },
    { odds: 0.1, k: 1.64485363 },
    { odds: 0.05, k: 1.95996398 },
  ],
  dteMin: 5,
  dteMax: 8,
  ridgePenalty: 5,
  targetFloor: 0.0001,
  minTrainingWeeks: 100,
  minTrainingTickers: 3,
  refitAnchor: '2024-12-27',
  refitEveryDays: 28,
  embargoDays: 7,
  evaluationLevels: [0.03, 0.05, 0.08, 0.1],
  reliabilityWindows: [26, 52],
  annualSessions: 252,
} as const;

/** Choices the specification leaves to the reference source, which was not available. */
export const WEEKLY_RANGE_DEFAULTS = {
  provenance: 'proposed',
  /** Feature standardization uses the population standard deviation. */
  standardization: 'population-std',
  /** The intercept is the training mean of the target and is not penalized. */
  interceptPenalized: false,
  /** Tail ratios divide each training outcome by that row's in sample fitted scale. */
  tailScale: 'in-sample-fitted',
  /** The option and IV quotes must be dated on the anchor session. */
  quoteMustMatchAnchor: true,
  /** The weekly expiry must be the last session of the forecast week. */
  expiryMustBeWeekEnd: true,
  /** Relative tolerance when proving the anchor close matches at settlement. */
  basisTolerance: 1e-6,
} as const;

const LN2 = Math.log(2);

// ---------------------------------------------------------------------------------------------
// Forecast context
// ---------------------------------------------------------------------------------------------

export interface ForecastContext {
  /** Index and date of the prior week's last completed close. This is the forecast date. */
  anchorIndex: number;
  anchorDate: ISODate;
  /** C. */
  close: number;
  weekStart: ISODate;
  nominalFriday: ISODate;
  /** Actual exchange sessions of the forecast week. */
  sessions: ISODate[];
  /** T. */
  sessionCount: number;
  /** Last actual session of the forecast week. */
  weekEnd: ISODate;
  earlyCloses: ISODate[];
  /** True when the series already contains sessions of the forecast week. */
  weekInProgress: boolean;
}

/** Monday of the week the next forecast targets, given the last completed session. */
export const nextForecastWeek = (lastCompleted: ISODate): ISODate => mondayOf(nextSession(lastCompleted));

const validRow = (b: Bar): boolean => {
  const v = [b.open, b.high, b.low, b.close];
  if (v.some((x) => !Number.isFinite(x) || x <= 0)) return false;
  const eps = 1e-9 * b.high;
  return b.high + eps >= Math.max(b.open, b.close) && b.low - eps <= Math.min(b.open, b.close);
};

/**
 * Forecast context for the week containing `forecastWeek` (any date in it). Defaults to the week
 * of the next session after the last bar. The anchor must be the last exchange session before
 * that week. A Friday holiday therefore anchors on the prior actual close. Requires 21
 * consecutive valid rows through the anchor.
 */
export const forecastContext = (bars: readonly Bar[], forecastWeek?: ISODate): Maybe<ForecastContext> => {
  const last = bars[bars.length - 1];
  if (!last) return na('insufficient-history', 'No completed sessions');
  const monday = mondayOf(forecastWeek ?? nextSession(last.date));
  const nominalFriday = fridayOf(monday);
  const sessions = sessionsBetween(monday, nominalFriday);
  if (sessions.length === 0) return na('not-applicable', `No exchange sessions in the week of ${monday}`);
  const anchorDate = prevSession(monday);
  const i = indexOfDate(bars, anchorDate);
  if (i < 0) {
    return last.date < anchorDate
      ? na('missing-session', `The prior week close on ${anchorDate} has not completed in this series`)
      : na('missing-session', `The series has no row for the prior week close on ${anchorDate}`);
  }
  const need = WEEKLY_RANGE_SPEC.requiredRows;
  if (i < need - 1) return na('insufficient-history', `Needs ${need} consecutive sessions through ${anchorDate}, series has ${i + 1}`);
  for (let j = i - need + 1; j <= i; j++) {
    const b = bars[j]!;
    if (!validRow(b)) return na('invalid-input', `Row ${b.date} is not a valid OHLC bar`);
    if (j > i - need + 1 && b.date !== nextSession(bars[j - 1]!.date)) {
      return na('missing-session', `Sessions are not consecutive between ${bars[j - 1]!.date} and ${b.date}`);
    }
  }
  return {
    anchorIndex: i,
    anchorDate,
    close: bars[i]!.close,
    weekStart: monday,
    nominalFriday,
    sessions,
    sessionCount: sessions.length,
    weekEnd: sessions[sessions.length - 1]!,
    earlyCloses: sessions.filter(isEarlyClose),
    weekInProgress: last.date >= monday,
  };
};

/**
 * S_real = sqrt(T x mean(v)) over the 20 sessions ending at `anchorIndex`.
 * Caller guarantees 21 valid consecutive rows (forecastContext does).
 */
export const realizedScale = (bars: readonly Bar[], anchorIndex: number, sessionCount: number): Maybe<number> => {
  const n = WEEKLY_RANGE_SPEC.lookbackSessions;
  if (anchorIndex < n || anchorIndex >= bars.length) return na('insufficient-history', `Needs ${n + 1} rows through the anchor`);
  let s = 0;
  for (let j = anchorIndex - n + 1; j <= anchorIndex; j++) {
    const b = bars[j]!;
    const pc = bars[j - 1]!.close;
    const on = Math.log(b.open / pc);
    const hl = Math.log(b.high / b.low);
    const co = Math.log(b.close / b.open);
    s += on * on + 0.5 * hl * hl - (2 * LN2 - 1) * co * co;
  }
  const m = s / n;
  if (!(m > 0) || !Number.isFinite(m)) return na('flat-range', 'Realized variance over the last 20 sessions is not positive');
  return Math.sqrt(sessionCount * m);
};

// ---------------------------------------------------------------------------------------------
// Normal tail model (Engine A and the blend baseline)
// ---------------------------------------------------------------------------------------------

/** One sided touch probability for a level |z| scales away: 2(1 - Phi(|z|)). */
export const normalTouch = (z: number): number => Math.min(1, 2 * (1 - normCdf(Math.abs(z))));

export const BROWNIAN_MODEL_NAME = 'Zero drift continuous Brownian motion in log price';
export const BROWNIAN_MODEL_EXCLUSIONS = 'Excludes jumps, opening gaps and any drift. Volatility is constant across the week.';

/**
 * Probability that zero drift Brownian motion with total standard deviation `sigma` over the
 * window stays strictly inside the log barriers (-down, +up), both positive distances.
 * Uses the eigenfunction (sine) series when the corridor is narrow and the image (reflection)
 * series when it is wide. The two agree. Each converges fast in its own regime.
 */
export const brownianStayInside = (up: number, down: number, sigma: number): number => {
  if (!(up > 0) || !(down > 0) || !(sigma > 0)) return NaN;
  const L = up + down;
  const ratio = sigma / L;
  if (ratio >= 0.3) {
    // Survival of BM started at x = down in (0, L): sum over odd n of 4/(n pi) sin(n pi x / L) exp(-n^2 pi^2 sigma^2 / (2 L^2)).
    let s = 0;
    for (let n = 1; n < 400; n += 2) {
      const term = (4 / (n * Math.PI)) * Math.sin((n * Math.PI * down) / L) * Math.exp((-n * n * Math.PI * Math.PI * ratio * ratio) / 2);
      s += term;
      if (Math.abs(term) < 1e-16 && n > 5) break;
    }
    return Math.min(1, Math.max(0, s));
  }
  // Image series with barriers a = -down, b = up.
  const a = -down;
  const b = up;
  let s = 0;
  for (let k = -12; k <= 12; k++) {
    const shift = 2 * k * L;
    s += normCdf((b - shift) / sigma) - normCdf((a - shift) / sigma) - normCdf((-b - shift) / sigma) + normCdf((a - 2 * b - shift) / sigma);
  }
  return Math.min(1, Math.max(0, s));
};

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/** Verified weekly implied move from the exact same week expiry. Never synthesized. */
export interface ImpliedMoveInput {
  /** Implied absolute move through expiry as a fraction of C. */
  impliedMoveFraction: number;
  expiry: ISODate;
  /** Session the quote is dated on. */
  quoteDate: ISODate;
  /** True only when the provider verified the quote on the same price basis. */
  verified: boolean;
  source: SourceCapture;
}

export interface Iv30Input {
  /** Annualized 30 day implied volatility as a fraction. */
  iv30: number;
  quoteDate: ISODate;
  source: SourceCapture;
}

export interface EngineACheck {
  sOpt: number;
  dte: number;
  expiry: ISODate;
}

/** Engine A eligibility: verified, dated on the anchor, same week expiry, DTE inside 5 to 8. */
export const checkImpliedMove = (ctx: ForecastContext, input: ImpliedMoveInput | undefined | null): Maybe<EngineACheck> => {
  if (!input) return na('no-coverage', 'No same week expiry implied move was captured');
  if (!input.verified) return na('not-validated', 'The implied move quote is not verified');
  if (!Number.isFinite(input.impliedMoveFraction) || input.impliedMoveFraction <= 0) return na('invalid-input', 'Implied move must be a positive fraction');
  if (WEEKLY_RANGE_DEFAULTS.quoteMustMatchAnchor && input.quoteDate !== ctx.anchorDate) {
    return na('stale-source', `Implied move is dated ${input.quoteDate}, the forecast anchors on ${ctx.anchorDate}`);
  }
  if (!isSession(input.expiry) || input.expiry < ctx.weekStart || input.expiry > ctx.nominalFriday) {
    return na('invalid-input', `Expiry ${input.expiry} is not a session inside the forecast week`);
  }
  if (WEEKLY_RANGE_DEFAULTS.expiryMustBeWeekEnd && input.expiry !== ctx.weekEnd) {
    return na('invalid-input', `Expiry ${input.expiry} is not the last session of the forecast week (${ctx.weekEnd})`);
  }
  const dte = toDayNum(input.expiry) - toDayNum(ctx.anchorDate);
  if (dte < WEEKLY_RANGE_SPEC.dteMin || dte > WEEKLY_RANGE_SPEC.dteMax) {
    return na('invalid-input', `Days to expiry is ${dte}, outside ${WEEKLY_RANGE_SPEC.dteMin} to ${WEEKLY_RANGE_SPEC.dteMax}`);
  }
  return { sOpt: input.impliedMoveFraction / WEEKLY_RANGE_SPEC.absNormalMean, dte, expiry: input.expiry };
};

/** S_iv = IV30 x sqrt(T / 252). */
export const ivScale = (iv30: number, sessionCount: number): number => iv30 * Math.sqrt(sessionCount / WEEKLY_RANGE_SPEC.annualSessions);

export const checkIv30 = (ctx: ForecastContext, input: Iv30Input | undefined | null): Maybe<number> => {
  if (!input) return na('no-coverage', 'No dated IV30 was captured');
  if (!Number.isFinite(input.iv30) || input.iv30 <= 0) return na('invalid-input', 'IV30 must be a positive fraction');
  if (WEEKLY_RANGE_DEFAULTS.quoteMustMatchAnchor && input.quoteDate !== ctx.anchorDate) {
    return na('stale-source', `IV30 is dated ${input.quoteDate}, the forecast anchors on ${ctx.anchorDate}`);
  }
  return ivScale(input.iv30, ctx.sessionCount);
};

// ---------------------------------------------------------------------------------------------
// Engine B training
// ---------------------------------------------------------------------------------------------

/** One mature stock week used to train Engine B. All moves are logs relative to that week's C. */
export interface RangeTrainingRow {
  ticker: string;
  /** Anchor session of that week's forecast. */
  forecastDate: ISODate;
  /** Last session of the outcome week. */
  weekEnd: ISODate;
  sReal: number;
  sIv: number;
  earningsWeek: boolean;
  /** ln(week high / C). */
  up: number;
  /** ln(C / week low). */
  down: number;
  /** ln(week close / C). */
  closeChange: number;
}

export interface WeekOutcome {
  high: number;
  low: number;
  close: number;
  up: number;
  down: number;
  closeChange: number;
  weekEnd: ISODate;
}

/** Realized high, low and close for exactly the context's expected sessions. Pending when any is absent. */
export const weekOutcome = (bars: readonly Bar[], ctx: Pick<ForecastContext, 'sessions' | 'close'>): Maybe<WeekOutcome> => {
  let high = -Infinity;
  let low = Infinity;
  let close = NaN;
  for (const d of ctx.sessions) {
    const i = indexOfDate(bars, d);
    if (i < 0) return na('not-matured', `Session ${d} is not in the series`);
    const b = bars[i]!;
    if (!validRow(b)) return na('invalid-input', `Row ${d} is not a valid OHLC bar`);
    high = Math.max(high, b.high);
    low = Math.min(low, b.low);
    close = b.close;
  }
  return {
    high,
    low,
    close,
    up: Math.log(high / ctx.close),
    down: Math.log(ctx.close / low),
    closeChange: Math.log(close / ctx.close),
    weekEnd: ctx.sessions[ctx.sessions.length - 1]!,
  };
};

/**
 * Build one training row for a completed week from real inputs. IV30 must be the value dated on
 * the anchor session. It cannot be backfilled from a later quote.
 */
export const buildTrainingRow = (ticker: string, bars: readonly Bar[], week: ISODate, iv30: Iv30Input, earningsWeek: boolean): Maybe<RangeTrainingRow> => {
  const ctx = forecastContext(bars, week);
  if (isNa(ctx)) return ctx;
  const sReal = realizedScale(bars, ctx.anchorIndex, ctx.sessionCount);
  if (isNa(sReal)) return sReal;
  const sIv = checkIv30(ctx, iv30);
  if (isNa(sIv)) return sIv;
  const out = weekOutcome(bars, ctx);
  if (isNa(out)) return out;
  return { ticker, forecastDate: ctx.anchorDate, weekEnd: out.weekEnd, sReal, sIv, earningsWeek, up: out.up, down: out.down, closeChange: out.closeChange };
};

/** Target ln(max((up + down) / 2, 0.0001)). */
export const trainingTarget = (row: Pick<RangeTrainingRow, 'up' | 'down'>): number =>
  Math.log(Math.max((row.up + row.down) / 2, WEEKLY_RANGE_SPEC.targetFloor));

/** Inputs ln(S_real), ln(S_iv), earnings flag, flag x ln(S_iv). */
export const featureVector = (sReal: number, sIv: number, earningsWeek: boolean): number[] => {
  const f = earningsWeek ? 1 : 0;
  const li = Math.log(sIv);
  return [Math.log(sReal), li, f, f * li];
};

export interface RidgeFit {
  lambda: number;
  intercept: number;
  /** Coefficients on standardized features. */
  coef: number[];
  means: number[];
  /** Population standard deviations. A zero entry marks a constant feature whose coefficient is 0. */
  stds: number[];
  n: number;
}

/** Solve A x = b by Gaussian elimination with partial pivoting. Null when singular. */
const solveLinear = (A: number[][], b: number[]): number[] | null => {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r;
    if (Math.abs(M[piv]![c]!) < 1e-14) return null;
    [M[c], M[piv]] = [M[piv]!, M[c]!];
    for (let r = c + 1; r < n; r++) {
      const f = M[r]![c]! / M[c]![c]!;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r]![n]!;
    for (let k = r + 1; k < n; k++) s -= M[r]![k]! * x[k]!;
    x[r] = s / M[r]![r]!;
  }
  return x;
};

/**
 * Standardized ridge regression. Features are centered and divided by their population standard
 * deviation. beta = (Xs' Xs + lambda I)^-1 Xs' (y - mean(y)). The intercept is mean(y) and is
 * not penalized. A constant feature standardizes to zero and gets a zero coefficient.
 */
export const fitRidge = (X: readonly (readonly number[])[], y: readonly number[], lambda: number = WEEKLY_RANGE_SPEC.ridgePenalty): Maybe<RidgeFit> => {
  const n = y.length;
  const p = X[0]?.length ?? 0;
  if (n === 0 || p === 0 || X.length !== n) return na('invalid-input', 'Ridge needs a non empty design matrix matching the target');
  const means = new Array<number>(p).fill(0);
  const stds = new Array<number>(p).fill(0);
  for (let j = 0; j < p; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += X[i]![j]!;
    means[j] = s / n;
    let v = 0;
    for (let i = 0; i < n; i++) v += (X[i]![j]! - means[j]!) ** 2;
    stds[j] = Math.sqrt(v / n);
  }
  const yBar = mean(y);
  const A: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const b = new Array<number>(p).fill(0);
  for (let i = 0; i < n; i++) {
    const z = X[i]!.map((v, j) => (stds[j]! > 0 ? (v - means[j]!) / stds[j]! : 0));
    const r = y[i]! - yBar;
    for (let j = 0; j < p; j++) {
      b[j]! += z[j]! * r;
      for (let k = 0; k < p; k++) A[j]![k]! += z[j]! * z[k]!;
    }
  }
  // A constant feature has a zero row and column. Pin its coefficient to zero so the system stays solvable.
  for (let j = 0; j < p; j++) A[j]![j] = stds[j]! > 0 ? A[j]![j]! + lambda : 1;
  const coef = solveLinear(A, b);
  if (!coef) return na('invalid-input', 'Ridge system is singular');
  return { lambda, intercept: yBar, coef, means, stds, n };
};

export const ridgePredict = (fit: RidgeFit, x: readonly number[]): number => {
  let s = fit.intercept;
  for (let j = 0; j < fit.coef.length; j++) s += fit.stds[j]! > 0 ? (fit.coef[j]! * (x[j]! - fit.means[j]!)) / fit.stds[j]! : 0;
  return s;
};

/**
 * Embargo rules.
 * - 'strict-forecast-date': production. A training outcome must end no later than the refit
 *   forecast date minus seven days.
 * - 'reproduction-week-end-minus-seven': the original evaluation's cutoff, target week end minus
 *   seven days, which admits rows ending on the forecast Friday. Exposed only to reproduce the
 *   original study. Never use it for a live forecast.
 */
export type EmbargoRule = 'strict-forecast-date' | 'reproduction-week-end-minus-seven';

/** The refit date in force for a forecast date: anchor + 28k days, the latest on or before the forecast's Friday. */
export const refitDateFor = (forecastDate: ISODate): ISODate => {
  const a = toDayNum(WEEKLY_RANGE_SPEC.refitAnchor);
  const f = toDayNum(fridayOf(forecastDate));
  const k = Math.floor((f - a) / WEEKLY_RANGE_SPEC.refitEveryDays);
  return fromDayNum(a + k * WEEKLY_RANGE_SPEC.refitEveryDays);
};

export interface TrainingSelection {
  rule: EmbargoRule;
  refitDate: ISODate;
  /** Latest admissible outcome week end. */
  cutoff: ISODate;
  rows: RangeTrainingRow[];
  excludedByEmbargo: number;
  excludedInvalid: number;
  tickers: string[];
}

const rowValid = (r: RangeTrainingRow): boolean =>
  [r.sReal, r.sIv, r.up, r.down, r.closeChange].every(Number.isFinite) && r.sReal > 0 && r.sIv > 0 && r.up + r.down >= 0 && r.weekEnd > r.forecastDate;

/**
 * Rows admissible for a forecast on `forecastDate`. Under the strict rule the cutoff is the refit
 * date minus seven days. Under the reproduction rule it is `targetWeekEnd` minus seven days.
 */
export const selectTrainingRows = (
  rows: readonly RangeTrainingRow[],
  forecastDate: ISODate,
  rule: EmbargoRule = 'strict-forecast-date',
  targetWeekEnd?: ISODate,
): TrainingSelection => {
  const refitDate = refitDateFor(forecastDate);
  const base = rule === 'strict-forecast-date' ? refitDate : (targetWeekEnd ?? addDays(fridayOf(forecastDate), 7));
  const cutoff = addDays(base, -WEEKLY_RANGE_SPEC.embargoDays);
  const kept: RangeTrainingRow[] = [];
  let excludedByEmbargo = 0;
  let excludedInvalid = 0;
  for (const r of rows) {
    if (!rowValid(r)) excludedInvalid++;
    else if (r.weekEnd > cutoff) excludedByEmbargo++;
    else kept.push(r);
  }
  return { rule, refitDate, cutoff, rows: kept, excludedByEmbargo, excludedInvalid, tickers: [...new Set(kept.map((r) => r.ticker))].sort() };
};

export interface EmpiricalTails {
  /** Sorted ratios of realized move to the row's fitted scale. */
  up: number[];
  down: number[];
  close: number[];
  /** Paired up and down ratios per training week, for joint inside bounds estimates. */
  pairs: { up: number; down: number }[];
}

export interface EngineBModel {
  version: string;
  ridge: RidgeFit;
  rule: EmbargoRule;
  refitDate: ISODate;
  cutoff: ISODate;
  weeks: number;
  tickers: string[];
  excludedByEmbargo: number;
  excludedInvalid: number;
  tails: EmpiricalTails;
}

/** Fit Engine B for a forecast date. Unavailable below 100 eligible earlier stock weeks or 3 tickers. */
export const fitEngineB = (
  rows: readonly RangeTrainingRow[],
  forecastDate: ISODate,
  rule: EmbargoRule = 'strict-forecast-date',
  targetWeekEnd?: ISODate,
): Maybe<EngineBModel> => {
  const sel = selectTrainingRows(rows, forecastDate, rule, targetWeekEnd);
  if (sel.rows.length < WEEKLY_RANGE_SPEC.minTrainingWeeks) {
    return na('sample-too-small', `Engine B needs ${WEEKLY_RANGE_SPEC.minTrainingWeeks} eligible earlier stock weeks, has ${sel.rows.length} ending on or before ${sel.cutoff}`);
  }
  if (sel.tickers.length < WEEKLY_RANGE_SPEC.minTrainingTickers) {
    return na('sample-too-small', `Engine B needs ${WEEKLY_RANGE_SPEC.minTrainingTickers} tickers in the pool, has ${sel.tickers.length}`);
  }
  const X = sel.rows.map((r) => featureVector(r.sReal, r.sIv, r.earningsWeek));
  const y = sel.rows.map(trainingTarget);
  const ridge = fitRidge(X, y);
  if (isNa(ridge)) return ridge;
  const pairs = sel.rows.map((r, i) => {
    const s = Math.exp(ridgePredict(ridge, X[i]!)) / WEEKLY_RANGE_SPEC.absNormalMean;
    return { up: r.up / s, down: r.down / s, close: r.closeChange / s };
  });
  return {
    version: WEEKLY_RANGE_VERSION,
    ridge,
    rule: sel.rule,
    refitDate: sel.refitDate,
    cutoff: sel.cutoff,
    weeks: sel.rows.length,
    tickers: sel.tickers,
    excludedByEmbargo: sel.excludedByEmbargo,
    excludedInvalid: sel.excludedInvalid,
    tails: {
      up: sortedCopy(pairs.map((p) => p.up)),
      down: sortedCopy(pairs.map((p) => p.down)),
      close: sortedCopy(pairs.map((p) => p.close)),
      pairs: pairs.map((p) => ({ up: p.up, down: p.down })),
    },
  };
};

/** Engine B scale for one forecast: exp(prediction) / 0.7979. */
export const engineBScale = (model: EngineBModel, sReal: number, sIv: number, earningsWeek: boolean): number =>
  Math.exp(ridgePredict(model.ridge, featureVector(sReal, sIv, earningsWeek))) / WEEKLY_RANGE_SPEC.absNormalMean;

/** Baseline scale: the plain realized plus IV blend with normal tails. */
export const blendScale = (sReal: number, sIv: number): number => (sReal + sIv) / 2;

/** Count of sorted values >= x. */
const countAtLeast = (sorted: readonly number[], x: number): number => {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return sorted.length - lo;
};

/** Count of sorted values > x. */
const countAbove = (sorted: readonly number[], x: number): number => {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return sorted.length - lo;
};

// ---------------------------------------------------------------------------------------------
// Forecast
// ---------------------------------------------------------------------------------------------

export type RangeEngine = 'A' | 'B';
export type TailModel = 'normal' | 'empirical-training';

export interface RangeLevel {
  /** Per side touch odds this boundary is built for. */
  odds: number;
  upper: number;
  lower: number;
  /** Signed fractions relative to C. */
  upperPct: number;
  lowerPct: number;
  /** Log distances from C, both positive. */
  upperLog: number;
  lowerLog: number;
}

export interface InsideEstimate {
  /** Probability of staying inside both 10% per side boundaries for the whole week. */
  probability: number;
  model: string;
  exclusions: string;
  /** Training weeks behind an empirical estimate. */
  n?: number;
}

export interface WeeklyRangeForecast {
  version: string;
  engine: RangeEngine;
  tailModel: TailModel;
  /** Forecast date: the anchor session. */
  forecastDate: ISODate;
  context: ForecastContext;
  /** C. */
  close: number;
  /** S, total log standard deviation scale for the week. */
  scale: number;
  sReal: number;
  /** Engine A only. */
  sOpt?: number;
  /** Engine B only. */
  sIv?: number;
  /** 0.7979 x S. */
  expectedAbsLogMove: number;
  expectedHigh: number;
  expectedLow: number;
  /** Signed fractions relative to C. */
  expectedMoveUp: number;
  expectedMoveDown: number;
  levels: RangeLevel[];
  inside10: InsideEstimate;
  inputs: {
    priceThrough: ISODate;
    impliedMove?: { fraction: number; expiry: ISODate; quoteDate: ISODate; dte: number; source: SourceCapture };
    iv30?: { value: number; quoteDate: ISODate; source: SourceCapture };
    earningsWeek?: boolean;
    training?: { weeks: number; tickers: number; cutoff: ISODate; refitDate: ISODate; rule: EmbargoRule };
  };
  /** Why Engine A was not used, when the forecast comes from Engine B. */
  engineAReason?: Unavailable;
  /** Engine B empirical tails. Present only for Engine B. */
  tails?: EmpiricalTails;
  notes: string[];
}

const baseForecast = (ctx: ForecastContext, sReal: number, scale: number) => {
  const e = WEEKLY_RANGE_SPEC.absNormalMean * scale;
  return {
    version: WEEKLY_RANGE_VERSION,
    forecastDate: ctx.anchorDate,
    context: ctx,
    close: ctx.close,
    scale,
    sReal,
    expectedAbsLogMove: e,
    expectedHigh: ctx.close * Math.exp(e),
    expectedLow: ctx.close * Math.exp(-e),
    expectedMoveUp: Math.exp(e) - 1,
    expectedMoveDown: Math.exp(-e) - 1,
  };
};

const levelFromLogs = (C: number, odds: number, upperLog: number, lowerLog: number): RangeLevel => ({
  odds,
  upper: C * Math.exp(upperLog),
  lower: C * Math.exp(-lowerLog),
  upperPct: Math.exp(upperLog) - 1,
  lowerPct: Math.exp(-lowerLog) - 1,
  upperLog,
  lowerLog,
});

const normalLevels = (C: number, S: number): RangeLevel[] => WEEKLY_RANGE_SPEC.touchLevels.map(({ odds, k }) => levelFromLogs(C, odds, k * S, k * S));

const TEN_PCT_K = WEEKLY_RANGE_SPEC.touchLevels[2].k;

const normalInside10 = (S: number): InsideEstimate => ({
  probability: brownianStayInside(TEN_PCT_K * S, TEN_PCT_K * S, S),
  model: BROWNIAN_MODEL_NAME,
  exclusions: BROWNIAN_MODEL_EXCLUSIONS,
});

const SHARED_NOTES = [
  'A one sided touch is not a joint range probability and is not a close probability.',
  'Percentages are relative to the prior week close C.',
];

/** Engine A forecast from a context, realized scale and a checked implied move. */
export const engineAForecast = (ctx: ForecastContext, sReal: number, check: EngineACheck, input: ImpliedMoveInput): WeeklyRangeForecast => {
  const S = (sReal + check.sOpt) / 2;
  return {
    ...baseForecast(ctx, sReal, S),
    engine: 'A',
    tailModel: 'normal',
    sOpt: check.sOpt,
    levels: normalLevels(ctx.close, S),
    inside10: normalInside10(S),
    inputs: {
      priceThrough: ctx.anchorDate,
      impliedMove: { fraction: input.impliedMoveFraction, expiry: input.expiry, quoteDate: input.quoteDate, dte: check.dte, source: input.source },
    },
    notes: [...SHARED_NOTES, 'Engine A blends realized and option implied scale. Tails are normal in log price.'],
  };
};

/** Baseline forecast: realized plus IV blend with normal tails. Used only as the comparison baseline. */
export const blendBaselineForecast = (ctx: ForecastContext, sReal: number, sIv: number): { scale: number; levels: RangeLevel[]; inside10: InsideEstimate } => {
  const S = blendScale(sReal, sIv);
  return { scale: S, levels: normalLevels(ctx.close, S), inside10: normalInside10(S) };
};

/** Engine B forecast from a fitted model. */
export const engineBForecast = (
  ctx: ForecastContext,
  sReal: number,
  sIv: number,
  earningsWeek: boolean,
  model: EngineBModel,
  iv30: Iv30Input,
  engineAReason?: Unavailable,
): WeeklyRangeForecast => {
  const S = engineBScale(model, sReal, sIv, earningsWeek);
  const t = model.tails;
  const levels = WEEKLY_RANGE_SPEC.touchLevels.map(({ odds }) =>
    levelFromLogs(ctx.close, odds, Math.max(0, quantile(t.up, 1 - odds, true)) * S, Math.max(0, quantile(t.down, 1 - odds, true)) * S),
  );
  const ten = levels[2]!;
  const insideHits = t.pairs.filter((p) => p.up * S < ten.upperLog && p.down * S < ten.lowerLog).length;
  const f: WeeklyRangeForecast = {
    ...baseForecast(ctx, sReal, S),
    engine: 'B',
    tailModel: 'empirical-training',
    sIv,
    levels,
    inside10: {
      probability: insideHits / t.pairs.length,
      model: 'Empirical paired training weeks scaled to this forecast',
      exclusions: 'Reference is the training distribution. Training weeks are dependent across tickers in the same market week.',
      n: t.pairs.length,
    },
    inputs: {
      priceThrough: ctx.anchorDate,
      iv30: { value: iv30.iv30, quoteDate: iv30.quoteDate, source: iv30.source },
      earningsWeek,
      training: { weeks: model.weeks, tickers: model.tickers.length, cutoff: model.cutoff, refitDate: model.refitDate, rule: model.rule },
    },
    tails: t,
    notes: [...SHARED_NOTES, 'Engine B scale comes from a pooled ridge model. Tails are the empirical training distribution and can be asymmetric.'],
  };
  if (engineAReason) f.engineAReason = engineAReason;
  return f;
};

export interface WeeklyRangeInput {
  bars: readonly Bar[];
  /** Any date inside the target week. Defaults to the week of the next session after the last bar. */
  forecastWeek?: ISODate;
  impliedMove?: ImpliedMoveInput | null;
  iv30?: Iv30Input | null;
  /** Whether the forecast week contains an earnings reaction. Unavailable when earnings coverage is unknown. */
  earningsWeek?: Maybe<boolean>;
  /** Pooled mature stock weeks for Engine B. */
  training?: readonly RangeTrainingRow[];
}

/**
 * Produce the weekly range forecast. Engine A when a verified same week implied move exists.
 * Engine B when it does not and a dated IV30, known earnings status and a sufficient pool exist.
 * Otherwise Unavailable, with both reasons in the detail.
 */
export const weeklyRangeForecast = (input: WeeklyRangeInput): Maybe<WeeklyRangeForecast> => {
  const ctx = forecastContext(input.bars, input.forecastWeek);
  if (isNa(ctx)) return ctx;
  const sReal = realizedScale(input.bars, ctx.anchorIndex, ctx.sessionCount);
  if (isNa(sReal)) return sReal;
  const a = checkImpliedMove(ctx, input.impliedMove);
  if (!isNa(a)) return engineAForecast(ctx, sReal, a, input.impliedMove!);
  const bReason = ((): Unavailable | null => {
    const sIv = checkIv30(ctx, input.iv30);
    if (isNa(sIv)) return sIv;
    if (input.earningsWeek === undefined || isNa(input.earningsWeek)) {
      return na('no-coverage', isNa(input.earningsWeek) ? `Earnings coverage unknown. ${input.earningsWeek.detail ?? ''}`.trim() : 'Earnings coverage unknown');
    }
    return null;
  })();
  if (!bReason) {
    const sIv = checkIv30(ctx, input.iv30) as number;
    const model = fitEngineB(input.training ?? [], ctx.anchorDate);
    if (!isNa(model)) return engineBForecast(ctx, sReal, sIv, input.earningsWeek as boolean, model, input.iv30!, a);
    return na(model.code, `Engine A: ${a.detail ?? a.code}. Engine B: ${model.detail ?? model.code}.`);
  }
  return na(a.code === 'no-coverage' ? bReason.code : a.code, `Engine A: ${a.detail ?? a.code}. Engine B: ${bReason.detail ?? bReason.code}.`);
};

export interface StrikeInspection {
  strike: number;
  /** Strike relative to C as a signed fraction. */
  pctFromClose: number;
  /** Absolute dollar distance from C. */
  distance: number;
  side: 'above' | 'below' | 'at';
  /** ln(X/C) / S. */
  z: number;
  /** One sided probability of trading through the strike during the week. */
  touch: number;
  /** Probability the week closes above the strike. */
  finishAbove: number;
  /** Probability the week closes at or below the strike. */
  finishBelow: number;
  tailModel: TailModel;
  /** Training weeks behind an empirical estimate. */
  n?: number;
}

/** Touch and finish odds for an arbitrary strike under the forecast's own tail model. */
export const inspectStrike = (f: Pick<WeeklyRangeForecast, 'close' | 'scale' | 'tailModel' | 'tails'>, strike: number): Maybe<StrikeInspection> => {
  if (!Number.isFinite(strike) || strike <= 0) return na('invalid-input', 'Strike must be a positive price');
  const logDist = Math.log(strike / f.close);
  const z = logDist / f.scale;
  const side = strike > f.close ? 'above' : strike < f.close ? 'below' : 'at';
  const base = { strike, pctFromClose: strike / f.close - 1, distance: strike - f.close, side, z } as const;
  if (f.tailModel === 'normal' || !f.tails) {
    return { ...base, touch: normalTouch(z), finishAbove: 1 - normCdf(z), finishBelow: normCdf(z), tailModel: 'normal' };
  }
  const t = f.tails;
  const n = t.pairs.length;
  const touch = side === 'at' ? 1 : side === 'above' ? countAtLeast(t.up, z) / n : countAtLeast(t.down, -z) / n;
  const above = countAbove(t.close, z) / n;
  return { ...base, touch, finishAbove: above, finishBelow: 1 - above, tailModel: 'empirical-training', n };
};

// ---------------------------------------------------------------------------------------------
// Frozen forecasts and settlement
// ---------------------------------------------------------------------------------------------

export interface FrozenForecast {
  readonly id: string;
  readonly instrumentId: string;
  readonly symbol: string;
  readonly forecastDate: ISODate;
  /** When the record was captured, ISO timestamp supplied by the caller. */
  readonly capturedAt: string;
  readonly version: string;
  readonly engine: RangeEngine;
  readonly tailModel: TailModel;
  readonly basis: PriceBasis;
  readonly close: number;
  readonly scale: number;
  readonly sReal: number;
  readonly expectedHigh: number;
  readonly expectedLow: number;
  readonly weekStart: ISODate;
  readonly nominalFriday: ISODate;
  readonly weekEnd: ISODate;
  readonly expectedSessions: readonly ISODate[];
  readonly levels: readonly Readonly<RangeLevel>[];
  readonly inside10: Readonly<InsideEstimate>;
  readonly inputs: Readonly<WeeklyRangeForecast['inputs']>;
  /** Source capture of the price series behind C and S_real. */
  readonly priceSource: Readonly<SourceCapture>;
}

const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
};

export const forecastId = (instrumentId: string, forecastDate: ISODate): string => `${instrumentId}:${forecastDate}`;

/**
 * Freeze a forecast into the immutable archive. At most one record per instrument and forecast
 * date: a second capture for the same key is rejected and the archive is returned unchanged by
 * the caller. Reruns are therefore idempotent.
 */
export const freezeForecast = (
  archive: readonly FrozenForecast[],
  forecast: WeeklyRangeForecast,
  meta: { instrumentId: string; symbol: string; basis: PriceBasis; capturedAt: string; priceSource: SourceCapture },
): Maybe<{ record: FrozenForecast; archive: FrozenForecast[] }> => {
  const id = forecastId(meta.instrumentId, forecast.forecastDate);
  if (archive.some((r) => r.id === id)) return na('invalid-input', `A forecast for ${meta.symbol} dated ${forecast.forecastDate} is already frozen`);
  const record: FrozenForecast = deepFreeze({
    id,
    instrumentId: meta.instrumentId,
    symbol: meta.symbol,
    forecastDate: forecast.forecastDate,
    capturedAt: meta.capturedAt,
    version: forecast.version,
    engine: forecast.engine,
    tailModel: forecast.tailModel,
    basis: meta.basis,
    close: forecast.close,
    scale: forecast.scale,
    sReal: forecast.sReal,
    expectedHigh: forecast.expectedHigh,
    expectedLow: forecast.expectedLow,
    weekStart: forecast.context.weekStart,
    nominalFriday: forecast.context.nominalFriday,
    weekEnd: forecast.context.weekEnd,
    expectedSessions: [...forecast.context.sessions],
    levels: forecast.levels.map((l) => ({ ...l })),
    inside10: { ...forecast.inside10 },
    inputs: JSON.parse(JSON.stringify(forecast.inputs)) as WeeklyRangeForecast['inputs'],
    priceSource: { ...meta.priceSource },
  });
  return { record, archive: [...archive, record] };
};

export interface LevelOutcome {
  odds: number;
  upperTouched: boolean;
  lowerTouched: boolean;
  closedAboveUpper: boolean;
  closedBelowLower: boolean;
}

export interface Settlement {
  status: 'settled' | 'pending';
  id: string;
  forecastDate: ISODate;
  /** Sessions still missing when pending. */
  missingSessions: ISODate[];
  high?: number;
  low?: number;
  weekClose?: number;
  up?: number;
  down?: number;
  closeChange?: number;
  levels?: LevelOutcome[];
  /** True when neither 10% boundary was touched. */
  inside10?: boolean;
  /** Split factor proven by the caller and applied to the stored levels. 1 when none. */
  splitFactor: number;
}

/**
 * Settle a frozen forecast against verified bars for exactly its stored expected sessions.
 * - Pending while any expected session is absent.
 * - No settlement across a basis change. The series basis must match and the anchor close in the
 *   series must equal the stored C, or equal C divided by a split factor the caller has proven.
 */
export const settleForecast = (
  record: FrozenForecast,
  series: { bars: readonly Bar[]; basis: PriceBasis },
  opts: { provenSplitFactor?: number } = {},
): Maybe<Settlement> => {
  if (series.basis !== record.basis) return na('basis-mismatch', `Forecast is on ${record.basis}, series is on ${series.basis}`);
  const factor = opts.provenSplitFactor ?? 1;
  if (!(factor > 0) || !Number.isFinite(factor)) return na('invalid-input', 'Split factor must be positive');
  const ai = indexOfDate(series.bars, record.forecastDate);
  if (ai < 0) return na('missing-session', `The series has no row for the forecast date ${record.forecastDate}`);
  const C = record.close / factor;
  if (Math.abs(series.bars[ai]!.close / C - 1) > WEEKLY_RANGE_DEFAULTS.basisTolerance) {
    return na('basis-mismatch', `Anchor close in the series is ${series.bars[ai]!.close}, the forecast stored ${record.close}. The basis cannot be proven.`);
  }
  const missing = record.expectedSessions.filter((d) => indexOfDate(series.bars, d) < 0);
  const base = { id: record.id, forecastDate: record.forecastDate, splitFactor: factor };
  if (missing.length > 0) return { ...base, status: 'pending', missingSessions: missing };
  const out = weekOutcome(series.bars, { sessions: [...record.expectedSessions], close: C });
  if (isNa(out)) return out;
  const levels = record.levels.map((l) => ({
    odds: l.odds,
    upperTouched: out.high >= l.upper / factor,
    lowerTouched: out.low <= l.lower / factor,
    closedAboveUpper: out.close > l.upper / factor,
    closedBelowLower: out.close < l.lower / factor,
  }));
  const ten = levels.find((l) => l.odds === 0.1);
  return {
    ...base,
    status: 'settled',
    missingSessions: [],
    high: out.high,
    low: out.low,
    weekClose: out.close,
    up: out.up,
    down: out.down,
    closeChange: out.closeChange,
    levels,
    inside10: ten ? !ten.upperTouched && !ten.lowerTouched : undefined,
  };
};

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

/** One settled stock week for evaluation. Moves are logs relative to that week's C. */
export interface EvaluationRow {
  ticker: string;
  forecastDate: ISODate;
  scale: number;
  up: number;
  down: number;
  closeChange: number;
  /**
   * Model probability for a log distance from C. Defaults to the normal tail with `scale`.
   * kind 'touch' is the one sided touch, 'close' is finishing beyond the level on that side.
   */
  prob?: (logLevel: number, side: 'up' | 'down', kind: 'touch' | 'close') => number;
  /** Per side boundaries by odds, as log distances. Defaults to k x scale. */
  levels?: readonly { odds: number; upperLog: number; lowerLog: number }[];
}

export interface BrierCell {
  brier: number;
  /** Number of one sided outcomes scored. */
  n: number;
}

export interface LevelEvaluation {
  /** d, the symmetric percent level. Upper strike C(1 + d), lower strike C / (1 + d). */
  d: number;
  logLevel: number;
  touch: BrierCell;
  close: BrierCell;
  observedTouch: Proportion | null;
  observedClose: Proportion | null;
  meanPredictedTouch: number;
  meanPredictedClose: number;
}

export interface NominalEvaluation {
  /** Nominal per side touch odds. */
  odds: number;
  /** Observed one sided touches over two outcomes per stock week. Interval uses stock weeks as the effective n. */
  observed: Proportion | null;
}

export interface RangeEvaluation {
  weeks: number;
  tickers: number;
  from: ISODate | null;
  to: ISODate | null;
  byLevel: LevelEvaluation[];
  /** Pooled across the four levels and both sides. */
  touch: BrierCell;
  close: BrierCell;
  nominal: NominalEvaluation[];
  notes: string[];
}

const normalProb = (S: number) => (logLevel: number, _side: 'up' | 'down', kind: 'touch' | 'close'): number => {
  const z = logLevel / S;
  return kind === 'touch' ? normalTouch(z) : 1 - normCdf(z);
};

/**
 * Brier at symmetric log levels +-ln(1 + d) for d = 3, 5, 8, 10%, touch and close scored
 * separately, plus observed touch frequency at the nominal 50, 20, 10, 5% boundaries.
 * Each stock week contributes two one sided outcomes. They are not independent, so intervals use
 * the number of stock weeks as a conservative effective sample size.
 */
export const evaluateRange = (rows: readonly EvaluationRow[], level = 0.95): RangeEvaluation => {
  const weeks = rows.length;
  let tSum = 0;
  let cSum = 0;
  let pooledN = 0;
  const byLevel: LevelEvaluation[] = WEEKLY_RANGE_SPEC.evaluationLevels.map((d) => {
    const L = Math.log(1 + d);
    let ts = 0;
    let cs = 0;
    let tHits = 0;
    let cHits = 0;
    let tp = 0;
    let cp = 0;
    for (const r of rows) {
      const prob = r.prob ?? normalProb(r.scale);
      const sides: ['up' | 'down', boolean, boolean][] = [
        ['up', r.up >= L, r.closeChange > L],
        ['down', r.down >= L, r.closeChange < -L],
      ];
      for (const [side, touched, closed] of sides) {
        const pt = prob(L, side, 'touch');
        const pc = prob(L, side, 'close');
        ts += (pt - (touched ? 1 : 0)) ** 2;
        cs += (pc - (closed ? 1 : 0)) ** 2;
        tp += pt;
        cp += pc;
        if (touched) tHits++;
        if (closed) cHits++;
      }
    }
    const n = 2 * weeks;
    tSum += ts;
    cSum += cs;
    pooledN += n;
    return {
      d,
      logLevel: L,
      touch: { brier: n ? ts / n : NaN, n },
      close: { brier: n ? cs / n : NaN, n },
      observedTouch: wilson(tHits, n, level, weeks),
      observedClose: wilson(cHits, n, level, weeks),
      meanPredictedTouch: n ? tp / n : NaN,
      meanPredictedClose: n ? cp / n : NaN,
    };
  });
  const nominal: NominalEvaluation[] = WEEKLY_RANGE_SPEC.touchLevels.map(({ odds, k }) => {
    let hits = 0;
    for (const r of rows) {
      const lv = r.levels?.find((l) => l.odds === odds);
      const upLog = lv ? lv.upperLog : k * r.scale;
      const downLog = lv ? lv.lowerLog : k * r.scale;
      if (r.up >= upLog) hits++;
      if (r.down >= downLog) hits++;
    }
    return { odds, observed: wilson(hits, 2 * weeks, level, weeks) };
  });
  const dates = rows.map((r) => r.forecastDate).sort();
  return {
    weeks,
    tickers: new Set(rows.map((r) => r.ticker)).size,
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
    byLevel,
    touch: { brier: pooledN ? tSum / pooledN : NaN, n: pooledN },
    close: { brier: pooledN ? cSum / pooledN : NaN, n: pooledN },
    nominal,
    notes: [
      'Each stock week contributes two one sided outcomes. Counts are not independent stock weeks and are not either boundary rates.',
      'The lower level is C / (1 + d), symmetric in log price.',
      'Stocks in the same market week are dependent. Treat intervals as optimistic for broader generalization.',
    ],
  };
};

export interface ReliabilityWindow {
  window: number;
  /** Distinct forecast weeks actually available inside the window. */
  weeksCounted: number;
  /** False when fewer distinct forecast weeks exist than the window asks for. */
  complete: boolean;
  evaluation: RangeEvaluation;
}

/** Reliability over the most recent 26 and 52 distinct forecast weeks. */
export const reliabilityWindows = (rows: readonly EvaluationRow[], windows: readonly number[] = WEEKLY_RANGE_SPEC.reliabilityWindows): ReliabilityWindow[] => {
  const dates = [...new Set(rows.map((r) => fridayOf(r.forecastDate)))].sort();
  return windows.map((w) => {
    const keep = new Set(dates.slice(-w));
    const subset = rows.filter((r) => keep.has(fridayOf(r.forecastDate)));
    return { window: w, weeksCounted: keep.size, complete: dates.length >= w, evaluation: evaluateRange(subset) };
  });
};

// ---------------------------------------------------------------------------------------------
// Far out of the money premium tracker (hypothetical, inspection only)
// ---------------------------------------------------------------------------------------------

export interface TrackedOptionLeg {
  contractId: string;
  underlying: string;
  kind: 'call' | 'put';
  strike: number;
  expiry: ISODate;
  multiplier: number;
  /** Bid premium per share at capture. Unavailable when the provider did not verify it. */
  bid: Maybe<number>;
  /** True only when the bid carries a verified quote timestamp. */
  bidVerified: boolean;
  ask?: Maybe<number>;
  iv?: Maybe<number>;
  delta?: Maybe<number>;
  quoteDate?: ISODate;
}

export interface StranglePnl {
  /** Hypothetical expiry P and L for one standard pair before fees. */
  pnl: number;
  premium: number;
  callIntrinsic: number;
  putIntrinsic: number;
  settlementClose: number;
  expiry: ISODate;
  /** Always true: a short strangle has uncovered risk on both sides. */
  uncoveredRisk: true;
  notes: string[];
}

/**
 * Hypothetical short strangle expiry P and L:
 * 100 x [bid_call + bid_put - max(close - K_call, 0) - max(K_put - close, 0)].
 * Only when both bids are verified, both contracts are standard and match the underlying and
 * expiry, and the settlement close is the verified close on the expiry session. No fill is
 * implied and nothing is sent anywhere.
 */
export const strangleExpiryPnl = (call: TrackedOptionLeg, put: TrackedOptionLeg, settlement: { underlying: string; date: ISODate; close: Maybe<number>; basisVerified: boolean }): Maybe<StranglePnl> => {
  if (call.kind !== 'call' || put.kind !== 'put') return na('invalid-input', 'Needs one call and one put');
  if (call.underlying !== put.underlying || call.underlying !== settlement.underlying) return na('invalid-input', 'Underlying does not match across legs and settlement');
  if (call.expiry !== put.expiry) return na('invalid-input', 'Call and put expiries differ');
  if (call.multiplier !== 100 || put.multiplier !== 100) return na('not-applicable', 'Adjusted or non standard contracts are not supported');
  if (settlement.date !== call.expiry) return na('not-matured', `Settlement close must be dated on the expiry ${call.expiry}`);
  if (!settlement.basisVerified) return na('basis-mismatch', 'Settlement close is not on a proven strike basis');
  if (isNa(settlement.close)) return settlement.close;
  if (isNa(call.bid) || isNa(put.bid)) return na('no-coverage', 'A bid premium is unavailable. No synthetic premium is used.');
  if (!call.bidVerified || !put.bidVerified) return na('not-validated', 'Both bid premiums need verified quote timestamps');
  if (!(call.bid >= 0) || !(put.bid >= 0) || !(call.strike > 0) || !(put.strike > 0)) return na('invalid-input', 'Premiums and strikes must be non negative and positive');
  const X = settlement.close;
  const callIntrinsic = Math.max(X - call.strike, 0);
  const putIntrinsic = Math.max(put.strike - X, 0);
  const premium = call.bid + put.bid;
  return {
    pnl: 100 * (premium - callIntrinsic - putIntrinsic),
    premium,
    callIntrinsic,
    putIntrinsic,
    settlementClose: X,
    expiry: call.expiry,
    uncoveredRisk: true,
    notes: [
      'Hypothetical. A bid at capture is not a fill and neither leg is guaranteed fillable.',
      'Before fees. Loss is uncapped above the call strike and large below the put strike.',
    ],
  };
};

/**
 * Pick the listed strikes nearest the intended range boundaries from a real contract listing.
 * The call strike is the lowest listed strike at or above `upper`, the put strike the highest at
 * or below `lower`. Unavailable when the listing has no such contract for the expiry.
 */
export const selectStrangleStrikes = (
  listing: readonly { contractId: string; kind: 'call' | 'put'; strike: number; expiry: ISODate; multiplier: number }[],
  target: { upper: number; lower: number; expiry: ISODate },
): Maybe<{ call: { contractId: string; strike: number }; put: { contractId: string; strike: number } }> => {
  const std = listing.filter((c) => c.expiry === target.expiry && c.multiplier === 100);
  const calls = std.filter((c) => c.kind === 'call' && c.strike >= target.upper).sort((a, b) => a.strike - b.strike);
  const puts = std.filter((c) => c.kind === 'put' && c.strike <= target.lower).sort((a, b) => b.strike - a.strike);
  if (!calls[0] || !puts[0]) return na('no-coverage', `No standard listed contract at or beyond the range for ${target.expiry}`);
  return { call: { contractId: calls[0].contractId, strike: calls[0].strike }, put: { contractId: puts[0].contractId, strike: puts[0].strike } };
};
