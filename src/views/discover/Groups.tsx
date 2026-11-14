/** Group comparison: which groups moved, who inside them, and whether the names actually move together. */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { isNa, isNum, type Bar } from '../../engine/core/types';
import {
  aggregateGroups, coMovementMatrix, findGroup, GROUP_METRIC_LABELS, groupParticipation, industryGrouping, themesGrouping, topMovers,
  type GroupMetric, type GroupStat, type ParticipationReading,
} from '../../engine/groups';
import { applyUniverse, groupResearchMembers, serializeFilter, type GroupMemberRow } from '../../engine/screener';
import { median } from '../../engine/core/stats';
import { Card, Chip, DataTable, Disclosure, Segmented, Skeleton, Stat, StateNote, type Column } from '../../ui/components';
import { fmtDate, fmtMoney, fmtNum, fmtPct, fmtPp } from '../../ui/format';
import { useCapParam, useParam, useScrollRestore } from './shared/hooks';
import { CapControl, capLabel, DiscoverIssues, Na, PctCell, SymbolLink } from './shared/parts';
import { useDiscoverData } from './shared/useDiscoverData';

const METRICS: GroupMetric[] = ['day', 'wtd', 'mtd', 'qtd', 'ytd'];
const READING: Record<ParticipationReading, string> = {
  'group-wide': 'Group wide decline',
  'stock-specific': 'Stock specific decline',
  mixed: 'Mixed',
  'not-a-decline': 'Not a decline',
  unknown: 'Too few peers',
};
const tail = (b: readonly Bar[] | undefined, n: number): Bar[] => (b ? b.slice(-n) : []);

export default function Groups() {
  const d = useDiscoverData();
  const [cap, setCap] = useCapParam();
  const [metric, setMetric] = useParam<GroupMetric>('m', 'day', METRICS);
  const [modelKind, setModelKind] = useParam<'theme' | 'industry'>('model', 'theme', ['theme', 'industry']);
  const [stat, setStat] = useParam<GroupStat>('stat', 'average', ['average', 'median']);
  const [order, setOrder] = useParam<'strongest' | 'weakest'>('order', 'strongest', ['strongest', 'weakest']);
  const [search, setSearch] = useParam<string>('gq', '');
  const [selectedId, setSelectedId] = useParam<string>('g', '');
  const [win, setWin] = useParam<'63' | '252'>('w', '63', ['63', '252']);
  useScrollRestore(d.status === 'ready');

  const data = d.status === 'ready' ? d.data : null;
  const model = useMemo(() => (data ? (modelKind === 'theme' ? themesGrouping(data.groups) : industryGrouping(data.instruments)) : null), [data, modelKind]);
  const scope = useMemo(() => (data ? applyUniverse(data.rows, cap) : null), [data, cap]);
  const comparison = useMemo(() => (model && scope ? aggregateGroups(scope.rows, model, metric, { stat, order, search }) : null), [model, scope, metric, stat, order, search]);
  const selected = model && selectedId ? findGroup(model, selectedId) : null;
  const movers = useMemo(() => (scope ? topMovers(scope.rows, metric, { group: selected }) : null), [scope, metric, selected]);
  const members = useMemo(() => (data && selected ? groupResearchMembers(selected, data.rows, cap) : []), [data, selected, cap]);
  const participation = useMemo(() => {
    if (!data || !selected) return new Map<string, ReturnType<typeof groupParticipation>>();
    return new Map(selected.members.map((s) => [s, groupParticipation(s, data.asOf, selected.members, data.bars)]));
  }, [data, selected]);
  const co = useMemo(() => {
    if (!data || !selected) return null;
    const w = Number(win);
    const series = selected.members.filter((s) => data.bars.has(s)).map((s) => ({ symbol: s, bars: tail(data.bars.get(s), w + 6) }));
    const pairs = coMovementMatrix(series, w, tail(data.bars.get('SPY'), w + 6));
    const ok = pairs.flatMap((p) => (isNa(p.result) ? [] : [{ a: p.a, b: p.b, r: p.result }])).sort((x, y) => y.r.correlation - x.r.correlation);
    const sparse = pairs.flatMap((p) => (isNa(p.result) ? [{ a: p.a, b: p.b, why: p.result.detail ?? 'Unavailable' }] : []));
    const ex = ok.map((p) => p.r.excessCorrelation).filter(isNum);
    return { ok, sparse, total: pairs.length, medianCorr: ok.length ? median(ok.map((p) => p.r.correlation)) : null, medianExcess: ex.length ? median(ex) : null };
  }, [data, selected, win]);

  if (d.status === 'loading') return <Skeleton h={420} />;
  if (d.status === 'error' || !data || !model || !scope || !comparison || !movers) {
    return (
      <StateNote tone="error" title="Groups could not be loaded." action={<button type="button" className="btn small" onClick={d.reload}>Retry</button>}>
        {d.status === 'error' ? d.error.message : 'Unavailable'}
      </StateNote>
    );
  }
  const label = GROUP_METRIC_LABELS[metric];
  const hasNeg = comparison.aggregates.some((a) => isNum(a.value) && a.value < 0);
  const hasPos = comparison.aggregates.some((a) => isNum(a.value) && a.value > 0);
  const zero = hasNeg && hasPos ? 50 : hasNeg ? 100 : 0;
  const span = hasNeg && hasPos ? 50 : 100;
  const screenerLink = selected ? `/discover?${new URLSearchParams({ ...(cap !== 2 ? { cap: String(cap) } : {}), f: serializeFilter({ clauses: [{ field: modelKind === 'theme' ? 'group' : 'industry', op: 'eq', value: selected.name }] }) })}` : '';

  const memberCols: Column<GroupMemberRow>[] = [
    {
      key: 'symbol', header: 'Symbol', sticky: true, sort: (m) => m.symbol,
      cell: (m) => (
        <>
          <SymbolLink symbol={m.symbol} />
          {m.status !== 'in-universe' && <span className="dv-sub" title={m.label}>{m.status === 'etf' ? 'ETF' : m.status === 'below-floor' ? 'Below floor' : m.status === 'no-market-cap' ? 'No cap' : 'Not loaded'}</span>}
        </>
      ),
    },
    { key: 'cap', header: 'Cap', sort: (m) => (m.row && isNum(m.row.marketCap) ? m.row.marketCap : null), cell: (m) => (m.row && isNum(m.row.marketCap) ? fmtMoney(m.row.marketCap) : <Na why={m.row?.marketCap ?? m.label} />) },
    ...METRICS.map((k): Column<GroupMemberRow> => {
      const get = (m: GroupMemberRow) => (m.row ? (k === 'day' ? m.row.dayChange : m.row[k]) : null);
      return { key: k, header: GROUP_METRIC_LABELS[k], sort: (m) => { const x = get(m); return isNum(x) ? x : null; }, cell: (m) => { const x = get(m); return x === null ? <Na why="Not loaded" /> : <PctCell v={x} />; } };
    }),
    {
      key: 'vs', header: 'Today vs peers', info: 'The stock’s return on the latest session minus the median return of the other members, in percentage points.',
      sort: (m) => { const p = participation.get(m.symbol); return p && isNum(p.versusPeerMedian) ? p.versusPeerMedian : null; },
      cell: (m) => { const p = participation.get(m.symbol); return p && isNum(p.versusPeerMedian) ? <span className={`num ${p.versusPeerMedian > 0 ? 'up' : p.versusPeerMedian < 0 ? 'down' : 'flat'}`}>{fmtPp(p.versusPeerMedian)}</span> : <Na why={p?.versusPeerMedian} />; },
    },
    {
      key: 'down', header: 'Peers down', info: 'How many of the other members closed lower on the latest session.',
      sort: (m) => participation.get(m.symbol)?.peersDown?.rate ?? null,
      cell: (m) => { const p = participation.get(m.symbol)?.peersDown; return p ? <span className="num">{p.hits} of {p.n}</span> : <Na why="No peer has a return on this date" />; },
    },
    {
      key: 'reading', header: 'Reading', align: 'l', info: participation.values().next().value?.readingBasis,
      cell: (m) => { const p = participation.get(m.symbol); return <span className="muted">{p ? READING[p.reading] : 'n/a'}</span>; },
    },
  ];

  const MoverList = ({ title, items, note }: { title: string; items: { symbol: string; value: number }[]; note: string | null }) => (
    <div>
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="muted small" style={{ marginTop: 4 }}>{note}</p>
      ) : (
        <ol>
          {items.map((x) => (
            <li key={x.symbol}>
              <SymbolLink symbol={x.symbol} />
              <PctCell v={x.value} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );

  return (
    <div className="stack">
      <DiscoverIssues issues={data.issues} />
      <div className="dv-two">
        <Card
          title={`${model.label}, ${label}, ${stat}`}
          info={`${model.note} Each bar is the equal weighted ${stat} of members at or above ${capLabel(cap)} that have ${label} data. The count beside each name is members with data of members defined. Closes as of ${fmtDate(data.asOf)}.`}
        >
          <div className="stack" style={{ gap: 12 }}>
            <div className="dv-toolbar">
              <Segmented label="Period" value={metric} onChange={setMetric} options={METRICS.map((m) => ({ value: m, label: GROUP_METRIC_LABELS[m] }))} />
              <Segmented label="Grouping" value={modelKind} onChange={(v) => { setModelKind(v); }} options={[{ value: 'theme', label: 'Trading groups' }, { value: 'industry', label: 'Industry' }]} />
              <Segmented label="Statistic" value={stat} onChange={setStat} options={[{ value: 'average', label: 'Average' }, { value: 'median', label: 'Median' }]} />
              <Segmented label="Order" value={order} onChange={setOrder} options={[{ value: 'strongest', label: 'Strongest' }, { value: 'weakest', label: 'Weakest' }]} />
            </div>
            <div className="dv-toolbar">
              <CapControl value={cap} onChange={setCap} />
              <label className="field grow">
                Search groups
                <input className="input" type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
              </label>
            </div>
            {comparison.aggregates.length === 0 ? (
              <StateNote>No group matches this search.</StateNote>
            ) : (
              <div className="dv-gbars" role="list" aria-label={`${model.label} by ${label} ${stat}, ${order} first`}>
                {comparison.aggregates.map((a) => {
                  const v = isNum(a.value) ? a.value : null;
                  const w = v === null ? 0 : Math.abs(a.bar) * span;
                  return (
                    <div key={a.groupId} role="listitem" style={{ display: 'contents' }}>
                      <button type="button" className="dv-gbtn" aria-pressed={selected?.id === a.groupId} onClick={() => setSelectedId(selected?.id === a.groupId ? '' : a.groupId)}>
                        <span className="g-name">{a.name}</span>
                        <span className="g-cov">{a.withData} of {a.members}</span>
                        {a.breadth === 'single' && <Chip tone="warn" title="One member with data. This is one stock, not a group move.">1 stock</Chip>}
                        {a.breadth === 'narrow' && <Chip tone="warn" title="Fewer than three members with data.">Narrow</Chip>}
                      </button>
                      <div className="dv-track" aria-hidden="true">
                        {v !== null && <div className="dv-fill" style={{ left: `${v < 0 ? zero - w : zero}%`, width: `${w}%`, background: v >= 0 ? 'var(--up)' : 'var(--down)' }} />}
                        <div className="dv-zero" style={{ left: `${zero}%` }} />
                      </div>
                      <span className="dv-val">{v === null ? <Na why={a.value} /> : <PctCell v={v} />}</span>
                    </div>
                  );
                })}
              </div>
            )}
            {model.unclassified.length > 0 && <p className="small muted">Not classified: {model.unclassified.join(', ')}.</p>}
          </div>
        </Card>
        <Card title="Top 3 winners and losers" sub={`${movers.scopeLabel}. ${movers.withData} with data, at or above ${capLabel(cap)}.`}>
          <div className="dv-movers">
            <MoverList title="Winners" items={movers.winners} note={movers.winnersNote} />
            <MoverList title="Losers" items={movers.losers} note={movers.losersNote} />
          </div>
        </Card>
      </div>

      {selected && co && (
        <>
          <Card
            title={selected.name}
            sub={selected.basis}
            actions={
              <div className="row" style={{ gap: 8 }}>
                <Link className="btn small" to={screenerLink}>View in screener</Link>
                <button type="button" className="btn small primary" onClick={() => setSelectedId('')}>All stocks</button>
              </div>
            }
          >
            <DataTable caption={`Members of ${selected.name}`} rows={members} cols={memberCols} rowKey={(m) => m.symbol} />
            <p className="small muted" style={{ marginTop: 8 }}>
              Every member is listed for group research. Funds and members below {capLabel(cap)} are labeled and stay outside the group bar above. Latest session {fmtDate(data.asOf)}.
            </p>
          </Card>
          <Card
            title="Do these names move together"
            info="Pearson correlation of daily returns on common dates over the window. Market excess subtracts the SPY return on the same dates. Descriptive and retrospective. Today’s membership applied to history is not a historical universe and a curated theme is not proof of co movement."
            actions={<Segmented label="Window" value={win} onChange={setWin} options={[{ value: '63', label: '63 sessions' }, { value: '252', label: '252 sessions' }]} />}
          >
            {co.total === 0 ? (
              <StateNote>This group has fewer than two members with price history, so there is no pair to compare.</StateNote>
            ) : co.ok.length === 0 ? (
              <StateNote>No pair has enough common history for a {win} session window. {co.sparse[0]?.why}</StateNote>
            ) : (
              <div className="stack" style={{ gap: 12 }}>
                <div className="stats">
                  <Stat label="Median pair correlation" value={fmtNum(co.medianCorr, 2, true)} sub={`${co.ok.length} of ${co.total} pairs`} />
                  <Stat label="Median market excess" value={co.medianExcess === null ? 'n/a' : fmtNum(co.medianExcess, 2, true)} sub="after removing SPY" />
                  <Stat label="Tightest pair" value={`${co.ok[0]!.a} and ${co.ok[0]!.b}`} sub={fmtNum(co.ok[0]!.r.correlation, 2, true)} />
                  <Stat label="Loosest pair" value={`${co.ok[co.ok.length - 1]!.a} and ${co.ok[co.ok.length - 1]!.b}`} sub={fmtNum(co.ok[co.ok.length - 1]!.r.correlation, 2, true)} />
                </div>
                <Disclosure summary={`All pairs (${co.total})`}>
                  <DataTable
                    caption="Pairwise co movement"
                    rows={co.ok}
                    rowKey={(p) => `${p.a}-${p.b}`}
                    cols={[
                      { key: 'pair', header: 'Pair', sticky: true, cell: (p) => `${p.a} and ${p.b}` },
                      { key: 'c', header: 'Correlation', cell: (p) => fmtNum(p.r.correlation, 2, true) },
                      { key: 'x', header: 'Market excess', cell: (p) => (isNum(p.r.excessCorrelation) ? fmtNum(p.r.excessCorrelation, 2, true) : <Na why={p.r.excessCorrelation} />) },
                      { key: 's', header: 'Same direction', cell: (p) => (p.r.sameDirection ? `${fmtPct(p.r.sameDirection.rate, 0, false)} (${p.r.sameDirection.hits} of ${p.r.sameDirection.n})` : 'n/a') },
                      { key: 'n', header: 'Returns used', cell: (p) => `${p.r.n}${p.r.dropped ? `, ${p.r.dropped} dropped` : ''}` },
                      { key: 'd', header: 'Dates', align: 'l', cell: (p) => `${fmtDate(p.r.from)} to ${fmtDate(p.r.to)}` },
                    ]}
                  />
                  {co.sparse.length > 0 && (
                    <p className="small muted" style={{ marginTop: 8 }}>
                      Unavailable: {co.sparse.map((s) => `${s.a} and ${s.b} (${s.why})`).join(' ')}
                    </p>
                  )}
                </Disclosure>
              </div>
            )}
          </Card>
        </>
      )}
      {!selected && <p className="muted small">Select a group to see its members, who participated on the latest session, and how closely the names move together.</p>}
    </div>
  );
}
