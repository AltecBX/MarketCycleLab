import { describe, expect, it } from 'vitest';
import { sessionsBetween } from './core/calendar';
import { mulberry32 } from './core/stats';
import { isNa, type Bar, type EarningsEvent, type SourceCapture, type Unavailable } from './core/types';
import { INSTRUMENTS } from '../data/fixtures/universe';
import { syntheticDaily, syntheticEarnings } from '../data/fixtures/synthetic';
import {
  DEFAULTS, buildCandidates, buildCohorts, buildContext, caseOutcome, earningsContextAt, gatedProportion, matchDistance, monthlyState,
  plannedSessionsOf, recoveryFeasibility, remainingUpDayOdds, resolveOptions, statOf, type CohortMember, type MonthlyState, type StudyContext,
} from './monthlyReversal';
import {
  MODEL_DEFAULTS, calibrateCandidate, cohortOf, monthPathChart, monthlyReversalStudy, scanMonthlyReversal, sortScan, standardScenarios, whatIf,
} from './monthlyReversalModel';

const SRC: SourceCapture = { provider: 'test', kind: 'synthetic-fixture', capturedAt: '2026-11-14T00:00:00Z', version: 't' };

/** Bars on the given sessions. Open defaults to the previous close, high and low contain both. */
const mk = (dates: readonly string[], closes: readonly number[], opens?: readonly (number | undefined)[]): Bar[] => {
  const bars: Bar[] = [];
  let prev = closes[0]!;
  for (let k = 0; k < dates.length; k++) {
    const c = closes[k]!;
    const o = opens?.[k] ?? prev;
    bars.push({ date: dates[k]!, open: o, high: Math.max(o, c), low: Math.min(o, c), close: c, volume: 1000 });
    prev = c;
  }
  return bars;
};

/** A world where the daily return is a rule of (month, ordinal session). Deterministic. */
const world = (from: string, to: string, rule: (monthKey: string, ordinal: number, monthNumber: number) => number, start = 100): Bar[] => {
  const dates = sessionsBetween(from, to);
  const closes: number[] = [];
  let c = start;
  let key = '';
  let ord = 0;
  let monthNumber = -1;
  for (const d of dates) {
    if (d.slice(0, 7) !== key) {
      key = d.slice(0, 7);
      ord = 0;
      monthNumber++;
    }
    ord++;
    c = c * (1 + rule(key, ord, monthNumber));
    closes.push(c);
  }
  return mk(dates, closes);
};

/** Every month sells 1% a session for 10 sessions, then rises 1.2% a session. */
const sellThenRise = (_k: string, ord: number): number => (ord <= 10 ? -0.01 : 0.012);
const idxOf = (bars: readonly Bar[], date: string): number => bars.findIndex((b) => b.date === date);
const must = <T>(v: T): Exclude<T, Unavailable> => {
  if (isNa(v)) throw new Error(`unexpected unavailable: ${JSON.stringify(v)}`);
  return v as Exclude<T, Unavailable>;
};

describe('monthly state', () => {
  // Prior month final close 100 on 2025-12-31, then five January 2026 sessions.
  const dates = ['2025-12-30', '2025-12-31', '2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];
  const closes = [101, 100, 98, 99, 97, 96, 96];
  const bars = mk(dates, closes);

  it('computes the hand checked state on the prior close basis', () => {
    const s = must(monthlyState(bars, 6));
    expect(s.priorMonthClose).toBe(100);
    expect(s.priorMonthCloseDate).toBe('2025-12-31');
    expect(s.elapsed).toBe(5);
    expect(s.plannedSessions).toBe(20); // January 2026 loses New Year's Day and MLK Day
    expect(s.remaining).toBe(15);
    expect([s.up, s.down, s.flat]).toEqual([1, 3, 1]);
    expect(s.sequence).toBe('DUDDF');
    expect(s.negativeShare).toBeCloseTo(0.6, 12);
    expect(s.mtdReturn).toBeCloseTo(-0.04, 12);
    expect(s.streak).toEqual({ direction: 'flat', length: 1 });
    expect(s.longestDownStreak).toBe(2);
    expect(s.peak).toEqual({ value: 100, date: '2025-12-31', inMonth: false });
    expect(s.peakAge).toBe(5);
    expect(s.drawdown).toBeCloseTo(-0.04, 12);
    expect(s.lowAfterPeak).toEqual({ value: 96, date: '2026-01-07' }); // earliest of the tied lows
    expect(s.lowAge).toBe(1);
    expect(s.closingHigh).toEqual({ value: 99, date: '2026-01-05' });
    expect(s.closingLow).toEqual({ value: 96, date: '2026-01-07' });
    expect(s.bestDay.date).toBe('2026-01-05');
    expect(s.worstDay.date).toBe('2026-01-06');
    expect(s.worstDay.ret).toBeCloseTo(97 / 99 - 1, 12);
    expect(s.meanLoss).toBeCloseTo((-0.02 + (97 / 99 - 1) + (96 / 97 - 1)) / 3, 12);
    expect(s.medianGain).toBeCloseTo(99 / 98 - 1, 12);
    expect(s.newLowCount).toBe(3);
    expect(s.newLowFrequency).toBeCloseTo(0.6, 12);
    expect(s.rangePosition).toBe(0); // month range 96 to 100, close at the low
    expect(isNa(s.sellingAcceleration)).toBe(true); // recent window covers the whole month
    const s2 = must(monthlyState(bars, 6, { recentWindow: 2 }));
    const early = (98 / 100 - 1 + (99 / 98 - 1) + (97 / 99 - 1)) / 3;
    const late = (96 / 97 - 1 + 0) / 2;
    expect(s2.sellingAcceleration).toBeCloseTo(late - early, 12);
    expect(s2.recentNegativeShare).toBe(0.5);
  });

  it('changes classifications with the basis but keeps MTD on the close basis', () => {
    // Session two opens at 99.5 and closes at 99. Up versus the prior close, down versus its open.
    const withOpens = mk(dates, closes, [undefined, undefined, undefined, 99.5, undefined, undefined, undefined]);
    const a = must(monthlyState(withOpens, 6, { basis: 'prior-close' }));
    const b = must(monthlyState(withOpens, 6, { basis: 'open' }));
    expect(a.sequence).toBe('DUDDF');
    expect(b.sequence).toBe('DDDDF');
    expect(b.down).toBe(4);
    expect(b.mtdReturn).toBe(a.mtdReturn);
    expect(b.days[1]!.ret).toBeCloseTo(99 / 98 - 1, 12); // magnitude stays close vs prior close
    expect(b.days[1]!.classMove).toBeCloseTo(99 / 99.5 - 1, 12);
  });

  it('needs the prior month close and every session through the anchor', () => {
    const noBase = monthlyState(bars.slice(2), 2);
    expect(isNa(noBase) && noBase.code).toBe('missing-base-close');
    const gapBase = monthlyState([bars[0]!, ...bars.slice(2)], 3);
    expect(isNa(gapBase) && gapBase.code).toBe('missing-session');
    const gapInside = monthlyState([...bars.slice(0, 3), ...bars.slice(4)], 5);
    expect(isNa(gapInside) && gapInside.code).toBe('missing-session');
  });

  it('handles the first and last session of a month and holiday shortened months', () => {
    const w = world('2026-09-01', '2026-11-30', sellThenRise);
    const first = must(monthlyState(w, idxOf(w, '2026-11-02')));
    expect(first.elapsed).toBe(1);
    expect(first.plannedSessions).toBe(20); // Thanksgiving closes November 26
    expect(first.remaining).toBe(19);
    expect(isNa(first.dailyVol)).toBe(true);
    const mid = must(monthlyState(w, idxOf(w, '2026-11-13')));
    expect(mid.elapsed).toBe(10);
    expect(mid.remaining).toBe(10);
    expect(mid.remainingDates).not.toContain('2026-11-26');
    expect(mid.down).toBe(10);
    expect(mid.mtdReturn).toBeCloseTo(0.99 ** 10 - 1, 10);
    const last = must(monthlyState(w, idxOf(w, '2026-11-30')));
    expect(last.remaining).toBe(0);
    expect(last.elapsedFraction).toBe(1);
  });
});

describe('recovery feasibility', () => {
  const w = world('2026-09-01', '2026-11-30', (_k, ord) => (ord <= 3 ? 0.01 : ord <= 10 ? -0.03 : 0.01));
  const s = must(monthlyState(w, idxOf(w, '2026-11-13')));

  it('counts required up sessions and flags an impossible target', () => {
    expect([s.up, s.elapsed, s.remaining]).toEqual([3, 10, 10]);
    const half = recoveryFeasibility(s, { targetUpShare: 0.5 }).upShare!;
    expect(half.requiredUpDays).toBe(7);
    expect(half.feasible).toBe(true);
    const guard = recoveryFeasibility(s, { targetUpShare: 0.55 }).upShare!;
    expect(guard.requiredUpDays).toBe(8); // 20 x 0.55 is 11, not 12 from floating point
    const no = recoveryFeasibility(s, { targetUpShare: 0.7 }).upShare!;
    expect(no.requiredUpDays).toBe(11);
    expect(no.feasible).toBe(false);
    const met = recoveryFeasibility(s, { targetUpShare: 0.1 }).upShare!;
    expect(met.alreadyMet).toBe(true);
  });

  it('computes the required total and constant daily move to a target close', () => {
    const T = s.priorMonthClose;
    const f = recoveryFeasibility(s, { targetClose: T }).close!;
    expect(f.requiredTotal).toBeCloseTo(T / s.anchorClose - 1, 12);
    expect(f.requiredDaily).toBeCloseTo((T / s.anchorClose) ** (1 / 10) - 1, 12);
    expect(f.alreadyAtTarget).toBe(false);
    const at = recoveryFeasibility(s, { targetClose: s.anchorClose * 0.9 }).close!;
    expect(at.alreadyAtTarget).toBe(true);
    const end = must(monthlyState(w, idxOf(w, '2026-11-30')));
    const none = recoveryFeasibility(end, { targetClose: end.anchorClose * 1.5, targetUpShare: 0.9 });
    expect(none.noFutureSessions).toBe(true);
    expect(isNa(none.close!.requiredDaily)).toBe(true);
    expect(none.close!.feasible).toBe(false);
    expect(none.upShare!.feasible).toBe(false);
  });
});

describe('cohorts and outcomes', () => {
  const w = world('2014-12-01', '2026-11-13', sellThenRise);
  const i = w.length - 1;

  it('takes one equivalent ordinal anchor per earlier month inside the lookback', () => {
    const study = must(monthlyReversalStudy(w, i));
    const all = cohortOf(study, 'all-months')!;
    expect(study.state.elapsed).toBe(10);
    expect(all.members.length).toBe(120); // ten years of earlier months
    expect(new Set(all.members.map((m) => m.monthKey)).size).toBe(120);
    expect(all.members.every((m) => m.state.elapsed === 10 && m.anchorDate < '2026-11-01')).toBe(true);
    expect(all.members[0]!.anchorDate >= study.candidates.lookbackFrom).toBe(true);
    expect(study.candidates.inspectedMonths).toBe(120);
    expect(cohortOf(study, 'same-calendar-month')!.members.length).toBe(10);
    expect(cohortOf(study, 'same-calendar-month')!.members.every((m) => m.state.month === 11)).toBe(true);
  });

  it('reproduces the synthetic exact hit with outcome specific denominators', () => {
    const study = must(monthlyReversalStudy(w, i));
    const s = cohortOf(study, 'all-months')!.summary;
    const pos = statOf(s, 'positive-close')!;
    expect([pos.hits, pos.n]).toEqual([120, 120]);
    expect(must(pos.display).rate).toBe(1);
    expect(must(pos.display).lo).toBeLessThan(1);
    expect(s.returns!.median).toBeCloseTo(1.012 ** 5 - 1, 10);
    const close = statOf(s, 'target-close')!;
    expect(close.hits).toBe(120); // 1.012^3 is above +3%
    expect(s.cases[0]!.targetCloseOffset).toBe(3);
    // Held target is confirmed two sessions after the first qualifying close.
    expect(s.cases[0]!.targetHold).toEqual({ eventOffset: 3, confirmOffset: 5 });
    expect(statOf(s, 'further-decline-close')!.hits).toBe(0);
    expect(statOf(s, 'another-closing-low')!.hits).toBe(0);
    expect(statOf(s, 'positive-rest-of-month')!.hits).toBe(120);
    expect(statOf(s, 'majority-green-remaining')!.hits).toBe(120);
    // Month ends above the prior month close only when enough sessions follow the selloff.
    const me = statOf(s, 'positive-month-end')!;
    expect(me.n).toBe(120);
    const expectHits = cohortOf(study, 'all-months')!.members.filter((m) => 0.99 ** 10 * 1.012 ** m.state.remaining > 1).length;
    expect(me.hits).toBe(expectHits);
    // The anchor is below the prior month close, so the close race applies to every case.
    const race = statOf(s, 'new-low-before-regain')!;
    expect(race.n).toBe(120);
    expect(race.hits).toBe(0);
    expect(s.rebound.reached).toBe(120);
    expect(s.rebound.days!.median).toBe(3);
    expect(study.baselines.monthly!.hits).toBe(120);
    const daily = must(study.baselines.daily);
    expect(daily.n).toBeGreaterThan(daily.spacedN);
    expect(daily.spacedN).toBeGreaterThan(400);
  });

  it('excludes months with too few sessions and explains it', () => {
    const idx = idxOf(w, '2026-10-30'); // session 22 of a 22 session month
    const study = must(monthlyReversalStudy(w, idx));
    expect(study.state.elapsed).toBe(22);
    const few = study.candidates.exclusions.filter((e) => e.reason === 'too-few-sessions');
    expect(few.length).toBeGreaterThan(0);
    expect(few.every((e) => plannedSessionsOf(e.monthKey).length < 22)).toBe(true);
    expect(study.candidates.eligible + study.candidates.exclusions.length).toBe(study.candidates.inspectedMonths);
    // The fraction position keeps those months by scaling the ordinal.
    const frac = must(monthlyReversalStudy(w, idx, { position: 'fraction' }));
    expect(frac.candidates.exclusions.filter((e) => e.reason === 'too-few-sessions').length).toBe(0);
    expect(cohortOf(frac, 'all-months')!.members.every((m) => m.state.remaining === 0)).toBe(true);
  });

  it('separates matured from partially observed horizons', () => {
    const study = must(monthlyReversalStudy(w, i, { horizon: 90 }));
    const s = cohortOf(study, 'all-months')!.summary;
    expect(s.notMatured).toBeGreaterThanOrEqual(4);
    expect(s.matured + s.notMatured).toBe(120);
    expect(statOf(s, 'positive-close')!.n).toBe(s.matured);
    expect(statOf(s, 'positive-close')!.excluded).toBe(s.notMatured);
  });

  it('applies user filters and reports them', () => {
    const study = must(monthlyReversalStudy(w, i, { filters: { minDownSessions: 11 } }));
    expect(study.candidates.eligible).toBe(0);
    expect(study.candidates.exclusions.every((e) => e.reason === 'filtered')).toBe(true);
    expect(cohortOf(study, 'all-months')!.filters.join(' ')).toMatch(/At least 11 down sessions/);
    const pos = statOf(cohortOf(study, 'all-months')!.summary, 'positive-close')!;
    expect(pos.n).toBe(0);
    expect(isNa(pos.display)).toBe(true);
  });

  it('recomputes every dependent result from the same snapshot when one input changes', () => {
    const a = must(monthlyReversalStudy(w, i, { horizon: 5 }));
    const b = must(monthlyReversalStudy(w, i, { horizon: 10 }));
    expect(a.asOf).toBe(b.asOf);
    expect(a.state).toEqual(b.state);
    const sa = cohortOf(a, 'all-months')!.summary;
    const sb = cohortOf(b, 'all-months')!.summary;
    expect(sb.horizon).toBe(10);
    expect(sb.returns!.median).toBeCloseTo(1.012 ** 10 - 1, 10);
    expect(statOf(sb, 'positive-close')!.label).toMatch(/10 sessions/);
    expect(sa.returns!.median).not.toBe(sb.returns!.median);
    expect(must(b.baselines.daily).horizon).toBe(10);
    expect(b.model!.horizon).toBe(10);
    // Basis change with opens equal to prior closes leaves classifications unchanged, by construction.
    const c = must(monthlyReversalStudy(w, i, { basis: 'open' }));
    expect(c.state.down).toBe(a.state.down);
    expect(c.state.basis).toBe('open');
  });

  it('gates a displayed frequency on months and distinct years', () => {
    const o = { minMonths: 10, minYears: 3, level: 0.95 };
    const twelveInTwoYears = Array.from({ length: 12 }, (_, k) => `${2024 + (k % 2)}-0${1 + (k % 6)}-15`);
    const g = gatedProportion(6, twelveInTwoYears, o);
    expect(g.years).toBe(2);
    expect(isNa(g.display) && g.display.detail).toMatch(/distinct years/);
    const nine = gatedProportion(5, twelveInTwoYears.slice(0, 9), o);
    expect(isNa(nine.display) && nine.display.detail).toMatch(/needs 10/);
    const ok = gatedProportion(6, Array.from({ length: 12 }, (_, k) => `${2020 + (k % 4)}-03-15`), o);
    const p = must(ok.display);
    expect(p.rate).toBe(0.5);
    // Year clustering makes the interval wider than plain Wilson on 12.
    expect(p.hi - p.lo).toBeGreaterThan(0.5);
  });

  it('gives remaining up session odds over a common length', () => {
    const study = must(monthlyReversalStudy(w, i));
    const members = cohortOf(study, 'all-months')!.members;
    const odds = must(remainingUpDayOdds(study.ctx, members, 10, 6));
    expect(odds.eligible).toBe(120);
    expect(odds.exact.reduce((a, e) => a + e.count, 0)).toBe(120);
    // Months with fewer than 10 sessions left spill into the next month's selloff.
    expect(odds.exact[10]!.count + odds.exact[9]!.count + odds.exact[8]!.count).toBeGreaterThan(0);
    expect(odds.atLeast!.n).toBe(120);
    expect(odds.proportionView!.median).toBe(1);
    expect(isNa(remainingUpDayOdds(study.ctx, members, 0))).toBe(true);
    expect(isNa(remainingUpDayOdds(study.ctx, [], 5))).toBe(true);
  });
});

describe('outcome edge cases', () => {
  // Three months: November 2025 last session, December 2025, January 2026, query in February 2026.
  const dates = sessionsBetween('2025-11-28', '2026-02-10');
  const base = mk(dates, dates.map(() => 100));
  const jan = (ord: number) => idxOf(base, plannedSessionsOf('2026-01')[ord - 1]!);
  const feb = (ord: number) => idxOf(base, plannedSessionsOf('2026-02')[ord - 1]!);

  const memberFor = (bars: Bar[]): { ctx: StudyContext; m: CohortMember } => {
    const ctx = must(buildContext(bars, feb(5), resolveOptions({ horizon: 3 })));
    const q = must(monthlyState(ctx.bars, feb(5)));
    const set = buildCandidates(ctx, q);
    const m = set.members.find((x) => x.monthKey === '2026-01')!;
    return { ctx, m };
  };

  it('marks both levels inside one daily bar as indeterminate', () => {
    const bars = base.map((b) => ({ ...b }));
    const k = jan(5) + 1;
    bars[k] = { ...bars[k]!, high: 104, low: 94 }; // +3% target and -5% level in the same bar
    const { ctx, m } = memberFor(bars);
    expect(m.anchorIndex).toBe(jan(5));
    const c = caseOutcome(ctx, m);
    expect(c.intradayRace).toBe('indeterminate');
    expect(c.targetTouchOffset).toBe(1);
    expect(c.targetCloseOffset).toBeNull(); // a touch is not a close
    expect(c.furtherDeclineTouch).toBe(true);
    expect(c.furtherDeclineClose).toBe(false);
    const cohorts = buildCohorts(ctx, buildCandidates(ctx, must(monthlyState(bars, feb(5)))));
    const s = cohorts[0]!.summary;
    expect(s.indeterminateRace).toBe(1);
    expect(statOf(s, 'bounce-before-downside')!.n).toBe(s.matured - 1);
  });

  it('separates the hold event from its later confirmation and leaves an unfinished hold undecided', () => {
    const bars = base.map((b) => ({ ...b }));
    for (const off of [2, 3, 4]) {
      const k = jan(5) + off;
      bars[k] = { ...bars[k]!, close: 104, high: 104 };
    }
    const { ctx, m } = memberFor(bars);
    const c = caseOutcome(ctx, m);
    expect(c.targetCloseOffset).toBe(2);
    expect(c.targetHold).toEqual({ eventOffset: 2, confirmOffset: 4 });
    expect(c.failedBounce).toBe(false);
    // A hold that the data cannot finish judging is undefined, not a miss.
    const cut = bars.slice(0, feb(5) + 1);
    const o = resolveOptions({ horizon: 3 });
    const ctx2 = must(buildContext(cut, cut.length - 1, o));
    const q2 = must(monthlyState(cut, cut.length - 1));
    const set2 = buildCandidates(ctx2, q2);
    // Query itself has no forward rows.
    const self = caseOutcome(ctx2, set2.query);
    expect(self.matured).toBe(false);
    expect(self.targetHold).toBeUndefined();
    expect(self.rebound).toEqual({ offset: null, censored: true });
  });

  it('flags a failed bounce and excludes inconsistent bars from intraday odds', () => {
    const bars = base.map((b) => ({ ...b }));
    const k = jan(5);
    bars[k + 1] = { ...bars[k + 1]!, close: 104, high: 104 };
    bars[k + 2] = { ...bars[k + 2]!, open: 104, close: 99, high: 104, low: 99 };
    bars[k + 3] = { ...bars[k + 3]!, open: 99, close: 99.5, high: 99.2, low: 98 }; // high below the close: inconsistent
    const { ctx, m } = memberFor(bars);
    const c = caseOutcome(ctx, m);
    expect(c.failedBounce).toBe(true);
    expect(c.ohlcValid).toBe(false);
    expect(c.targetTouchOffset).toBeUndefined();
    expect(c.intradayRace).toBeUndefined();
    expect(c.ret).toBeCloseTo(-0.005, 12);
  });

  it('judges a new closing low against a close back at the prior month close', () => {
    // January falls to 95 by session 5, then closes at 94 before any recovery.
    const closes = dates.map((d) => (d.slice(0, 7) === '2026-01' ? 95 : 100));
    const bars = mk(dates, closes);
    const k = jan(5);
    bars[k + 1] = { ...bars[k + 1]!, close: 94, low: 94 };
    bars[k + 2] = { ...bars[k + 2]!, open: 94, close: 101, high: 101, low: 94 };
    const { ctx, m } = memberFor(bars);
    const c = caseOutcome(ctx, m);
    expect(m.state.mtdReturn).toBeCloseTo(-0.05, 12);
    expect(c.closeRace).toBe('new-low-first');
    expect(c.recovery).toEqual({ offset: 2, censored: false });
    expect(c.anotherClosingLow).toBe(true);
  });
});

describe('point in time earnings context', () => {
  const dates = sessionsBetween('2026-01-02', '2026-03-31');
  const bars = mk(dates, dates.map(() => 50));
  const ev = (date: string, knownAt?: string): EarningsEvent => ({ instrumentId: 'x', symbol: 'X', date, time: 'amc', status: 'confirmed', knownAt, source: SRC });
  const i = idxOf(bars, '2026-02-10');

  it('uses only what was known by the anchor', () => {
    expect(earningsContextAt(null, bars, i, 5, 5)).toBe('unknown');
    expect(earningsContextAt([], bars, i, 5, 5)).toBe('none');
    expect(earningsContextAt([ev('2026-02-06')], bars, i, 5, 5)).toBe('in-window'); // already happened
    expect(earningsContextAt([ev('2026-02-12', '2026-01-20T21:00:00Z')], bars, i, 5, 5)).toBe('in-window');
    expect(earningsContextAt([ev('2026-02-12', '2026-02-11T21:00:00Z')], bars, i, 5, 5)).toBe('none'); // announced after the anchor
    expect(earningsContextAt([ev('2026-02-12')], bars, i, 5, 5)).toBe('unknown'); // no knownAt, cannot assert
    expect(earningsContextAt([ev('2026-03-20', '2026-01-01T00:00:00Z')], bars, i, 5, 5)).toBe('none'); // outside the window
  });

  it('makes the same earnings cohort unavailable when the query context is unknown', () => {
    const w = world('2018-12-03', '2026-11-13', sellThenRise);
    const study = must(monthlyReversalStudy(w, w.length - 1));
    const c = cohortOf(study, 'same-earnings')!;
    expect(c.unavailable?.code).toBe('no-coverage');
    expect(c.members.length).toBe(0);
    const regime = cohortOf(study, 'regime')!;
    expect(regime.unavailable?.code).toBe('no-coverage');
    const withCtx = must(monthlyReversalStudy(w, w.length - 1, undefined, { earnings: [], market: world('2018-12-03', '2026-11-13', () => 0) }));
    expect(cohortOf(withCtx, 'same-earnings')!.unavailable).toBeUndefined();
    expect(cohortOf(withCtx, 'same-earnings')!.members.length).toBe(cohortOf(withCtx, 'all-months')!.members.length);
    // Flat market: not above its 200 session average, and excess return equals the stock return.
    expect(withCtx.query.marketAbove200).toBe(false);
    const all = cohortOf(withCtx, 'all-months')!.summary;
    expect(all.excessMarket!.median).toBeCloseTo(all.returns!.median, 12);
    expect(withCtx.query.features.vsMarket).toBeCloseTo(withCtx.state.mtdReturn, 12);
  });
});

describe('matching', () => {
  it('publishes signed differences and contributions and needs enough shared features', () => {
    const q = { negativeShare: 0.7, mtdReturn: -0.2, drawdown: -0.2, closingStreak: -3, recentNegativeShare: 0.8, dailyVol: 0.03 };
    const c = { negativeShare: 0.5, mtdReturn: -0.12, drawdown: -0.2, closingStreak: -3, recentNegativeShare: 0.8, dailyVol: 0.03 };
    const m = must(matchDistance(q, c, DEFAULTS));
    expect(m.shared).toBe(6);
    // negativeShare differs by 0.2 (one scale unit), mtd by 0.08 (one scale unit): mean of 2 over 6.
    expect(m.distance).toBeCloseTo(2 / 6, 10);
    expect(m.components[0]!.contribution).toBeCloseTo(0.5, 10);
    expect(m.components.find((x) => x.key === 'mtdReturn')!.diff).toBeCloseTo(0.08, 12);
    expect(m.missing).toContain('vsMarket');
    const few = matchDistance({ negativeShare: 0.7, mtdReturn: -0.2 }, c, DEFAULTS);
    expect(isNa(few) && few.code).toBe('no-coverage');
    const seq = must(matchDistance(q, c, { ...DEFAULTS, sequenceMatch: true }, { query: 'DDUDD', candidate: 'DDUDU' }));
    expect(seq.components.find((x) => x.key === 'sequence')!.normalized).toBeCloseTo(0.2, 12);
  });
});

describe('calibrated candidate gate', () => {
  it('withholds the percentage when the candidate only ties the baseline', () => {
    const w = world('2014-12-01', '2026-11-13', sellThenRise);
    const study = must(monthlyReversalStudy(w, w.length - 1));
    const m = study.model!;
    expect(m.scored).toBeGreaterThanOrEqual(24);
    expect(m.brier).toBe(0);
    expect(m.baselineBrier).toBe(0);
    expect(m.status).toBe('not-reliable');
    expect(isNa(m.probability) && m.probability.code).toBe('gate-failed');
    expect(m.current!.matchN).toBeGreaterThan(0); // realized counts stay available
    expect(m.reasons.length).toBeGreaterThan(0);
  });

  it('passes when matches separate outcomes in both halves, trained only on earlier matured cases', () => {
    // Two kinds of month. Selloff months rise after session 10, rally months fall after it.
    const kind = (n: number) => (n * 7) % 3 === 0;
    const w = world('2016-12-01', '2026-11-13', (_k, ord, n) => (kind(n) ? (ord <= 10 ? -0.01 : 0.01) : ord <= 10 ? 0.01 : -0.01));
    const i = w.length - 1;
    const study = must(monthlyReversalStudy(w, i));
    const m = study.model!;
    expect(m.status).toBe('valid');
    expect(m.scored).toBeGreaterThanOrEqual(MODEL_DEFAULTS.minScored);
    expect(m.brier!).toBeLessThan(m.baselineBrier!);
    expect(m.halves[0].beatsBaseline && m.halves[1].beatsBaseline).toBe(true);
    expect(m.predictions.every((p) => p.trainingN >= 24)).toBe(true);
    const p = must(m.probability);
    // Formula check from the realized counts.
    const cur = m.current!;
    expect(p).toBeCloseTo((cur.matchHits + 4 * (cur.baselineHits / cur.baselineN)) / (cur.matchN + 4), 12);
    // Matches are earlier months of the same kind, and each kind has one outcome.
    const selloff = study.state.down === 10;
    expect(cur.matchN).toBeGreaterThan(20);
    expect(cur.matchHits).toBe(selloff ? cur.matchN : 0);
    expect(selloff ? p > 0.9 : p < 0.1).toBe(true);
    // Walk forward predictions never see their own or later outcomes: recompute one by hand.
    const o = resolveOptions();
    const ctx = must(buildContext(w, i, o));
    const set = buildCandidates({ ...ctx, options: { ...o, lookbackYears: 500 } }, study.state);
    const again = calibrateCandidate(ctx, set);
    expect(again.predictions).toEqual(m.predictions);
    const first = again.predictions[0]!;
    const testMember = set.members.find((x) => x.monthKey === first.monthKey)!;
    const training = set.members.filter((x) => x.anchorIndex + o.horizon < testMember.anchorIndex);
    expect(first.trainingN).toBe(training.length);
    expect(training.every((x) => x.anchorDate < first.anchorDate)).toBe(true);
  });

  it('reports insufficient evidence on a short history', () => {
    const w = world('2024-12-02', '2026-11-13', sellThenRise);
    const study = must(monthlyReversalStudy(w, w.length - 1));
    expect(study.model!.status).toBe('insufficient-evidence');
    expect(isNa(study.model!.probability) && study.model!.probability.code).toBe('sample-too-small');
    expect(study.model!.scored).toBeLessThan(24);
  });
});

describe('what if scenarios', () => {
  const w = world('2014-12-01', '2026-11-13', sellThenRise);
  const i = w.length - 1;

  it('is hypothetical, leaves inputs untouched and shows changed thresholds and cohorts', () => {
    const before = JSON.stringify(w);
    const st = must(monthlyState(w, i));
    const scenarios = standardScenarios(st);
    expect(scenarios.map((s) => s.id)).toEqual(['down-day', 'three-green', 'minus-3', 'plus-2', 'new-low', 'market-up-stock-down']);
    const r = must(whatIf(w, i, scenarios[0]!));
    expect(JSON.stringify(w)).toBe(before);
    expect(r.hypothetical).toBe(true);
    expect(r.appendedDates).toEqual(['2026-11-16']);
    expect(r.crossesMonthEnd).toBe(false);
    const down = r.changes.find((c) => c.key === 'down')!;
    expect(down.scenario).toBe(down.base + 1);
    const need = r.changes.find((c) => c.key === 'requiredUpDays')!;
    expect(need.base).toBe(10);
    expect(need.scenario).toBe(10);
    const rem = r.changes.find((c) => c.key === 'remaining')!;
    expect(rem.scenario).toBe(rem.base - 1);
    // The cohort moves to session 11 anchors, built from real earlier months only.
    const res = must(r.result);
    expect(res.state.elapsed).toBe(11);
    expect(cohortOf(res, 'all-months')!.members.every((m) => m.anchorDate < '2026-11-01')).toBe(true);
    expect(r.cohortChanges.find((c) => c.kind === 'all-months')!.scenario.members).toBe(120);
    const green = must(whatIf(w, i, scenarios[1]!));
    expect(green.appendedDates.length).toBe(3);
    expect(must(green.result).state.up).toBe(3);
    const low = must(whatIf(w, i, scenarios[4]!));
    expect(must(low.result).state.closingLow.date).toBe('2026-11-16');
  });

  it('notes when a scenario runs past the month end', () => {
    const idx = idxOf(w, '2026-10-30');
    const r = must(whatIf(w, idx, { id: 'x', label: 'x', steps: [{ stockRet: -0.01 }] }));
    expect(r.crossesMonthEnd).toBe(true);
    expect(must(r.result).state.elapsed).toBe(1);
    expect(isNa(whatIf(w, idx, { id: 'e', label: 'e', steps: [] }))).toBe(true);
  });
});

describe('chart paths and scanner', () => {
  const w = world('2014-12-01', '2026-11-13', sellThenRise);
  const i = w.length - 1;

  it('labels forward paths as history and only draws bands with enough cases', () => {
    const study = must(monthlyReversalStudy(w, i, undefined, undefined, { includeModel: false }));
    expect(study.model).toBeNull();
    const chart = monthPathChart(study.ctx, study.state, cohortOf(study, 'all-months')!.members);
    expect(chart.kind).toBe('historical-study');
    expect(chart.current.length).toBe(10);
    expect(chart.current[9]!.mtd).toBeCloseTo(study.state.mtdReturn, 12);
    expect(chart.sessionsAhead).toBe(10);
    expect(chart.bands.length).toBe(10);
    expect(chart.bands[0]!.median).toBeCloseTo(0.012, 10);
    expect(chart.bands[0]!.mtdEquivalentMedian).toBeCloseTo((1 + study.state.mtdReturn) * 1.012 - 1, 10);
    const sparse = monthPathChart(study.ctx, study.state, cohortOf(study, 'all-months')!.members.slice(0, 3));
    expect(sparse.cases.length).toBe(3);
    expect(sparse.bands.length).toBe(0);
  });

  it('scans a common date with separate metrics and sorts missing values last', () => {
    const short = world('2026-08-03', '2026-11-13', () => -0.004);
    const stale = w.slice(0, w.length - 1);
    const scan = scanMonthlyReversal(
      [
        { symbol: 'LONG', bars: w },
        { symbol: 'SHORT', bars: short },
        { symbol: 'STALE', bars: stale },
      ],
      '2026-11-13',
    );
    expect(scan.rows.map((r) => r.symbol)).toEqual(['LONG', 'SHORT']);
    expect(scan.skipped.map((s) => s.symbol)).toEqual(['STALE']);
    expect(scan.skipped[0]!.reason.code).toBe('missing-session');
    const long = scan.rows[0]!;
    const sh = scan.rows[1]!;
    expect(long.sampleQuality).toBe('adequate');
    expect(sh.sampleQuality).toBe('sparse');
    expect(isNa(sh.positiveRate)).toBe(true);
    expect(sh.n).toBeLessThan(10);
    expect('score' in long).toBe(false);
    expect(sortScan(scan.rows, 'positiveRate', 'asc').map((r) => r.symbol)).toEqual(['LONG', 'SHORT']);
    expect(sortScan(scan.rows, 'positiveRate', 'desc').map((r) => r.symbol)).toEqual(['LONG', 'SHORT']);
    expect(sortScan(scan.rows, 'mtdReturn', 'asc')[0]!.symbol).toBe('LONG');
  });
});

describe('invariants', () => {
  const rnd = mulberry32(42);
  const dates = sessionsBetween('2012-12-03', '2026-11-13');
  const closes: number[] = [];
  let c = 64;
  for (let k = 0; k < dates.length; k++) {
    c = Math.max(1, Math.round(c * (1 + (rnd() - 0.49) * 0.05) * 100) / 100);
    closes.push(c);
  }
  const bars = mk(dates, closes);
  const strip = (s: unknown) => JSON.stringify(s, (k, v) => (k === 'ctx' ? undefined : v));

  it('appending future rows does not change an earlier as-of study', () => {
    const i = idxOf(bars, '2025-06-13');
    const a = must(monthlyReversalStudy(bars.slice(0, i + 1), i));
    const b = must(monthlyReversalStudy(bars, i));
    expect(strip(b)).toBe(strip(a));
    // Not matured at the as-of date even though later rows exist in the input.
    const s = cohortOf(must(monthlyReversalStudy(bars, i, { horizon: 60 })), 'all-months')!.summary;
    expect(s.notMatured).toBeGreaterThan(0);
  });

  it('scaling every price by one factor does not change returns, states or counts', () => {
    const i = bars.length - 1;
    const scaled = bars.map((b) => ({ ...b, open: b.open * 2, high: b.high * 2, low: b.low * 2, close: b.close * 2 }));
    const a = must(monthlyReversalStudy(bars, i));
    const b = must(monthlyReversalStudy(scaled, i));
    expect(b.state.mtdReturn).toBe(a.state.mtdReturn);
    expect(b.state.sequence).toBe(a.state.sequence);
    expect(b.state.drawdown).toBe(a.state.drawdown);
    for (const kind of ['all-months', 'same-calendar-month', 'similar-setup'] as const) {
      const sa = cohortOf(a, kind)!.summary;
      const sb = cohortOf(b, kind)!.summary;
      expect(sb.stats.map((x) => [x.key, x.hits, x.n])).toEqual(sa.stats.map((x) => [x.key, x.hits, x.n]));
      expect(sb.returns).toEqual(sa.returns);
    }
    expect(b.model!.status).toBe(a.model!.status);
    expect(b.model!.brier).toBe(a.model!.brier);
  });
});

describe('synthetic fixture smoke test', () => {
  const inst = (s: string) => INSTRUMENTS.find((x) => x.symbol === s)!;
  const spy = syntheticDaily(inst('SPY')).bars;
  const xlk = syntheticDaily(inst('XLK')).bars;

  it('runs on a long history with market, sector and earnings context', () => {
    const nvda = syntheticDaily(inst('NVDA')).bars;
    const ev = syntheticEarnings(inst('NVDA'));
    const study = must(monthlyReversalStudy(nvda, nvda.length - 1, undefined, { market: spy, sector: xlk, earnings: Array.isArray(ev) ? ev : [] }));
    expect(study.asOf).toBe('2026-11-13');
    expect(study.state.elapsed).toBe(10);
    const all = cohortOf(study, 'all-months')!;
    expect(all.members.length).toBeLessThanOrEqual(120);
    expect(all.members.length).toBeGreaterThanOrEqual(110);
    expect(cohortOf(study, 'regime')!.unavailable).toBeUndefined();
    expect(cohortOf(study, 'same-earnings')!.unavailable).toBeUndefined();
    expect(study.query.features.vsSector).toBeDefined();
    const similar = cohortOf(study, 'similar-setup')!;
    expect(similar.members.length).toBeLessThanOrEqual(all.members.length);
    for (const m of similar.members) expect(must(m.match).distance).toBeLessThanOrEqual(1);
    const model = study.model!;
    expect(['valid', 'not-reliable', 'insufficient-evidence']).toContain(model.status);
    expect(model.scored).toBeGreaterThan(100); // whole history, not only the display lookback
    expect(isNa(model.probability)).toBe(model.status !== 'valid');
    for (const s of all.summary.stats) {
      expect(s.hits).toBeLessThanOrEqual(s.n);
      expect(s.n + s.excluded).toBe(all.members.length);
    }
  });

  it('withholds the percentage on a short history', () => {
    const sndk = syntheticDaily(inst('SNDK')).bars;
    const study = must(monthlyReversalStudy(sndk, sndk.length - 1, undefined, { market: spy, sector: xlk }));
    const all = cohortOf(study, 'all-months')!;
    expect(all.members.length).toBeLessThan(21);
    expect(study.candidates.historyFirst).toBe('2025-02-24');
    const similar = statOf(cohortOf(study, 'similar-setup')!.summary, 'positive-close')!;
    if (similar.n < 10) expect(isNa(similar.display)).toBe(true);
    const pos = statOf(all.summary, 'positive-close')!;
    // Fewer than three distinct years of matured months: counts stay, the percentage is withheld.
    expect(pos.years).toBeLessThan(3);
    expect(isNa(pos.display)).toBe(true);
    expect(pos.n).toBeGreaterThan(0);
    expect(study.model!.status).toBe('insufficient-evidence');
    const st: MonthlyState = study.state;
    expect(st.priorMonthCloseDate).toBe('2026-10-30');
  });
});
