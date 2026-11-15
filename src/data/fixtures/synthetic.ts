/**
 * Deterministic synthetic market data for fixture mode and tests.
 *
 * NOTHING here is market data. Series are generated from seeded random factors on the real
 * exchange session calendar so that every engine can be exercised with realistic structure:
 * a market factor, group factors, volatility clustering, earnings gaps, short histories.
 * Every payload carries `kind: 'synthetic-fixture'` and the UI shows that label wherever a
 * number appears.
 */
import { addDays, isSession, monthOf, sessionOnOrAfter, sessionsBetween, yearOf, ymd } from '../../engine/core/calendar';
import { buildCoverage } from '../../engine/core/series';
import { hashString, mulberry32 } from '../../engine/core/stats';
import { na, type Bar, type DailySeries, type EarningsEvent, type EarningsTime, type ISODate, type Instrument, type Maybe, type SourceCapture } from '../../engine/core/types';
import type { CalendarEntry, CashFlowPeriod, Fundamentals } from '../contracts';
import { GROUPS, INSTRUMENTS, primaryGroupOf } from './universe';

export const FIXTURE_VERSION = 'synthetic-v1';
export const FIXTURE_AS_OF: ISODate = '2026-11-13';
export const FIXTURE_NOW = '2026-11-14T15:00:00Z';
const DEFAULT_START: ISODate = '2010-01-04';

export const fixtureSource = (note?: string): SourceCapture => ({
  provider: FIXTURE_VERSION,
  kind: 'synthetic-fixture',
  capturedAt: FIXTURE_NOW,
  version: FIXTURE_VERSION,
  note: note ?? 'Synthetic fixture. Generated for testing. Not market data.',
});

const gaussian = (rnd: () => number): number => {
  let u = 0;
  while (u === 0) u = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
};

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Factor returns shared across symbols, keyed by session date. Built once. */
interface Factors {
  dates: ISODate[];
  index: Map<ISODate, number>;
  market: Float64Array;
  groups: Map<string, Float64Array>;
}

let factorCache: Factors | null = null;

const factors = (): Factors => {
  if (factorCache) return factorCache;
  const dates = sessionsBetween('1999-01-04', FIXTURE_AS_OF);
  const index = new Map(dates.map((d, i) => [d, i]));
  const rnd = mulberry32(hashString('market-factor'));
  const market = new Float64Array(dates.length);
  // Volatility clustering: a slow log-vol state plus rare stress regimes.
  let lv = 0;
  let stress = 0;
  for (let i = 0; i < dates.length; i++) {
    lv = 0.97 * lv + 0.12 * gaussian(rnd);
    if (stress > 0) stress--;
    else if (rnd() < 0.0016) stress = 25 + Math.floor(rnd() * 50);
    const vol = 0.0085 * Math.exp(lv) * (stress > 0 ? 2.1 : 1);
    const drift = stress > 0 ? -0.0016 : 0.00048;
    market[i] = drift + vol * gaussian(rnd);
  }
  const groups = new Map<string, Float64Array>();
  for (const g of GROUPS) {
    const r = mulberry32(hashString(`group:${g.id}`));
    const arr = new Float64Array(dates.length);
    let glv = 0;
    // The group level is mean reverting, so a group cannot drift arbitrarily far from the market.
    let level = 0;
    for (let i = 0; i < dates.length; i++) {
      glv = 0.96 * glv + 0.15 * gaussian(r);
      const next = 0.9985 * level + 0.0075 * Math.exp(glv) * gaussian(r);
      arr[i] = 0.00008 + next - level;
      level = next;
    }
    groups.set(g.id, arr);
  }
  factorCache = { dates, index, market, groups };
  return factorCache;
};

interface Profile {
  beta: number;
  groupBeta: number;
  idioVol: number;
  drift: number;
  endPrice: number;
  baseVolume: number;
}

const profileOf = (inst: Instrument): Profile => {
  const rnd = mulberry32(hashString(`profile:${inst.symbol}`));
  if (inst.symbol === 'SPY') return { beta: 1, groupBeta: 0, idioVol: 0.0008, drift: 0, endPrice: 668, baseVolume: 70e6 };
  if (inst.type === 'etf') {
    return { beta: 0.85 + rnd() * 0.5, groupBeta: 0.5, idioVol: 0.003 + rnd() * 0.003, drift: 0, endPrice: 40 + rnd() * 260, baseVolume: 4e6 + rnd() * 30e6 };
  }
  return {
    beta: 0.8 + rnd() * 1.1,
    groupBeta: 0.7 + rnd() * 0.8,
    idioVol: 0.009 + rnd() * 0.013,
    drift: 0.00002 + rnd() * 0.0003,
    endPrice: 18 + Math.exp(rnd() * 3.2) * 22,
    baseVolume: 2e6 + Math.exp(rnd() * 3.5) * 2e6,
  };
};

const FISCAL_PATTERNS: readonly (readonly number[])[] = [
  [1, 4, 7, 10],
  [2, 5, 8, 11],
  [3, 6, 9, 12],
];

/** Deterministic quarterly earnings schedule for a stock, past and next. ETFs have none. */
export const syntheticEarnings = (inst: Instrument): Maybe<EarningsEvent[]> => {
  if (inst.type === 'etf' || inst.type === 'index') return na('not-applicable', 'Funds do not report earnings');
  const rnd = mulberry32(hashString(`earnings:${inst.symbol}`));
  const pattern = FISCAL_PATTERNS[Math.floor(rnd() * 3)]!;
  const dayBase = 5 + Math.floor(rnd() * 20);
  const timeRoll = rnd();
  const baseTime: EarningsTime = timeRoll < 0.55 ? 'amc' : timeRoll < 0.92 ? 'bmo' : 'unknown';
  const start = inst.listedOn && inst.listedOn > DEFAULT_START ? inst.listedOn : DEFAULT_START;
  const out: EarningsEvent[] = [];
  for (let y = yearOf(start); y <= yearOf(FIXTURE_AS_OF) + 1; y++) {
    for (const m of pattern) {
      const jitter = Math.floor(rnd() * 5) - 2;
      const date = sessionOnOrAfter(ymd(y, m, Math.min(27, Math.max(1, dayBase + jitter))));
      if (date < addDays(start, 45)) continue;
      const future = date > FIXTURE_AS_OF;
      if (future && out.some((e) => e.date > FIXTURE_AS_OF)) continue; // keep only the next one
      const q = Math.floor((m - 1) / 3) + 1;
      const surprise = gaussian(rnd) * 0.06;
      const est = round2(0.4 + rnd() * 3);
      out.push({
        instrumentId: inst.id,
        symbol: inst.symbol,
        date,
        time: baseTime,
        status: future ? (rnd() < 0.6 ? 'confirmed' : 'estimated') : 'confirmed',
        fiscalPeriod: `FY${y} Q${q}`,
        knownAt: `${addDays(date, -21)}T21:00:00Z`,
        epsEstimate: est,
        epsActual: future ? null : round2(est * (1 + surprise)),
        revenueEstimate: null,
        revenueActual: null,
        source: fixtureSource(),
      });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
};

/** The first regular session that can react to a release, using the shared timing rule. */
const reactionDate = (e: EarningsEvent): ISODate | null => {
  if (e.time === 'bmo' || e.time === 'during') return isSession(e.date) ? e.date : sessionOnOrAfter(e.date);
  if (e.time === 'amc') return sessionOnOrAfter(addDays(e.date, 1));
  return null;
};

const seriesCache = new Map<string, DailySeries>();

/** Synthetic split-consistent daily OHLCV for one instrument through the fixture as-of date. */
export const syntheticDaily = (inst: Instrument): DailySeries => {
  const hit = seriesCache.get(inst.id);
  if (hit) return hit;
  const f = factors();
  const p = profileOf(inst);
  const start = inst.symbol === 'NVDA' ? '1999-01-22' : inst.listedOn && inst.listedOn > DEFAULT_START ? inst.listedOn : DEFAULT_START;
  const startIdx = f.dates.findIndex((d) => d >= start);
  const rnd = mulberry32(hashString(`series:${inst.symbol}`));
  const group = primaryGroupOf(inst.symbol);
  const gf = group ? f.groups.get(group.id) : undefined;
  const earn = syntheticEarnings(inst);
  const reactions = new Set<ISODate>();
  if (Array.isArray(earn)) for (const e of earn) { const d = reactionDate(e); if (d) reactions.add(d); }

  const n = f.dates.length - startIdx;
  const rets = new Float64Array(n);
  let lv = 0;
  // The stock specific level is mean reverting (half life near three years) so long histories stay plausible.
  let idio = 0;
  for (let k = 0; k < n; k++) {
    const i = startIdx + k;
    lv = 0.95 * lv + 0.16 * gaussian(rnd);
    const nextIdio = 0.9991 * idio + p.idioVol * Math.exp(lv) * gaussian(rnd);
    let r = p.drift + p.beta * f.market[i]! + (gf ? p.groupBeta * gf[i]! : 0) + (nextIdio - idio);
    idio = nextIdio;
    if (reactions.has(f.dates[i]!)) r += gaussian(rnd) * (0.035 + p.idioVol * 2.2);
    rets[k] = Math.max(-0.45, Math.min(0.6, r));
  }
  // Anchor the path so the final close equals the profile's end price.
  let logSum = 0;
  for (let k = 1; k < n; k++) logSum += Math.log(1 + rets[k]!);
  let close = p.endPrice / Math.exp(logSum);
  const bars: Bar[] = [];
  for (let k = 0; k < n; k++) {
    const date = f.dates[startIdx + k]!;
    const prev = close;
    if (k > 0) close = prev * (1 + rets[k]!);
    const r = k > 0 ? rets[k]! : 0;
    const gapShare = reactions.has(date) ? 0.8 : 0.25 + 0.3 * rnd();
    const open = k > 0 ? prev * (1 + r * gapShare) : close * (1 + 0.002 * gaussian(rnd));
    const span = Math.abs(close - open) + close * (0.004 + Math.abs(gaussian(rnd)) * (p.idioVol * 0.55 + 0.003));
    const up = rnd();
    const high = Math.max(open, close) + span * 0.5 * up;
    const low = Math.max(0.01, Math.min(open, close) - span * 0.5 * (1 - up));
    const vol = Math.round(p.baseVolume * Math.exp(0.35 * gaussian(rnd)) * (1 + 14 * Math.abs(r)) * (reactions.has(date) ? 1.9 : 1));
    const o = round2(open);
    const c = round2(close);
    bars.push({ date, open: o, high: round2(Math.max(high, o, c)), low: round2(Math.max(0.01, Math.min(low, o, c))), close: c, volume: vol });
  }
  const series: DailySeries = {
    instrumentId: inst.id,
    symbol: inst.symbol,
    currency: inst.currency,
    basis: 'split-adjusted',
    bars,
    coverage: buildCoverage(bars),
    source: fixtureSource(),
  };
  seriesCache.set(inst.id, series);
  return series;
};

const MEGA = new Set(['NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO', 'TSM', 'LLY']);
const LARGE = new Set(['AMD', 'MU', 'INTC', 'QCOM', 'JPM', 'XOM', 'UNH', 'COST', 'WMT', 'CAT', 'BABA', 'PDD', 'ETN', 'GEV', 'MRVL']);
const SMALL = new Set(['AAOI', 'AXTI', 'ARQQ', 'RGTI', 'QBTS', 'INFQ']);

const fiscalQuarterEnds = (asOf: ISODate, count: number): ISODate[] => {
  const out: ISODate[] = [];
  let y = yearOf(asOf);
  let m = Math.floor((monthOf(asOf) - 1) / 3) * 3; // last completed quarter-end month
  if (m === 0) { m = 12; y--; }
  while (out.length < count) {
    out.push(addDays(m === 12 ? ymd(y + 1, 1, 1) : ymd(y, m + 1, 1), -1));
    m -= 3;
    if (m <= 0) { m = 12; y--; }
  }
  return out;
};

/** Synthetic fundamentals. A few symbols deliberately lack fields so missing-data paths are exercised. */
export const syntheticFundamentals = (inst: Instrument): Maybe<Fundamentals> => {
  if (inst.type === 'etf' || inst.type === 'index') return na('not-applicable', 'Funds have no issuer fundamentals here');
  const rnd = mulberry32(hashString(`fund:${inst.symbol}`));
  const series = syntheticDaily(inst);
  const last = series.bars[series.bars.length - 1]!;
  const src = fixtureSource();
  // Synthetic size tiers so the fixture has a believable spread of large, mid and small names.
  const tier = MEGA.has(inst.symbol) ? [900, 3200] : LARGE.has(inst.symbol) ? [80, 600] : SMALL.has(inst.symbol) ? [1.2, 9] : [10, 90];
  const capB = tier[0]! * Math.exp(rnd() * Math.log(tier[1]! / tier[0]!));
  const marketCap = capB * 1e9;
  const shares = marketCap / last.close;
  const pe = 9 + rnd() * 45;
  const lossMaking = rnd() < 0.12;
  const eps = lossMaking ? -round2(0.1 + rnd() * 2) : round2(last.close / pe);
  const ends = fiscalQuarterEnds(FIXTURE_AS_OF, 5);
  const fcfMargin = (rnd() - 0.2) * 0.012;
  const periods: CashFlowPeriod[] = ends.map((periodEnd, k) => {
    const ocf = marketCap * (fcfMargin + 0.006 + (rnd() - 0.5) * 0.002);
    const capex = Math.abs(marketCap * (0.001 + rnd() * 0.003));
    const missing = k === 0 && hashString(inst.symbol) % 9 === 0; // newest report lacks a derivable FCF
    return {
      scope: 'quarter',
      periodEnd,
      filedAt: addDays(periodEnd, 35),
      currency: 'USD',
      operatingCashFlow: Math.round(ocf),
      capex: Math.round(capex),
      freeCashFlow: missing ? null : Math.round(ocf - capex),
      source: src,
    };
  });
  const noEstimate = hashString(inst.symbol) % 13 === 0;
  return {
    instrumentId: inst.id,
    currency: 'USD',
    marketCap: { value: Math.round(marketCap), asOf: last.date, source: src },
    sharesOutstanding: { value: Math.round(shares), asOf: ends[0]!, source: src },
    forwardEps: noEstimate
      ? na('no-coverage', 'No verified FY1 estimate in this capture')
      : { value: eps, asOf: last.date, horizon: 'FY1', fiscalYearEnd: ymd(yearOf(FIXTURE_AS_OF), 12, 31), currency: 'USD', source: src },
    cash: { value: Math.round(marketCap * (0.01 + rnd() * 0.07)), asOf: ends[0]!, source: src },
    cashFlow: periods,
    beta: round2(profileOf(inst).beta),
  };
};

/** Cross-stock earnings calendar for the inclusive date window. */
export const syntheticCalendar = (from: ISODate, to: ISODate): CalendarEntry[] => {
  const out: CalendarEntry[] = [];
  for (const inst of INSTRUMENTS) {
    const ev = syntheticEarnings(inst);
    if (!Array.isArray(ev)) continue;
    const fund = syntheticFundamentals(inst);
    const cap = !('unavailable' in fund) && !('unavailable' in fund.marketCap) ? fund.marketCap.value : null;
    for (const e of ev) if (e.date >= from && e.date <= to) out.push({ ...e, name: inst.name, marketCap: cap });
  }
  return out.sort((a, b) => (a.date === b.date ? a.symbol.localeCompare(b.symbol) : a.date < b.date ? -1 : 1));
};

/** Test helper: build a series from a list of closes on consecutive sessions starting at `start`. */
export const seriesFromCloses = (closes: readonly number[], start: ISODate = '2024-01-02'): Bar[] => {
  const bars: Bar[] = [];
  let d = sessionOnOrAfter(start);
  let prev = closes[0] ?? 0;
  for (const c of closes) {
    bars.push({ date: d, open: prev, high: Math.max(prev, c), low: Math.min(prev, c), close: c, volume: 1_000_000 });
    prev = c;
    d = sessionOnOrAfter(addDays(d, 1));
  }
  return bars;
};
