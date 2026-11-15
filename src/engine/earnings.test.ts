import { describe, expect, it } from 'vitest';
import { addDays, sessionOnOrBefore } from './core/calendar';
import { isNa, type Bar, type EarningsEvent, type EarningsTime } from './core/types';
import {
  calendarOffsetPath, calendarWindow, compareQuarter, earningsReaction, earningsStudy, expectedVsRealized, filterCalendar, groupCalendar, mergeCalendar, nextEarnings,
  normalizeEvents, pathEnvelope, reactionSession, reportId, sortBySchedule, type CalendarRow,
} from './earnings';
import { fixtureSource, seriesFromCloses, syntheticDaily, syntheticEarnings } from '../data/fixtures/synthetic';
import { INSTRUMENTS } from '../data/fixtures/universe';

const src = fixtureSource();
const ev = (date: string, time: EarningsTime, extra: Partial<EarningsEvent> = {}): EarningsEvent => ({
  instrumentId: 'us:test',
  symbol: 'TEST',
  date,
  time,
  status: 'confirmed',
  source: src,
  ...extra,
});

/** 60 consecutive sessions from 2026-09-01 with closes 100, 101, ... 159. Open is the prior close. */
const bars: Bar[] = seriesFromCloses(Array.from({ length: 60 }, (_, i) => 100 + i), '2026-09-01');
const scale = (bs: readonly Bar[], k: number): Bar[] => bs.map((b) => ({ ...b, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k }));

describe('reaction session mapping', () => {
  it('maps before open, during and after close releases', () => {
    expect(reactionSession(ev('2026-11-10', 'bmo'))).toBe('2026-11-10');
    expect(reactionSession(ev('2026-11-10', 'during'))).toBe('2026-11-10');
    expect(reactionSession(ev('2026-11-10', 'amc'))).toBe('2026-11-11');
    expect(reactionSession(ev('2026-11-13', 'amc'))).toBe('2026-11-16'); // Friday after close reacts Monday
    expect(reactionSession(ev('2026-11-25', 'amc'))).toBe('2026-11-27'); // Thanksgiving is skipped
  });
  it('withholds an unknown time on a session and resolves a non trading date', () => {
    const r = reactionSession(ev('2026-11-10', 'unknown'));
    expect(isNa(r) && r.code).toBe('ambiguous-timing');
    expect(reactionSession(ev('2026-11-14', 'unknown'))).toBe('2026-11-16'); // Saturday
    expect(reactionSession(ev('2026-11-15', 'amc'))).toBe('2026-11-16'); // Sunday
    expect(reactionSession(ev('2026-11-26', 'bmo'))).toBe('2026-11-27'); // holiday
  });
});

describe('reaction study arithmetic', () => {
  const e = ev(bars[29]!.date, 'amc', { epsActual: 1.1, epsEstimate: 1.0 });
  const row = earningsReaction(bars, e);

  it('computes runups, reaction and drift by hand', () => {
    expect(row.reactionDate).toBe(bars[30]!.date);
    expect(row.preCloseDate).toBe(bars[29]!.date);
    expect(row.preClose).toBe(129);
    expect(row.reaction).toBeCloseTo(130 / 129 - 1, 12);
    expect(row.gap).toBeCloseTo(0, 12); // open equals the prior close in this fixture
    expect(row.session).toBeCloseTo(130 / 129 - 1, 12);
    expect(row.magnitude).toBeCloseTo(130 / 129 - 1, 12);
    expect(row.runups[5]).toBeCloseTo(129 / 124 - 1, 12);
    expect(row.runups[20]).toBeCloseTo(129 / 109 - 1, 12);
    expect(row.drift[1]).toBeCloseTo(131 / 130 - 1, 12);
    expect(row.drift[20]).toBeCloseTo(150 / 130 - 1, 12);
  });
  it('separates gap from session move', () => {
    const custom = bars.map((b) => ({ ...b }));
    custom[30] = { ...custom[30]!, open: 135, high: 136, low: 128, close: 130 };
    const r = earningsReaction(custom, e);
    expect(r.gap).toBeCloseTo(135 / 129 - 1, 12);
    expect(r.session).toBeCloseTo(130 / 135 - 1, 12);
    expect(r.reactionHigh).toBeCloseTo(136 / 129 - 1, 12);
    expect(r.reactionLow).toBeCloseTo(128 / 129 - 1, 12);
  });
  it('never repeats a close in a path', () => {
    expect(row.path.length).toBe(41);
    expect(row.pathComplete).toBe(true);
    expect(new Set(row.path.map((p) => p.date)).size).toBe(row.path.length);
    expect(new Set(row.path.map((p) => p.offset)).size).toBe(row.path.length);
    expect(row.path.find((p) => p.offset === -1)!.ret).toBe(0);
    expect(row.path.find((p) => p.offset === 0)!.date).toBe(bars[30]!.date);
  });
  it('keeps surprise separate from price', () => {
    expect(row.eps.available).toBe(true);
    expect(row.eps.pct).toBeCloseTo(0.1, 12);
    expect(row.revenue.available).toBe(false);
    const unknown = earningsReaction(bars, ev(bars[29]!.date, 'unknown', { epsActual: 2, epsEstimate: 1 }));
    expect(isNa(unknown.reaction) && unknown.reaction.code).toBe('ambiguous-timing');
    expect(unknown.eps.available).toBe(true);
    expect(unknown.path).toEqual([]);
  });
  it('reports structured reasons for thin history, unmatured windows and missing sessions', () => {
    const early = earningsReaction(bars, ev(bars[3]!.date, 'amc'));
    expect(typeof early.reaction).toBe('number');
    const r5 = early.runups[5]!;
    expect(isNa(r5) && r5.code).toBe('insufficient-history');
    const late = earningsReaction(bars, ev(bars[58]!.date, 'bmo'));
    expect(typeof late.drift[1]).toBe('number');
    const d5 = late.drift[5]!;
    expect(isNa(d5) && d5.code).toBe('not-matured');
    expect(late.pathComplete).toBe(false);
    const future = earningsReaction(bars, ev(addDays(bars[59]!.date, 10), 'bmo'));
    expect(isNa(future.reaction) && future.reaction.code).toBe('not-matured');
    const gapped = bars.filter((_, i) => i !== 29);
    const g = earningsReaction(gapped, e);
    expect(isNa(g.reaction) && g.reaction.code).toBe('missing-session');
    const gappedRunup = bars.filter((_, i) => i !== 26);
    const g2 = earningsReaction(gappedRunup, e);
    expect(typeof g2.reaction).toBe('number');
    const ru = g2.runups[5]!;
    expect(isNa(ru) && ru.code).toBe('missing-session');
  });
});

describe('study, envelopes and comparison', () => {
  const events = [
    ev(bars[25]!.date, 'amc', { fiscalPeriod: 'FY2026 Q2' }),
    ev(bars[29]!.date, 'amc', { fiscalPeriod: 'FY2026 Q3' }),
    ev(bars[29]!.date, 'amc', { fiscalPeriod: 'FY2026 Q3', status: 'estimated' }),
    ev(bars[57]!.date, 'bmo', { fiscalPeriod: 'FY2026 Q4' }),
    ev(addDays(bars[59]!.date, 30), 'amc', { fiscalPeriod: 'FY2027 Q1', status: 'estimated' }),
  ];
  it('removes duplicate reports and keeps stable ids', () => {
    const n = normalizeEvents(events);
    expect(n.duplicatesRemoved).toBe(1);
    expect(n.events.length).toBe(4);
    expect(n.events[1]!.status).toBe('confirmed');
    expect(new Set(n.events.map(reportId)).size).toBe(4);
    const conflict = normalizeEvents([ev('2026-11-17', 'amc', { fiscalPeriod: 'FY2026 Q3' }), ev('2026-11-18', 'amc', { fiscalPeriod: 'FY2026 Q3' })]);
    expect(conflict.periodConflicts).toEqual([{ fiscalPeriod: 'FY2026 Q3', dates: ['2026-11-17', '2026-11-18'] }]);
  });
  it('summarizes with explicit denominators', () => {
    const s = earningsStudy(bars, events);
    expect(s.rows.length).toBe(3);
    expect(s.upcoming.length).toBe(1);
    expect(s.reaction.n).toBe(3);
    expect(s.drift[20]!.n).toBe(2);
    expect(s.drift[20]!.unavailable['not-matured']).toBe(1);
    expect(s.commonCoverage).toBe(2);
    expect(s.reaction.positive!.hits).toBe(3);
  });
  it('builds envelopes only from comparable paths', () => {
    const s = earningsStudy(bars, events, { pathBefore: 3, pathAfter: 3 });
    const env = pathEnvelope(s.rows, -3, 3);
    expect(isNa(env)).toBe(false);
    if (!isNa(env)) {
      expect(env.n).toBe(2);
      expect(env.excluded).toBe(1);
      expect(env.offsets).toEqual([-3, -2, -1, 0, 1, 2, 3]);
      expect(env.median[2]).toBe(0);
      expect(env.median[3]).toBeCloseTo((126 / 125 - 1 + (130 / 129 - 1)) / 2, 12);
      expect(env.endpoint.length).toBe(2);
    }
    const cmp = compareQuarter(s, 3, -3, 3);
    expect(cmp.selected.length).toBe(1);
    expect(cmp.all.length).toBe(3);
    expect(!isNa(cmp.selectedEnvelope) && cmp.selectedEnvelope.n).toBe(1);
    const none = compareQuarter(s, 1, -3, 3);
    expect(isNa(none.selectedEnvelope) && none.selectedEnvelope.code).toBe('sample-too-small');
  });
  it('is unchanged by later rows and by a price scale factor', () => {
    const cut = earningsStudy(bars.slice(0, 45), events);
    const asOf = earningsStudy(bars, events, { asOf: bars[44]!.date });
    expect(JSON.stringify(asOf.rows)).toBe(JSON.stringify(cut.rows));
    expect(asOf.asOf).toBe(bars[44]!.date);
    const a = earningsStudy(bars, events);
    const b = earningsStudy(scale(bars, 3.7), events);
    for (let i = 0; i < a.rows.length; i++) {
      expect(b.rows[i]!.reaction as number).toBeCloseTo(a.rows[i]!.reaction as number, 12);
      expect(b.rows[i]!.runups[5] as number).toBeCloseTo(a.rows[i]!.runups[5] as number, 12);
      expect(b.rows[i]!.path.map((p) => +p.ret.toFixed(12))).toEqual(a.rows[i]!.path.map((p) => +p.ret.toFixed(12)));
    }
  });
});

describe('calendar offset alignment', () => {
  it('labels real trading dates and flags carried points', () => {
    const e = ev(bars[29]!.date, 'amc');
    const p = calendarOffsetPath(bars, e, -7, 7);
    expect(isNa(p)).toBe(false);
    if (isNa(p)) return;
    expect(p.baseDate).toBe(sessionOnOrBefore(addDays(e.date, -7)));
    expect(p.points.length).toBe(15);
    expect(p.truncatedAt).toBeNull();
    expect(p.tradingPoints.every((x) => x.priceDate === x.calendarDate)).toBe(true);
    expect(new Set(p.tradingPoints.map((x) => x.priceDate)).size).toBe(p.tradingPoints.length);
    const carried = p.points.filter((x) => x.carried);
    expect(carried.length).toBeGreaterThan(0);
    for (const c of carried) {
      const prevTrading = p.tradingPoints.filter((t) => t.calendarDate < c.calendarDate).pop();
      // A carried point repeats the previous close, or the base close before any trading point.
      expect(c.ret).toBe(prevTrading ? prevTrading.ret : 0);
      expect(c.priceDate < c.calendarDate).toBe(true);
    }
  });
  it('truncates at the available cutoff', () => {
    const p = calendarOffsetPath(bars, ev(bars[58]!.date, 'bmo'));
    expect(!isNa(p) && p.truncatedAt).toBe(bars[59]!.date);
    expect(!isNa(p) && p.points[p.points.length - 1]!.calendarDate <= bars[59]!.date).toBe(true);
    const early = calendarOffsetPath(bars, ev(bars[2]!.date, 'bmo'));
    expect(isNa(early) && early.code).toBe('insufficient-history');
  });
});

describe('next earnings', () => {
  const today = '2026-11-14';
  it('selects the next usable future date', () => {
    const ne = nextEarnings([ev('2026-08-20', 'amc'), ev('2026-11-19', 'amc', { status: 'estimated' }), ev('2027-02-18', 'amc', { status: 'estimated' })], today);
    expect(isNa(ne)).toBe(false);
    if (!isNa(ne)) {
      expect(ne.date).toBe('2026-11-19');
      expect(ne.status).toBe('estimated');
      expect(ne.daysUntil).toBe(5);
      expect(ne.sessionsUntil).toBe(4);
      expect(ne.reactionDate).toBe('2026-11-20');
    }
  });
  it('prefers a confirmed date over a nearby estimate', () => {
    const ne = nextEarnings([ev('2026-11-18', 'amc', { status: 'estimated' }), ev('2026-11-19', 'amc', { status: 'confirmed' })], today);
    expect(!isNa(ne) && ne.date).toBe('2026-11-19');
  });
  it('returns honest unavailable states', () => {
    const fund = nextEarnings([], today, 'etf');
    expect(isNa(fund) && fund.code).toBe('not-applicable');
    const none = nextEarnings([ev('2026-08-20', 'amc')], today);
    expect(isNa(none) && none.code).toBe('no-coverage');
    const failed = nextEarnings({ unavailable: true, code: 'source-failed', detail: 'provider down' }, today);
    expect(isNa(failed) && failed.code).toBe('source-failed');
  });
});

describe('calendar model', () => {
  const row = (symbol: string, date: string, time: EarningsTime, extra: Partial<CalendarRow> = {}): CalendarRow => ({
    ...ev(date, time),
    instrumentId: `us:${symbol.toLowerCase()}`,
    symbol,
    name: `${symbol} Corp`,
    marketCap: 1e9,
    ...extra,
  });
  it('builds session aware windows', () => {
    expect(calendarWindow('2026-11-13', 'tomorrow').from).toBe('2026-11-16');
    expect(calendarWindow('2026-11-25', 'tomorrow').from).toBe('2026-11-27');
    expect(calendarWindow('2026-11-14', 'next-week')).toMatchObject({ from: '2026-11-16', to: '2026-11-20' });
    expect(calendarWindow('2026-11-11', 'this-week')).toMatchObject({ from: '2026-11-11', to: '2026-11-13' });
  });
  it('flags a source conflict and removes duplicate listings', () => {
    const a = { ...row('AAA', '2026-11-17', 'amc', { status: 'estimated' }), source: { ...src, provider: 'provider-a' } };
    const b = { ...row('AAA', '2026-11-18', 'amc'), source: { ...src, provider: 'issuer' } };
    const dup = row('BBB', '2026-11-17', 'bmo');
    const items = mergeCalendar([a, b, dup, { ...dup }]);
    expect(items.length).toBe(2);
    const aaa = items.find((i) => i.entry.symbol === 'AAA')!;
    expect(aaa.entry.date).toBe('2026-11-18');
    expect(aaa.conflictDates).toEqual(['2026-11-17']);
    expect(aaa.conflictSources).toEqual(['provider-a']);
    expect(items.find((i) => i.entry.symbol === 'BBB')!.conflictDates).toEqual([]);
    expect(filterCalendar(items, { conflictsOnly: true }).map((i) => i.entry.symbol)).toEqual(['AAA']);
  });
  it('sorts by schedule with unknown time last, filters and groups by date', () => {
    const items = mergeCalendar([
      row('UNK', '2026-11-24', 'unknown', { marketCap: 9e12 }),
      row('AMC1', '2026-11-24', 'amc'),
      row('BMO1', '2026-11-24', 'bmo', { marketCap: 5e9 }),
      row('BMO2', '2026-11-24', 'bmo', { marketCap: 9e9, status: 'estimated' }),
      row('HOL', '2026-11-26', 'bmo'),
      row('OUT', '2026-12-10', 'bmo'),
    ]);
    expect(sortBySchedule(items).filter((i) => i.entry.date === '2026-11-24').map((i) => i.entry.symbol)).toEqual(['BMO2', 'BMO1', 'AMC1', 'UNK']);
    const days = groupCalendar(items, '2026-11-23', '2026-11-27');
    expect(days.map((d) => d.date)).toEqual(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27']);
    const tue = days[1]!;
    expect(tue.counts).toEqual({ bmo: 2, during: 0, amc: 1, unknown: 1 });
    expect(tue.confirmed).toBe(3);
    expect(tue.estimated).toBe(1);
    const hol = days[3]!;
    expect(hol.isSession).toBe(false);
    expect(hol.closure).toBe('Thanksgiving Day');
    expect(hol.items[0]!.reactionDate).toBe('2026-11-27');
    expect(days[0]!.items).toEqual([]);
    expect(filterCalendar(items, { times: ['bmo'] }).length).toBe(4);
    expect(filterCalendar(items, { times: ['unknown'] }).map((i) => i.entry.symbol)).toEqual(['UNK']);
    expect(filterCalendar(items, { status: 'estimated' }).map((i) => i.entry.symbol)).toEqual(['BMO2']);
    expect(filterCalendar(items, { search: 'amc1 corp' }).length).toBe(1);
    expect(filterCalendar(items, { symbols: ['hol', 'OUT'] }).length).toBe(2);
  });
});

describe('expected move comparison', () => {
  const capture = { quoteDate: bars[30]!.date, expiry: bars[35]!.date, impliedMove: 0.05, underlyingPrice: 130, source: src };
  it('compares implied and realized magnitude over the same period', () => {
    const r = expectedVsRealized(bars, capture, [ev(bars[32]!.date, 'bmo')]);
    expect(isNa(r)).toBe(false);
    if (!isNa(r)) {
      expect(r.label).toBe('Expiry magnitude');
      expect(r.realized).toBeCloseTo(135 / 130 - 1, 12);
      expect(r.ratio).toBeCloseTo((135 / 130 - 1) / 0.05, 12);
      expect(r.sessions).toBe(5);
      expect(r.reactionsInside).toEqual([bars[32]!.date]);
    }
  });
  it('refuses a basis mismatch, an unmatured expiry and bad inputs', () => {
    const mismatch = expectedVsRealized(bars, { ...capture, underlyingPrice: 140 });
    expect(isNa(mismatch) && mismatch.code).toBe('basis-mismatch');
    const future = expectedVsRealized(bars, { ...capture, expiry: addDays(bars[59]!.date, 20) });
    expect(isNa(future) && future.code).toBe('not-matured');
    const bad = expectedVsRealized(bars, { ...capture, impliedMove: 0 });
    expect(isNa(bad) && bad.code).toBe('invalid-input');
    const noQuote = expectedVsRealized(bars, { ...capture, quoteDate: '2026-08-01' });
    expect(isNa(noQuote) && noQuote.code).toBe('missing-session');
  });
  it('uses the last session on or before a non trading expiry date', () => {
    const friday = bars.find((b, i) => i > 31 && new Date(`${b.date}T00:00:00Z`).getUTCDay() === 5)!;
    const r = expectedVsRealized(bars, { ...capture, expiry: addDays(friday.date, 1) });
    expect(!isNa(r) && r.expirySession).toBe(friday.date);
  });
});

describe('fixture smoke test', () => {
  it('studies NVDA and MU reports on the synthetic fixture', () => {
    for (const sym of ['NVDA', 'MU']) {
      const inst = INSTRUMENTS.find((i) => i.symbol === sym)!;
      const series = syntheticDaily(inst);
      const events = syntheticEarnings(inst);
      expect(Array.isArray(events)).toBe(true);
      if (!Array.isArray(events)) continue;
      const s = earningsStudy(series.bars, events);
      expect(s.rows.length).toBeGreaterThan(40);
      expect(s.upcoming.length).toBe(1);
      for (const r of s.rows) expect(new Set(r.path.map((p) => p.date)).size).toBe(r.path.length);
      const measured = s.rows.filter((r) => typeof r.reaction === 'number').length;
      expect(s.reaction.n).toBe(measured);
      expect(s.reaction.n + Object.values(s.reaction.unavailable).reduce((a, b) => a + b, 0)).toBe(s.rows.length);
      const ne = nextEarnings(events, '2026-11-14', inst.type);
      expect(isNa(ne)).toBe(false);
    }
    const spy = INSTRUMENTS.find((i) => i.symbol === 'SPY')!;
    const ne = nextEarnings(syntheticEarnings(spy), '2026-11-14', spy.type);
    expect(isNa(ne) && ne.code).toBe('not-applicable');
  });
});
