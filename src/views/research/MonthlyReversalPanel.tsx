/**
 * Monthly Reversal. How heavy this month's selling is against earlier months at the same point,
 * what followed in comparable months, and how good that evidence is.
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { RequireBars, useResearch } from '../../app/research';
import { useBars } from '../../data/client';
import { useEngine } from '../../data/engine';
import { isNa, type Bar, type Maybe } from '../../engine/core/types';
import { monthlyState, type CohortKind } from '../../engine/monthlyReversal';
import { standardScenarios, type MonthlyReversalStudy, type WhatIfResult } from '../../engine/monthlyReversalModel';
import { Card, Chip, Disclosure, Segmented, Skeleton, StateNote } from '../../ui/components';
import { fmtDate, reasonDetail } from '../../ui/format';
import { CasesBlock, DistributionTable, FeasibilityBlock, LeadStats, OddsBlock, OutcomeRows, PathChart, SampleDetail, SequenceStrip, Severity, TimeTo, WhatIfTable } from './monthly/blocks';
import './monthly/monthly.css';
import {
  activeChips, clearSettings, COHORT_KINDS, HORIZON_CHOICES, LEVEL_CHOICES, LOOKBACK_CHOICES, MAX_HORIZON, MR_DEFAULTS, readSettings, settingsSummary, studyKey, toOptions, writeSetting, type MrSettings,
} from './monthly/settings';

const COHORT_NAME: Record<CohortKind, string> = {
  'similar-setup': 'Similar selling setup',
  'all-months': 'All earlier months',
  'same-calendar-month': 'Same calendar month',
  regime: 'Same market regime',
  'same-earnings': 'Same earnings context',
};

function Panel() {
  const r = useResearch();
  const [sp, setSp] = useSearchParams();
  const s = useMemo(() => readSettings(sp), [sp]);
  const set = <K extends keyof MrSettings>(key: K, value: MrSettings[K]) => setSp(writeSetting(sp, key, value), { replace: true });
  const { bars, symbol, instrument } = r;
  const i = bars.length - 1;
  const asOf = r.asOf ?? '';

  // The month state is cheap, so the lead block never waits on the study.
  const state = useMemo(() => monthlyState(bars, i, { basis: s.basis }), [bars, i, s.basis]);

  const sectorSymbol = instrument.sectorEtf && instrument.sectorEtf !== symbol ? instrument.sectorEtf : null;
  const spy = useBars('SPY', asOf || undefined);
  const sector = useBars(sectorSymbol, asOf || undefined);
  const contextReady = spy.status !== 'loading' && (sectorSymbol === null || sector.status !== 'loading');
  const pick = (x: typeof spy): Bar[] | undefined => (x.status === 'ready' && !isNa(x.data) ? x.data : undefined);
  const market = pick(spy);
  const sectorBars = sectorSymbol ? pick(sector) : undefined;
  const context = () => ({ market, sector: sectorBars, earnings: isNa(r.earningsKnown) ? undefined : r.earningsKnown });
  const ctxKey = `${market ? 'm' : '-'}${sectorBars ? 's' : '-'}${isNa(r.earningsKnown) ? '-' : 'e'}`;
  const baseKey = `${symbol}:${asOf}:${bars.length}:${ctxKey}:${studyKey(s)}`;

  const study = useEngine<Maybe<MonthlyReversalStudy>>(contextReady && !isNa(state) ? baseKey : null, 'monthlyReversalModel', 'monthlyReversalStudy', () => [bars, i, toOptions(s), context()]);

  const [whatIfOpen, setWhatIfOpen] = useState(false);
  const scenarios = useMemo(() => (isNa(state) ? [] : standardScenarios(state)), [state]);
  const scId = sp.get('mr_sc') ?? scenarios[0]?.id ?? '';
  const scenario = scenarios.find((x) => x.id === scId) ?? scenarios[0];
  const whatIf = useEngine<Maybe<WhatIfResult>>(whatIfOpen && scenario && contextReady ? `${baseKey}:${scenario.id}` : null, 'monthlyReversalModel', 'whatIf', () => [bars, i, scenario, toOptions(s), context()]);

  const [targetClose, setTargetClose] = useState<number | null>(null);
  const [upShare, setUpShare] = useState(0.5);

  if (isNa(state)) {
    return (
      <StateNote tone="warn" title="Monthly Reversal is unavailable for this date.">
        {reasonDetail(state)} The study needs the final close of the prior month and every session of this month through {fmtDate(r.asOf)}.
      </StateNote>
    );
  }

  const chips = activeChips(s);
  const data = study.status === 'ready' && !isNa(study.data) ? study.data : null;
  const cohort = data ? (data.cohorts.find((c) => c.kind === s.cohort) ?? data.cohorts[0]) : undefined;
  const all = data?.cohorts.find((c) => c.kind === 'all-months');
  const marketDown = spy.status === 'error' || (spy.status === 'ready' && isNa(spy.data));

  const pending = study.status === 'loading' || !contextReady;
  const failed =
    study.status === 'error' ? (
      <StateNote tone="error" title="The study could not be computed." action={<button type="button" className="btn small" onClick={study.reload}>Retry</button>}>
        {study.error.message}
      </StateNote>
    ) : study.status === 'ready' && isNa(study.data) ? (
      <StateNote tone="warn">{reasonDetail(study.data)}</StateNote>
    ) : null;

  return (
    <div className="stack">
      <Card
        title={`This month so far, through ${fmtDate(state.anchorDate)}`}
        info="Observed facts for the calendar month through the latest completed session. Month to date uses the final close of the prior month as its base."
        actions={state.elapsed === 1 ? <Chip>First session of the month</Chip> : undefined}
      >
        <div className="stack" style={{ gap: 14 }}>
          <LeadStats state={state} />
          <SequenceStrip state={state} />
          {pending ? <Skeleton h={64} /> : data ? <Severity state={data.state} all={all} /> : null}
        </div>
      </Card>

      <div className="card" style={{ padding: '4px 16px' }}>
        <Disclosure
          summary={
            <span>
              Study settings <span className="muted" style={{ fontWeight: 450 }}>{settingsSummary(s)}</span>
            </span>
          }
        >
          <div className="mr-settings">
            <label className="field">
              Sessions ahead
              <Segmented label="Sessions ahead" value={s.horizon} options={HORIZON_CHOICES.map((h) => ({ value: h, label: String(h) }))} onChange={(v) => set('horizon', v)} />
            </label>
            <label className="field">
              Custom sessions ahead, up to {MAX_HORIZON}
              <input className="input" type="number" min={1} max={MAX_HORIZON} defaultValue={s.horizon} key={`h-${s.horizon}`} onBlur={(e) => set('horizon', Math.max(1, Math.min(MAX_HORIZON, Math.round(Number(e.target.value) || MR_DEFAULTS.horizon))))} />
            </label>
            <label className="field">
              Lookback
              <select className="select" value={s.lookbackYears} onChange={(e) => set('lookbackYears', Number(e.target.value))}>
                {[...new Set([...LOOKBACK_CHOICES, s.lookbackYears])].sort((a, b) => a - b).map((y) => (
                  <option key={y} value={y}>{y} years</option>
                ))}
              </select>
            </label>
            <label className="field">
              Bounce target above the close (%)
              <input className="input" type="number" min={0.1} max={50} step={0.5} defaultValue={+(s.bounce * 100).toFixed(2)} key={`b-${s.bounce}`} onBlur={(e) => set('bounce', Math.max(0.001, Math.min(0.5, (Number(e.target.value) || 3) / 100)))} />
            </label>
            <label className="field">
              Downside level below the close (%)
              <input className="input" type="number" min={0.1} max={50} step={0.5} defaultValue={+(s.downside * 100).toFixed(2)} key={`d-${s.downside}`} onBlur={(e) => set('downside', Math.max(0.001, Math.min(0.5, (Number(e.target.value) || 5) / 100)))} />
            </label>
            <label className="field">
              Closes needed to hold the target
              <input className="input" type="number" min={1} max={20} defaultValue={s.holdSessions} key={`hd-${s.holdSessions}`} onBlur={(e) => set('holdSessions', Math.max(1, Math.min(20, Math.round(Number(e.target.value) || 3))))} />
            </label>
            <label className="field">
              A down session is
              <select className="select" value={s.basis} onChange={(e) => set('basis', e.target.value === 'open' ? 'open' : 'prior-close')}>
                <option value="prior-close">A close below the previous close</option>
                <option value="open">A close below its own open</option>
              </select>
            </label>
            <label className="field">
              Interval level
              <Segmented label="Interval level" value={s.level} options={LEVEL_CHOICES.map((l) => ({ value: l, label: `${Math.round(l * 100)}%` }))} onChange={(v) => set('level', v)} />
            </label>
          </div>
        </Disclosure>
        {chips.length > 0 && (
          <div className="row" style={{ gap: 6, paddingBottom: 10 }}>
            {chips.map((c) => (
              <Chip key={c.key} tone="accent" onRemove={() => set(c.key, MR_DEFAULTS[c.key])}>{c.label}</Chip>
            ))}
            <button type="button" className="btn ghost small" onClick={() => setSp(clearSettings(sp), { replace: true })}>Reset all</button>
          </div>
        )}
      </div>

      {marketDown && <StateNote tone="warn" title="Market series unavailable.">The market regime cohort and market relative figures are left out. Everything else uses the stock's own history.</StateNote>}
      {failed}
      {pending && <Skeleton h={320} />}

      {data && cohort && (
        <>
          <div className="mr-two">
            <Card title="Month to date path" info="The observed path through the latest close, then what earlier months did after the same point. The right side is history of other months, not a projection.">
              <PathChart study={data} cohort={cohort} />
            </Card>
            <Card
              title={`Higher close after ${data.options.horizon} ${data.options.horizon === 1 ? 'session' : 'sessions'}`}
              info="How often the close was above the anchor close after the horizon. Normal odds are the baseline. Conditional odds are the chosen cohort of earlier months."
              actions={
                <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <span className="sr-only">Cohort</span>
                  <select className="select" aria-label="Cohort" value={cohort.kind} onChange={(e) => set('cohort', e.target.value as CohortKind)}>
                    {COHORT_KINDS.map((k) => {
                      const c = data.cohorts.find((x) => x.kind === k);
                      return <option key={k} value={k}>{COHORT_NAME[k]} ({c?.unavailable ? 'unavailable' : (c?.members.length ?? 0)})</option>;
                    })}
                  </select>
                </label>
              }
            >
              <div className="stack" style={{ gap: 10 }}>
                <OddsBlock study={data} cohort={cohort} daily={data.baselines.daily} />
                <SampleDetail study={data} cohort={cohort} />
              </div>
            </Card>
          </div>

          <Card title={`What followed in ${cohort.members.length} months: ${cohort.label.toLowerCase()}`} sub="Each line has its own denominator. A percentage shows only when the months and years gate passes.">
            {cohort.unavailable ? (
              <StateNote>{reasonDetail(cohort.unavailable)}. Choose another cohort.</StateNote>
            ) : cohort.members.length === 0 ? (
              <StateNote>No earlier month qualifies for this cohort under these settings. A longer lookback or the all months cohort would add cases.</StateNote>
            ) : (
              <div className="stack" style={{ gap: 14 }}>
                <OutcomeRows summary={cohort.summary} />
                <div>
                  <h3 style={{ marginBottom: 6 }}>Durable recovery, with timing</h3>
                  <TimeTo t={cohort.summary.rebound} />
                  <TimeTo t={cohort.summary.recovery} />
                </div>
                <Disclosure summary="Distribution of moves">
                  <DistributionTable summary={cohort.summary} />
                </Disclosure>
              </div>
            )}
          </Card>

          <Card title="Can the month still recover" info="Left: arithmetic the calendar allows. Right: counts from earlier months. They are separate questions.">
            <FeasibilityBlock
              study={data}
              cohort={cohort}
              targetClose={targetClose ?? data.state.priorMonthClose}
              upShare={upShare}
              onTargetClose={(v) => { const x = Number(v); setTargetClose(Number.isFinite(x) && x > 0 ? x : null); }}
              onUpShare={(v) => { const x = Number(v); if (Number.isFinite(x)) setUpShare(Math.max(0, Math.min(1, x / 100))); }}
            />
          </Card>

          <Card title="Matched months" info="Every earlier month in the cohort, including the ones that kept falling. Select a row to see why it qualified and what followed.">
            <CasesBlock study={data} cohort={cohort} symbol={symbol} />
          </Card>

          <div className="card" style={{ padding: '4px 16px 10px' }}>
            <details className="disclosure" onToggle={(e) => setWhatIfOpen((e.target as HTMLDetailsElement).open)}>
              <summary>What if scenarios, hypothetical</summary>
              <div className="stack" style={{ gap: 10 }}>
                <label className="field" style={{ maxWidth: 360 }}>
                  Scenario
                  <select className="select" value={scenario?.id ?? ''} onChange={(e) => { const n = new URLSearchParams(sp); n.set('mr_sc', e.target.value); setSp(n, { replace: true }); }}>
                    {scenarios.map((x) => (
                      <option key={x.id} value={x.id}>{x.label}</option>
                    ))}
                  </select>
                </label>
                {whatIf.status === 'loading' && whatIfOpen && <Skeleton h={160} />}
                {whatIf.status === 'error' && <StateNote tone="error" action={<button type="button" className="btn small" onClick={whatIf.reload}>Retry</button>}>{whatIf.error.message}</StateNote>}
                {whatIf.status === 'ready' && (isNa(whatIf.data) ? <StateNote>{reasonDetail(whatIf.data)}</StateNote> : <WhatIfTable w={whatIf.data} />)}
              </div>
            </details>
          </div>
        </>
      )}
    </div>
  );
}

export default function MonthlyReversalPanel() {
  return (
    <RequireBars min={30}>
      <Panel />
    </RequireBars>
  );
}
