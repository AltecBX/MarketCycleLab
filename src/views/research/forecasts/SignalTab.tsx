/** Signal Score. Buy and Sell percent render only when the horizon status is valid. */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useResearch } from '../../../app/research';
import { useBars, useHealth } from '../../../data/client';
import { useEngine } from '../../../data/engine';
import { isNa, type ModelStatus } from '../../../engine/core/types';
import type { SignalDataHealth, SignalHorizonScore, SignalInput, SignalInputEvidence, SignalScore } from '../../../engine/signal';
import { Card, DataTable, Disclosure, Freq, Info, Pct, Skeleton, Stat, StateNote, type Column } from '../../../ui/components';
import { fmtDate, fmtInt, fmtNum, fmtPct, fmtTimeET } from '../../../ui/format';
import type { CalibrationBin } from '../../../engine/validation';

const STATUS_LABEL: Record<ModelStatus, string> = {
  valid: 'Valid',
  'not-reliable': 'Not reliable',
  'insufficient-evidence': 'Insufficient evidence',
  stale: 'Stale',
  unavailable: 'Unavailable',
};

/** Engine reasons carry raw ISO values. Show them in the house date and ET time formats. */
const humanize = (s: string): string =>
  s
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, (m) => fmtTimeET(m))
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, (m) => fmtDate(m));

/** Per block reasons repeat. Group them so the card states each cause once with its block count. */
const groupReasons = (reasons: readonly string[]): { text: string; count: number }[] => {
  const m = new Map<string, number>();
  for (const r of reasons) {
    const t = r.replace(/^Block \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}\.\s*/, '');
    m.set(t, (m.get(t) ?? 0) + 1);
  }
  return [...m.entries()].map(([text, count]) => ({ text, count }));
};

const TOP_INPUTS = 5;

function StatusBadge({ s }: { s: ModelStatus }) {
  return (
    <span className="fc-status" data-s={s}>
      {STATUS_LABEL[s]}
    </span>
  );
}

function Evidence({ e }: { e: SignalInputEvidence }) {
  return (
    <div className="fc-ev">
      <span>
        <strong>{e.label}</strong>
        {e.state ? <span className="muted"> · {e.state}</span> : null}
      </span>
      <span className="num">
        {e.active ? (
          <>
            {e.estimate !== null ? fmtPct(e.estimate, 0, false) : 'n/a'}
            <span className="faint small"> log odds {fmtNum(e.contribution, 2, true)}</span>
          </>
        ) : (
          <span className="faint">Inactive</span>
        )}
      </span>
      <span className="fc-ev-sub">
        {humanize(e.context)}.
        {e.active
          ? ` Own cases ${e.own.hits} of ${e.own.n} higher. Level used: ${e.origin}${e.retrospectiveGroup ? ', group membership applied retrospectively' : ''}.`
          : ` ${humanize(e.inactiveReason ?? 'No usable cases')}.`}
      </span>
    </div>
  );
}

const calCols: Column<CalibrationBin>[] = [
  { key: 'band', header: 'Predicted band', align: 'l', cell: (b) => `${fmtPct(b.lo, 0, false)} to ${fmtPct(b.hi, 0, false)}` },
  { key: 'n', header: 'Forecasts', cell: (b) => fmtInt(b.n) },
  { key: 'mp', header: 'Mean predicted', cell: (b) => (b.meanPrediction === null ? 'n/a' : fmtPct(b.meanPrediction, 1, false)) },
  { key: 'obs', header: 'Observed higher close', align: 'l', cell: (b) => <Freq p={b.observed} /> },
];

function HorizonCard({ h }: { h: SignalHorizonScore }) {
  const ev = h.evaluation;
  const active = [...h.evidence].filter((e) => e.active).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const inactive = h.evidence.filter((e) => !e.active);
  const valid = h.status === 'valid' && h.buy !== null && h.sell !== null;
  const blocksReady = ev ? ev.blocks.filter((b) => b.ready).length : 0;
  const blocksBeat = ev ? ev.blocks.filter((b) => b.ready && b.beatsBaseline).length : 0;
  return (
    <Card title={`${h.horizon} sessions`} sub={`Target. ${h.target}.`} actions={<StatusBadge s={h.status} />}>
      <div className="stack" style={{ gap: 12 }}>
        {valid ? (
          <div className="stats">
            <Stat label={`Close higher after ${h.horizon} sessions`} value={fmtPct(h.buy, 0, false)} sub="Buy percent. Validated estimate" />
            <Stat label={`No higher close after ${h.horizon} sessions (includes flat)`} value={fmtPct(h.sell, 0, false)} sub="Sell percent. 100 minus Buy" />
            <Stat label="Calibration band, observed" value={<Freq p={h.interval} />} sub="Held out forecasts in the same band" />
          </div>
        ) : (
          <StateNote tone={h.status === 'stale' || h.status === 'not-reliable' ? 'warn' : 'info'} title={`No percentage. ${STATUS_LABEL[h.status]}.`}>
            <ul className="fc-reasons">
              {groupReasons(h.reasons).map((r) => (
                <li key={r.text}>
                  {humanize(r.text)}
                  {r.count > 1 ? ` (${r.count} blocks)` : ''}
                </li>
              ))}
            </ul>
          </StateNote>
        )}
        {(h.baseline || ev) && <div className="stats">
          <Stat
            label="Baseline, earlier all days"
            info="Share of earlier spaced sessions whose close was higher after the same horizon. This is the rate the model has to beat."
            value={h.baseline ? fmtPct(h.baseline.rate, 0, false) : 'n/a'}
            sub={h.baseline ? `${h.baseline.hits} of ${h.baseline.n}` : 'No matured earlier cases'}
          />
          <Stat
            label="Brier, model"
            info="Mean squared error of the held out forecasts on the same dates and targets. Lower is better."
            value={ev && ev.brier !== null ? ev.brier.toFixed(4) : 'n/a'}
            sub={ev ? `${ev.baselineBrier !== null ? `Baseline ${ev.baselineBrier.toFixed(4)}. ` : ''}${fmtInt(ev.forecasts)} forecasts scored` : 'Not evaluated'}
          />
          <Stat label="Blocks beating baseline" value={ev ? `${blocksBeat} of ${blocksReady}` : 'n/a'} sub={ev ? `${ev.blocks.length} blocks, ${blocksReady} ready` : undefined} />
          <Stat
            label="Held out hit rate"
            info={ev?.hitRateDefinition ?? 'Share of held out forecasts where the side with probability of at least one half matched.'}
            value={ev?.hitRate ? fmtPct(ev.hitRate.rate, 0, false) : 'n/a'}
            sub={ev?.hitRate ? `${ev.hitRate.hits} of ${ev.hitRate.n}` : undefined}
          />
          <Stat label="Inputs and cases" value={`${h.usableInputs} inputs, ${fmtInt(h.matches)} cases`} sub="Each case counted once" />
        </div>}
        {ev && (
          <div className="small muted">
            History from {fmtDate(ev.coverage.historyFrom)}. {ev.coverage.firstForecast ? `Forecasts scored ${fmtDate(ev.coverage.firstForecast)} to ${fmtDate(ev.coverage.lastForecast)}.` : 'No forecasts scored yet.'}
          </div>
        )}
        {h.comparable && (
          <div>
            <h3 style={{ marginBottom: 6 }}>
              Historical comparable cases <Info text={`${h.comparable.source}. ${h.comparable.basis}. These are observed outcomes, separate from the model estimate and its interval.`} />
            </h3>
            <div className="stats">
              <Stat label="Median return" value={<Pct v={h.comparable.median} />} sub={`n ${h.comparable.n}`} />
              <Stat label="10th percentile" value={<Pct v={h.comparable.p10} />} />
              <Stat label="90th percentile" value={<Pct v={h.comparable.p90} />} />
              <Stat label="Median worst drawdown, closes" value={<Pct v={-Math.abs(h.comparable.medianWorstCloseDrawdown)} />} sub={`Intraday lows ${fmtPct(-Math.abs(h.comparable.medianWorstLowDrawdown), 2)}`} />
            </div>
          </div>
        )}
        {active.length > 0 && (
          <div>
            <h3>Input evidence, largest contribution first</h3>
            {active.slice(0, TOP_INPUTS).map((e) => (
              <Evidence key={e.id} e={e} />
            ))}
            {active.length > TOP_INPUTS && (
              <Disclosure summary={`All ${active.length} active inputs`}>
                {active.slice(TOP_INPUTS).map((e) => (
                  <Evidence key={e.id} e={e} />
                ))}
              </Disclosure>
            )}
          </div>
        )}
        {inactive.length > 0 && (
          <Disclosure summary={`Inactive inputs (${inactive.length})`}>
            {inactive.map((e) => (
              <Evidence key={e.id} e={e} />
            ))}
          </Disclosure>
        )}
        {ev && ev.calibration.some((b) => b.n > 0) && (
          <Disclosure summary="Reliability and calibration">
            <DataTable rows={ev.calibration.filter((b) => b.n > 0)} cols={calCols} rowKey={(b) => String(b.lo)} caption={`Calibration bands, ${h.horizon} sessions`} />
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table className="data">
                <caption className="sr-only">Evaluation blocks</caption>
                <thead>
                  <tr>
                    <th className="l">Block</th>
                    <th>Forecasts</th>
                    <th>Brier</th>
                    <th>Baseline</th>
                    <th className="l">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {ev.blocks.map((b) => (
                    <tr key={b.block}>
                      <td className="l">{fmtDate(b.startDate)} to {fmtDate(b.endDate)}</td>
                      <td>{b.forecasts}</td>
                      <td>{b.brier === null ? 'n/a' : b.brier.toFixed(4)}</td>
                      <td>{b.baselineBrier === null ? 'n/a' : b.baselineBrier.toFixed(4)}</td>
                      <td className="l">{!b.ready ? humanize(b.reason ?? 'Not ready') : b.beatsBaseline ? 'Beat baseline' : 'Did not beat baseline'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Disclosure>
        )}
        <Disclosure summary="Forecast registration">
          <dl className="kv">
            <dt>Target</dt><dd>{h.registration.target}</dd>
            <dt>Observation</dt><dd>{h.registration.observation}</dd>
            <dt>Eligibility</dt><dd>{h.registration.eligibility}</dd>
            <dt>Sampling</dt><dd>{h.registration.samplingCadence}</dd>
            <dt>Split</dt>
            <dd>
              Burn in {h.registration.split.burnIn} sessions, blocks of {h.registration.split.blockSize}, spacing {h.registration.split.spacing}, embargo {h.registration.split.embargo}, at least {h.registration.split.minBlocks} blocks of {h.registration.split.minForecastsPerBlock} forecasts
            </dd>
            <dt>Baseline</dt><dd>{h.registration.baseline}</dd>
            <dt>Calibration</dt><dd>{h.registration.calibration}</dd>
            <dt>Fallback</dt><dd>{h.registration.fallback}</dd>
            <dt>Version</dt><dd>{h.registration.version}</dd>
          </dl>
        </Disclosure>
      </div>
    </Card>
  );
}

export function SignalTab() {
  const r = useResearch();
  const health = useHealth();
  const spy = useBars(r.symbol === 'SPY' ? null : 'SPY', r.asOf ?? undefined);
  const spyReady = r.symbol === 'SPY' || spy.status !== 'loading';
  const ready = health.status === 'ready' && spyReady;

  const input = useMemo<SignalInput | null>(() => {
    if (health.status !== 'ready') return null;
    const prices = health.data.find((s) => s.id === 'prices');
    const failed = !!r.barsIssue || (prices !== undefined && prices.state !== 'ok');
    // Fixture mode has no owner data check job. It treats the fixture clock as the last good check
    // while the price source is healthy, and the source's own last success when it is not.
    // A frozen as-of view is a historical replay, so the expected session is the as-of date itself.
    const h: SignalDataHealth = {
      sourceFailed: failed,
      failure: failed ? (prices?.error ?? r.barsIssue?.detail ?? 'Daily price history is unavailable') : undefined,
      lastGoodCheckAt: failed ? (prices?.lastSuccess ?? null) : r.clock.now,
      expectedLatestSession: r.frozen && r.asOf ? r.asOf : r.clock.lastCompletedSession,
      presentLatestSession: r.asOf,
    };
    const spyBars = spy.status === 'ready' && !isNa(spy.data) ? spy.data : undefined;
    return {
      symbol: r.symbol,
      bars: r.bars,
      spyBars,
      earnings: isNa(r.earningsKnown) ? undefined : r.earningsKnown,
      health: h,
      now: r.clock.now,
      dataVersion: isNa(r.series) ? undefined : `${r.series.source.provider}@${r.series.coverage.last ?? ''}`,
    };
  }, [health, spy, r]);

  const key = ready && input ? `${r.symbol}|${r.asOf ?? 'none'}|${r.bars.length}|${input.health.sourceFailed}|${input.spyBars ? 'spy' : 'nospy'}|${isNa(r.earningsKnown) ? 'noearn' : r.earningsKnown.length}` : null;
  const score = useEngine<SignalScore>(key, 'signal', 'computeSignalScore', () => [input]);

  if (!ready || score.status === 'loading') return <Skeleton h={320} />;
  if (score.status === 'error') {
    return (
      <StateNote tone="error" title="The Signal Score could not be computed." action={<button type="button" className="btn small" onClick={score.reload}>Retry</button>}>
        {score.error.message}
      </StateNote>
    );
  }
  const s = score.data;
  const gateBad = s.gate.status !== 'ok';
  return (
    <div className="stack">
      <div className="row" style={{ gap: 8 }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          Signal Score
          <Info text="Buy percent estimates how often the close is higher after the stated number of completed sessions. Sell percent is 100 minus Buy and includes flat closes. These names describe a price outcome. They place no trade and are not advice." />
        </h2>
        <span className="muted small">
          {s.asOf ? `As of the ${fmtDate(s.asOf)} close.` : 'No completed close.'} {r.frozen ? 'Historical replay, not a current score.' : ''}
        </span>
      </div>
      {gateBad && (
        <StateNote tone="warn" title={s.gate.status === 'stale' ? 'Stale. The score is disabled.' : 'Unavailable. The score is disabled.'} action={<Link className="btn small" to="/data">Source status</Link>}>
          {humanize(s.gate.reason ?? 'The data gate failed')}. Freshness limit {s.gate.limitMinutes} minutes. No cached score is shown.
        </StateNote>
      )}
      {!gateBad && !isNa(r.earningsKnown) ? null : !gateBad && isNa(r.earningsKnown) && r.instrument.type === 'stock' ? (
        <StateNote>Earnings source unavailable. The earnings input is inactive. Other inputs are unaffected.</StateNote>
      ) : null}
      <div className="grid">
        {s.horizons.map((h) => (
          <HorizonCard key={h.horizon} h={h} />
        ))}
      </div>
      <Disclosure summary="Model and data versions">
        <dl className="kv">
          <dt>Model</dt><dd>{s.modelVersion}</dd>
          <dt>Price data</dt><dd>{s.dataVersion ?? 'n/a'}</dd>
          <dt>Data gate</dt><dd>{s.gate.status === 'ok' ? `Passed. Check age ${s.gate.ageMinutes === null ? 'n/a' : Math.round(s.gate.ageMinutes)} minutes, limit ${s.gate.limitMinutes}` : STATUS_LABEL[s.gate.status === 'stale' ? 'stale' : 'unavailable']}</dd>
          <dt>Thresholds</dt><dd>Several fitting settings are proposed values pending reconciliation with the reference source.</dd>
        </dl>
      </Disclosure>
    </div>
  );
}
