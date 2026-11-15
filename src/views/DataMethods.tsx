/** Data and methods: what each source feeds, how fresh it is, what failed and what still works. */
import { Link } from 'react-router-dom';
import { getFixtureProvider, getProvider, invalidate, isFixtureMode, useHealth } from '../data/client';
import type { FixtureSourceId } from '../data/fixtureProvider';
import { CALENDAR_VERSION, calendarCoverage, SPECIAL_CLOSURES } from '../engine/core/calendar';
import { Card, Chip, Disclosure, Skeleton, StateNote } from '../ui/components';
import { fmtDate, fmtTimeET } from '../ui/format';

const METHODS: { name: string; text: string }[] = [
  { name: 'Price return', text: 'Close at the endpoint divided by the base close, minus 1. Weekly, monthly and year boards use quote closes on one split basis with no dividend reinvestment.' },
  { name: 'Period to date', text: 'WTD, MTD, QTD and YTD start from the final completed close of the preceding period. A series that begins inside the period has no base and shows a reason instead of a number.' },
  { name: 'Closing drawdown', text: 'Close divided by the running closing peak, minus 1. The gain needed to regain the peak is peak divided by close, minus 1. Traded highs, closing highs, year highs and all-time highs are labeled separately.' },
  { name: 'Moving averages', text: 'Simple average of the last N completed closes. A 200-day value needs 200 sessions. Runs count from the first close on the new side and end on the exit close.' },
  { name: 'ATR and RSI', text: 'Wilder smoothing over 14 sessions. True range uses the prior close. Early values are empty and never backfilled.' },
  { name: 'Frequencies', text: 'Every frequency shows hits, the denominator and a Wilson interval. Small or clustered samples use a conservative effective sample size.' },
  { name: 'Forward outcomes', text: 'An outcome counts only when its horizon has completed. Endpoint returns, touches and holds are separate measures with separate denominators.' },
  { name: 'Modeled probabilities', text: 'A model percentage appears only when it beats its stated baseline out of sample, on matured labels, in chronological blocks. Otherwise the page shows the historical description and the reason the model is withheld.' },
  { name: 'No look-ahead', text: 'A value at a date uses data through that date. Later confirmations, eventual bottoms and revised figures never enter an earlier feature.' },
];

export default function DataMethods() {
  const h = useHealth();
  const clock = getProvider().clock();
  const cal = calendarCoverage();
  const fixture = isFixtureMode();
  return (
    <div className="stack">
      <h1>Data and methods</h1>
      {fixture && (
        <StateNote tone="warn" title="Fixture mode.">
          Every price, estimate and report date in this build is synthetic and generated for testing. Identity facts such as names and themes come from the owner specification. No live provider is connected.
        </StateNote>
      )}
      <Card title="Sources" sub={`Latest completed session ${fmtDate(clock.lastCompletedSession)}. Checked ${fmtTimeET(clock.now)}.`}>
        {h.status === 'loading' && <Skeleton h={120} />}
        {h.status === 'error' && (
          <StateNote tone="error" title="Source status could not be read." action={<button type="button" className="btn small" onClick={h.reload}>Retry</button>}>
            {h.error.message}
          </StateNote>
        )}
        {h.status === 'ready' && (
          <div className="stack" style={{ gap: 12 }}>
            {h.data.map((s) => (
              <div key={s.id} className="row" style={{ alignItems: 'flex-start', borderBottom: '1px solid var(--border)', paddingBottom: 12 }}>
                <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <strong>{s.label}</strong>
                    <Chip tone={s.state === 'ok' ? 'up' : s.state === 'failed' ? 'down' : 'warn'}>{s.state === 'ok' ? 'Working' : s.state === 'failed' ? 'Failed' : s.state === 'stale' ? 'Stale' : 'Degraded'}</Chip>
                    {s.kind === 'synthetic-fixture' && <Chip tone="warn">Synthetic</Chip>}
                  </div>
                  <div className="muted small">Feeds {s.feeds.join(', ')}</div>
                  {s.state !== 'ok' && (
                    <div className="small" style={{ marginTop: 4 }}>
                      <span className="down">{s.error}.</span> {s.fallback} Last good capture covers through {fmtDate(s.dataThrough)}.
                    </div>
                  )}
                </div>
                <div className="small muted" style={{ flex: '0 1 220px' }}>
                  <div>Data through {fmtDate(s.dataThrough)}</div>
                  <div>Last success {fmtTimeET(s.lastSuccess)}</div>
                  <div>Last attempt {fmtTimeET(s.lastAttempt)}</div>
                </div>
                <div className="row">
                  <button type="button" className="btn small" onClick={() => { if (fixture && s.state !== 'ok') getFixtureProvider().setOutage(s.id as FixtureSourceId, false); else invalidate(); }}>
                    {s.state === 'ok' ? 'Recheck' : 'Retry source'}
                  </button>
                  {fixture && s.state === 'ok' && (
                    <button type="button" className="btn small ghost" onClick={() => getFixtureProvider().setOutage(s.id as FixtureSourceId, true)} title="Fixture mode only. Simulates this source going down so the failure path can be reviewed.">
                      Simulate outage
                    </button>
                  )}
                </div>
              </div>
            ))}
            <p className="muted small">
              A source that fails affects only the cards it feeds. Each affected card names the source and offers a retry. Return to your analysis with the browser Back button, or <Link to="/">open Today</Link>.
            </p>
          </div>
        )}
      </Card>
      <Card title="Exchange calendar" sub={`${cal.version}. ${cal.note}`}>
        <Disclosure summary={`Unscheduled closures in range (${Object.keys(SPECIAL_CLOSURES).length})`}>
          <dl className="kv">
            {Object.entries(SPECIAL_CLOSURES).map(([d, why]) => (
              <div key={d} style={{ display: 'contents' }}>
                <dt>{fmtDate(d)}</dt>
                <dd>{why}</dd>
              </div>
            ))}
          </dl>
        </Disclosure>
        <p className="muted small">Calendar version {CALENDAR_VERSION}. A session the calendar expects and a source does not have is reported as missing. It is never replaced with the previous trading day.</p>
      </Card>
      <Card title="Methods">
        <dl className="kv">
          {METHODS.map((m) => (
            <div key={m.name} style={{ display: 'contents' }}>
              <dt>{m.name}</dt>
              <dd>{m.text}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card title="Known gaps" sub="What this build cannot show yet, and why.">
        <ul style={{ margin: 0, paddingLeft: 18 }} className="muted">
          <li>No live market data provider is connected. Live quotes, option chains and implied moves are unavailable.</li>
          <li>Company logos need licensed artwork. Every symbol shows a ticker badge instead.</li>
          <li>Point-in-time estimate revisions, historical index membership and full-market breadth have no source.</li>
          <li>Model thresholds that the specification delegates to the reference source are marked proposed until reconciled.</li>
          <li>Owner records are stored in this browser only. Account storage and device sync need the server deployment.</li>
        </ul>
      </Card>
    </div>
  );
}
