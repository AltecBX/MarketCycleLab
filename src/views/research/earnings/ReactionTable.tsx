/** One row per past report, with every measure and the reason for anything missing. */
import { useMemo, useState } from 'react';
import { isNa, numOrNull, type Maybe } from '../../../engine/core/types';
import { DRIFT_WINDOWS, RUNUP_WINDOWS, TIME_LABEL, type EarningsStudy, type MeasureSummary, type ReactionRow } from '../../../engine/earnings';
import { DataTable, Freq, Missing, Pct, Sheet, sortRows, type Column, type SortState } from '../../../ui/components';
import { fmtDate, fmtNum, fmtPct, fmtPrice, reasonDetail } from '../../../ui/format';
import { fmtDay, useIsNarrow } from './util';

const PAGE = 10;

const reportCell = (r: ReactionRow, onPick: (r: ReactionRow) => void) => (
  <button type="button" className="er-row-btn" onClick={(e) => { e.stopPropagation(); onPick(r); }} aria-label={`Open ${r.label}`}>
    <span>{r.event.fiscalPeriod ?? 'Report'}</span>
    <span className="faint small">
      {fmtDate(r.event.date)}
      {r.path.length > 0 && !r.pathComplete ? ', partial path' : ''}
    </span>
  </button>
);

export function ReactionTable({ study, selectedId, onSelect }: { study: EarningsStudy; selectedId: string | null; onSelect: (id: string) => void }) {
  const narrow = useIsNarrow();
  const [sort, setSort] = useState<SortState>({ key: 'report', dir: 'desc' });
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<ReactionRow | null>(null);
  const pick = (r: ReactionRow) => {
    onSelect(r.id);
    setOpen(r);
  };
  const cols = useMemo<Column<ReactionRow>[]>(() => {
    const pct = (key: string, header: string, get: (r: ReactionRow) => Maybe<number>, info?: string): Column<ReactionRow> => ({
      key, header, info, sort: (r) => numOrNull(get(r)), cell: (r) => <Pct v={get(r)} digits={1} />,
    });
    const report: Column<ReactionRow> = { key: 'report', header: 'Report', sticky: true, sort: (r) => r.event.date, cell: (r) => reportCell(r, pick) };
    const reaction = pct('reaction', 'First close', (r) => r.reaction, 'First reacting close divided by the last close before the report, minus 1.');
    if (narrow) return [report, reaction, pct('d20', 'Drift 20', (r) => r.drift[20]!)];
    return [
      report,
      { key: 'time', header: 'Time', align: 'l', sort: (r) => r.event.time, cell: (r) => <span className="muted">{TIME_LABEL[r.event.time]}</span> },
      ...RUNUP_WINDOWS.slice().reverse().map((k) => pct(`r${k}`, `Runup ${k}`, (r) => r.runups[k]!, k === 20 ? 'Return over the stated sessions ending at the last close before the report.' : undefined)),
      pct('gap', 'Gap', (r) => r.gap, 'Open of the reacting session versus the last close before the report.'),
      reaction,
      ...DRIFT_WINDOWS.map((h) => pct(`d${h}`, `Drift ${h}`, (r) => r.drift[h]!, h === 1 ? 'Return over the stated sessions starting from the first reacting close.' : undefined)),
      { key: 'est', header: 'EPS est.', sort: (r) => r.eps.estimate, cell: (r) => (r.eps.estimate === null ? <span className="faint">n/a</span> : fmtNum(r.eps.estimate)) },
      { key: 'act', header: 'EPS actual', sort: (r) => r.eps.actual, cell: (r) => (r.eps.actual === null ? <span className="faint">n/a</span> : fmtNum(r.eps.actual)) },
      { key: 'surp', header: 'Surprise', info: 'Actual minus estimate, divided by the absolute estimate. Shown only when both exist.', sort: (r) => r.eps.pct, cell: (r) => <Pct v={r.eps.pct} digits={1} /> },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrow]);
  const sorted = useMemo(() => sortRows(study.rows, cols, sort), [study.rows, cols, sort]);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE));
  const p = Math.min(page, pages - 1);
  const rows = sorted.slice(p * PAGE, p * PAGE + PAGE);
  return (
    <>
      <DataTable rows={rows} cols={cols} sort={sort} onSort={(s) => { setSort(s); setPage(0); }} rowKey={(r) => r.id} onRow={pick} selectedKey={selectedId} caption="Past earnings reports and price reactions" empty="No past reports in the selected history." />
      <div className="er-pager">
        <span>
          {sorted.length === 0 ? 'No reports' : `Reports ${p * PAGE + 1} to ${Math.min(sorted.length, p * PAGE + PAGE)} of ${sorted.length}`}
        </span>
        <button type="button" className="btn small" disabled={p === 0} onClick={() => setPage(p - 1)}>Previous</button>
        <button type="button" className="btn small" disabled={p >= pages - 1} onClick={() => setPage(p + 1)}>Next</button>
      </div>
      {open && <ReportSheet row={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function ReportSheet({ row, onClose }: { row: ReactionRow; onClose: () => void }) {
  const v = (m: Maybe<number>) => (isNa(m) ? <Missing why={reasonDetail(m)} /> : <Pct v={m} />);
  const d = (m: Maybe<string>) => (isNa(m) ? <Missing why={reasonDetail(m)} /> : fmtDay(m));
  return (
    <Sheet title={row.event.fiscalPeriod ? `${row.event.fiscalPeriod}, ${fmtDate(row.event.date)}` : fmtDate(row.event.date)} onClose={onClose}>
      <dl className="kv">
        <dt>Release</dt>
        <dd>{fmtDay(row.event.date)}, {TIME_LABEL[row.event.time].toLowerCase()}, {row.event.status}</dd>
        <dt>First reacting session</dt>
        <dd>{d(row.reactionDate)}</dd>
        <dt>Last close before</dt>
        <dd>{isNa(row.preClose) || isNa(row.preCloseDate) ? <Missing why={reasonDetail(isNa(row.preClose) ? row.preClose : (row.preCloseDate as never))} /> : `${fmtPrice(row.preClose)} on ${fmtDate(row.preCloseDate)}`}</dd>
        {RUNUP_WINDOWS.map((k) => (
          <div key={k} style={{ display: 'contents' }}><dt>Runup, {k} sessions before</dt><dd>{v(row.runups[k]!)}</dd></div>
        ))}
        <dt>Gap at the open</dt><dd>{v(row.gap)}</dd>
        <dt>Open to close</dt><dd>{v(row.session)}</dd>
        <dt>First reacting close</dt><dd>{v(row.reaction)}</dd>
        <dt>Session high, low vs prior close</dt>
        <dd>{v(row.reactionHigh)} and {v(row.reactionLow)}. Order inside the session is unknown.</dd>
        {DRIFT_WINDOWS.map((h) => (
          <div key={h} style={{ display: 'contents' }}><dt>Drift, {h} sessions after</dt><dd>{v(row.drift[h]!)}</dd></div>
        ))}
        <dt>EPS</dt>
        <dd>{row.eps.available ? `Actual ${fmtNum(row.eps.actual)} vs estimate ${fmtNum(row.eps.estimate)}${row.eps.pct !== null ? `, surprise ${fmtPct(row.eps.pct, 1)}` : ''}` : 'Actual or estimate not available'}</dd>
        <dt>Revenue</dt>
        <dd>{row.revenue.available ? `Actual ${fmtNum(row.revenue.actual, 0)} vs estimate ${fmtNum(row.revenue.estimate, 0)}` : 'Not available in this capture'}</dd>
        <dt>Path coverage</dt>
        <dd>{row.path.length === 0 ? 'No path' : `${row.path.length} sessions, ${fmtDate(row.path[0]!.date)} to ${fmtDate(row.path[row.path.length - 1]!.date)}${row.pathComplete ? '' : '. Truncated'}`}</dd>
      </dl>
    </Sheet>
  );
}

export function MeasureTable({ study }: { study: EarningsStudy }) {
  const rows: { key: string; label: string; s: MeasureSummary }[] = [
    ...RUNUP_WINDOWS.slice().reverse().map((k) => ({ key: `r${k}`, label: `Runup, ${k} sessions before`, s: study.runups[k]! })),
    { key: 'gap', label: 'Gap at the open', s: study.gap },
    { key: 'reaction', label: 'First reacting close', s: study.reaction },
    { key: 'mag', label: 'First close, absolute size', s: study.magnitude },
    ...DRIFT_WINDOWS.map((h) => ({ key: `d${h}`, label: `Drift, ${h} sessions after`, s: study.drift[h]! })),
  ];
  type R = (typeof rows)[number];
  const q = (get: (r: R) => number | undefined) => (r: R) => (r.s.distribution ? <Pct v={get(r)} digits={1} plain={r.key === 'mag'} /> : <span className="faint">n/a</span>);
  const cols: Column<R>[] = [
    { key: 'm', header: 'Measure', sticky: true, cell: (r) => r.label },
    { key: 'n', header: 'Reports', info: 'Reports where the measure is available. Others are left out for the stated reason, such as a horizon that has not completed.', cell: (r) => { const out = Object.values(r.s.unavailable).reduce((a, b) => a + b, 0); return <span title={Object.entries(r.s.unavailable).map(([k, c]) => `${c} ${k}`).join(', ')}>{r.s.n}{out ? <span className="faint small"> ({out} out)</span> : null}</span>; } },
    { key: 'p10', header: '10th', cell: q((r) => r.s.distribution?.p10) },
    { key: 'p25', header: '25th', cell: q((r) => r.s.distribution?.p25) },
    { key: 'med', header: 'Median', cell: (r) => <strong>{q((x) => x.s.distribution?.median)(r)}</strong> },
    { key: 'p75', header: '75th', cell: q((r) => r.s.distribution?.p75) },
    { key: 'p90', header: '90th', cell: q((r) => r.s.distribution?.p90) },
    { key: 'pos', header: 'Share positive', align: 'l', cell: (r) => (r.key === 'mag' ? <span className="faint">n/a</span> : <Freq p={r.s.positive} />) },
  ];
  return <DataTable rows={rows} cols={cols} rowKey={(r) => r.key} caption="Distribution of each measure across past reports" />;
}
