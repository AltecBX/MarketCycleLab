/** Crossing history: every run above or below the chosen average, sortable, searchable, paged. */
import { useMemo, useState } from 'react';
import { RUN_LABELS, searchRuns, type MaRun, type Side } from '../../../engine/maRuns';
import { isNum } from '../../../engine/core/types';
import { Chip, DataTable, Pct, Segmented, Sheet, sortRows, type Column, type SortState } from '../../../ui/components';
import { dirClass, fmtDate, fmtPct, fmtPrice, plural } from '../../../ui/format';
import { usePhone } from './params';

const PAGE = 25;

const sideWord = (s: Side) => (s === 'above' ? 'Above' : 'Below');
const sideGlyph = (s: Side) => (s === 'above' ? '▲' : '▼');

function SideChip({ side }: { side: Side }) {
  return (
    <Chip tone={side === 'above' ? 'up' : 'down'}>
      <span aria-hidden="true" style={{ fontSize: 9 }}>{sideGlyph(side)}</span>
      {sideWord(side)}
    </Chip>
  );
}

const exitText = (r: MaRun): string => (r.status === 'active' ? 'Still running' : r.exitDate && r.exitKind !== 'gap' ? fmtDate(r.exitDate) : 'Not observed');

function RunFlags({ r }: { r: MaRun }) {
  return (
    <>
      {r.status === 'active' && <Chip tone="gold">Active</Chip>}
      {r.status === 'interrupted' && <Chip tone="warn" title={RUN_LABELS.status.interrupted}>Interrupted</Chip>}
      {r.startKind === 'leading' && <Chip tone="warn" title="Already on this side when the study history begins. Not a confirmed crossing. Left out of the statistics.">Start not observed</Chip>}
      {r.startKind === 'after-gap' && <Chip tone="warn" title={RUN_LABELS.startKind['after-gap']}>Unverified start</Chip>}
    </>
  );
}

function RunDetail({ r, window }: { r: MaRun; window: number }) {
  const move = isNum(r.moveToExit) ? r.moveToExit : null;
  return (
    <dl className="kv">
      <dt>Side</dt>
      <dd>{sideWord(r.side)} the {window} day average</dd>
      <dt>Status</dt>
      <dd>{RUN_LABELS.status[r.status]}</dd>
      <dt>Start</dt>
      <dd>{fmtDate(r.entryDate)} at {fmtPrice(r.entryClose)}. {RUN_LABELS.startKind[r.startKind]}.</dd>
      <dt>Consecutive sessions</dt>
      <dd>{plural(r.length, 'session')}. The first close on this side is session 1. The exit close is not counted.</dd>
      <dt>Last close on this side</dt>
      <dd>{fmtDate(r.lastDate)} at {fmtPrice(r.lastClose)}, {fmtPct(r.lastDistance)} from the average</dd>
      <dt>Exit</dt>
      <dd>
        {r.status === 'active'
          ? 'Still running. Not a completed sample.'
          : r.exitDate && r.exitKind
            ? `${fmtDate(r.exitDate)}${r.exitClose !== null ? ` at ${fmtPrice(r.exitClose)}` : ''}. ${RUN_LABELS.exitKind[r.exitKind]}.`
            : 'Not observed'}
      </dd>
      <dt>Farthest from the average</dt>
      <dd>
        <span className={dirClass(r.farthestDistance)}>{fmtPct(r.farthestDistance)}</span> on {fmtDate(r.farthestDistanceDate)}. Close against that day's average.
      </dd>
      <dt>{r.side === 'below' ? 'Biggest drop from the crossing' : 'Biggest rise from the crossing'}</dt>
      <dd>
        <span className={dirClass(r.extremeFromEntry)}>{fmtPct(r.extremeFromEntry)}</span> on {fmtDate(r.extremeFromEntryDate)}
        {r.extremeDatesCoincide ? ', the same date as the farthest distance.' : '. A different date from the farthest distance, because the average itself moved.'} Close against the crossing close of {fmtPrice(r.entryClose)}.
      </dd>
      <dt>Move to exit</dt>
      <dd>{move === null ? 'Not applicable. The run has no observed exit.' : <><span className={dirClass(move)}>{fmtPct(move)}</span> from the crossing close to the exit close</>}</dd>
    </dl>
  );
}

export function RunTable({ runs, window, studySide }: { runs: readonly MaRun[]; window: number; studySide: Side | null }) {
  const phone = usePhone();
  const [sideFilter, setSideFilter] = useState<'all' | Side>(studySide ?? 'all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'entry', dir: 'desc' });
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<MaRun | null>(null);

  const cols = useMemo<Column<MaRun>[]>(
    () => [
      {
        key: 'entry',
        header: 'Entry',
        sticky: true,
        sort: (r) => r.entryDate,
        cell: (r) => (
          <span className="ma-two">
            {fmtDate(r.entryDate)}
            <small>{fmtPrice(r.entryClose)}</small>
          </span>
        ),
      },
      { key: 'side', header: 'Side', align: 'l', sort: (r) => r.side, cell: (r) => <SideChip side={r.side} /> },
      {
        key: 'length',
        header: (
          <>
            Consecutive
            <br />
            sessions
          </>
        ),
        info: 'Sessions in a row on this side. The first close across the average is session 1. The close that ends the run is not counted.',
        sort: (r) => r.length,
        cell: (r) => (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end' }}>
            <RunFlags r={r} />
            <strong className="num">{r.length}</strong>
          </span>
        ),
      },
      {
        key: 'exit',
        header: 'Exit',
        sort: (r) => r.exitDate,
        cell: (r) => (
          <span className="ma-two">
            {exitText(r)}
            <small>{r.exitKind === 'touch' ? 'closed on the average' : r.exitKind === 'cross' ? 'closed across' : r.exitKind === 'gap' ? 'missing session' : ' '}</small>
          </span>
        ),
      },
      {
        key: 'far',
        header: (
          <>
            Farthest from
            <br />
            average
          </>
        ),
        info: 'Most extreme close against that day\'s average during the run, with its own date.',
        sort: (r) => r.farthestDistance,
        cell: (r) => (
          <span className="ma-two">
            <Pct v={r.farthestDistance} />
            <small>{fmtDate(r.farthestDistanceDate)}</small>
          </span>
        ),
      },
      {
        key: 'ext',
        header: (
          <>
            Extreme change
            <br />
            from crossing
          </>
        ),
        info: 'Biggest drop (below runs) or rise (above runs) of the close against the crossing close, with its own date. It can differ from the farthest distance date because the average moves.',
        sort: (r) => r.extremeFromEntry,
        cell: (r) => (
          <span className="ma-two">
            <Pct v={r.extremeFromEntry} />
            <small>{r.extremeDatesCoincide ? 'same date' : fmtDate(r.extremeFromEntryDate)}</small>
          </span>
        ),
      },
      {
        key: 'move',
        header: (
          <>
            Move
            <br />
            to exit
          </>
        ),
        info: 'Exit close against the crossing close. Empty while a run is still open.',
        sort: (r) => (isNum(r.moveToExit) ? r.moveToExit : null),
        cell: (r) => <Pct v={isNum(r.moveToExit) ? r.moveToExit : null} />,
      },
    ],
    [],
  );

  const filtered = useMemo(() => {
    const f = searchRuns(runs, { side: sideFilter === 'all' ? undefined : sideFilter, query: query.replace(/,/g, ' ') });
    // Free text also matches the display form of dates, for example "Mar 2020".
    const q = query.trim().toLowerCase();
    const extra = q && f.length === 0 ? runs.filter((r) => (sideFilter === 'all' || r.side === sideFilter) && [fmtDate(r.entryDate), fmtDate(r.exitDate), fmtDate(r.lastDate)].join(' ').toLowerCase().includes(q)) : f;
    return sortRows(extra, cols, sort);
  }, [runs, sideFilter, query, sort, cols]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const p = Math.min(page, pages - 1);
  const rows = filtered.slice(p * PAGE, p * PAGE + PAGE);
  const keyOf = (r: MaRun) => `${r.side}:${r.entryDate}`;

  return (
    <div>
      <div className="row" style={{ marginBottom: 12, alignItems: 'flex-end' }}>
        <Segmented
          label="Side shown"
          value={sideFilter}
          options={[
            { value: 'all', label: 'Both sides' },
            { value: 'above', label: 'Above' },
            { value: 'below', label: 'Below' },
          ]}
          onChange={(v) => {
            setSideFilter(v);
            setPage(0);
          }}
        />
        <label className="field" style={{ flex: '1 1 180px', maxWidth: 280 }}>
          Find by date or outcome
          <input
            className="input"
            type="search"
            placeholder="2020, Mar 2020, active, touch"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <span className="muted small">{plural(filtered.length, 'run')}</span>
      </div>
      {phone ? (
        filtered.length === 0 ? (
          <div className="state">No runs match. Clear the search or show both sides.</div>
        ) : (
          <ul className="ma-list" aria-label={`Runs against the ${window} day average`}>
            {rows.map((r) => (
              <li key={keyOf(r)}>
                <button type="button" onClick={() => setOpen(r)} aria-label={`${sideWord(r.side)} run from ${fmtDate(r.entryDate)}, ${r.length} sessions. Open details`}>
                  <span className="ma-row-main">
                    {fmtDate(r.entryDate)} <span className="faint" style={{ fontWeight: 400 }}>to</span> {exitText(r)}
                  </span>
                  <span className="ma-row-r num">
                    <strong>{r.length}</strong> <span className="faint small">sessions</span>
                  </span>
                  <span className="ma-row-sub row" style={{ gap: 6 }}>
                    <SideChip side={r.side} />
                    <RunFlags r={r} />
                  </span>
                  <span className="ma-row-r ma-row-sub">
                    farthest <Pct v={r.farthestDistance} digits={1} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : (
        <DataTable
          rows={rows}
          cols={cols}
          sort={sort}
          onSort={(s) => {
            setSort(s);
            setPage(0);
          }}
          rowKey={keyOf}
          onRow={setOpen}
          caption={`Runs above and below the ${window} day average`}
          empty="No runs match. Clear the search or show both sides."
        />
      )}
      {pages > 1 && (
        <div className="ma-pager">
          <button type="button" className="btn small" disabled={p === 0} onClick={() => setPage(p - 1)}>
            Newer
          </button>
          <span className="muted small">
            Page {p + 1} of {pages}
          </span>
          <button type="button" className="btn small" disabled={p >= pages - 1} onClick={() => setPage(p + 1)}>
            Older
          </button>
          {phone && (
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              Order
              <select className="select" value={`${sort.key}:${sort.dir}`} onChange={(e) => { const [key, dir] = e.target.value.split(':'); setSort({ key: key!, dir: dir as 'asc' | 'desc' }); setPage(0); }}>
                <option value="entry:desc">Newest first</option>
                <option value="entry:asc">Oldest first</option>
                <option value="length:desc">Longest first</option>
                <option value="far:asc">Farthest below first</option>
                <option value="far:desc">Farthest above first</option>
              </select>
            </label>
          )}
        </div>
      )}
      {open && (
        <Sheet title={`${sideWord(open.side)} the ${window} day, from ${fmtDate(open.entryDate)}`} onClose={() => setOpen(null)}>
          <RunDetail r={open} window={window} />
        </Sheet>
      )}
    </div>
  );
}
