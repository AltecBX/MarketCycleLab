/** Drawdown board: how far each stock sits below its 52 week traded high, on one scale. */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { applyUniverse, drawdownBoard, groupCounts, type DrawdownEntry } from '../../engine/screener';
import { Card, DataTable, Sheet, Skeleton, sortRows, Stat, StateNote, type Column, type SortState } from '../../ui/components';
import { median } from '../../engine/core/stats';
import { fmtDate, fmtPct, fmtPrice } from '../../ui/format';
import { useCapParam, useIsPhone, useParam, useScrollRestore } from './shared/hooks';
import { CapControl, capLabel, DiscoverIssues, PctCell, SymbolLink } from './shared/parts';
import { useDiscoverData } from './shared/useDiscoverData';

export default function DrawdownBoard() {
  const d = useDiscoverData();
  const nav = useNavigate();
  const phone = useIsPhone();
  const [cap, setCap] = useCapParam();
  const [group, setGroup] = useParam<string>('g', '');
  const [sortParam, setSortParam] = useParam<string>('sort', '');
  const [detail, setDetail] = useState<DrawdownEntry | null>(null);
  useScrollRestore(d.status === 'ready');

  const uni = useMemo(() => (d.status === 'ready' ? applyUniverse(d.data.rows, cap) : null), [d, cap]);
  const groups = useMemo(() => (uni ? groupCounts(uni.rows) : []), [uni]);
  const board = useMemo(() => (uni ? drawdownBoard(group ? uni.rows.filter((r) => r.groups.includes(group)) : uni.rows) : null), [uni, group]);

  if (d.status === 'loading') return <Skeleton h={420} />;
  if (d.status === 'error' || !board || !uni) {
    return (
      <StateNote tone="error" title="The drawdown board could not be loaded." action={<button type="button" className="btn small" onClick={d.reload}>Retry</button>}>
        {d.status === 'error' ? d.error.message : 'Unavailable'}
      </StateNote>
    );
  }
  const [sk, sd] = sortParam.split('.');
  const sort: SortState | null = sk && (sd === 'asc' || sd === 'desc') ? { key: sk, dir: sd } : null;
  const open = (e: DrawdownEntry) => nav(`/research/${encodeURIComponent(e.symbol)}/selloffs`);

  const all: Column<DrawdownEntry>[] = [
    { key: 'symbol', header: 'Symbol', sticky: true, sort: (e) => e.symbol, cell: (e) => <SymbolLink symbol={e.symbol} section="selloffs" /> },
    { key: 'name', header: 'Company', align: 'l', sort: (e) => e.name, cell: (e) => <span className="dv-name" title={e.name}>{e.name}</span> },
    { key: 'group', header: 'Group', align: 'l', sort: (e) => e.group, cell: (e) => (e.group ? <button type="button" className="dv-link" onClick={(ev) => { ev.stopPropagation(); setGroup(e.group!); }}><span className="dv-name">{e.group}</span></button> : <span className="faint">None</span>) },
    { key: 'price', header: 'Close', sort: (e) => e.price, cell: (e) => fmtPrice(e.price) },
    {
      key: 'high', header: '52 week traded high', info: board.highDefinition, sort: (e) => e.high,
      cell: (e) => (
        <span title={e.highSource}>
          {fmtPrice(e.high)}
          <span className="dv-sub">{fmtDate(e.highDate)}{e.shortHistory ? ', short history' : ''}</span>
        </span>
      ),
    },
    {
      key: 'drawdown', header: 'From high', info: 'Close divided by the 52 week traded high, minus 1. Bars share one scale: the deepest decline on the board is a full bar.', sort: (e) => e.drawdown,
      cell: (e) => (
        <span className="dv-dd">
          <span className="dv-track" aria-hidden="true"><span className="dv-fill" style={{ right: 0, width: `${e.bar * 100}%`, background: 'var(--down)' }} /></span>
          <PctCell v={e.drawdown} digits={1} />
        </span>
      ),
    },
    { key: 'gain', header: 'To regain', info: 'The gain needed to get back to the 52 week traded high: high divided by close, minus 1.', sort: (e) => e.requiredGain, cell: (e) => <span className="num">{fmtPct(e.requiredGain, 1)}</span> },
    { key: 'day', header: 'Today', sort: (e) => (typeof e.dayChange === 'number' ? e.dayChange : null), cell: (e) => <PctCell v={e.dayChange} /> },
  ];
  const cols = phone ? all.filter((c) => ['symbol', 'drawdown', 'gain'].includes(c.key)) : all;
  const rows = sort ? sortRows(board.entries, all, sort) : board.entries;
  const dds = board.entries.map((e) => e.drawdown);

  return (
    <div className="stack">
      <DiscoverIssues issues={d.data.issues} />
      <Card title="Below the 52 week traded high" info={`${board.highDefinition} Closes as of ${fmtDate(d.data.asOf)}.`}>
        <div className="stack" style={{ gap: 12 }}>
          <div className="dv-toolbar">
            <CapControl value={cap} onChange={setCap} />
            <label className="field">
              Group
              <select className="select" value={group} onChange={(e) => setGroup(e.target.value)}>
                <option value="">All stocks</option>
                {groups.map((g) => (
                  <option key={g.group} value={g.group}>{g.group} ({g.count})</option>
                ))}
              </select>
            </label>
            {group && <button type="button" className="btn small primary" onClick={() => setGroup('')}>All stocks</button>}
          </div>
          {board.entries.length > 0 && (
            <div className="stats">
              <Stat label="Stocks" value={board.entries.length} sub={`at or above ${capLabel(cap)}${group ? `, ${group}` : ''}`} />
              <Stat label="Median from high" value={fmtPct(median(dds), 1)} tone="down" />
              <Stat label="Down 20% or more" value={`${dds.filter((x) => x <= -0.2).length} of ${dds.length}`} />
              <Stat label="Within 5% of high" value={`${dds.filter((x) => x >= -0.05).length} of ${dds.length}`} />
            </div>
          )}
          <DataTable
            caption="Drawdown from the 52 week traded high"
            rows={rows}
            cols={cols}
            rowKey={(e) => e.symbol}
            sort={sort ?? { key: 'drawdown', dir: 'asc' }}
            onSort={(s) => setSortParam(`${s.key}.${s.dir}`)}
            onRow={phone ? setDetail : open}
            empty="No stock at this market cap floor has a completed close and a 52 week high."
          />
          {board.unavailable.length > 0 && (
            <p className="small muted">Not placed: {board.unavailable.map((u) => `${u.symbol} (${u.reason})`).join(', ')}.</p>
          )}
        </div>
      </Card>
      {detail && (
        <Sheet title={`${detail.symbol}  ${detail.name}`} onClose={() => setDetail(null)}>
          <div className="stack" style={{ gap: 12 }}>
            <button type="button" className="btn primary" style={{ minHeight: 44 }} onClick={() => open(detail)}>Open selloff research</button>
            <dl className="kv">
              <dt>Close</dt><dd>{fmtPrice(detail.price)}, {fmtDate(detail.priceDate)}</dd>
              <dt>52 week traded high</dt><dd>{fmtPrice(detail.high)}, {fmtDate(detail.highDate)}</dd>
              <dt>From high</dt><dd>{fmtPct(detail.drawdown, 1)}</dd>
              <dt>To regain</dt><dd>{fmtPct(detail.requiredGain, 1)}</dd>
              <dt>Today</dt><dd><PctCell v={detail.dayChange} /></dd>
              <dt>Group</dt><dd>{detail.group ?? 'None'}</dd>
              <dt>High basis</dt><dd>{detail.highSource}</dd>
            </dl>
          </div>
        </Sheet>
      )}
    </div>
  );
}
