/** Cash flow: dated cash on hand and the latest fiscal period free cash flow, next to price behavior. */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { median } from '../../engine/core/stats';
import { isNa, isNum } from '../../engine/core/types';
import { applyUniverse, searchRows, type ScreenerRow } from '../../engine/screener';
import { Card, Chip, DataTable, Sheet, Skeleton, sortRows, Stat, StateNote, type Column, type SortState } from '../../ui/components';
import { fmtDate, fmtMoney, fmtPct, reasonDetail } from '../../ui/format';
import { useCapParam, useIsPhone, useParam, useScrollRestore } from './shared/hooks';
import { CapControl, capLabel, DiscoverIssues, Na, PctCell, SymbolLink } from './shared/parts';
import { useDiscoverData } from './shared/useDiscoverData';

const SCOPE: Record<string, string> = { quarter: 'Quarter', 'fiscal-year': 'Fiscal year', ttm: 'Trailing year', ytd: 'Fiscal year to date' };

export default function CashFlow() {
  const d = useDiscoverData();
  const nav = useNavigate();
  const phone = useIsPhone();
  const [cap, setCap] = useCapParam();
  const [q, setQ] = useParam<string>('q', '');
  const [only, setOnly] = useParam<'' | 'pos' | 'neg'>('fcf', '', ['', 'pos', 'neg']);
  const [prior, setPrior] = useParam<'' | '1'>('prior', '', ['', '1']);
  const [sortParam, setSortParam] = useParam<string>('sort', '');
  const [detail, setDetail] = useState<ScreenerRow | null>(null);
  useScrollRestore(d.status === 'ready');

  const includePrior = prior === '1';
  /** FCF used for sorting and filtering. A prior period value counts only when the user opts in. */
  const fcfOf = (r: ScreenerRow): number | null => (isNum(r.fcf) ? r.fcf : includePrior && !isNa(r.fcfRecord) ? r.fcfRecord.value : null);

  const uni = useMemo(() => (d.status === 'ready' ? applyUniverse(d.data.rows, cap).rows : null), [d, cap]);
  const rows = useMemo(() => {
    if (!uni) return [];
    return searchRows(uni, q).filter((r) => {
      if (!only) return true;
      const v = isNum(r.fcf) ? r.fcf : includePrior && !isNa(r.fcfRecord) ? r.fcfRecord.value : null;
      return v !== null && (only === 'pos' ? v > 0 : v < 0);
    });
  }, [uni, q, only, includePrior]);

  if (d.status === 'loading') return <Skeleton h={420} />;
  if (d.status === 'error' || !uni) {
    return (
      <StateNote tone="error" title="Cash flow could not be loaded." action={<button type="button" className="btn small" onClick={d.reload}>Retry</button>}>
        {d.status === 'error' ? d.error.message : 'Unavailable'}
      </StateNote>
    );
  }
  const [sk, sd] = sortParam.split('.');
  const sort: SortState = sk && (sd === 'asc' || sd === 'desc') ? { key: sk, dir: sd } : { key: 'fcf', dir: 'desc' };
  const open = (r: ScreenerRow) => nav(`/research/${encodeURIComponent(r.symbol)}/business`);
  const rec = (r: ScreenerRow) => (isNa(r.fcfRecord) ? null : r.fcfRecord);

  const current = uni.filter((r) => isNum(r.fcf));
  const fallback = uni.filter((r) => !isNum(r.fcf) && !isNa(r.fcfRecord));
  const pos = current.filter((r) => (r.fcf as number) > 0);
  const neg = current.filter((r) => (r.fcf as number) < 0);
  const ytdOf = (xs: ScreenerRow[]) => xs.map((r) => r.ytd).filter(isNum);
  const posYtd = ytdOf(pos);
  const negYtd = ytdOf(neg);

  const all: Column<ScreenerRow>[] = [
    { key: 'symbol', header: 'Symbol', sticky: true, sort: (r) => r.symbol, cell: (r) => <SymbolLink symbol={r.symbol} section="business" /> },
    { key: 'name', header: 'Company', align: 'l', sort: (r) => r.name, cell: (r) => <span className="dv-name" title={r.name}>{r.name}</span> },
    {
      key: 'cash', header: 'Cash on hand', info: 'Cash and cash equivalents at the balance sheet date shown. It does not show current cash generation.', sort: (r) => (isNum(r.cash) ? r.cash : null),
      cell: (r) => (isNa(r.cashRecord) ? <Na why={r.cashRecord} /> : <span>{fmtMoney(r.cashRecord.value)}<span className="dv-sub">at {fmtDate(r.cashRecord.asOf)}</span></span>),
    },
    {
      key: 'fcf', header: 'Free cash flow', info: 'Operating cash flow minus capital expenditure for the newest released fiscal period of one scope. When the newest report has no free cash flow, the latest earlier period is shown, flagged, and left out of sorting and filters unless you include it.',
      sort: fcfOf,
      cell: (r) => {
        const f = rec(r);
        if (!f) return <Na why={r.fcfRecord} />;
        return (
          <span>
            <span className={f.isLatestPeriod ? (f.value >= 0 ? 'up' : 'down') : 'muted'}>{fmtMoney(f.value, true)}</span>{' '}
            {!f.isLatestPeriod && <Chip tone="warn" title={f.note ?? `The report for ${f.newestPeriodEnd} has no free cash flow`}>Prior period</Chip>}
            <span className="dv-sub">{SCOPE[f.scope] ?? f.scope} to {fmtDate(f.periodEnd)}</span>
          </span>
        );
      },
    },
    { key: 'ocf', header: 'Operating cash flow', sort: (r) => rec(r)?.operatingCashFlow ?? null, cell: (r) => (rec(r) ? fmtMoney(rec(r)!.operatingCashFlow, true) : <Na why={r.fcfRecord} />) },
    { key: 'capex', header: 'Capex', info: 'Capital expenditure as a positive outflow.', sort: (r) => rec(r)?.capex ?? null, cell: (r) => (rec(r) ? fmtMoney(rec(r)!.capex) : <Na why={r.fcfRecord} />) },
    { key: 'filed', header: 'Filed', sort: (r) => rec(r)?.filedAt ?? null, cell: (r) => (rec(r) ? (rec(r)!.filedAt === rec(r)!.periodEnd ? 'Not provided' : fmtDate(rec(r)!.filedAt)) : <Na why={r.fcfRecord} />) },
    { key: 'ytd', header: 'YTD price', info: 'Price return from the final close of the prior year. Shown beside free cash flow for comparison only.', sort: (r) => (isNum(r.ytd) ? r.ytd : null), cell: (r) => <PctCell v={r.ytd} /> },
    { key: 'cap', header: 'Cap', sort: (r) => (isNum(r.marketCap) ? r.marketCap : null), cell: (r) => (isNum(r.marketCap) ? fmtMoney(r.marketCap) : <Na why={r.marketCap} />) },
  ];
  const cols = phone ? all.filter((c) => ['symbol', 'fcf', 'cash', 'ytd'].includes(c.key)) : all;
  const sorted = sortRows(rows, all, sort);

  return (
    <div className="stack">
      <DiscoverIssues issues={d.data.issues} />
      <Card title="Cash and free cash flow" info={`Stocks at or above ${capLabel(cap)}. Every figure carries its fiscal period or balance sheet date. Scopes are never mixed.`}>
        <div className="stack" style={{ gap: 12 }}>
          <div className="stats">
            <Stat label="Current period FCF" value={`${current.length} of ${uni.length}`} sub="stocks with the newest period" />
            <Stat label="Positive FCF" value={`${pos.length} of ${current.length}`} />
            <Stat label="Prior period only" value={fallback.length} sub="newest report lacks FCF" />
            <Stat
              label="Median YTD price"
              info="Exploratory. A side by side description of this list on one date, not a tested relationship and not a forecast."
              value={<>{posYtd.length ? fmtPct(median(posYtd), 1) : 'n/a'} <span className="muted" style={{ fontSize: 12, fontWeight: 500 }}>vs</span> {negYtd.length ? fmtPct(median(negYtd), 1) : 'n/a'}</>}
              sub={`positive FCF (${posYtd.length}) vs negative (${negYtd.length})`}
            />
          </div>
          <div className="dv-toolbar">
            <CapControl value={cap} onChange={setCap} />
            <label className="field grow">
              Search ticker, company or group
              <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            <label className="field">
              Free cash flow
              <select className="select" value={only} onChange={(e) => setOnly(e.target.value as '' | 'pos' | 'neg')}>
                <option value="">Any</option>
                <option value="pos">Positive</option>
                <option value="neg">Negative</option>
              </select>
            </label>
            <label className="row small" style={{ gap: 6, minHeight: 34 }}>
              <input type="checkbox" checked={includePrior} onChange={(e) => setPrior(e.target.checked ? '1' : '')} />
              Include prior period values in sort and filter
            </label>
            <span className="dv-count num" role="status">{rows.length} of {uni.length} stocks</span>
          </div>
          <DataTable
            caption="Cash on hand and free cash flow by stock"
            rows={sorted}
            cols={cols}
            rowKey={(r) => r.symbol}
            sort={sort}
            onSort={(s) => setSortParam(`${s.key}.${s.dir}`)}
            onRow={phone ? setDetail : open}
            empty="No stock matches. Clear the search or the free cash flow filter."
          />
        </div>
      </Card>
      {detail && (
        <Sheet title={`${detail.symbol}  ${detail.name}`} onClose={() => setDetail(null)}>
          <div className="stack" style={{ gap: 12 }}>
            <button type="button" className="btn primary" style={{ minHeight: 44 }} onClick={() => open(detail)}>Open business research</button>
            <dl className="kv">
              <dt>Cash on hand</dt><dd>{isNa(detail.cashRecord) ? reasonDetail(detail.cashRecord) : `${fmtMoney(detail.cashRecord.value)} at ${fmtDate(detail.cashRecord.asOf)}`}</dd>
              {rec(detail) ? (
                <>
                  <dt>Free cash flow</dt><dd>{fmtMoney(rec(detail)!.value, true)}, {(SCOPE[rec(detail)!.scope] ?? rec(detail)!.scope).toLowerCase()} to {fmtDate(rec(detail)!.periodEnd)}{rec(detail)!.isLatestPeriod ? '' : '. Prior period, the newest report has none.'}</dd>
                  <dt>Operating cash flow</dt><dd>{fmtMoney(rec(detail)!.operatingCashFlow, true)}</dd>
                  <dt>Capex</dt><dd>{fmtMoney(rec(detail)!.capex)}</dd>
                  <dt>Filed</dt><dd>{rec(detail)!.filedAt === rec(detail)!.periodEnd ? 'Not provided by the source' : fmtDate(rec(detail)!.filedAt)}</dd>
                </>
              ) : (
                <><dt>Free cash flow</dt><dd>{isNa(detail.fcfRecord) ? reasonDetail(detail.fcfRecord) : 'n/a'}</dd></>
              )}
              <dt>YTD price</dt><dd><PctCell v={detail.ytd} /></dd>
              <dt>Market cap</dt><dd>{isNum(detail.marketCap) ? fmtMoney(detail.marketCap) : 'n/a'}</dd>
            </dl>
          </div>
        </Sheet>
      )}
    </div>
  );
}
