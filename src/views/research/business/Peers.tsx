/** Peer valuation on the same canonical FY1 basis the quote strip uses. */
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useResearch } from '../../../app/research';
import { researchPath } from '../../../app/routes';
import { loadBundle, useAsync, useGroups } from '../../../data/client';
import { sliceAsOf } from '../../../engine/core/series';
import { isNa, na, numOrNull, type ISODate, type Maybe } from '../../../engine/core/types';
import { peerContext, valuationFacts, type ForwardPeRecord, type ValuationFacts } from '../../../engine/valuation';
import { Chip, DataTable, Missing, Segmented, Skeleton, Stat, StateNote, sortRows, type Column, type SortState } from '../../../ui/components';
import { fmtDate, fmtMoney, fmtMultiple, fmtPct, reasonDetail } from '../../../ui/format';

interface PeerRow {
  symbol: string;
  name: string;
  type: string;
  self: boolean;
  priceDate: ISODate | null;
  facts: ValuationFacts | null;
  issue: string | null;
}

const loadPeer = async (symbol: string, asOf: ISODate | null, self: string): Promise<PeerRow> => {
  const b = await loadBundle(symbol);
  if (isNa(b)) return { symbol, name: '', type: '', self: symbol === self, priceDate: null, facts: null, issue: reasonDetail(b) };
  const bars = isNa(b.series) ? [] : asOf ? sliceAsOf(b.series.bars, asOf) : b.series.bars;
  const last = bars[bars.length - 1];
  const price = last ? { close: last.close, date: last.date, currency: b.instrument.currency } : na('source-failed', 'No completed close');
  return { symbol: b.instrument.symbol, name: b.instrument.name, type: b.instrument.type, self: symbol === self, priceDate: last?.date ?? null, facts: valuationFacts(price, b.fundamentals), issue: null };
};

export function Peers({ subject }: { subject: Maybe<ForwardPeRecord> }) {
  const r = useResearch();
  const [sp, setSp] = useSearchParams();
  const groups = useGroups();
  const [sort, setSort] = useState<SortState>({ key: 'pe', dir: 'asc' });
  const mine = groups.status === 'ready' ? groups.data.filter((g) => g.members.includes(r.symbol)) : [];
  const group = mine.find((g) => g.id === sp.get('group')) ?? mine[0] ?? null;
  const asOf = r.frozen ? r.asOf : null;
  const peers = useAsync(group ? `peers:${group.id}:${r.symbol}:${asOf ?? ''}` : null, () => Promise.all(group!.members.map((m) => loadPeer(m, asOf, r.symbol))));
  const ctx = useMemo(() => {
    if (peers.status !== 'ready' || !r.asOf) return null;
    return peerContext(subject, peers.data.filter((p) => !p.self).map((p) => ({ symbol: p.symbol, record: p.facts ? p.facts.forwardPe : na('no-coverage', p.issue ?? 'Not loaded') })), r.asOf);
  }, [peers, subject, r.asOf]);

  if (groups.status === 'loading') return <Skeleton h={120} />;
  if (groups.status === 'error') {
    return (
      <StateNote tone="error" title="Trading groups are unavailable." action={<button type="button" className="btn small" onClick={groups.reload}>Retry</button>}>
        {groups.error.message} Peer context needs a group. <Link to="/data">See source status</Link>
      </StateNote>
    );
  }
  if (!group) return <StateNote>{r.symbol} is not in a curated trading group, so there is no peer set to compare.</StateNote>;

  const cols: Column<PeerRow>[] = [
    {
      key: 'sym', header: 'Symbol', sticky: true, sort: (p) => p.symbol,
      cell: (p) => (p.self ? <strong>{p.symbol}</strong> : <Link to={researchPath(p.symbol, 'business', { asof: sp.get('asof') ?? undefined })}>{p.symbol}</Link>),
    },
    { key: 'name', header: 'Company', align: 'l', sort: (p) => p.name, cell: (p) => <span className="muted">{p.name || p.issue}{p.type === 'etf' ? ' (ETF)' : ''}</span> },
    { key: 'pe', header: 'Forward P/E', info: 'Completed close divided by the verified positive FY1 annual EPS estimate. Loss making names have no multiple.', sort: (p) => (p.facts && !isNa(p.facts.forwardPe) ? p.facts.forwardPe.value : null), cell: (p) => (!p.facts ? <span className="faint">n/a</span> : isNa(p.facts.forwardPe) ? <Missing why={p.facts.forwardPe} /> : fmtMultiple(p.facts.forwardPe.value)) },
    { key: 'cap', header: 'Market cap', sort: (p) => (p.facts ? numOrNull(p.facts.marketCap) : null), cell: (p) => (!p.facts || isNa(p.facts.marketCap) ? <span className="faint">n/a</span> : fmtMoney(p.facts.marketCap)) },
    { key: 'fcf', header: 'Latest FCF', info: 'Free cash flow of the newest fiscal quarter with a derivable figure.', sort: (p) => (p.facts && !isNa(p.facts.fcf) ? p.facts.fcf.value : null), cell: (p) => (!p.facts ? <span className="faint">n/a</span> : isNa(p.facts.fcf) ? <Missing why={p.facts.fcf} /> : <span title={`Quarter to ${fmtDate(p.facts.fcf.periodEnd)}`}>{fmtMoney(p.facts.fcf.value, true)}{p.facts.fcf.isLatestPeriod ? '' : ' *'}</span>) },
    { key: 'cash', header: 'Cash', sort: (p) => (p.facts && !isNa(p.facts.cash) ? p.facts.cash.value : null), cell: (p) => (!p.facts ? <span className="faint">n/a</span> : isNa(p.facts.cash) ? <Missing why={p.facts.cash} /> : fmtMoney(p.facts.cash.value)) },
    { key: 'date', header: 'Close date', sort: (p) => p.priceDate, cell: (p) => <span className="muted">{fmtDate(p.priceDate)}</span> },
  ];

  return (
    <div className="stack" style={{ gap: 12 }}>
      {mine.length > 1 && (
        <Segmented label="Peer group" value={group.id} options={mine.map((g) => ({ value: g.id, label: g.name }))} onChange={(id) => { const n = new URLSearchParams(sp); n.set('group', id); setSp(n, { replace: true }); }} />
      )}
      <div className="stats">
        <Stat
          label="Peer median forward P/E"
          info="Needs at least three peers with a compatible snapshot within seven days."
          value={!ctx ? '…' : isNa(ctx) ? <Missing why={ctx} /> : fmtMultiple(ctx.median)}
          sub={ctx && !isNa(ctx) ? `${ctx.n} peers, ${fmtMultiple(ctx.min)} to ${fmtMultiple(ctx.max)}` : ctx && isNa(ctx) ? ctx.detail?.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (d) => fmtDate(d)) : undefined}
        />
        <Stat
          label={`${r.symbol} within peers`}
          info="Midrank percentile of this stock's multiple inside the peer multiples. Higher means a higher multiple than more peers."
          value={!ctx ? '…' : isNa(ctx) ? <span className="faint">n/a</span> : isNa(ctx.subjectPercentile) ? <Missing why={ctx.subjectPercentile} /> : ctx.subjectPercentile <= 0 ? 'Below every peer' : ctx.subjectPercentile >= 1 ? 'Above every peer' : `${fmtPct(ctx.subjectPercentile, 0, false)} percentile`}
          sub={ctx && !isNa(ctx) && ctx.excluded.length ? `${ctx.excluded.length} left out: ${ctx.excluded.map((e) => e.symbol).join(', ')}` : undefined}
        />
      </div>
      {peers.status === 'loading' && <Skeleton h={160} />}
      {peers.status === 'error' && <StateNote tone="error" title="Peers could not be loaded." action={<button type="button" className="btn small" onClick={peers.reload}>Retry</button>}>{peers.error.message}</StateNote>}
      {peers.status === 'ready' && (
        <DataTable rows={sortRows(peers.data, cols, sort)} cols={cols} sort={sort} onSort={setSort} rowKey={(p) => p.symbol} selectedKey={r.symbol} caption={`${group.name} members on the same valuation basis`} />
      )}
      <p className="faint small">
        <Chip>{group.kind === 'curated-theme' ? 'Curated theme' : group.kind}</Chip> {group.basis.replace(/^Curated theme\.\s*/, '')} A theme is a research grouping, not evidence of co-movement. An asterisk marks a prior period figure.
      </p>
    </div>
  );
}
