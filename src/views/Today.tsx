/** Today: what changed, what needs attention, pick a stock, see the evidence. */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { researchPath } from '../app/routes';
import { getProvider, invalidate, useHealth } from '../data/client';
import { newId, useWorkspace } from '../data/workspace';
import { isNa } from '../engine/core/types';
import { TIME_LABEL } from '../engine/earnings';
import { todaySummary, type Alert, type TodayInput, type TodayRow } from '../engine/today';
import { Card, Chip, DataTable, Disclosure, Missing, Pct, Skeleton, sortRows, StateNote, type Column, type SortState } from '../ui/components';
import { fmtDate, fmtDateShort, fmtDollars, fmtNum, fmtPct, fmtPrice, reasonDetail, reasonText } from '../ui/format';
import { ALERT_TARGET, alertConfigOf, barsOf, etDate, RULE_LABEL, useBundles, useIsNarrow, useResolver } from './portfolio/shared/data';
import { SymbolPicker } from './portfolio/shared/ui';
import './portfolio/shared/pf.css';

const OPEN_LIMIT = 5;
const SEV_TONE = { high: 'down', medium: 'warn', low: 'accent' } as const;

function MiniBars({ rows, value, caption }: { rows: readonly TodayRow[]; value: (r: TodayRow) => number; caption: string }) {
  const max = Math.max(1e-9, ...rows.map((r) => Math.abs(value(r))));
  return (
    <div className="pf-mini" role="list" aria-label={caption}>
      {rows.map((r) => (
        <div key={r.symbol} role="listitem" style={{ display: 'contents' }}>
          <Link className="pf-sym" to={researchPath(r.symbol, 'selloffs')}>{r.symbol}</Link>
          <div className="pf-mini-track" aria-hidden="true"><div className="pf-mini-fill" style={{ width: `${(Math.abs(value(r)) / max) * 100}%` }} /></div>
          <span className="num down">{fmtPct(value(r), 1)}</span>
        </div>
      ))}
    </div>
  );
}

export default function Today() {
  const [ws, update] = useWorkspace();
  const { instruments, bySymbol, resolve, ready } = useResolver();
  const health = useHealth();
  const clock = getProvider().clock();
  const today = etDate(clock.now);
  const narrow = useIsNarrow();
  const [showAcked, setShowAcked] = useState(false);
  const [sort, setSort] = useState<SortState | null>(null);
  const [conflict, setConflict] = useState(false);
  const [allOpen, setAllOpen] = useState(false);
  const [editing, setEditing] = useState(false);

  const symbols = useMemo(() => {
    const out: string[] = [];
    for (const s of [...ws.positions.map((p) => p.symbol), ...ws.watchlist]) {
      const r = resolve(s);
      const sym = isNa(r) ? s.toUpperCase() : r.symbol;
      if (!out.includes(sym)) out.push(sym);
    }
    return out;
  }, [ws.positions, ws.watchlist, resolve]);
  const bundles = useBundles(ready ? symbols : []);

  const summary = useMemo(() => {
    if (bundles.status !== 'ready') return null;
    const shares = new Map<string, number>();
    for (const p of ws.positions) {
      const r = resolve(p.symbol);
      const sym = isNa(r) ? p.symbol.toUpperCase() : r.symbol;
      shares.set(sym, (shares.get(sym) ?? 0) + p.shares);
    }
    const inputs: TodayInput[] = [];
    const unknown: string[] = [];
    for (const s of symbols) {
      const b = bundles.data.get(s);
      const inst = bySymbol.get(s);
      if (!b || isNa(b) || !inst) {
        unknown.push(s);
        continue;
      }
      const input: TodayInput = { instrument: inst, bars: barsOf(b), earnings: b.earnings };
      if (shares.has(s)) input.shares = shares.get(s)!;
      inputs.push(input);
    }
    const s = todaySummary(inputs, { today, lastCompletedSession: clock.lastCompletedSession, config: alertConfigOf(ws), health: health.status === 'ready' ? health.data : [], topFlagLimit: 200 });
    return { s, unknown };
  }, [bundles, symbols, ws, bySymbol, resolve, today, clock.lastCompletedSession, health]);

  const acked = useMemo(() => new Set(ws.alertsAcknowledged), [ws.alertsAcknowledged]);

  const acknowledge = (a: Alert) => {
    if (acked.has(a.key)) return;
    const ok = update((w) =>
      w.alertsAcknowledged.includes(a.key)
        ? w
        : {
            ...w,
            alertsAcknowledged: [...w.alertsAcknowledged, a.key],
            journal: [...w.journal, { id: newId(), createdAt: new Date().toISOString(), symbol: a.symbol, kind: 'alert-ack', text: `Acknowledged: ${a.symbol}, ${a.title}. ${a.detail}`, payload: { type: 'alert-ack', key: a.key, rule: a.rule, date: a.date } }],
          },
    );
    setConflict(!ok);
  };
  const addWatch = (symbol: string) => setConflict(!update((w) => (w.watchlist.includes(symbol) ? w : { ...w, watchlist: [...w.watchlist, symbol] })));
  const removeWatch = (symbol: string) => setConflict(!update((w) => ({ ...w, watchlist: w.watchlist.filter((s) => s !== symbol) })));

  const healthLine = (() => {
    if (health.status !== 'ready') return null;
    const bad = health.data.filter((h) => h.state !== 'ok');
    return (
      <span className="pf-health">
        <span className="dot" aria-hidden="true" style={{ background: bad.length ? 'var(--warn)' : 'var(--up)' }} />
        Latest completed session {fmtDate(clock.lastCompletedSession)}.{' '}
        {bad.length ? (
          <>
            <strong style={{ color: 'var(--warn)' }}>{bad.map((b) => b.label).join(', ')} {bad.length > 1 ? 'are' : 'is'} down.</strong> <Link to="/data">See what is still usable</Link>
          </>
        ) : (
          <>All sources working. <Link to="/data">Sources</Link></>
        )}
      </span>
    );
  })();

  const cols: Column<TodayRow>[] = [
    {
      key: 'symbol', header: 'Symbol', sticky: true, sort: (r) => r.symbol,
      cell: (r) => (
        <span>
          <Link className="pf-sym" to={researchPath(r.symbol)}>{r.symbol}</Link>
          {r.held && <span style={{ marginLeft: 6 }}><Chip tone="accent">Held</Chip></span>}
        </span>
      ),
    },
    { key: 'close', header: 'Close', sort: (r) => (isNa(r.close) ? null : r.close), cell: (r) => (isNa(r.close) ? <Missing why={r.close} /> : <span className="num">{fmtPrice(r.close)}</span>) },
    { key: 'day', header: 'Day', info: 'Latest completed close against the previous close.', sort: (r) => (isNa(r.dayChange) ? null : r.dayChange), cell: (r) => <Pct v={r.dayChange} glyph /> },
    {
      key: 'sma', header: '200 day', info: 'Close divided by the average of the last 200 completed closes, minus 1.', sort: (r) => (isNa(r.sma200) ? null : r.sma200.distance),
      cell: (r) => (isNa(r.sma200) ? <Missing why={r.sma200} /> : <Link to={researchPath(r.symbol, 'trend')} style={{ color: 'inherit' }}><Pct v={r.sma200.distance} /> <span className="faint small">{r.sma200.side}</span></Link>),
    },
    {
      key: 'dd', header: 'From closing high', info: 'Latest close against the highest close of the last 252 sessions.', sort: (r) => (isNa(r.drawdown) ? null : r.drawdown.value),
      cell: (r) => (isNa(r.drawdown) ? <Missing why={r.drawdown} /> : <Link to={researchPath(r.symbol, 'selloffs')} style={{ color: 'inherit' }} title={`High ${fmtPrice(r.drawdown.peakClose)} on ${fmtDate(r.drawdown.peakDate)}`}><Pct v={r.drawdown.value} /></Link>),
    },
    {
      key: 'earn', header: 'Next earnings', sort: (r) => (isNa(r.nextEarnings) ? null : r.nextEarnings.date),
      cell: (r) => (isNa(r.nextEarnings) ? <Missing why={r.nextEarnings} /> : <Link to={researchPath(r.symbol, 'earnings')} style={{ color: 'inherit' }}>{fmtDateShort(r.nextEarnings.date)} <span className="faint small">{r.nextEarnings.status === 'confirmed' ? 'confirmed' : 'estimated'}</span></Link>),
    },
    {
      key: 'pos', header: 'Position', info: 'Shares times the latest completed close, for held names only.', sort: (r) => (isNa(r.positionValue) ? null : r.positionValue),
      cell: (r) => (!r.held ? <span className="faint">Watch only</span> : isNa(r.positionValue) ? <Missing why={r.positionValue} /> : <span className="num">{fmtDollars(r.positionValue)}</span>),
    },
    {
      key: 'x', header: <span className="sr-only">Remove</span>,
      cell: (r) => (ws.watchlist.includes(r.symbol) ? <button type="button" className="btn ghost small" aria-label={`Remove ${r.symbol} from the watchlist`} onClick={(e) => { e.stopPropagation(); removeWatch(r.symbol); }}>Remove</button> : null),
    },
  ];

  const s = summary?.s;
  const alerts = s ? s.topFlags : [];
  const open = alerts.filter((a) => !acked.has(a.key));
  const ackedList = alerts.filter((a) => acked.has(a.key));
  const withheld = s ? s.rows.flatMap((r) => r.withheld.map((w) => ({ symbol: r.symbol, ...w }))) : [];
  const closeDates = s ? [...new Set(s.rows.map((r) => (isNa(r.closeDate) ? null : r.closeDate)).filter((d): d is string => d !== null))] : [];
  const decliners = s ? s.rows.filter((r) => !isNa(r.dayChange) && r.dayChange < 0).sort((a, b) => (a.dayChange as number) - (b.dayChange as number)).slice(0, 5) : [];
  const deepest = s ? s.rows.filter((r) => !isNa(r.drawdown) && r.drawdown.value < 0).sort((a, b) => (isNa(a.drawdown) ? 0 : a.drawdown.value) - (isNa(b.drawdown) ? 0 : b.drawdown.value)).slice(0, 5) : [];
  const sorted = s ? sortRows(s.rows, cols, sort) : [];

  const renderAlert = (a: Alert, isAcked: boolean) => {
    const t = ALERT_TARGET[a.rule];
    return (
      <li key={a.key} className="pf-alert" data-acked={isAcked}>
        <div className="pf-alert-title">
          <Chip tone={SEV_TONE[a.severity]}>{RULE_LABEL[a.rule]}</Chip>
          <Link className="pf-sym" to={researchPath(a.symbol)}>{a.symbol}</Link>
          <span>{a.title}</span>
          <span className="faint small">{fmtDate(a.date)}</span>
        </div>
        <div className="pf-alert-detail">{a.detail.replace(/\d{4}-\d{2}-\d{2}/g, (d) => fmtDate(d))} <Link to={researchPath(a.symbol, t.section, t.params)}>{t.label}</Link></div>
        <div className="pf-alert-actions">
          {isAcked ? <span className="faint small">Acknowledged</span> : <button type="button" className="btn small" onClick={() => acknowledge(a)} aria-label={`Acknowledge ${a.symbol} ${a.title}`}>Acknowledge</button>}
        </div>
      </li>
    );
  };

  return (
    <div className="stack">
      <div className="pf-head">
        <h1>Today</h1>
        {healthLine}
      </div>
      {conflict && <StateNote tone="warn" title="Another tab changed your workspace.">The latest copy is loaded. Repeat the last action.</StateNote>}
      {bundles.status === 'error' && (
        <StateNote tone="error" title="The watchlist could not be loaded." action={<button type="button" className="btn small" onClick={() => invalidate()}>Retry</button>}>{bundles.error.message}</StateNote>
      )}
      {(!ready || bundles.status === 'loading') && symbols.length > 0 && <Skeleton h={260} />}
      {ready && symbols.length === 0 && <StateNote>Your watchlist is empty. Add a ticker below to see its close, trend, drawdown and next earnings here.</StateNote>}
      {s && (
        <div className="pf-today">
          <div className="stack">
            <Card
              title="Needs attention"
              info={`Rules on completed sessions: earnings within ${ws.settings.alertRules.earningsDays} calendar days, a session down ${fmtPct(ws.settings.alertRules.downSession, 0, false)} or more, ${fmtPct(ws.settings.alertRules.drawdown, 0, false)} or more below the 252 session closing high, a new close below the 200 day average.`}
              actions={ackedList.length > 0 ? <button type="button" className="btn ghost small" aria-pressed={showAcked} onClick={() => setShowAcked((v) => !v)}>{showAcked ? 'Hide' : 'Show'} acknowledged ({ackedList.length})</button> : undefined}
            >
              {open.length === 0 && <p className="muted">No open flags on {s.rows.length} names{ackedList.length ? `. ${ackedList.length} acknowledged` : ''}.</p>}
              <ul className="pf-alerts">
                {(allOpen ? open : open.slice(0, OPEN_LIMIT)).map((a) => renderAlert(a, false))}
                {showAcked && ackedList.map((a) => renderAlert(a, true))}
              </ul>
              {open.length > OPEN_LIMIT && (
                <button type="button" className="btn ghost small" style={{ marginTop: 6 }} aria-expanded={allOpen} onClick={() => setAllOpen((v) => !v)}>
                  {allOpen ? 'Show the top flags only' : `Show ${open.length - OPEN_LIMIT} more`}
                </button>
              )}
              {withheld.length > 0 && (
                <Disclosure summary={`${withheld.length} rule checks could not run`}>
                  <ul className="muted small" style={{ margin: 0, paddingLeft: 18 }}>
                    {withheld.map((w, i) => <li key={i}>{w.symbol}, {RULE_LABEL[w.rule]}. {reasonDetail(w.reason)}</li>)}
                  </ul>
                </Disclosure>
              )}
            </Card>
            <Card
              title="Watchlist and positions"
              sub={
                <>
                  {closeDates.length === 1 ? `Closes on ${fmtDate(closeDates[0])}. ` : closeDates.length > 1 ? `Close dates differ: ${closeDates.map((d) => fmtDate(d)).join(', ')}. ` : ''}
                  {s.totals.heldCount > 0
                    ? <>Positions {fmtDollars(s.totals.positionDollars)} across {s.totals.markedCount} of {s.totals.heldCount} held.{s.totals.unmarked.length > 0 && <strong style={{ color: 'var(--warn)' }}> Not marked and not in the total: {s.totals.unmarked.join(', ')}.</strong>} </>
                    : <>No positions. <Link to="/portfolio">Add positions</Link>. </>}
                  {s.totals.watchOnlyCount} watch only.
                </>
              }
            >
              <div className="pf-stack-sm">
                {narrow ? (
                  <ul className="pf-list">
                    {sorted.map((r) => (
                      <li key={r.symbol}>
                        <div className="pf-row-top">
                          <Link className="pf-sym" to={researchPath(r.symbol)}>{r.symbol}</Link>
                          <span className="grow faint small">{r.held ? (isNa(r.positionValue) ? `Held, ${reasonText(r.positionValue)}` : `Held, ${fmtDollars(r.positionValue)}`) : 'Watch only'}</span>
                          <span className="num">{isNa(r.close) ? reasonText(r.close) : fmtPrice(r.close)}</span>
                          <Pct v={r.dayChange} glyph />
                        </div>
                        <div className="pf-row-sub">
                          <span>200 day {isNa(r.sma200) ? reasonText(r.sma200) : <Pct v={r.sma200.distance} digits={1} />}</span>
                          <span>From high {isNa(r.drawdown) ? reasonText(r.drawdown) : <Pct v={r.drawdown.value} digits={1} />}</span>
                          <span>Earnings {isNa(r.nextEarnings) ? reasonText(r.nextEarnings) : `${fmtDateShort(r.nextEarnings.date)}, ${r.nextEarnings.status}`}</span>
                          {editing && ws.watchlist.includes(r.symbol) && <button type="button" className="btn ghost small" style={{ marginLeft: 'auto' }} aria-label={`Remove ${r.symbol} from the watchlist`} onClick={() => removeWatch(r.symbol)}>Remove</button>}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <DataTable rows={sorted} cols={cols} sort={sort} onSort={setSort} rowKey={(r) => r.symbol} caption="Watchlist and positions" />
                )}
                {summary.unknown.length > 0 && <StateNote tone="warn">Not in the loaded universe: {summary.unknown.join(', ')}.</StateNote>}
                <div className="row">
                  <div style={{ flex: '1 1 200px', maxWidth: 320 }}>
                    <SymbolPicker instruments={instruments} label="Add a ticker to the watchlist" placeholder="Add to watchlist" onPick={addWatch} />
                  </div>
                  {narrow && <button type="button" className="btn small" aria-pressed={editing} onClick={() => setEditing((v) => !v)}>{editing ? 'Done' : 'Edit list'}</button>}
                </div>
              </div>
            </Card>
          </div>
          <div className="stack">
            <Card title="Week ahead" sub={`Known reports ${fmtDateShort(s.weekAhead.from)} through ${fmtDate(s.weekAhead.to)}.`}>
              {s.weekAhead.items.length === 0 ? (
                <p className="muted">No held or watched name has a known report in this window.</p>
              ) : (
                <ul className="pf-list">
                  {s.weekAhead.items.map((i) => (
                    <li key={i.symbol}>
                      <div className="pf-row-top">
                        <Link className="pf-sym" to={researchPath(i.symbol, 'earnings')}>{i.symbol}</Link>
                        <span className="grow">{fmtDateShort(i.date)}, {TIME_LABEL[i.time].toLowerCase()}</span>
                        <Chip tone={i.status === 'confirmed' ? 'up' : 'warn'}>{i.status === 'confirmed' ? 'Confirmed' : 'Estimated'}</Chip>
                      </div>
                      {i.held && <div className="pf-row-sub"><span>Exposure {isNa(i.exposure) ? reasonText(i.exposure) : fmtDollars(i.exposure)}</span><span>Implied move unavailable, no dated option quote</span></div>}
                    </li>
                  ))}
                </ul>
              )}
              {(s.weekAhead.exposureCovered > 0 || s.weekAhead.exposureMissing.length > 0) && (
                <p className="small muted" style={{ marginTop: 8 }}>
                  Held exposure reporting: {fmtDollars(s.weekAhead.knownExposure)} across {s.weekAhead.exposureCovered} marked.
                  {s.weekAhead.exposureMissing.length > 0 && ` Exposure unknown for ${s.weekAhead.exposureMissing.join(', ')}.`}
                </p>
              )}
              {s.weekAhead.dateUnknown.length > 0 && <p className="small" style={{ marginTop: 8, color: 'var(--warn)' }}>Report date unknown for {s.weekAhead.dateUnknown.join(', ')}. They may report in this window.</p>}
            </Card>
            <Card title="Largest declines" sub="Latest session, then distance below the 252 session closing high.">
              {decliners.length === 0 && deepest.length === 0 && <p className="muted">No name closed lower or sits below its closing high.</p>}
              {decliners.length > 0 && (
                <>
                  <h3 style={{ marginBottom: 6 }}>Latest session</h3>
                  <MiniBars rows={decliners} value={(r) => r.dayChange as number} caption="Largest declines in the latest session" />
                </>
              )}
              {deepest.length > 0 && (
                <>
                  <h3 style={{ margin: '12px 0 6px' }}>Below closing high</h3>
                  <MiniBars rows={deepest} value={(r) => (isNa(r.drawdown) ? 0 : r.drawdown.value)} caption="Deepest drawdowns from the closing high" />
                </>
              )}
            </Card>
          </div>
        </div>
      )}
      {s && <span className="sr-only">{fmtNum(s.rows.length, 0)} names loaded</span>}
    </div>
  );
}
