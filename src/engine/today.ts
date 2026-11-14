/**
 * Today: alert evaluation and the summary model for a watch list and positions.
 *
 * Definitions:
 * - Alerts come from completed sessions only. A call flagged provisional or hypothetical is refused.
 * - Earnings soon: a known earnings date 0 to `earningsWithinDays` calendar days from today.
 * - Down session: the latest completed close is at least `downSessionPct` below the previous close.
 * - Drawdown: the latest close is at least `drawdownPct` below the highest close of the lookback
 *   window ending at the latest session (default 252 sessions, or the whole history when shorter
 *   is all that exists and `drawdownLookback` is null). The alert is dated at the first session of
 *   the current breach, so repeated runs keep one alert per breach.
 * - New 200 day breach: the latest close is strictly below its SMA200 and the previous close was
 *   at or above its own SMA200. It fires on the breach session only.
 * - Dedup key: instrument, alert date, rule, state. The same condition never produces two alerts.
 * - Position dollars are shares times the latest completed close. An unknown share count or price
 *   contributes nothing and is listed as missing. It is never counted as zero.
 */
import { addDays, fridayOf, toDayNum } from './core/calendar';
import { sma } from './core/indicators';
import { nextEarnings, type NextEarnings } from './earnings';
import { isNa, na, type Bar, type EarningsEvent, type ISODate, type Instrument, type Maybe, type Unavailable } from './core/types';
import type { SourceHealth } from '../data/contracts';

export type AlertRule = 'earnings-soon' | 'down-session' | 'drawdown' | 'sma200-breach';
export type AlertSeverity = 'high' | 'medium' | 'low';

export interface AlertConfig {
  earningsWithinDays: number;
  downSessionPct: number;
  drawdownPct: number;
  /** Sessions in the closing high window for the drawdown rule. Null uses the whole history. */
  drawdownLookback: number | null;
  smaLength: number;
  enabled: Record<AlertRule, boolean>;
}

/** Reference defaults from the owner specification. All are configurable. */
export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  earningsWithinDays: 7,
  downSessionPct: 0.05,
  drawdownPct: 0.2,
  drawdownLookback: 252,
  smaLength: 200,
  enabled: { 'earnings-soon': true, 'down-session': true, drawdown: true, 'sma200-breach': true },
};

export const ALERT_CONFIG_PROVENANCE = {
  earningsWithinDays: 'spec',
  downSessionPct: 'spec',
  drawdownPct: 'spec',
  smaLength: 'spec',
  /** The specification says "the relevant closing high" without a window. 252 sessions is proposed. */
  drawdownLookback: 'proposed',
} as const;

export interface Alert {
  /** Dedup key: instrument | date | rule | state. */
  key: string;
  instrumentId: string;
  symbol: string;
  rule: AlertRule;
  /** Session or event date the alert refers to. */
  date: ISODate;
  state: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  /** The measured value behind the alert, as a fraction or a day count. */
  value: number;
}

export interface AlertEvaluation {
  alerts: Alert[];
  /** Rules that could not be evaluated, with the reason. A withheld rule is not an all clear. */
  withheld: { rule: AlertRule; reason: Unavailable }[];
}

export interface AlertInput {
  instrument: Pick<Instrument, 'id' | 'symbol' | 'type'>;
  /** Completed sessions only. */
  bars: Maybe<readonly Bar[]>;
  earnings: Maybe<readonly EarningsEvent[]>;
  /** Calendar date of the evaluation, exchange local. */
  today: ISODate;
  /** Latest session whose close has happened. When set, older data withholds the price rules as stale. */
  lastCompletedSession?: ISODate;
  /** True when any input is an intraday preview or other unconfirmed data. Refused. */
  provisional?: boolean;
  /** True when any input is a what if scenario. Refused. */
  hypothetical?: boolean;
}

const SEVERITY_ORDER: Record<AlertSeverity, number> = { high: 0, medium: 1, low: 2 };
const RULE_ORDER: Record<AlertRule, number> = { drawdown: 0, 'down-session': 1, 'sma200-breach': 2, 'earnings-soon': 3 };

/** Tolerance so a move that equals a threshold on paper is not lost to floating point rounding. */
const EPS = 1e-9;

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

const makeKey = (instrumentId: string, date: ISODate, rule: AlertRule, state: string): string => `${instrumentId}|${date}|${rule}|${state}`;

/**
 * Evaluate the alert rules for one instrument. Returns Unavailable when the inputs are provisional
 * or hypothetical, so a scenario or an intraday preview can never raise an alert.
 */
export const evaluateAlerts = (input: AlertInput, config: AlertConfig = DEFAULT_ALERT_CONFIG): Maybe<AlertEvaluation> => {
  if (input.provisional) return na('invalid-input', 'Alerts use completed sessions only. Provisional inputs are refused.');
  if (input.hypothetical) return na('invalid-input', 'Alerts are never produced from hypothetical inputs.');
  const { instrument } = input;
  const alerts: Alert[] = [];
  const withheld: AlertEvaluation['withheld'] = [];
  const add = (rule: AlertRule, date: ISODate, state: string, severity: AlertSeverity, title: string, detail: string, value: number) =>
    alerts.push({ key: makeKey(instrument.id, date, rule, state), instrumentId: instrument.id, symbol: instrument.symbol, rule, date, state, severity, title, detail, value });

  if (config.enabled['earnings-soon']) {
    const ne = nextEarnings(input.earnings, input.today, instrument.type);
    if (isNa(ne)) {
      if (ne.code !== 'not-applicable') withheld.push({ rule: 'earnings-soon', reason: ne });
    } else if (ne.daysUntil >= 0 && ne.daysUntil <= config.earningsWithinDays) {
      const when = ne.daysUntil === 0 ? 'today' : ne.daysUntil === 1 ? 'in 1 day' : `in ${ne.daysUntil} days`;
      add(
        'earnings-soon',
        ne.date,
        ne.status,
        ne.daysUntil <= 2 ? 'medium' : 'low',
        `Earnings ${when}`,
        `${ne.status === 'confirmed' ? 'Confirmed' : 'Estimated'} report date ${ne.date}.`,
        ne.daysUntil,
      );
    }
  }

  const priceRules: AlertRule[] = ['down-session', 'drawdown', 'sma200-breach'];
  const wantPrice = priceRules.some((r) => config.enabled[r]);
  if (wantPrice) {
    const bars = input.bars;
    const withholdAll = (reason: Unavailable) => {
      for (const r of priceRules) if (config.enabled[r]) withheld.push({ rule: r, reason });
    };
    if (isNa(bars)) withholdAll(bars);
    else if (bars.length === 0) withholdAll(na('no-coverage', 'No completed sessions'));
    else if (input.lastCompletedSession && bars[bars.length - 1]!.date < input.lastCompletedSession) {
      withholdAll(na('stale-source', `Latest close is ${bars[bars.length - 1]!.date}. The latest completed session is ${input.lastCompletedSession}.`));
    } else {
      const n = bars.length;
      const last = bars[n - 1]!;
      const closes = bars.map((b) => b.close);

      if (config.enabled['down-session']) {
        if (n < 2) withheld.push({ rule: 'down-session', reason: na('insufficient-history', 'Needs a previous close') });
        else {
          const ch = last.close / bars[n - 2]!.close - 1;
          if (ch <= -config.downSessionPct + EPS) {
            add('down-session', last.date, 'triggered', 'high', `Down ${pct(-ch)} in one session`, `Close ${last.close} on ${last.date} against ${bars[n - 2]!.close} on ${bars[n - 2]!.date}.`, ch);
          }
        }
      }

      if (config.enabled.drawdown) {
        const lb = config.drawdownLookback;
        // Drawdown from the highest close of the window ending at each session.
        const ddAt = (i: number): { dd: number; peakIdx: number } => {
          const from = lb === null ? 0 : Math.max(0, i - lb + 1);
          let pk = from;
          for (let j = from; j <= i; j++) if (closes[j]! > closes[pk]!) pk = j;
          return { dd: closes[i]! / closes[pk]! - 1, peakIdx: pk };
        };
        const cur = ddAt(n - 1);
        if (cur.dd <= -config.drawdownPct + EPS) {
          let start = n - 1;
          while (start - 1 >= 0 && ddAt(start - 1).dd <= -config.drawdownPct + EPS) start--;
          const peak = bars[cur.peakIdx]!;
          add(
            'drawdown',
            bars[start]!.date,
            'breached',
            'high',
            `Down ${pct(-cur.dd)} from the closing high`,
            `Closing high ${peak.close} on ${peak.date}. First ${pct(config.drawdownPct)} breach on ${bars[start]!.date}.${lb !== null && n < lb ? ' History is shorter than the lookback window.' : ''}`,
            cur.dd,
          );
        }
      }

      if (config.enabled['sma200-breach']) {
        const L = config.smaLength;
        if (n < L + 1) withheld.push({ rule: 'sma200-breach', reason: na('insufficient-history', `Needs ${L + 1} completed sessions, has ${n}`) });
        else {
          const s = sma(closes, L);
          const sNow = s[n - 1];
          const sPrev = s[n - 2];
          if (sNow !== null && sNow !== undefined && sPrev !== null && sPrev !== undefined && last.close < sNow && bars[n - 2]!.close >= sPrev) {
            add('sma200-breach', last.date, 'new-breach', 'medium', `New close below the ${L} session average`, `Close ${last.close} against an average of ${sNow.toFixed(2)}. The previous close was at or above its average.`, last.close / sNow - 1);
          }
        }
      }
    }
  }
  return { alerts: sortAlerts(alerts), withheld };
};

/** Severity first, then rule priority, then the larger absolute value, then symbol. */
export const sortAlerts = (alerts: readonly Alert[]): Alert[] =>
  [...alerts].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      RULE_ORDER[a.rule] - RULE_ORDER[b.rule] ||
      (a.rule === 'earnings-soon' ? a.value - b.value : Math.abs(b.value) - Math.abs(a.value)) ||
      a.symbol.localeCompare(b.symbol),
  );

/** Alerts whose key has not been seen. Also removes duplicates inside the batch. */
export const newAlerts = (alerts: readonly Alert[], seenKeys: Iterable<string>): Alert[] => {
  const seen = new Set(seenKeys);
  const out: Alert[] = [];
  for (const a of alerts) {
    if (seen.has(a.key)) continue;
    seen.add(a.key);
    out.push(a);
  }
  return out;
};

/* -------------------------------------------------------------------- summary */

export interface TodayInput {
  instrument: Pick<Instrument, 'id' | 'symbol' | 'name' | 'type'>;
  bars: Maybe<readonly Bar[]>;
  earnings: Maybe<readonly EarningsEvent[]>;
  /** Shares held. Undefined for a watch only name. Null when the position exists but the quantity is unknown. */
  shares?: number | null;
  /** Dated option implied move per share through an actual expiry, when a capture supports it. */
  impliedMove?: { perShare: number; expiry: ISODate };
}

export interface TodayRow {
  instrumentId: string;
  symbol: string;
  name: string;
  held: boolean;
  close: Maybe<number>;
  closeDate: Maybe<ISODate>;
  /** Latest close against the previous close. */
  dayChange: Maybe<number>;
  sma200: Maybe<{ value: number; distance: number; side: 'above' | 'below' | 'at' }>;
  /** Drawdown from the highest close of the alert lookback window. */
  drawdown: Maybe<{ value: number; peakDate: ISODate; peakClose: number }>;
  nextEarnings: Maybe<NextEarnings>;
  shares: Maybe<number>;
  /** Shares times the latest completed close. */
  positionValue: Maybe<number>;
  alerts: Alert[];
  withheld: AlertEvaluation['withheld'];
}

export interface TodayTotals {
  heldCount: number;
  watchOnlyCount: number;
  /** Sum of position values that could be marked. */
  positionDollars: number;
  /** Positions included in `positionDollars`. */
  markedCount: number;
  /** Held symbols with no usable price or share count. They are not in the total. */
  unmarked: string[];
  /** True only when every held position is marked. */
  complete: boolean;
}

export interface WeekAheadItem {
  symbol: string;
  date: ISODate;
  time: NextEarnings['time'];
  status: NextEarnings['status'];
  held: boolean;
  /** Shares times the latest completed close, for held symbols. */
  exposure: Maybe<number>;
  /** Option implied move per share times shares: a hypothetical holding scale move through the expiry. */
  impliedHoldingMove: Maybe<number>;
  impliedExpiry: ISODate | null;
}

export interface WeekAhead {
  from: ISODate;
  to: ISODate;
  items: WeekAheadItem[];
  /** Sum of known exposures of held symbols reporting in the window. */
  knownExposure: number;
  exposureCovered: number;
  /** Held symbols reporting in the window whose exposure is unknown. */
  exposureMissing: string[];
  /** Symbols with no usable earnings date. They may or may not report in the window. */
  dateUnknown: string[];
}

export interface TodaySummary {
  today: ISODate;
  lastCompletedSession: ISODate | null;
  rows: TodayRow[];
  totals: TodayTotals;
  /** New and standing alerts across all rows, most important first. */
  topFlags: Alert[];
  /** Rows with a down session alert, largest decline first. */
  selloffs: TodayRow[];
  /** Rows in an alert level drawdown, deepest first. */
  drawdowns: TodayRow[];
  weekAhead: WeekAhead;
  health: SourceHealth[];
  /** Sources that are not ok. A failed source limits what the rows above can say. */
  healthIssues: SourceHealth[];
}

export interface TodayOptions {
  today: ISODate;
  lastCompletedSession?: ISODate;
  config?: AlertConfig;
  health?: readonly SourceHealth[];
  topFlagLimit?: number;
}

const buildRow = (input: TodayInput, opts: TodayOptions, config: AlertConfig): TodayRow => {
  const held = input.shares !== undefined;
  const bars = input.bars;
  const stale = !isNa(bars) && bars.length > 0 && opts.lastCompletedSession !== undefined && bars[bars.length - 1]!.date < opts.lastCompletedSession;
  const base: Unavailable | null = isNa(bars) ? bars : bars.length === 0 ? na('no-coverage', 'No completed sessions') : null;
  let close: Maybe<number> = base ?? na('no-coverage');
  let closeDate: Maybe<ISODate> = base ?? na('no-coverage');
  let dayChange: Maybe<number> = base ?? na('no-coverage');
  let sma200: TodayRow['sma200'] = base ?? na('no-coverage');
  let drawdown: TodayRow['drawdown'] = base ?? na('no-coverage');
  if (!isNa(bars) && bars.length > 0) {
    const n = bars.length;
    const last = bars[n - 1]!;
    close = last.close;
    closeDate = last.date;
    dayChange = n >= 2 ? last.close / bars[n - 2]!.close - 1 : na('insufficient-history', 'Needs a previous close');
    const closes = bars.map((b) => b.close);
    const s = n >= config.smaLength ? sma(closes, config.smaLength)[n - 1] : null;
    sma200 =
      s === null || s === undefined
        ? na('insufficient-history', `Needs ${config.smaLength} completed sessions, has ${n}`)
        : { value: s, distance: last.close / s - 1, side: last.close > s ? 'above' : last.close < s ? 'below' : 'at' };
    const from = config.drawdownLookback === null ? 0 : Math.max(0, n - config.drawdownLookback);
    let pk = from;
    for (let j = from; j < n; j++) if (closes[j]! > closes[pk]!) pk = j;
    drawdown = { value: last.close / closes[pk]! - 1, peakDate: bars[pk]!.date, peakClose: closes[pk]! };
  }
  const shares: Maybe<number> =
    input.shares === undefined
      ? na('not-applicable', 'Watch only')
      : input.shares === null || !Number.isFinite(input.shares)
        ? na('no-coverage', 'Share quantity unknown')
        : input.shares;
  let positionValue: Maybe<number>;
  if (!held) positionValue = na('not-applicable', 'Watch only');
  else if (isNa(shares)) positionValue = shares;
  else if (typeof close !== 'number') positionValue = close;
  else if (stale) positionValue = na('stale-source', `Latest close is ${closeDate as ISODate}, older than the latest completed session`);
  else positionValue = shares * close;
  const evaluation = evaluateAlerts(
    { instrument: input.instrument, bars, earnings: input.earnings, today: opts.today, lastCompletedSession: opts.lastCompletedSession },
    config,
  );
  return {
    instrumentId: input.instrument.id,
    symbol: input.instrument.symbol,
    name: input.instrument.name,
    held,
    close,
    closeDate,
    dayChange,
    sma200,
    drawdown,
    nextEarnings: nextEarnings(input.earnings, opts.today, input.instrument.type),
    shares,
    positionValue,
    alerts: isNa(evaluation) ? [] : evaluation.alerts,
    withheld: isNa(evaluation) ? [] : evaluation.withheld,
  };
};

/**
 * Week Ahead queue: known reports from today through Friday of the current week, or through the
 * coming Friday when today is a weekend. Exposure is
 * shares times the completed close for held symbols. Unknown prices and dates are listed, never
 * summed as zero.
 */
export const weekAhead = (rows: readonly TodayRow[], inputs: readonly TodayInput[], today: ISODate): WeekAhead => {
  const fri = fridayOf(today);
  // On a weekend the queue looks at the coming Monday to Friday week.
  const to = fri < today ? addDays(fri, 7) : fri;
  const byId = new Map(inputs.map((i) => [i.instrument.id, i]));
  const items: WeekAheadItem[] = [];
  const dateUnknown: string[] = [];
  const exposureMissing: string[] = [];
  let knownExposure = 0;
  let exposureCovered = 0;
  for (const r of rows) {
    const ne = r.nextEarnings;
    if (isNa(ne)) {
      if (ne.code !== 'not-applicable') dateUnknown.push(r.symbol);
      continue;
    }
    if (ne.date < today || ne.date > to) continue;
    const input = byId.get(r.instrumentId);
    const exposure: Maybe<number> = r.held ? r.positionValue : na('not-applicable', 'Watch only');
    if (r.held) {
      if (typeof exposure === 'number') {
        knownExposure += exposure;
        exposureCovered++;
      } else exposureMissing.push(r.symbol);
    }
    const im = input?.impliedMove;
    const impliedHoldingMove: Maybe<number> = !r.held
      ? na('not-applicable', 'Watch only')
      : !im
        ? na('no-coverage', 'No dated option implied move for this symbol')
        : typeof r.shares !== 'number'
          ? r.shares
          : im.expiry < ne.date
            ? na('not-applicable', `Option expiry ${im.expiry} is before the report date`)
            : Math.abs(im.perShare) * Math.abs(r.shares);
    items.push({ symbol: r.symbol, date: ne.date, time: ne.time, status: ne.status, held: r.held, exposure, impliedHoldingMove, impliedExpiry: im?.expiry ?? null });
  }
  items.sort((a, b) => (a.date === b.date ? a.symbol.localeCompare(b.symbol) : a.date < b.date ? -1 : 1));
  return { from: today, to, items, knownExposure, exposureCovered, exposureMissing, dateUnknown };
};

/** Today summary for a watch list and positions. */
export const todaySummary = (inputs: readonly TodayInput[], opts: TodayOptions): TodaySummary => {
  const config = opts.config ?? DEFAULT_ALERT_CONFIG;
  const rows = inputs.map((i) => buildRow(i, opts, config));
  const heldRows = rows.filter((r) => r.held);
  let positionDollars = 0;
  let markedCount = 0;
  const unmarked: string[] = [];
  for (const r of heldRows) {
    if (typeof r.positionValue === 'number') {
      positionDollars += r.positionValue;
      markedCount++;
    } else unmarked.push(r.symbol);
  }
  const allAlerts = sortAlerts(newAlerts(rows.flatMap((r) => r.alerts), []));
  const num = (v: Maybe<number>): number => (typeof v === 'number' ? v : 0);
  const health = [...(opts.health ?? [])];
  return {
    today: opts.today,
    lastCompletedSession: opts.lastCompletedSession ?? null,
    rows,
    totals: { heldCount: heldRows.length, watchOnlyCount: rows.length - heldRows.length, positionDollars, markedCount, unmarked, complete: unmarked.length === 0 },
    topFlags: allAlerts.slice(0, opts.topFlagLimit ?? 8),
    selloffs: rows.filter((r) => r.alerts.some((a) => a.rule === 'down-session')).sort((a, b) => num(a.dayChange) - num(b.dayChange)),
    drawdowns: rows
      .filter((r) => r.alerts.some((a) => a.rule === 'drawdown'))
      .sort((a, b) => (isNa(a.drawdown) ? 0 : a.drawdown.value) - (isNa(b.drawdown) ? 0 : b.drawdown.value)),
    weekAhead: weekAhead(rows, inputs, opts.today),
    health,
    healthIssues: health.filter((h) => h.state !== 'ok'),
  };
};

/** Calendar days between today and a date. Negative when the date is in the past. */
export const daysFromToday = (today: ISODate, date: ISODate): number => toDayNum(date) - toDayNum(today);
