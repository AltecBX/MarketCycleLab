/** Earnings: when is the next report, how firm is the date, how did price behave around past reports. */
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { RequireBars, useResearch } from '../../app/research';
import { researchPath } from '../../app/routes';
import { invalidate } from '../../data/client';
import { isNa } from '../../engine/core/types';
import { earningsStudy, fiscalQuarterOf, nextEarnings } from '../../engine/earnings';
import { Card, Disclosure, Pct, Stat, StateNote } from '../../ui/components';
import { fmtDate, fmtPct, plural, reasonDetail } from '../../ui/format';
import './earnings/earnings.css';
import { NextReport } from './earnings/NextReport';
import { PathCompare, type Align, type QuarterChoice } from './earnings/PathCompare';
import { MeasureTable, ReactionTable } from './earnings/ReactionTable';

export default function Earnings() {
  const r = useResearch();
  const [sp, setSp] = useSearchParams();
  const isFund = r.instrument.type === 'etf' || r.instrument.type === 'index';
  const today = r.frozen && r.asOf ? r.asOf : r.clock.lastCompletedSession;
  const events = r.earningsKnown;
  const next = useMemo(() => nextEarnings(events, today, r.instrument.type), [events, today, r.instrument.type]);
  const study = useMemo(() => {
    if (isNa(events) || r.bars.length === 0) return null;
    const ws = r.windowStart;
    return earningsStudy(r.bars, ws ? events.filter((e) => e.date >= ws) : events);
  }, [events, r.bars, r.windowStart]);

  const set = (k: string, v: string | null) => {
    const n = new URLSearchParams(sp);
    if (v === null) n.delete(k);
    else n.set(k, v);
    setSp(n, { replace: true });
  };
  const qp = sp.get('q');
  const quarter: QuarterChoice = qp && ['1', '2', '3', '4'].includes(qp) ? (Number(qp) as QuarterChoice) : 'all';
  const align: Align = sp.get('align') === 'calendar' ? 'calendar' : 'sessions';

  if (isFund) {
    return (
      <Card title="Earnings">
        <StateNote title="Not applicable.">
          {r.symbol} is a fund and does not report earnings. <Link to={researchPath(r.symbol, 'overview', { asof: sp.get('asof') ?? undefined })}>Open its price research</Link>
        </StateNote>
      </Card>
    );
  }
  if (isNa(events)) {
    return (
      <Card title="Next report">
        <StateNote tone="error" title="Earnings dates are unavailable." action={<button type="button" className="btn small" onClick={() => invalidate()}>Retry</button>}>
          {reasonDetail(events)} Reaction studies need report dates, so they are withheld. Price studies in the other sections stay usable. <Link to="/data">See source status</Link>
        </StateNote>
      </Card>
    );
  }

  const withPath = study ? study.rows.filter((x) => x.path.length > 1) : [];
  const selParam = sp.get('report');
  const selected = study ? (study.rows.find((x) => x.event.date === selParam) ?? withPath[withPath.length - 1] ?? null) : null;
  const nextQ = isNa(next) ? null : fiscalQuarterOf({ fiscalPeriod: next.fiscalPeriod ?? undefined });

  return (
    <div className="stack">
      <Card title="Next report">
        <NextReport next={next} frozen={r.frozen} />
      </Card>
      <RequireBars>
        {study && study.rows.length === 0 && <StateNote>No past report falls inside the history shown. Widen History shown under Data details to include earlier reports.</StateNote>}
        {study && study.rows.length > 0 && (
          <>
            <Card
              title="Price around past reports"
              info="Each line is the close relative to the last close before a report. Session 0 is the first regular session that could react."
              sub={`${plural(study.rows.length, 'report')} from ${fmtDate(study.rows[0]!.event.date)} to ${fmtDate(study.rows[study.rows.length - 1]!.event.date)}, data through ${fmtDate(study.asOf)}.`}
            >
              <div className="stats" style={{ marginBottom: 14 }}>
                <Stat label="Typical first move size" info="Median absolute move of the first reacting close versus the prior close. Direction ignored." value={study.magnitude.distribution ? fmtPct(study.magnitude.distribution.median, 1, false) : 'n/a'} sub={`${study.magnitude.n} reports`} />
                <Stat
                  label="First close higher"
                  value={study.reaction.positive ? fmtPct(study.reaction.positive.rate, 0, false) : 'n/a'}
                  sub={study.reaction.positive ? `${study.reaction.positive.hits} of ${study.reaction.positive.n} reports, 95% interval ${fmtPct(study.reaction.positive.lo, 0, false)} to ${fmtPct(study.reaction.positive.hi, 0, false)}` : undefined}
                />
                <Stat label="Median runup, 20 sessions before" value={<Pct v={study.runups[20]?.distribution?.median} digits={1} />} sub={`${study.runups[20]?.n ?? 0} reports`} />
                <Stat label="Median drift, 20 sessions after" info="Measured from the first reacting close, so the reaction itself is not counted." value={<Pct v={study.drift[20]?.distribution?.median} digits={1} />} sub={`${study.drift[20]?.n ?? 0} matured reports`} />
              </div>
              <PathCompare bars={r.bars} study={study} quarter={quarter} align={align} selected={selected} nextQuarter={nextQ} onQuarter={(q) => set('q', q === 'all' ? null : String(q))} onAlign={(a) => set('align', a === 'sessions' ? null : a)} />
              <Disclosure summary="Distribution of each measure">
                <MeasureTable study={study} />
                <p className="faint small" style={{ marginTop: 6 }}>
                  {study.commonCoverage} reports have both the 20 session runup and the 20 session drift. Intervals use a year clustered sample size. These are historical descriptions, not forecasts.
                </p>
              </Disclosure>
            </Card>
            <Card title="Every report" sub="Select a report to highlight it in the chart and open its detail. Missing values show their reason on hover or in the detail.">
              {(study.duplicatesRemoved > 0 || study.periodConflicts.length > 0) && (
                <StateNote tone="warn">
                  {study.duplicatesRemoved > 0 && `${plural(study.duplicatesRemoved, 'duplicate row')} removed. `}
                  {study.periodConflicts.map((c) => `${c.fiscalPeriod} appears with dates ${c.dates.map(fmtDate).join(' and ')}. `)}
                </StateNote>
              )}
              <ReactionTable study={study} selectedId={selected?.id ?? null} onSelect={(id) => set('report', study.rows.find((x) => x.id === id)?.event.date ?? null)} />
            </Card>
          </>
        )}
      </RequireBars>
      <Card title="Expected move versus realized move">
        <StateNote title="Unavailable.">
          This comparison needs an option quote captured on a known date for an actual expiry, on the same price basis as the completed close. No option source is connected in this build. When a capture exists the result is an expiry magnitude. It is not an isolated earnings move, a probability or a direction.
        </StateNote>
      </Card>
    </div>
  );
}
