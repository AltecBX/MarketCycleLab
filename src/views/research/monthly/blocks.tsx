/** Blocks of the Monthly Reversal panel. Each answers one question and states its own denominator. */
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { researchPath } from '../../../app/routes';
import { midrankPercentile } from '../../../engine/core/stats';
import { isNa, type Distribution, type Maybe, type Proportion } from '../../../engine/core/types';
import {
  recoveryFeasibility, remainingUpDayOdds, type CaseOutcome, type Cohort, type CohortMember, type FeatureKey, type MatchComponent,
  type MonthlyState, type OutcomeStat, type OutcomeSummary, type TimeToStat,
} from '../../../engine/monthlyReversal';
import { monthPathChart, type CalibrationResult, type DailyBaseline, type MonthlyReversalStudy, type WhatIfResult } from '../../../engine/monthlyReversalModel';
import { BarChart, LineChart, type LineSeries } from '../../../ui/charts';
import { Chip, DataTable, Disclosure, Freq, Info, Pct, Sheet, StateNote, Stat, type Column } from '../../../ui/components';
import { fmtDate, fmtDateShort, fmtNum, fmtPct, fmtPp, fmtPrice, reasonDetail } from '../../../ui/format';

const GLYPH = { down: '▼', up: '▲', flat: '–' } as const;
const INTERVAL_INFO = 'Wilson interval. It uses a conservative sample size that treats months inside one calendar year as related, so it is wide.';

/* ------------------------------------------------------------------ lead */

export function SequenceStrip({ state }: { state: MonthlyState }) {
  const label = `Sessions this month in order. ${state.days.map((d) => `${fmtDateShort(d.date)} ${d.cls}`).join(', ')}. ${state.remaining} sessions remain.`;
  return (
    <div className="mr-seq" role="img" aria-label={label}>
      {state.days.map((d, k) => (
        <span key={d.date} className="mr-seq-day" data-cls={d.cls} data-last={k === state.days.length - 1} title={`${fmtDate(d.date)}, ${fmtPct(d.ret)}`}>
          {GLYPH[d.cls]}
        </span>
      ))}
      {state.remainingDates.map((d) => (
        <span key={d} className="mr-seq-day" data-cls="ahead" title={`${fmtDate(d)}, not traded yet`} />
      ))}
    </div>
  );
}

export function LeadStats({ state }: { state: MonthlyState }) {
  const s = state;
  const streak = s.streak.direction === 'flat' ? `${s.streak.length} flat` : `${s.streak.length} ${s.streak.direction}`;
  return (
    <div className="stats">
      <Stat
        label="Down sessions"
        info={s.basis === 'open' ? 'A session is down when it closes below its own open.' : 'A session is down when it closes below the previous close.'}
        value={`${s.down} of ${s.elapsed}`}
        sub={`${s.up} up, ${s.flat} flat`}
      />
      <Stat label="Month to date" value={<Pct v={s.mtdReturn} />} sub={`from ${fmtPrice(s.priorMonthClose)} on ${fmtDate(s.priorMonthCloseDate)}`} />
      <Stat
        label="From month peak close"
        info="Latest close versus the highest close this month. The prior month close counts as the starting reference."
        value={<Pct v={s.drawdown} />}
        sub={`${fmtPrice(s.peak.value)} on ${fmtDate(s.peak.date)}${s.peak.inMonth ? '' : ', prior month close'}`}
      />
      <Stat label="Closing streak" value={streak} sub={`longest down run ${s.longestDownStreak}`} />
      <Stat label="Sessions remaining" value={`${s.remaining} of ${s.plannedSessions}`} sub={s.remaining === 0 ? 'last session of the month' : `through ${fmtDate(s.remainingDates[s.remainingDates.length - 1])}`} />
    </div>
  );
}

function SevItem({ label, value, pctile, n, weakLow }: { label: string; value: string; pctile: number; n: number; weakLow: boolean }) {
  const p = Math.round(pctile * 100);
  return (
    <div className="mr-sev-item">
      <div className="small muted">{label}</div>
      <div className="num">
        <strong>{value}</strong> <span className="small muted">at percentile {p} of {n}</span>
      </div>
      <div className="mr-sev-bar" aria-hidden="true">
        <i style={{ left: `${Math.max(0, Math.min(100, p))}%` }} />
      </div>
      <div className="small faint">{weakLow ? 'Lower is weaker' : 'Higher is heavier selling'}</div>
    </div>
  );
}

/** Where this month sits against earlier months at the same session number. Observed, not modeled. */
export function Severity({ state, all }: { state: MonthlyState; all: Cohort | undefined }) {
  const m = all?.members ?? [];
  if (m.length === 0) return <StateNote>No earlier month reaches session {state.elapsed} inside the lookback, so severity cannot be ranked.</StateNote>;
  return (
    <div>
      <h3 style={{ marginBottom: 6 }}>
        Versus {m.length} earlier months at session {state.elapsed} <Info text="Midrank percentile among earlier months at the same session number. Observed history, not a forecast." />
      </h3>
      <div className="mr-severity">
        <SevItem label="Month to date return" value={fmtPct(state.mtdReturn)} pctile={midrankPercentile(m.map((x) => x.state.mtdReturn), state.mtdReturn)} n={m.length} weakLow />
        <SevItem label="Share of down sessions" value={fmtPct(state.negativeShare, 0, false)} pctile={midrankPercentile(m.map((x) => x.state.negativeShare), state.negativeShare)} n={m.length} weakLow={false} />
        <SevItem label="Drop from month peak close" value={fmtPct(state.drawdown)} pctile={midrankPercentile(m.map((x) => x.state.drawdown), state.drawdown)} n={m.length} weakLow />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ path chart */

const MAX_CONTEXT = 30;

export function PathChart({ study, cohort }: { study: MonthlyReversalStudy; cohort: Cohort }) {
  const { state } = study;
  const chart = useMemo(() => monthPathChart(study.ctx, state, cohort.members), [study, state, cohort]);
  const series = useMemo<LineSeries[]>(() => {
    const e = state.elapsed;
    const toMtd = (r: number) => (1 + state.mtdReturn) * (1 + r) - 1;
    const out: LineSeries[] = [];
    const ctxCases = [...chart.cases].slice(-MAX_CONTEXT);
    for (const c of ctxCases) {
      const last = c.before[c.before.length - 1];
      const base = last ? last.mtd : 0;
      const n = c.before.length;
      out.push({
        id: `c-${c.monthKey}`,
        label: c.monthKey,
        context: true,
        points: [{ x: 0, y: 0 }, ...c.before.map((p) => ({ x: p.ordinal, y: p.mtd })), ...c.after.map((p) => ({ x: n + p.offset, y: (1 + base) * (1 + p.ret) - 1 }))],
      });
    }
    out.push({ id: 'now', label: 'This month, observed', width: 2.6, points: [{ x: 0, y: 0 }, ...chart.current.map((p) => ({ x: p.ordinal, y: p.mtd }))] });
    if (chart.bands.length) {
      const start = { x: e, y: state.mtdReturn };
      out.push({ id: 'med', label: 'Earlier months after this point, median', dashed: true, color: 'var(--gold-line)', points: [start, ...chart.bands.map((b) => ({ x: e + b.offset, y: toMtd(b.median) }))] });
      out.push({ id: 'p10', label: '10th percentile', dashed: true, width: 1, color: 'var(--text-3)', points: [start, ...chart.bands.map((b) => ({ x: e + b.offset, y: toMtd(b.p10) }))] });
      out.push({ id: 'p90', label: '90th percentile', dashed: true, width: 1, color: 'var(--text-3)', points: [start, ...chart.bands.map((b) => ({ x: e + b.offset, y: toMtd(b.p90) }))] });
    }
    return out;
  }, [chart, state]);
  const envelope = useMemo(() => {
    const toMtd = (r: number) => (1 + state.mtdReturn) * (1 + r) - 1;
    return { color: 'var(--gold-line)', points: [{ x: state.elapsed, lo: state.mtdReturn, hi: state.mtdReturn }, ...chart.bands.map((b) => ({ x: state.elapsed + b.offset, lo: toMtd(b.p25), hi: toMtd(b.p75) }))] };
  }, [chart, state]);
  const lastBand = chart.bands[chart.bands.length - 1];
  const xLabel = (x: number) => (x === 0 ? 'Prior month close' : x > state.plannedSessions ? `Session ${x}, next month` : `Session ${x}`);
  const aria = `Month to date path. Observed through session ${state.elapsed} at ${fmtPct(state.mtdReturn)}. ${
    lastBand ? `In ${lastBand.n} earlier months the median move over the next ${lastBand.offset} sessions was ${fmtPct(lastBand.median)}, middle half ${fmtPct(lastBand.p25)} to ${fmtPct(lastBand.p75)}. History, not a forecast.` : 'Too few earlier months for a band.'
  }`;
  return (
    <div>
      <LineChart
        series={series}
        envelope={chart.bands.length ? envelope : undefined}
        xLabel={xLabel}
        yFormat={(y) => fmtPct(y, 0)}
        ariaLabel={aria}
        zeroLine
        height={280}
        vLines={[{ x: state.elapsed, label: 'Latest close' }]}
        bands={chart.sessionsAhead > 0 ? [{ x0: state.elapsed, x1: state.elapsed + chart.sessionsAhead, color: 'var(--surface-2)' }] : []}
      />
      <p className="mr-note">
        Right of the latest close: what {cohort.members.length} earlier months did after the same point, rebased to today. Shaded band is the middle half. It is history, not a forecast.
        Gray lines are {Math.min(MAX_CONTEXT, chart.cases.length)} earlier months on their own month to date scale.
        {chart.bands.length === 0 && ` A band needs at least ${chart.minBandCases} earlier months.`}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ odds */

export function Gated({ hits, n, display }: { hits: number; n: number; display: Maybe<Proportion> }) {
  if (!isNa(display)) return <Freq p={display} />;
  return (
    <span className="mr-withheld">
      {hits} of {n}. <span className="small">Percentage withheld. {display.detail ?? 'Sample too small'}.</span>
    </span>
  );
}

function OddBox({ kind, selected, children }: { kind: ReactNode; selected?: boolean; children: ReactNode }) {
  return (
    <div className="mr-odd" data-selected={selected ? 'true' : undefined}>
      <div className="mr-odd-kind">{kind}</div>
      {children}
    </div>
  );
}

function StatOdd({ stat, level }: { stat: OutcomeStat | null | undefined; level: number }) {
  if (!stat) return <div className="mr-odd-rate withheld">No cases</div>;
  if (isNa(stat.display)) {
    return (
      <>
        <div className="mr-odd-rate withheld">Percentage withheld</div>
        <div className="mr-odd-sub">
          {stat.hits} of {stat.n} months higher, {stat.years} {stat.years === 1 ? 'year' : 'years'}. {stat.display.detail ?? 'Sample too small'}.
        </div>
      </>
    );
  }
  const p = stat.display;
  return (
    <>
      <div className="mr-odd-rate num">{fmtPct(p.rate, 0, false)}</div>
      <div className="mr-odd-sub">
        {p.hits} of {p.n} months, {stat.years} years. {Math.round(level * 100)}% interval {fmtPct(p.lo, 0, false)} to {fmtPct(p.hi, 0, false)}
      </div>
    </>
  );
}

export function ModelNote({ model }: { model: CalibrationResult | null }) {
  if (!model) return null;
  const b = model.brier !== null && model.baselineBrier !== null ? `Brier ${fmtNum(model.brier, 4)} versus baseline ${fmtNum(model.baselineBrier, 4)} over ${model.scored} scored predictions.` : `${model.scored} scored predictions.`;
  if (model.status === 'valid' && !isNa(model.probability)) {
    return (
      <StateNote title="Calibrated estimate.">
        <span className="num"><strong>{fmtPct(model.probability, 0, false)}</strong></span> for {model.target.toLowerCase()}. {b} It beat the baseline in both halves of the record.
        <div className="small">{model.formula}</div>
      </StateNote>
    );
  }
  const status = model.status === 'not-reliable' ? 'Not reliable' : model.status === 'insufficient-evidence' ? 'Insufficient evidence' : model.status === 'stale' ? 'Stale' : 'Unavailable';
  return (
    <StateNote tone="warn" title={`Model withheld. ${status}.`}>
      {b} {model.reasons.join('. ')}.
      {model.current && (
        <span> Realized counts stay as description: {model.current.matchHits} of {model.current.matchN} matched months higher, {model.current.baselineHits} of {model.current.baselineN} of all earlier months.</span>
      )}
    </StateNote>
  );
}

export function OddsBlock({ study, cohort, daily }: { study: MonthlyReversalStudy; cohort: Cohort; daily: Maybe<DailyBaseline> }) {
  const level = study.options.level;
  const sel = cohort.summary.stats.find((s) => s.key === 'positive-close');
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="mr-odds">
        <OddBox kind={<>Normal odds, any session <Info text="Every session in the lookback with a completed outcome. Windows overlap, so the interval uses spaced anchors." /></>}>
          {isNa(daily) ? (
            <div className="mr-odd-rate withheld">{reasonDetail(daily)}</div>
          ) : (
            <>
              <div className="mr-odd-rate num">{fmtPct(daily.rate, 0, false)}</div>
              <div className="mr-odd-sub">
                {daily.hits.toLocaleString('en-US')} of {daily.n.toLocaleString('en-US')} sessions, {daily.spacedN} spaced.
                {daily.interval && ` ${Math.round(level * 100)}% interval ${fmtPct(daily.interval.lo, 0, false)} to ${fmtPct(daily.interval.hi, 0, false)}`}
              </div>
            </>
          )}
        </OddBox>
        <OddBox kind={`Normal odds, session ${study.state.elapsed} of any earlier month`}>
          <StatOdd stat={study.baselines.monthly} level={level} />
        </OddBox>
        <OddBox selected kind={<>Conditional, {cohort.label.toLowerCase()} <Info text={INTERVAL_INFO} /></>}>
          {cohort.unavailable ? <div className="mr-odd-rate withheld">{reasonDetail(cohort.unavailable)}</div> : <StatOdd stat={sel} level={level} />}
        </OddBox>
      </div>
      <ModelNote model={study.model} />
    </div>
  );
}

/* ------------------------------------------------------------------ outcome table */

const GROUPS: { title: string; info: string; keys: string[] }[] = [
  { title: 'Endpoint direction', info: 'Where the close ended at a fixed date. An endpoint says nothing about the path in between.', keys: ['positive-close', 'positive-rest-of-month', 'positive-month-end', 'positive-next-month-end', 'majority-green-remaining', 'beat-market', 'beat-sector'] },
  { title: 'Further downside', info: 'Whether price went lower at any point inside the window.', keys: ['further-decline-close', 'further-decline-touch', 'another-closing-low', 'retest-near-low'] },
  { title: 'Bounce: touch, close, hold', info: 'A touch is an intraday trade at the level. A close is a session close at it. A hold is consecutive closes at it, known only on the last of them.', keys: ['target-touch', 'target-close', 'target-hold', 'failed-bounce'] },
  { title: 'Sequence: which came first', info: 'Order of events inside the window. Two levels inside one daily bar have no known order and are left out.', keys: ['new-low-before-regain', 'bounce-before-downside'] },
];

export function OutcomeRows({ summary }: { summary: OutcomeSummary }) {
  return (
    <div className="mr-rows">
      {GROUPS.map((g) => (
        <div key={g.title} style={{ display: 'contents' }}>
          <div className="mr-group-title">
            {g.title} <Info text={g.info} />
          </div>
          {g.keys.map((k) => {
            const s = summary.stats.find((x) => x.key === k);
            if (!s) return null;
            return (
              <div className="mr-row" key={k}>
                <div className="mr-row-label">
                  {s.label}
                  <span className="mr-basis">{s.basis === 'close' ? 'closes' : 'intraday'}</span>
                  {s.excluded > 0 && <div className="small faint">{s.excluded} left out. {s.excludedNote}.</div>}
                </div>
                <div className="mr-row-val">
                  <Gated hits={s.hits} n={s.n} display={s.display} />
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

interface DistRow {
  label: string;
  d: Distribution | null;
}

export function DistributionTable({ summary }: { summary: OutcomeSummary }) {
  const h = summary.horizon;
  const rows: DistRow[] = [
    { label: `Close after ${h} sessions`, d: summary.returns },
    { label: 'Worst close inside the window', d: summary.adverseClose },
    { label: 'Best close inside the window', d: summary.favorableClose },
    { label: 'Worst intraday low', d: summary.adverseIntraday },
    { label: 'Best intraday high', d: summary.favorableIntraday },
    { label: 'Return minus market', d: summary.excessMarket },
    { label: 'Return minus sector', d: summary.excessSector },
  ].filter((r) => r.d !== null);
  const col = (key: string, header: string, pick: (d: Distribution) => number): Column<DistRow> => ({ key, header, cell: (r) => <Pct v={r.d ? pick(r.d) : null} digits={1} /> });
  const cols: Column<DistRow>[] = [
    { key: 'label', header: 'Versus the anchor close', sticky: true, cell: (r) => r.label },
    col('p10', '10th', (d) => d.p10),
    col('p25', '25th', (d) => d.p25),
    col('p50', 'Median', (d) => d.median),
    col('p75', '75th', (d) => d.p75),
    col('p90', '90th', (d) => d.p90),
    { key: 'n', header: 'Months', cell: (r) => <span className="num">{r.d?.n ?? 0}</span> },
  ];
  if (rows.length === 0) return <StateNote>No matured case yet, so there is no distribution to show.</StateNote>;
  return <DataTable rows={rows} cols={cols} rowKey={(r) => r.label} caption="Distribution of outcomes in the selected cohort" />;
}

export function TimeTo({ t }: { t: TimeToStat }) {
  if (t.eligible === 0) return <div className="mr-line muted">{t.label}. No case this applies to.</div>;
  return (
    <div className="mr-line">
      {t.label}. <strong>Reached in {t.reached} of {t.eligible}</strong>
      {t.days && <span>, median {fmtNum(t.days.median, 0)} sessions (25th {fmtNum(t.days.p25, 0)}, 75th {fmtNum(t.days.p75, 0)})</span>}.
      <span className="muted"> {t.notReached} not reached inside the window, {t.censored} unresolved because the data ends first.</span>
    </div>
  );
}

/* ------------------------------------------------------------------ feasibility */

export function FeasibilityBlock({ study, cohort, targetClose, upShare, onTargetClose, onUpShare }: { study: MonthlyReversalStudy; cohort: Cohort; targetClose: number; upShare: number; onTargetClose: (v: string) => void; onUpShare: (v: string) => void }) {
  const { state } = study;
  const f = useMemo(() => recoveryFeasibility(state, { targetClose, targetUpShare: upShare }), [state, targetClose, upShare]);
  const need = f.upShare?.requiredUpDays ?? 0;
  const odds = useMemo(() => remainingUpDayOdds(study.ctx, cohort.members, state.remaining, need), [study, cohort, state, need]);
  const c = f.close;
  const u = f.upShare;
  return (
    <div className="mr-feas">
      <div>
        <h3>Arithmetic <Info text="What the calendar still allows. It says nothing about how often it happened." /></h3>
        <div className="mr-line">
          <strong className="num">{f.remaining}</strong> planned {f.remaining === 1 ? 'session remains' : 'sessions remain'} this month.
        </div>
        <div className="row" style={{ margin: '6px 0' }}>
          <label className="field">
            Target close ($)
            <input className="input" style={{ width: 110 }} type="number" min={0} step="0.01" inputMode="decimal" defaultValue={targetClose.toFixed(2)} key={`tc-${state.anchorDate}`} onBlur={(e) => onTargetClose(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onTargetClose((e.target as HTMLInputElement).value)} />
          </label>
          <label className="field">
            Target share of up sessions (%)
            <input className="input" style={{ width: 110 }} type="number" min={0} max={100} step="5" inputMode="decimal" defaultValue={Math.round(upShare * 100)} key={`us-${state.anchorDate}`} onBlur={(e) => onUpShare(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onUpShare((e.target as HTMLInputElement).value)} />
          </label>
        </div>
        {c && (
          <div className="mr-line">
            {c.alreadyAtTarget ? (
              <>The close of {fmtPrice(c.anchorClose)} is already at or above {fmtPrice(c.target)}.</>
            ) : f.noFutureSessions ? (
              <>A close at {fmtPrice(c.target)} needs <strong className="num">{fmtPct(c.requiredTotal)}</strong>. No session remains this month, so it cannot happen this month.</>
            ) : (
              <>
                A close at {fmtPrice(c.target)} needs <strong className="num">{fmtPct(c.requiredTotal)}</strong> in total, or{' '}
                <strong className="num">{isNa(c.requiredDaily) ? 'n/a' : fmtPct(c.requiredDaily)}</strong> every session for {f.remaining} sessions.
              </>
            )}
          </div>
        )}
        {u && (
          <div className="mr-line">
            {u.alreadyMet ? (
              <>{u.currentUp} up sessions already meet a {fmtPct(u.target, 0, false)} share of {u.totalSessions}.</>
            ) : u.feasible ? (
              <>A {fmtPct(u.target, 0, false)} share of up sessions needs <strong className="num">{u.requiredUpDays} of the {f.remaining}</strong> remaining to close up.</>
            ) : (
              <><strong>Impossible this month.</strong> A {fmtPct(u.target, 0, false)} share needs {u.requiredUpDays} more up sessions and {f.remaining} remain.</>
            )}
          </div>
        )}
      </div>
      <div>
        <h3>What earlier months did <Info text="Up sessions over the same number of sessions after each earlier anchor. Counted, not modeled." /></h3>
        {isNa(odds) ? (
          <StateNote>{reasonDetail(odds)}</StateNote>
        ) : (
          <>
            <BarChart
              height={150}
              bars={odds.exact.map((e) => ({ key: String(e.upDays), label: String(e.upDays), value: e.share, detail: `${e.count} of ${odds.eligible} months`, color: e.upDays >= need && need > 0 ? 'var(--accent)' : 'var(--border-strong)' }))}
              yFormat={(y) => fmtPct(y, 0, false)}
              ariaLabel={`Share of ${odds.eligible} earlier months by number of up sessions over the next ${odds.sessions} sessions`}
            />
            <div className="small faint" style={{ textAlign: 'center' }}>Up sessions over the next {odds.sessions}</div>
            {odds.atLeast && need > 0 && (
              <div className="mr-line">
                At least {odds.atLeast.k} up sessions: <Gated hits={odds.atLeast.hits} n={odds.atLeast.n} display={odds.atLeast.display} />
              </div>
            )}
            {odds.proportionView && (
              <div className="mr-line muted">
                Share of up sessions over each month's own remainder: median {fmtPct(odds.proportionView.median, 0, false)}, middle half {fmtPct(odds.proportionView.p25, 0, false)} to {fmtPct(odds.proportionView.p75, 0, false)}, {odds.proportionCases} months.
              </div>
            )}
            {odds.insufficientPath > 0 && <div className="small faint">{odds.insufficientPath} months left out because their path is shorter than {odds.sessions} sessions.</div>}
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ matched cases */

const BINARY: ReadonlySet<string> = new Set(['marketAbove200', 'stockAbove50', 'stockAbove200', 'earningsKnown']);
const SHORT: Record<FeatureKey | 'sequence', string> = {
  negativeShare: 'down share',
  mtdReturn: 'month to date',
  drawdown: 'drop from peak',
  closingStreak: 'streak',
  recentNegativeShare: 'recent down share',
  lossAcceleration: 'acceleration',
  downsideDaySize: 'down day size',
  dailyVol: 'daily volatility',
  vsMarket: 'versus market',
  vsSector: 'versus sector',
  marketAbove200: 'market regime',
  marketVol: 'market volatility',
  stockAbove50: '50 session side',
  stockAbove200: '200 session side',
  earningsKnown: 'earnings window',
  sequence: 'recent order',
};

const diffText = (c: MatchComponent): string => {
  if (BINARY.has(c.key)) return c.diff === 0 ? 'same' : 'differs';
  if (c.key === 'closingStreak') return `${fmtNum(c.diff, 0, true)} sessions`;
  if (c.key === 'sequence') return `${fmtPct(c.diff, 0, false)} differ`;
  return fmtPp(c.diff, 1);
};

interface CaseRow {
  m: CohortMember;
  o: CaseOutcome | undefined;
  distance: number | null;
}

const closest = (m: CohortMember, n: number): MatchComponent[] => (isNa(m.match) ? [] : m.match.components.filter((c) => !BINARY.has(c.key)).sort((a, b) => a.normalized - b.normalized).slice(0, n));
const furthest = (m: CohortMember, n: number): MatchComponent[] => (isNa(m.match) ? [] : [...m.match.components].sort((a, b) => b.normalized - a.normalized).slice(0, n));

export function CasesBlock({ study, cohort, symbol }: { study: MonthlyReversalStudy; cohort: Cohort; symbol: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [order, setOrder] = useState<'match' | 'date' | 'worst'>('match');
  const h = study.options.horizon;
  const rows = useMemo<CaseRow[]>(() => {
    const byKey = new Map(cohort.summary.cases.map((c) => [c.monthKey, c]));
    const r = cohort.members.map((m) => ({ m, o: byKey.get(m.monthKey), distance: isNa(m.match) ? null : m.match.distance }));
    if (order === 'date') return r.sort((a, b) => (a.m.anchorDate < b.m.anchorDate ? 1 : -1));
    if (order === 'worst') return r.sort((a, b) => (a.o?.ret ?? Infinity) - (b.o?.ret ?? Infinity));
    return r.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
  }, [cohort, order]);
  const shown = all ? rows : rows.slice(0, 10);
  const lower = rows.filter((r) => r.o?.matured && (r.o.ret ?? 0) < 0).length;
  const matured = rows.filter((r) => r.o?.matured).length;
  const cols: Column<CaseRow>[] = [
    { key: 'date', header: 'Anchor', sticky: true, cell: (r) => <button type="button" className="btn ghost small" style={{ padding: '2px 4px' }} onClick={() => setOpen(r.m.monthKey)}>{fmtDate(r.m.anchorDate)}</button> },
    { key: 'mtd', header: 'Month to date then', cell: (r) => <Pct v={r.m.state.mtdReturn} digits={1} /> },
    { key: 'down', header: 'Down sessions', cell: (r) => <span className="num">{r.m.state.down} of {r.m.state.elapsed}</span> },
    { key: 'why', header: 'Closest on', align: 'l', cell: (r) => <span className="small">{closest(r.m, 2).map((c) => `${SHORT[c.key]} ${diffText(c)}`).join(', ') || 'n/a'}</span> },
    { key: 'dist', header: 'Match distance', info: 'Weighted mean of normalized differences. Zero is identical. Weights are proposed defaults, not the reference weights.', cell: (r) => <span className="num">{r.distance === null ? 'n/a' : fmtNum(r.distance, 2)}</span> },
    { key: 'ret', header: `Close after ${h}`, cell: (r) => (r.o?.matured ? <Pct v={r.o.ret} digits={1} glyph /> : <span className="faint">Not matured</span>) },
    { key: 'mae', header: 'Worst close', cell: (r) => <Pct v={r.o?.maeClose} digits={1} /> },
    { key: 'me', header: 'To month end', cell: (r) => <Pct v={r.o?.restOfMonthRet} digits={1} /> },
  ];
  const sel = rows.find((r) => r.m.monthKey === open);
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row">
        <span className="small muted">
          {matured} matured of {rows.length}. {lower} closed lower after {h} sessions, {matured - lower} closed higher or flat.
        </span>
        <span style={{ flex: 1 }} />
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          Order
          <select className="select" value={order} onChange={(e) => setOrder(e.target.value as typeof order)}>
            <option value="match">Closest match first</option>
            <option value="worst">Weakest outcome first</option>
            <option value="date">Most recent first</option>
          </select>
        </label>
      </div>
      <DataTable rows={shown} cols={cols} rowKey={(r) => r.m.monthKey} onRow={(r) => setOpen(r.m.monthKey)} selectedKey={open} caption="Earlier months in the selected cohort" empty="No earlier month qualifies under these settings." />
      {rows.length > 10 && (
        <button type="button" className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setAll((a) => !a)}>
          {all ? 'Show the first 10' : `Show all ${rows.length}`}
        </button>
      )}
      {sel && (
        <Sheet title={`${fmtDate(sel.m.anchorDate)}, session ${sel.m.state.elapsed}`} onClose={() => setOpen(null)}>
          <div className="stack" style={{ gap: 14 }}>
            <LeadStats state={sel.m.state} />
            <SequenceStrip state={sel.m.state} />
            <div>
              <h3 style={{ marginBottom: 6 }}>Why it qualified</h3>
              {isNa(sel.m.match) ? (
                <StateNote>{reasonDetail(sel.m.match)}</StateNote>
              ) : (
                <>
                  <div className="small muted">Match distance {fmtNum(sel.m.match.distance, 2)} over {sel.m.match.shared} shared features. Differences are this case minus today.</div>
                  <dl className="kv" style={{ marginTop: 6 }}>
                    {[...sel.m.match.components].sort((a, b) => a.normalized - b.normalized).map((c) => (
                      <div key={c.key} style={{ display: 'contents' }}>
                        <dt>{c.label}</dt>
                        <dd className="num">{diffText(c)} <span className="faint small">({fmtPct(c.contribution, 0, false)} of distance)</span></dd>
                      </div>
                    ))}
                  </dl>
                  {furthest(sel.m, 1)[0] && <div className="small faint" style={{ marginTop: 4 }}>Largest difference: {SHORT[furthest(sel.m, 1)[0]!.key]}.</div>}
                </>
              )}
            </div>
            <div>
              <h3 style={{ marginBottom: 6 }}>What followed</h3>
              {sel.o ? (
                <dl className="kv">
                  <dt>Next session</dt>
                  <dd><Pct v={sel.o.path?.[0]} digits={1} /></dd>
                  <dt>After {h} sessions</dt>
                  <dd>{sel.o.matured ? <><Pct v={sel.o.ret} digits={1} /> <span className="faint small">on {fmtDate(sel.o.endDate)}</span></> : 'Not matured'}</dd>
                  <dt>Worst and best close</dt>
                  <dd><Pct v={sel.o.maeClose} digits={1} /> and <Pct v={sel.o.mfeClose} digits={1} /></dd>
                  <dt>To month end</dt>
                  <dd><Pct v={sel.o.restOfMonthRet} digits={1} />{sel.o.anotherClosingLow ? ', after another monthly closing low' : ''}</dd>
                  <dt>To next month end</dt>
                  <dd><Pct v={sel.o.nextMonthEndRet} digits={1} /></dd>
                  <dt>Bounce target close</dt>
                  <dd>{sel.o.targetCloseOffset ? `Session ${sel.o.targetCloseOffset}` : sel.o.matured ? 'Not reached' : 'n/a'}{sel.o.failedBounce ? ', then closed below the anchor' : ''}</dd>
                </dl>
              ) : (
                <StateNote>No outcome rows for this month.</StateNote>
              )}
            </div>
            <Link className="btn primary" to={researchPath(symbol, 'selloffs', { tab: 'monthly', asof: sel.m.anchorDate })}>
              Open {fmtDate(sel.m.anchorDate)} as an as-of view
            </Link>
          </div>
        </Sheet>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ what if */

const PCT_KEYS: ReadonlySet<string> = new Set(['mtdReturn', 'drawdown', 'requiredToPriorClose']);
const CHANGE_FMT = (key: string, v: number): string => (PCT_KEYS.has(key) ? fmtPct(v, 1) : key === 'negativeShare' ? fmtPct(v, 0, false) : fmtNum(v, 0));

export function WhatIfTable({ w }: { w: WhatIfResult }) {
  return (
    <div className="mr-hypo stack" style={{ gap: 10 }}>
      <div className="row">
        <Chip tone="warn">Hypothetical</Chip>
        <span className="small muted">
          {w.scenario.label}. Placed on {w.appendedDates.map((d) => fmtDateShort(d)).join(', ')}. {w.crossesMonthEnd ? 'Crosses the month end. ' : ''}Nothing above changes.
        </span>
      </div>
      {isNa(w.result) ? (
        <StateNote>{reasonDetail(w.result)}</StateNote>
      ) : (
        <>
          <div className="table-wrap">
            <table className="data">
              <caption className="sr-only">Month state now and under the scenario</caption>
              <thead>
                <tr><th className="l" scope="col">Measure</th><th scope="col">Now</th><th scope="col">Scenario</th></tr>
              </thead>
              <tbody>
                {w.changes.map((c) => (
                  <tr key={c.key}><td className="l">{c.label}</td><td className="num">{CHANGE_FMT(c.key, c.base)}</td><td className="num">{CHANGE_FMT(c.key, c.scenario)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-wrap">
            <table className="data">
              <caption className="sr-only">Cohorts now and under the scenario</caption>
              <thead>
                <tr><th className="l" scope="col">Cohort, higher close after {w.base.options.horizon} sessions</th><th scope="col">Now</th><th scope="col">Scenario</th></tr>
              </thead>
              <tbody>
                {w.cohortChanges.map((c) => (
                  <tr key={c.kind}><td className="l" style={{ whiteSpace: 'normal' }}>{c.label}</td><td className="num">{c.base.hits} of {c.base.n}</td><td className="num">{c.scenario.hits} of {c.scenario.n}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="small faint">{w.note}</div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ sample */

export function SampleDetail({ study, cohort }: { study: MonthlyReversalStudy; cohort: Cohort }) {
  const c = study.candidates;
  const byReason = new Map<string, number>();
  for (const e of c.exclusions) byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + 1);
  return (
    <Disclosure summary="Sample and method">
      <dl className="kv">
        <dt>History</dt>
        <dd>{fmtDate(c.historyFirst)} to {fmtDate(c.historyLast)}</dd>
        <dt>Lookback from</dt>
        <dd>{fmtDate(c.lookbackFrom)}</dd>
        <dt>Months inspected</dt>
        <dd className="num">{c.inspectedMonths}, {c.eligible} eligible, {c.exclusions.length} excluded{byReason.size ? ` (${[...byReason].map(([r, n]) => `${n} ${r.replace(/-/g, ' ')}`).join(', ')})` : ''}</dd>
        <dt>Selected cohort</dt>
        <dd>{cohort.label}, {cohort.members.length} months, {cohort.summary.matured} matured, {cohort.summary.notMatured} not matured, {cohort.summary.years} years</dd>
        <dt>Cohort filters</dt>
        <dd>{cohort.filters.join('. ')}.</dd>
        <dt>Display gate</dt>
        <dd>A percentage shows only with at least {study.options.minMonths} eligible months across at least {study.options.minYears} distinct years.</dd>
        <dt>Match weights</dt>
        <dd>Equal weights and proposed scales. The reference weights were not available, so matching is not yet reconciled with the original app.</dd>
        {cohort.summary.indeterminateRace > 0 && (
          <>
            <dt>Same bar cases</dt>
            <dd>{cohort.summary.indeterminateRace} cases had both levels inside one daily bar and are left out of sequence odds.</dd>
          </>
        )}
      </dl>
    </Disclosure>
  );
}
