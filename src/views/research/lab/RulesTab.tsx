/**
 * Rule tests. Lists what price did after each dated signal of a declared rule, next to the same
 * period every session baseline. Conditional price outcomes, not trading performance. The verdict
 * rests on the holdout period only.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RequireBars, useResearch } from '../../../app/research';
import { researchPath } from '../../../app/routes';
import { useBars } from '../../../data/client';
import { useEngine } from '../../../data/engine';
import { indexOnOrBefore } from '../../../engine/core/series';
import { isNa, type Bar, type Maybe } from '../../../engine/core/types';
import { LAB_DEFAULTS, STRATEGY_DEFAULTS, type AuditRow, type AuditSummary, type Condition, type LabAnalogResult, type RuleAudit } from '../../../engine/strategy';
import { BarChart } from '../../../ui/charts';
import { Card, Chip, DataTable, Disclosure, Freq, Info, Pct, Skeleton, sortRows, StateNote, type Column, type SortState } from '../../../ui/components';
import { fmtDate, fmtInt, fmtPct, fmtPp, fmtPrice, reasonDetail } from '../../../ui/format';
import { describeConditions, presetOf, PRESETS, settingsFromParams, settingsKey, settingsToPatch, toRule, warmupOf, type RuleSettings } from './ruleParams';
import { PAGE_SIZE, Pager, useParamPatch } from './shared';

const SMA_CHOICES = [5, 10, 20, 50, 100, 200];
const pctIn = (x: number | undefined): string => (x === undefined ? '' : String(Math.round(x * 10000) / 100));
const pctOut = (s: string): number | undefined => (s.trim() === '' || !Number.isFinite(Number(s)) ? undefined : Number(s) / 100);

function ConditionEditor({ c, onChange, onRemove, canRemove }: { c: Condition; onChange: (c: Condition) => void; onRemove: () => void; canRemove: boolean }) {
  const setKind = (k: Condition['kind']) => {
    if (k === c.kind) return;
    onChange(k === 'drawdown' ? { kind: 'drawdown', atLeast: 0.2 } : k === 'sma' ? { kind: 'sma', n: 200, side: 'below' } : k === 'move' ? { kind: 'move', sessions: 5, atLeast: 0.05 } : { kind: 'relative', sessions: 20, atMost: -0.1 });
  };
  const bounds = (cc: Extract<Condition, { kind: 'move' | 'relative' }>, unit: string) => {
    const upd = (key: 'atLeast' | 'atMost', v: string) => {
      const next = { ...cc };
      const x = pctOut(v);
      if (x === undefined) delete next[key];
      else next[key] = x;
      onChange(next);
    };
    return (
      <>
        <label className="field">
          Sessions
          <input className="input" type="number" min={1} max={250} value={cc.sessions} onChange={(e) => onChange({ ...cc, sessions: Math.max(1, Math.round(Number(e.target.value) || 1)) })} />
        </label>
        <label className="field">
          At least, {unit}
          <input className="input" type="number" step="0.5" placeholder="none" value={pctIn(cc.atLeast)} onChange={(e) => upd('atLeast', e.target.value)} />
        </label>
        <label className="field">
          At most, {unit}
          <input className="input" type="number" step="0.5" placeholder="none" value={pctIn(cc.atMost)} onChange={(e) => upd('atMost', e.target.value)} />
        </label>
      </>
    );
  };
  return (
    <div className="lab-cond">
      <label className="field">
        Condition
        <select className="select" value={c.kind} onChange={(e) => setKind(e.target.value as Condition['kind'])}>
          <option value="drawdown">Drawdown from closing peak</option>
          <option value="sma">Side of a moving average</option>
          <option value="move">Move over N sessions</option>
          <option value="relative">Move versus benchmark</option>
        </select>
      </label>
      {c.kind === 'drawdown' && (
        <>
          <label className="field">
            At least, %
            <input className="input" type="number" min={0.5} step="0.5" value={pctIn(c.atLeast)} onChange={(e) => onChange({ ...c, atLeast: Math.max(0.005, pctOut(e.target.value) ?? c.atLeast) })} />
          </label>
          <label className="field">
            Peak lookback, sessions
            <input
              className="input"
              type="number"
              min={2}
              placeholder="running peak"
              value={c.lookback ?? ''}
              onChange={(e) => {
                const v = Math.round(Number(e.target.value));
                onChange(e.target.value === '' || !(v >= 2) ? { kind: 'drawdown', atLeast: c.atLeast } : { ...c, lookback: v });
              }}
            />
          </label>
        </>
      )}
      {c.kind === 'sma' && (
        <>
          <label className="field">
            Average
            <select className="select" value={c.n} onChange={(e) => onChange({ ...c, n: Number(e.target.value) })}>
              {SMA_CHOICES.map((n) => (
                <option key={n} value={n}>{n} session</option>
              ))}
            </select>
          </label>
          <label className="field">
            Close is
            <select className="select" value={c.side} onChange={(e) => onChange({ ...c, side: e.target.value as 'above' | 'below' })}>
              <option value="below">Below</option>
              <option value="above">Above</option>
            </select>
          </label>
        </>
      )}
      {c.kind === 'move' && bounds(c, '%')}
      {c.kind === 'relative' && bounds(c, 'pp')}
      {canRemove && (
        <button type="button" className="btn small ghost" onClick={onRemove}>
          Remove
        </button>
      )}
    </div>
  );
}

function RuleBuilder({ initial, benchmarks, onApply }: { initial: RuleSettings; benchmarks: string[]; onApply: (s: RuleSettings) => void }) {
  const [d, setD] = useState<RuleSettings>(initial);
  const invalid = d.conditions.some((c) => (c.kind === 'move' || c.kind === 'relative') && c.atLeast === undefined && c.atMost === undefined);
  const hasRel = d.conditions.some((c) => c.kind === 'relative');
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div>
        {d.conditions.map((c, i) => (
          <ConditionEditor
            key={i}
            c={c}
            canRemove={d.conditions.length > 1}
            onChange={(n) => setD({ ...d, conditions: d.conditions.map((x, j) => (j === i ? n : x)) })}
            onRemove={() => setD({ ...d, conditions: d.conditions.filter((_, j) => j !== i) })}
          />
        ))}
      </div>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        {d.conditions.length < 4 && (
          <button type="button" className="btn small" onClick={() => setD({ ...d, conditions: [...d.conditions, { kind: 'sma', n: 50, side: 'below' }] })}>
            Add condition
          </button>
        )}
        <label className="field">
          Signal when
          <select className="select" value={d.trigger} onChange={(e) => setD({ ...d, trigger: e.target.value as RuleSettings['trigger'] })}>
            <option value="first-session">First session all hold</option>
            <option value="every-session">Every session all hold</option>
          </select>
        </label>
        <label className="field">
          Entry
          <select className="select" value={d.entry} onChange={(e) => setD({ ...d, entry: e.target.value as RuleSettings['entry'] })}>
            <option value="signal-close">Signal close</option>
            <option value="next-open">Next session open</option>
          </select>
        </label>
        <label className="field">
          Horizon, sessions
          <input className="input lab-num" type="number" min={1} max={250} value={d.horizon} onChange={(e) => setD({ ...d, horizon: Math.min(250, Math.max(1, Math.round(Number(e.target.value) || 1))) })} />
        </label>
        <label className="field">
          Cost per side, bps
          <input className="input lab-num" type="number" min={0} max={200} step="1" value={d.costBps} onChange={(e) => setD({ ...d, costBps: Math.min(200, Math.max(0, Number(e.target.value) || 0)) })} />
        </label>
        <label className="field">
          Failure lookback, sessions
          <input className="input lab-num" type="number" min={0} max={60} placeholder="none" value={d.failLookback || ''} onChange={(e) => setD({ ...d, failLookback: Math.min(60, Math.max(0, Math.round(Number(e.target.value) || 0))) })} />
        </label>
        {hasRel && (
          <label className="field">
            Benchmark
            <select className="select" value={d.benchmark} onChange={(e) => setD({ ...d, benchmark: e.target.value })}>
              {benchmarks.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p className="muted small">
        Failure means a later close inside the horizon below the lowest close of the lookback sessions ending at the signal. Cost is charged on entry and again on exit as a fraction of the traded price.
      </p>
      {invalid && <StateNote tone="warn">A move condition needs at least one bound.</StateNote>}
      <div className="row">
        <button type="button" className="btn primary" disabled={invalid} onClick={() => onApply(d)}>
          Run rule
        </button>
      </div>
    </div>
  );
}

const SEG_TITLE: Record<AuditSummary['segment'], string> = { holdout: 'Holdout period', selection: 'Selection period', all: 'Both periods' };

function SegmentPanel({ s, hasFailure }: { s: AuditSummary; hasFailure: boolean }) {
  const b = s.baseline;
  return (
    <div className="lab-seg" data-judged={s.segment === 'holdout'}>
      <h3>
        {SEG_TITLE[s.segment]}
        {s.segment === 'holdout' && <Chip tone="gold">Judged here</Chip>}
      </h3>
      <div className="muted small">{s.from && s.to ? `${fmtDate(s.from)} to ${fmtDate(s.to)}` : 'No sessions in this period'}</div>
      <dl className="kv">
        <dt>Signals kept</dt>
        <dd className="num">{fmtInt(s.n)}</dd>
        {s.n === 0 ? (
          <>
        <dt>Every session</dt>
        <dd className="num">
          {b.allWinRate === null ? 'n/a' : fmtPct(b.allWinRate, 0, false)} <span className="faint small">of {fmtInt(b.allSessions)} overlapping windows</span>
        </dd>
            <dt>Every session median net</dt>
            <dd className="num">{b.allMedianNet === null ? 'n/a' : fmtPct(b.allMedianNet)}</dd>
          </>
        ) : (
          <>
        <dt>Higher net close</dt>
        <dd><Freq p={s.win} /></dd>
        <dt>Every session</dt>
        <dd className="num">
          {b.allWinRate === null ? 'n/a' : fmtPct(b.allWinRate, 0, false)} <span className="faint small">of {fmtInt(b.allSessions)} overlapping windows</span>
        </dd>
        <dt>Difference</dt>
        <dd>{isNa(s.winRateDiffPp) ? <span className="faint">n/a</span> : <span className="num">{fmtPp(s.winRateDiffPp, 1)}</span>}</dd>
        <dt>Median net</dt>
        <dd>
          <Pct v={s.net?.median} /> <span className="faint small">every session {b.allMedianNet === null ? 'n/a' : fmtPct(b.allMedianNet)}</span>
        </dd>
        <dt>Net p10 to p90</dt>
        <dd className="num">{s.net ? `${fmtPct(s.net.p10, 1)} to ${fmtPct(s.net.p90, 1)}` : 'n/a'}</dd>
        <dt>Worst and best net</dt>
        <dd className="num">{s.net ? `${fmtPct(s.net.min, 1)}, ${fmtPct(s.net.max, 1)}` : 'n/a'}</dd>
        <dt>Median gross</dt>
        <dd><Pct v={s.gross?.median} /></dd>
        <dt>Worst close in hold</dt>
        <dd className="num">{s.adverse ? `median ${fmtPct(s.adverse.median, 1)}, p10 ${fmtPct(s.adverse.p10, 1)}` : 'n/a'}</dd>
          </>
        )}
        {hasFailure && s.n > 0 && (
          <>
            <dt>Failed</dt>
            <dd><Freq p={s.failure} /></dd>
          </>
        )}
      </dl>
    </div>
  );
}

const STATUS_TEXT: Record<string, string> = { valid: 'Beat its baseline in the holdout', 'not-reliable': 'Did not clearly beat its baseline', 'insufficient-evidence': 'Too few holdout signals to judge' };

function AnalogCard({ bars, signals, k }: { bars: Bar[]; signals: number[]; k: string }) {
  const lab = useEngine<LabAnalogResult>(signals.length ? k : null, 'strategy', 'labAnalogOutcomes', () => [bars, signals]);
  return (
    <Card
      title="What happened next after every signal"
      info={`Close to close outcomes ${LAB_DEFAULTS.horizons.join(', ')} sessions after each signal, thinned so windows do not overlap. A frequency needs ${LAB_DEFAULTS.minSupport} matured cases. Below that only the counts and the distribution show.`}
      sub="Signal close to later close, before costs. Historical description, not a forecast."
    >
      {signals.length === 0 && <StateNote>The rule has no signals in this history.</StateNote>}
      {lab.status === 'loading' && signals.length > 0 && <Skeleton h={120} />}
      {lab.status === 'error' && <StateNote tone="error" title="The study could not run." action={<button type="button" className="btn small" onClick={lab.reload}>Retry</button>}>{lab.error.message}</StateNote>}
      {lab.status === 'ready' && (
        <div className="table-wrap lab-wrap" tabIndex={0} role="region" aria-label="Outcomes by horizon">
          <table className="data">
            <thead>
              <tr>
                <th className="l" scope="col">Sessions later</th>
                <th scope="col">Cases</th>
                <th className="l" scope="col">Higher close</th>
                <th scope="col">Median</th>
                <th scope="col">p10 to p90</th>
                <th scope="col">Median worst close</th>
                <th className="l" scope="col">Left out</th>
              </tr>
            </thead>
            <tbody>
              {lab.data.horizons.map((h) => (
                <tr key={h.horizon}>
                  <td className="l">{h.horizon}</td>
                  <td>{fmtInt(h.support)}</td>
                  <td className="l">
                    {isNa(h.frequency) ? (
                      <span className="muted">Withheld. {h.support} of {lab.data.minSupport} cases needed</span>
                    ) : (
                      <Freq p={h.frequency} />
                    )}
                  </td>
                  <td><Pct v={h.summary.returns?.median} /></td>
                  <td className="num">{h.summary.returns ? `${fmtPct(h.summary.returns.p10, 1)} to ${fmtPct(h.summary.returns.p90, 1)}` : 'n/a'}</td>
                  <td><Pct v={h.summary.adverse?.median} digits={1} /></td>
                  <td className="muted lab-left">{h.overlapDropped} overlap, {h.notMatured} not matured</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function RulesTab() {
  return (
    <RequireBars min={30}>
      <Rules />
    </RequireBars>
  );
}

function Rules() {
  const r = useResearch();
  const [sp, patch] = useParamPatch();
  const spKey = sp.toString();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const settings = useMemo(() => settingsFromParams(sp), [spKey]);
  const preset = presetOf(settings);
  const needsBench = settings.conditions.some((c) => c.kind === 'relative');
  const bench = useBars(needsBench ? settings.benchmark : null, r.asOf ?? undefined);
  const benchmarks = useMemo(() => [...new Set(['SPY', 'QQQ', r.instrument.sectorEtf, 'SMH'].filter((x): x is string => !!x && x !== r.symbol))], [r.instrument.sectorEtf, r.symbol]);

  // Output starts at the history window. Earlier bars are kept only as indicator warm-up.
  const study = useMemo(() => {
    const ws = r.windowStart;
    const at = ws ? Math.max(0, indexOnOrBefore(r.bars, ws) + 1) : 0;
    const start = Math.max(0, at - warmupOf(settings.conditions));
    return { bars: start === 0 ? r.bars : r.bars.slice(start), peakFrom: r.bars[start]?.date ?? null };
  }, [r.bars, r.windowStart, settings.conditions]);

  const benchBars: Maybe<Bar[]> | null = needsBench ? (bench.status === 'ready' ? bench.data : null) : null;
  const benchReady = !needsBench || (benchBars !== null && !isNa(benchBars));
  const key = `${r.symbol}|${r.asOf}|${r.history}|${settingsKey(settings)}`;
  const audit = useEngine<Maybe<RuleAudit>>(benchReady ? key : null, 'strategy', 'auditRule', () => [
    study.bars,
    toRule(settings),
    needsBench && benchBars && !isNa(benchBars) ? { costBps: settings.costBps, benchmark: benchBars } : { costBps: settings.costBps },
  ]);

  const [sort, setSort] = useState<SortState | null>({ key: 'signal', dir: 'desc' });
  const page = Math.max(0, Number(sp.get('page') ?? 0) || 0);
  const a = audit.status === 'ready' && !isNa(audit.data) ? audit.data : null;
  const hasFailure = settings.failLookback > 0;

  const cols = useMemo<Column<AuditRow>[]>(() => {
    const c: Column<AuditRow>[] = [
      {
        key: 'signal',
        header: 'Signal',
        sticky: true,
        sort: (x) => x.signalDate,
        cell: (x) => (
          <Link to={researchPath(r.symbol, 'overview', { asof: x.signalDate })} title="Open this date as a historical cut">
            {fmtDate(x.signalDate)}
          </Link>
        ),
      },
      { key: 'seg', header: 'Period', align: 'l', sort: (x) => x.segment, cell: (x) => (x.segment === 'holdout' ? 'Holdout' : 'Selection') },
      { key: 'entry', header: 'Entry', sort: (x) => x.entryDate, cell: (x) => <span className="num">{fmtDate(x.entryDate)} at {fmtPrice(x.entryPrice)}</span> },
      { key: 'exit', header: 'Exit', sort: (x) => x.exitDate, cell: (x) => <span className="num">{fmtDate(x.exitDate)} at {fmtPrice(x.exitPrice)}</span> },
      { key: 'gross', header: 'Gross', sort: (x) => x.gross, cell: (x) => <Pct v={x.gross} /> },
      { key: 'net', header: 'Net', info: 'After the per side cost on entry and on exit.', sort: (x) => x.net, cell: (x) => <Pct v={x.net} /> },
      { key: 'worst', header: 'Worst close', info: 'Lowest close inside the hold relative to the entry price.', sort: (x) => x.minCloseRet, cell: (x) => <Pct v={x.minCloseRet} digits={1} /> },
    ];
    if (hasFailure) c.push({ key: 'fail', header: 'Failed', align: 'l', sort: (x) => (x.failed === null ? null : x.failed ? 1 : 0), cell: (x) => (x.failed === null ? <span className="faint">n/a</span> : x.failed ? `Yes, session ${x.failOffset}` : 'No') });
    return c;
  }, [r.symbol, hasFailure]);

  const sorted = useMemo(() => (a ? sortRows(a.rows, cols, sort) : []), [a, cols, sort]);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pg = Math.min(page, pages - 1);
  const firstHold = a?.rows.findIndex((x) => x.segment === 'holdout') ?? -1;
  const sentences = describeConditions(settings, settings.conditions.some((c) => c.kind === 'drawdown' && !c.lookback) && study.bars !== r.bars ? study.peakFrom : null);

  return (
    <div className="stack">
      <Card
        title="Rule under test"
        info="A rule is a set of conditions on past closes. The table below lists what price did after each dated signal. These are conditional price outcomes, not trading performance."
        actions={
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <span className="sr-only">Preset</span>
            <select
              className="select"
              aria-label="Preset rule"
              value={preset?.id ?? 'custom'}
              style={{ maxWidth: 'min(100%, 340px)' }}
              onChange={(e) => {
                const p = PRESETS.find((x) => x.id === e.target.value);
                if (p) patch(settingsToPatch({ ...p.settings, costBps: settings.costBps }), false);
              }}
            >
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
              {!preset && <option value="custom">Custom rule</option>}
            </select>
          </label>
        }
      >
        <ul className="lab-rule">
          {sentences.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
        <div className="row" style={{ marginTop: 8, gap: 6 }}>
          <Chip>{settings.trigger === 'first-session' ? 'Signal on the first session all hold' : 'Signal on every session all hold'}</Chip>
          <Chip>Enter at {settings.entry === 'signal-close' ? 'the signal close' : 'the next session open'}</Chip>
          <Chip>Exit at the close {settings.horizon} sessions later</Chip>
          <Chip tone={settings.costBps === STRATEGY_DEFAULTS.costBps ? undefined : 'accent'}>{settings.costBps} bps per side</Chip>
          {hasFailure && <Chip>Failure: close below the {settings.failLookback} session low</Chip>}
        </div>
        <Disclosure summary="Edit rule">
          <RuleBuilder key={settingsKey(settings)} initial={settings} benchmarks={benchmarks.includes(settings.benchmark) ? benchmarks : [settings.benchmark, ...benchmarks]} onApply={(s) => patch(settingsToPatch(s), false)} />
        </Disclosure>
      </Card>

      {needsBench && bench.status === 'ready' && isNa(bench.data) && (
        <StateNote tone="warn" title={`${settings.benchmark} history is unavailable.`}>
          {reasonDetail(bench.data)} The relative condition cannot be evaluated.
        </StateNote>
      )}
      {(audit.status === 'loading' || (needsBench && bench.status === 'loading')) && benchReady && <Skeleton h={260} />}
      {audit.status === 'error' && (
        <StateNote tone="error" title="The rule test could not run." action={<button type="button" className="btn small" onClick={audit.reload}>Retry</button>}>
          {audit.error.message}
        </StateNote>
      )}
      {audit.status === 'ready' && isNa(audit.data) && <StateNote tone="warn" title="This rule cannot be tested here.">{reasonDetail(audit.data)}</StateNote>}

      {a && (
        <>
          <Card
            title="Outcomes after signals, next to every session"
            info="The date range is split in time. A rule chosen on the selection period is judged only on the later holdout period. Signals whose hold crosses the split are left out."
            sub={`Net of ${a.costNote.charAt(0).toLowerCase()}${a.costNote.slice(1)} Entry and exit as stated above. Holdout starts ${fmtDate(a.splitDate)}.`}
          >
            <StateNote tone={a.verdict.status === 'valid' ? 'info' : 'warn'} title={`${STATUS_TEXT[a.verdict.status] ?? 'Not judged'}.`}>
              {a.verdict.statement}
            </StateNote>
            <div className="lab-seg-grid" style={{ marginTop: 12 }}>
              <SegmentPanel s={a.holdout} hasFailure={hasFailure} />
              <SegmentPanel s={a.selection} hasFailure={hasFailure} />
              <SegmentPanel s={a.all} hasFailure={hasFailure} />
            </div>
            <p className="muted small" style={{ marginTop: 10 }}>
              Signal accounting: {fmtInt(a.scan.signals.length)} signals found on {fmtInt(a.scan.evaluable)} evaluable sessions. Left out: {a.notMatured} not matured, {a.overlapDropped} overlapping an earlier hold, {a.embargoed} crossing the split
              {a.scan.priorUnknownSkipped ? `, ${a.scan.priorUnknownSkipped} with an unknown prior session` : ''}. Kept: {fmtInt(a.rows.length)}. {fmtInt(a.scan.unevaluable)} sessions could not be evaluated (warm-up or no benchmark close).
              The every session interval uses windows spaced one horizon apart: holdout <Freq p={a.holdout.baseline.spacedWin} />.
            </p>
          </Card>

          <Card title="Net outcome of each kept signal" sub={`Oldest to newest. H marks the first holdout signal. ${a.rows.length} signals.`}>
            {a.rows.length === 0 ? (
              <StateNote>No signal has a matured, non overlapping hold in this history. A longer history window or a looser rule would produce some.</StateNote>
            ) : (
              <BarChart
                ariaLabel={`Net outcome after each of ${a.rows.length} signals. Median ${a.all.net ? fmtPct(a.all.net.median) : 'n/a'}`}
                yFormat={(y) => fmtPct(y, 0)}
                height={190}
                bars={a.rows.map((x, i) => ({
                  key: x.signalDate,
                  label: fmtDate(x.signalDate),
                  value: x.net,
                  detail: `${x.segment === 'holdout' ? 'Holdout' : 'Selection'}. Exit ${fmtDate(x.exitDate)}`,
                  flag: i === firstHold ? 'H' : undefined,
                }))}
              />
            )}
          </Card>

          <Card title="Signals" info="Every figure above traces to these rows. A date opens that session as a historical cut.">
            <DataTable caption="Kept signals with entry, exit and outcome" rows={sorted.slice(pg * PAGE_SIZE, (pg + 1) * PAGE_SIZE)} cols={cols} sort={sort} onSort={setSort} rowKey={(x) => x.signalDate} empty="No kept signals." />
            <Pager page={pg} pages={pages} total={sorted.length} noun="signals" onPage={(p) => patch({ page: p ? String(p) : null })} />
          </Card>

          <AnalogCard bars={study.bars} signals={a.scan.signals} k={key} />
          <p className="muted small">
            {a.note} <Info text="No exposure, compounding or account size is specified here, so no trading performance is reported." label="About trading performance" />
          </p>
        </>
      )}
    </div>
  );
}
