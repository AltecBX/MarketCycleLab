/**
 * Trading groups, industry views and co movement diagnostics (owner specification section 12).
 *
 * Definitions
 * - Three grouping models are kept separate: curated trading themes (owner research groupings),
 *   verified industry (issuer classification on the instrument), and provider classification
 *   (whatever a data provider labels). Membership can be many to many. The display group of a
 *   symbol is the first group in model order that contains it, which is deterministic.
 * - A group aggregate for a metric (Today, WTD, MTD, QTD, YTD) is equal weighted over the members
 *   that are in scope AND have the metric. It reports members defined, members in scope and
 *   members with data, so a 1 of 1 group is never presented as broad.
 * - Co movement over a window of W sessions uses simple daily returns over the last W exchange
 *   sessions ending at the last common date, keeping a slot only when both series have that
 *   session and the one before it. It needs at least
 *   max(30, ceil(0.8 x W)) comparable returns. The market excess version subtracts the benchmark
 *   return on the same dates. Same direction rate excludes days where either return is zero.
 *   These are descriptive and retrospective. A manual theme is not proof of co movement and
 *   today's membership applied to history is not a historical universe.
 * - Participation on a date puts the stock's daily return next to the peer median and the share
 *   of peers down, so a view can separate a stock specific move from group weakness.
 */
import type { TradingGroup } from '../data/contracts';
import { prevSession } from './core/calendar';
import { indexOfDate } from './core/series';
import { mean, median, pearson, wilson } from './core/stats';
import { isNa, isNum, na, type Bar, type ISODate, type Instrument, type Maybe, type Proportion } from './core/types';

export const GROUP_DEFAULTS = {
  /** Fewer members with data than this is flagged narrow. One is flagged single. */
  broadMinMembers: { value: 3, provenance: 'proposed' as const },
  topMovers: { value: 3, provenance: 'spec' as const },
  coMovementWindows: { value: [63, 252] as const, provenance: 'spec' as const },
  /** Share of peers down at or above which a decline reads as group wide. */
  groupWideShare: { value: 2 / 3, provenance: 'proposed' as const },
  /** Share of peers down at or below which a decline reads as stock specific. */
  stockSpecificShare: { value: 1 / 3, provenance: 'proposed' as const },
  minPeersForReading: { value: 2, provenance: 'proposed' as const },
} as const;

/** Minimum comparable returns for a co movement window: max(30, ceil(0.8 x window)). */
export const minComparableReturns = (window: number): number => Math.max(30, Math.ceil(0.8 * window));

/* ------------------------------------------------------------- grouping models */

export type GroupingKind = 'curated-theme' | 'verified-industry' | 'provider-classification';

export interface GroupDef {
  id: string;
  name: string;
  kind: GroupingKind;
  members: string[];
  /** Why these names sit together and the evidence quality. */
  basis: string;
}

export interface GroupingModel {
  kind: GroupingKind;
  label: string;
  note: string;
  groups: GroupDef[];
  /** Symbols the model could not place. */
  unclassified: string[];
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Curated trading themes. Order is preserved and decides the display group. */
export const themesGrouping = (groups: readonly TradingGroup[]): GroupingModel => ({
  kind: 'curated-theme',
  label: 'Trading groups',
  note: 'Curated research themes. A theme is not evidence of co movement.',
  groups: groups.map((g) => ({ id: g.id, name: g.name, kind: 'curated-theme', members: [...g.members], basis: g.basis })),
  unclassified: [],
});

/** Verified industry from the instrument record. Funds and unclassified names are listed, not guessed. */
export const industryGrouping = (instruments: readonly Instrument[]): GroupingModel => {
  const map = new Map<string, string[]>();
  const unclassified: string[] = [];
  for (const i of instruments) {
    if (i.type === 'etf' || i.type === 'index') continue;
    if (!i.industry) unclassified.push(i.symbol);
    else map.set(i.industry, [...(map.get(i.industry) ?? []), i.symbol]);
  }
  return {
    kind: 'verified-industry',
    label: 'Industry',
    note: 'Industry classification on the instrument record. Each symbol has one industry.',
    groups: [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, members]) => ({ id: `industry:${slug(name)}`, name, kind: 'verified-industry', members, basis: 'Instrument industry classification' })),
    unclassified,
  };
};

/** Provider classification, kept apart from verified industry so a provider label never overrides it. */
export const providerGrouping = (classification: Readonly<Record<string, string | null | undefined>>, providerLabel: string): GroupingModel => {
  const map = new Map<string, string[]>();
  const unclassified: string[] = [];
  for (const [symbol, label] of Object.entries(classification)) {
    if (!label) unclassified.push(symbol);
    else map.set(label, [...(map.get(label) ?? []), symbol]);
  }
  return {
    kind: 'provider-classification',
    label: `${providerLabel} classification`,
    note: `Labels as supplied by ${providerLabel}. Not reviewed against issuer evidence.`,
    groups: [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, members]) => ({ id: `provider:${slug(name)}`, name, kind: 'provider-classification', members, basis: `${providerLabel} label` })),
    unclassified,
  };
};

/** Every group of the model that contains the symbol, in model order. */
export const membershipsOf = (symbol: string, model: GroupingModel): GroupDef[] => model.groups.filter((g) => g.members.includes(symbol));

/** The one deterministic display group of a symbol: the first group in model order that contains it. */
export const displayGroupOf = (symbol: string, model: GroupingModel): GroupDef | null => model.groups.find((g) => g.members.includes(symbol)) ?? null;

/** Case insensitive exact lookup of a group by name or id. */
export const findGroup = (model: GroupingModel, nameOrId: string): GroupDef | null => {
  const q = nameOrId.trim().toLowerCase();
  return model.groups.find((g) => g.id.toLowerCase() === q || g.name.toLowerCase() === q) ?? null;
};

/* ------------------------------------------------------------------ aggregates */

export type GroupMetric = 'day' | 'wtd' | 'mtd' | 'qtd' | 'ytd';

export const GROUP_METRIC_LABELS: Record<GroupMetric, string> = { day: 'Today', wtd: 'WTD', mtd: 'MTD', qtd: 'QTD', ytd: 'YTD' };

/** The minimal row a group view needs. A screener row satisfies it. */
export interface MetricRow {
  symbol: string;
  name?: string;
  dayChange: Maybe<number>;
  wtd: Maybe<number>;
  mtd: Maybe<number>;
  qtd: Maybe<number>;
  ytd: Maybe<number>;
}

export const metricOf = (row: MetricRow, metric: GroupMetric): Maybe<number> => (metric === 'day' ? row.dayChange : row[metric]);

export type GroupStat = 'average' | 'median';
export type Breadth = 'none' | 'single' | 'narrow' | 'broad';

export interface MemberValue {
  symbol: string;
  value: number;
}

export interface GroupAggregate {
  groupId: string;
  name: string;
  kind: GroupingKind;
  /** Members the group defines. */
  members: number;
  /** Members present in the rows passed in (the active universe and filters). */
  inScope: number;
  /** Members in scope that have the metric. The denominator of the aggregate. */
  withData: number;
  average: Maybe<number>;
  median: Maybe<number>;
  /** The selected statistic. */
  value: Maybe<number>;
  up: number;
  down: number;
  flat: number;
  best: MemberValue | null;
  worst: MemberValue | null;
  breadth: Breadth;
  /** Plain coverage text such as "4 of 5 members with data". */
  coverageLabel: string;
  /** Signed bar length on the common zero scale, -1 to 1. Zero when unavailable. */
  bar: number;
  /** Member values, strongest first. */
  values: MemberValue[];
}

export interface GroupComparison {
  metric: GroupMetric;
  metricLabel: string;
  stat: GroupStat;
  order: 'strongest' | 'weakest';
  aggregates: GroupAggregate[];
  /** Largest absolute selected statistic. Bars are value / maxAbs around zero. */
  maxAbs: number;
  groupingKind: GroupingKind;
  groupingLabel: string;
}

export interface AggregateOptions {
  stat?: GroupStat;
  order?: 'strongest' | 'weakest';
  /** Case insensitive search on group name. */
  search?: string;
}

const breadthOf = (withData: number): Breadth =>
  withData === 0 ? 'none' : withData === 1 ? 'single' : withData < GROUP_DEFAULTS.broadMinMembers.value ? 'narrow' : 'broad';

/**
 * Equal weighted group comparison for one metric over the rows passed in. Pass the rows that
 * survive the active universe and filters so denominators match what the list shows.
 */
export const aggregateGroups = (rows: readonly MetricRow[], model: GroupingModel, metric: GroupMetric, opts: AggregateOptions = {}): GroupComparison => {
  const stat = opts.stat ?? 'average';
  const order = opts.order ?? 'strongest';
  const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
  const q = opts.search?.trim().toLowerCase() ?? '';
  const aggregates: GroupAggregate[] = [];
  for (const g of model.groups) {
    if (q !== '' && !g.name.toLowerCase().includes(q)) continue;
    const values: MemberValue[] = [];
    let inScope = 0;
    for (const s of g.members) {
      const row = bySymbol.get(s);
      if (!row) continue;
      inScope++;
      const v = metricOf(row, metric);
      if (isNum(v)) values.push({ symbol: s, value: v });
    }
    values.sort((a, b) => b.value - a.value);
    const xs = values.map((v) => v.value);
    const none = na('no-coverage', inScope === 0 ? 'No member in the current list' : `No member has ${GROUP_METRIC_LABELS[metric]} data`);
    const average: Maybe<number> = xs.length ? mean(xs) : none;
    const med: Maybe<number> = xs.length ? median(xs) : none;
    aggregates.push({
      groupId: g.id,
      name: g.name,
      kind: g.kind,
      members: g.members.length,
      inScope,
      withData: xs.length,
      average,
      median: med,
      value: stat === 'average' ? average : med,
      up: xs.filter((x) => x > 0).length,
      down: xs.filter((x) => x < 0).length,
      flat: xs.filter((x) => x === 0).length,
      best: values[0] ?? null,
      worst: values[values.length - 1] ?? null,
      breadth: breadthOf(xs.length),
      coverageLabel: `${xs.length} of ${g.members.length} members with data`,
      bar: 0,
      values,
    });
  }
  const sign = order === 'strongest' ? -1 : 1;
  const indexed = aggregates.map((a, idx) => ({ a, idx }));
  indexed.sort((x, y) => {
    const xv = isNum(x.a.value) ? x.a.value : null;
    const yv = isNum(y.a.value) ? y.a.value : null;
    if (xv === null || yv === null) return xv === null && yv === null ? x.idx - y.idx : xv === null ? 1 : -1;
    return xv !== yv ? sign * (xv - yv) : x.idx - y.idx;
  });
  const sorted = indexed.map((x) => x.a);
  let maxAbs = 0;
  for (const a of sorted) if (isNum(a.value)) maxAbs = Math.max(maxAbs, Math.abs(a.value));
  for (const a of sorted) a.bar = isNum(a.value) && maxAbs > 0 ? a.value / maxAbs : 0;
  return {
    metric,
    metricLabel: GROUP_METRIC_LABELS[metric],
    stat,
    order,
    aggregates: sorted,
    maxAbs,
    groupingKind: model.kind,
    groupingLabel: model.label,
  };
};

export interface TopMovers {
  metric: GroupMetric;
  /** What the lists cover, for example "All stocks, Today" or a group name. */
  scopeLabel: string;
  /** Rows in scope with the metric. */
  withData: number;
  /** Highest positive values, strongest first. Never contains a non positive value. */
  winners: MemberValue[];
  /** Lowest negative values, weakest first. Never contains a non negative value. */
  losers: MemberValue[];
  /** Plain text for an empty side, or null. */
  winnersNote: string | null;
  losersNote: string | null;
}

/** Top winners and losers for the active comparison, optionally limited to one group's members. */
export const topMovers = (
  rows: readonly MetricRow[],
  metric: GroupMetric,
  opts: { n?: number; group?: Pick<GroupDef, 'name' | 'members'> | null } = {},
): TopMovers => {
  const n = opts.n ?? GROUP_DEFAULTS.topMovers.value;
  const members = opts.group ? new Set(opts.group.members) : null;
  const vals: MemberValue[] = [];
  for (const r of rows) {
    if (members && !members.has(r.symbol)) continue;
    const v = metricOf(r, metric);
    if (isNum(v)) vals.push({ symbol: r.symbol, value: v });
  }
  const desc = [...vals].sort((a, b) => b.value - a.value);
  const winners = desc.filter((v) => v.value > 0).slice(0, n);
  const losers = desc.filter((v) => v.value < 0).reverse().slice(0, n);
  const label = GROUP_METRIC_LABELS[metric];
  const empty = vals.length === 0 ? `No ${label} data in this scope` : null;
  return {
    metric,
    scopeLabel: `${opts.group ? opts.group.name : 'All stocks in the list'}, ${label}`,
    withData: vals.length,
    winners,
    losers,
    winnersNote: winners.length ? null : empty ?? `No gainers ${metric === 'day' ? 'today' : `for ${label}`}`,
    losersNote: losers.length ? null : empty ?? `No decliners ${metric === 'day' ? 'today' : `for ${label}`}`,
  };
};

/* ----------------------------------------------------------------- co movement */

export interface CoMovement {
  window: number;
  /** Comparable one session returns used. */
  n: number;
  minRequired: number;
  /** Pearson correlation of simple daily returns. */
  correlation: number;
  /** Pearson correlation of returns in excess of the benchmark, when a benchmark was supplied. */
  excessCorrelation: Maybe<number>;
  /** Share of days both moved the same way, among days where neither return was zero. */
  sameDirection: Proportion | null;
  from: ISODate;
  to: ISODate;
  /** Window slots dropped because a session was missing in one of the series. */
  dropped: number;
  label: string;
}

interface ReturnPoint {
  date: ISODate;
  ra: number;
  rb: number;
  rm: number | null;
}

/**
 * Co movement of two series over the last `window` sessions ending at their last common date.
 * Optional `market` bars (for example SPY) add the market excess correlation.
 */
export const coMovement = (a: readonly Bar[], b: readonly Bar[], window: number, market?: readonly Bar[] | null): Maybe<CoMovement> => {
  if (a.length < 2 || b.length < 2) return na('no-coverage', 'A series has fewer than two sessions');
  const lastCommon = a[a.length - 1]!.date < b[b.length - 1]!.date ? a[a.length - 1]!.date : b[b.length - 1]!.date;
  const firstCommon = a[0]!.date > b[0]!.date ? a[0]!.date : b[0]!.date;
  const aIndex = new Map(a.map((x, i) => [x.date, i]));
  const bIndex = new Map(b.map((x, i) => [x.date, i]));
  const mIndex = market ? new Map(market.map((x, i) => [x.date, i])) : null;
  const points: ReturnPoint[] = [];
  let dropped = 0;
  // Walk exchange sessions backward from the last common date, one return slot per session.
  let d = lastCommon;
  for (let slot = 0; slot < window; slot++) {
    const p = prevSession(d);
    if (p < firstCommon) break;
    const ia = aIndex.get(d);
    const jb = bIndex.get(d);
    if (ia === undefined || jb === undefined || ia < 1 || jb < 1 || a[ia - 1]!.date !== p || b[jb - 1]!.date !== p) {
      dropped++;
    } else {
      let rm: number | null = null;
      if (market && mIndex) {
        const jm = mIndex.get(d);
        if (jm !== undefined && jm >= 1 && market[jm - 1]!.date === p) rm = market[jm]!.close / market[jm - 1]!.close - 1;
      }
      points.push({ date: d, ra: a[ia]!.close / a[ia - 1]!.close - 1, rb: b[jb]!.close / b[jb - 1]!.close - 1, rm });
    }
    d = p;
  }
  points.reverse();
  const minRequired = minComparableReturns(window);
  if (points.length === 0) return na('no-coverage', 'No comparable one session returns on common dates');
  if (points.length < minRequired) {
    return na('sample-too-small', `Sparse. ${points.length} comparable returns, needs ${minRequired} for a ${window} session window.`);
  }
  const corr = pearson(points.map((p) => p.ra), points.map((p) => p.rb));
  if (!Number.isFinite(corr)) return na('not-applicable', 'A series did not move inside the window');
  let excess: Maybe<number>;
  if (!market) excess = na('not-applicable', 'No benchmark supplied');
  else {
    const withM = points.filter((p) => p.rm !== null);
    if (withM.length < minRequired) {
      excess = na('sample-too-small', `Sparse. ${withM.length} dates with the benchmark, needs ${minRequired}.`);
    } else {
      const c = pearson(withM.map((p) => p.ra - p.rm!), withM.map((p) => p.rb - p.rm!));
      excess = Number.isFinite(c) ? c : na('not-applicable', 'Excess returns did not vary');
    }
  }
  const moved = points.filter((p) => p.ra !== 0 && p.rb !== 0);
  const same = moved.filter((p) => p.ra > 0 === p.rb > 0).length;
  return {
    window,
    n: points.length,
    minRequired,
    correlation: corr,
    excessCorrelation: excess,
    sameDirection: wilson(same, moved.length),
    from: points[0]!.date,
    to: points[points.length - 1]!.date,
    dropped,
    label: 'Descriptive and retrospective. Daily returns on common dates. Not a forecast of future co movement.',
  };
};

export interface PairDiagnostic {
  a: string;
  b: string;
  result: Maybe<CoMovement>;
}

/** Pairwise co movement for every pair of the supplied series. */
export const coMovementMatrix = (
  series: readonly { symbol: string; bars: readonly Bar[] }[],
  window: number,
  market?: readonly Bar[] | null,
): PairDiagnostic[] => {
  const out: PairDiagnostic[] = [];
  for (let i = 0; i < series.length; i++) {
    for (let j = i + 1; j < series.length; j++) {
      out.push({ a: series[i]!.symbol, b: series[j]!.symbol, result: coMovement(series[i]!.bars, series[j]!.bars, window, market) });
    }
  }
  return out;
};

/* --------------------------------------------------------------- participation */

export type ParticipationReading = 'group-wide' | 'stock-specific' | 'mixed' | 'not-a-decline' | 'unknown';

export interface GroupParticipation {
  date: ISODate;
  symbol: string;
  stockReturn: Maybe<number>;
  /** Peers only. The stock itself is excluded. */
  peers: { symbol: string; ret: Maybe<number> }[];
  peersWithData: number;
  peerMedian: Maybe<number>;
  /** Stock return minus peer median, in percentage points as a fraction. */
  versusPeerMedian: Maybe<number>;
  /** Share of peers with a lower close that day. */
  peersDown: Proportion | null;
  downSymbols: string[];
  upSymbols: string[];
  reading: ParticipationReading;
  /** The rule behind the reading, so it can be shown. */
  readingBasis: string;
}

/** One session simple return on `date`, requiring the previous exchange session to be present. */
export const sessionReturn = (bars: readonly Bar[] | undefined, date: ISODate): Maybe<number> => {
  if (!bars || bars.length === 0) return na('no-coverage', 'No history loaded');
  const i = indexOfDate(bars, date);
  if (i < 0) return na('missing-session', `No completed session on ${date}`);
  if (i === 0) return na('insufficient-history', 'No previous close');
  if (bars[i - 1]!.date !== prevSession(date)) return na('missing-session', `Expected a close on ${prevSession(date)}`);
  return bars[i]!.close / bars[i - 1]!.close - 1;
};

/**
 * Who participated on a date: the stock's return, each peer's return, the peer median and the
 * share of peers down. The reading follows a stated share rule and is unknown with too few peers.
 */
export const groupParticipation = (
  symbol: string,
  date: ISODate,
  members: readonly string[],
  barsBySymbol: ReadonlyMap<string, readonly Bar[]>,
): GroupParticipation => {
  const stockReturn = sessionReturn(barsBySymbol.get(symbol), date);
  const peers = members.filter((m) => m !== symbol).map((m) => ({ symbol: m, ret: sessionReturn(barsBySymbol.get(m), date) }));
  const have = peers.filter((p): p is { symbol: string; ret: number } => isNum(p.ret));
  const xs = have.map((p) => p.ret);
  const peerMedian: Maybe<number> = xs.length ? median(xs) : na('no-coverage', 'No peer has a return on this date');
  const down = have.filter((p) => p.ret < 0);
  const share = xs.length ? down.length / xs.length : null;
  const wide = GROUP_DEFAULTS.groupWideShare.value;
  const narrow = GROUP_DEFAULTS.stockSpecificShare.value;
  let reading: ParticipationReading;
  if (!isNum(stockReturn) || share === null || xs.length < GROUP_DEFAULTS.minPeersForReading.value) reading = 'unknown';
  else if (stockReturn >= 0) reading = 'not-a-decline';
  else if (share >= wide) reading = 'group-wide';
  else if (share <= narrow) reading = 'stock-specific';
  else reading = 'mixed';
  return {
    date,
    symbol,
    stockReturn,
    peers,
    peersWithData: xs.length,
    peerMedian,
    versusPeerMedian: isNum(stockReturn) && isNum(peerMedian) ? stockReturn - peerMedian : isNa(stockReturn) ? stockReturn : peerMedian,
    peersDown: wilson(down.length, xs.length),
    downSymbols: down.map((p) => p.symbol),
    upSymbols: have.filter((p) => p.ret > 0).map((p) => p.symbol),
    reading,
    readingBasis:
      'Group wide when at least two thirds of peers with data closed lower, stock specific when at most one third did, mixed otherwise. Needs two peers with data.',
  };
};

/** The same participation view from period metrics already on rows (WTD, MTD, QTD, YTD or Today). */
export const participationFromRows = (
  symbol: string,
  rows: readonly MetricRow[],
  group: Pick<GroupDef, 'members'>,
  metric: GroupMetric,
): { stock: Maybe<number>; peerMedian: Maybe<number>; peersWithData: number; peersDown: Proportion | null; versusPeerMedian: Maybe<number> } => {
  const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
  const self = bySymbol.get(symbol);
  const stock: Maybe<number> = self ? metricOf(self, metric) : na('no-coverage', 'Symbol is not in the current list');
  const xs: number[] = [];
  for (const m of group.members) {
    if (m === symbol) continue;
    const r = bySymbol.get(m);
    const v = r ? metricOf(r, metric) : null;
    if (isNum(v)) xs.push(v);
  }
  const peerMedian: Maybe<number> = xs.length ? median(xs) : na('no-coverage', 'No peer has this metric');
  return {
    stock,
    peerMedian,
    peersWithData: xs.length,
    peersDown: wilson(xs.filter((x) => x < 0).length, xs.length),
    versusPeerMedian: isNum(stock) && isNum(peerMedian) ? stock - peerMedian : isNa(stock) ? stock : peerMedian,
  };
};
