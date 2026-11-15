/** Relative tab: own return versus market, sector and a chosen benchmark on aligned sessions. */
import { useMemo } from 'react';
import { useBars, useInstruments } from '../../../data/client';
import { isNa, type Bar, type Maybe } from '../../../engine/core/types';
import {
  ALL_WINDOWS,
  relativeDivergences,
  relativeMatrix,
  type PivotDivergence,
  type RelativeMatrix,
  type RelativeRow,
  type WindowKey,
} from '../../../engine/relativeStrength';
import { LineChart } from '../../../ui/charts';
import { Card, Chip, DataTable, Disclosure, Missing, Pct, Segmented, Skeleton, StateNote, type Column } from '../../../ui/components';
import { dirClass, fmtDate, fmtNum, fmtPct, fmtPp, reasonDetail, reasonText } from '../../../ui/format';
import { shortWindow } from './util';

const LINE_WINDOWS: WindowKey[] = ['3M', '6M', '1Y', '3Y'];

const Pp = ({ v }: { v: number | null }) => (v === null ? <span className="faint">n/a</span> : <span className={`num ${dirClass(v)}`}>{fmtPp(v, 1)}</span>);

const rowOf = (m: Maybe<RelativeMatrix> | null, k: WindowKey): Maybe<RelativeRow> | null => {
  if (!m || isNa(m)) return null;
  return m.rows.find((r) => r.key === k)?.row ?? null;
};

function PivotFinding({ title, d, text }: { title: string; d: Maybe<PivotDivergence>; text: (d: PivotDivergence) => string }) {
  const active = !isNa(d) && d.active;
  return (
    <div data-active={active}>
      <div>
        <strong>{title}</strong> <Chip tone={active ? 'gold' : undefined}>{isNa(d) ? 'Unavailable' : d.active ? 'Present' : 'Not present'}</Chip>
      </div>
      <div className="muted small">{isNa(d) ? reasonDetail(d) : text(d)}</div>
    </div>
  );
}

export function RelativeTab({
  bars,
  symbol,
  sectorEtf,
  asOf,
  bm,
  onBm,
  lw,
  onLw,
  spy,
}: {
  bars: readonly Bar[];
  symbol: string;
  sectorEtf: string | null;
  asOf: string;
  bm: string;
  onBm: (s: string) => void;
  lw: WindowKey;
  onLw: (k: WindowKey) => void;
  spy: Maybe<Bar[]> | null;
}) {
  const all = useInstruments();
  const sector = useBars(sectorEtf && sectorEtf !== symbol ? sectorEtf : null, asOf);
  const chosen = useBars(bm !== symbol ? bm : null, asOf);
  const quick = [...new Set(['SPY', 'QQQ', sectorEtf, 'SMH'].filter((x): x is string => !!x && x !== symbol))];

  const mSpy = useMemo(() => (spy && !isNa(spy) && symbol !== 'SPY' ? relativeMatrix(bars, { symbol: 'SPY', bars: spy, role: 'market' }) : null), [bars, spy, symbol]);
  const sectorBars = sector.status === 'ready' && !isNa(sector.data) ? sector.data : null;
  const mSector = useMemo(() => (sectorBars && sectorEtf ? relativeMatrix(bars, { symbol: sectorEtf, bars: sectorBars, role: 'sector' }) : null), [bars, sectorBars, sectorEtf]);
  const bmBars = chosen.status === 'ready' && !isNa(chosen.data) ? chosen.data : null;
  const m = useMemo(() => (bmBars ? relativeMatrix(bars, { symbol: bm, bars: bmBars, role: bm === 'SPY' ? 'market' : bm === sectorEtf ? 'sector' : 'custom' }, { lineWindow: lw }) : null), [bars, bmBars, bm, sectorEtf, lw]);
  const div = useMemo(() => (bmBars ? relativeDivergences(bars, { symbol: bm, bars: bmBars }) : null), [bars, bmBars, bm]);

  const both: Column<WindowKey>[] = [
    { key: 'w', header: 'Window', sticky: true, cell: (k) => shortWindow(k) },
    {
      key: 'own',
      header: 'Own return',
      cell: (k) => {
        const r = rowOf(mSpy, k) ?? rowOf(mSector, k) ?? rowOf(m, k);
        return r && !isNa(r) ? <Pct v={r.own} digits={1} /> : <span className="faint" title={r ? reasonDetail(r) : undefined}>{r ? reasonText(r) : 'n/a'}</span>;
      },
    },
    { key: 'spy', header: 'Versus SPY', info: 'Own return minus the SPY return over the same aligned sessions, in percentage points.', cell: (k) => { const r = rowOf(mSpy, k); return <Pp v={r && !isNa(r) ? r.excessPp : null} />; } },
    ...(sectorEtf && sectorEtf !== symbol
      ? [{ key: 'sec', header: `Versus ${sectorEtf}`, info: 'Own return minus the sector fund return over the same aligned sessions, in percentage points.', cell: (k: WindowKey) => { const r = rowOf(mSector, k); return <Pp v={r && !isNa(r) ? r.excessPp : null} />; } } as Column<WindowKey>]
      : []),
  ];

  const detail: Column<{ key: WindowKey; label: string; row: Maybe<RelativeRow> }>[] = [
    { key: 'w', header: 'Window', sticky: true, cell: (r) => shortWindow(r.key) },
    { key: 'own', header: 'Own', cell: (r) => (isNa(r.row) ? <span className="faint" title={reasonDetail(r.row)}>{reasonText(r.row)}</span> : <Pct v={r.row.own} digits={1} />) },
    { key: 'bm', header: bm, cell: (r) => (isNa(r.row) ? '' : <Pct v={r.row.benchmark} digits={1} />) },
    { key: 'ex', header: 'Excess', cell: (r) => (isNa(r.row) ? '' : <Pp v={r.row.excessPp} />) },
    { key: 'rw', header: 'Relative wealth', info: 'One plus own return, divided by one plus the benchmark return. Above 1 means the stock gained on the benchmark.', cell: (r) => (isNa(r.row) ? '' : <span className="num">{fmtNum(r.row.relativeWealth, 3)}</span>) },
    { key: 'ch', header: '5 session change', info: 'Change in this window excess versus five aligned sessions earlier.', cell: (r) => (isNa(r.row) || isNa(r.row.excessChange) ? '' : <Pp v={r.row.excessChange} />) },
    { key: 'dir', header: 'Direction', cell: (r) => (isNa(r.row) || isNa(r.row.direction) ? '' : r.row.direction === 'improving' ? '▲ Improving' : r.row.direction === 'weakening' ? '▼ Weakening' : 'Flat') },
    { key: 'rh', header: 'Ratio high', info: 'Date of the highest stock to benchmark price ratio inside the window.', cell: (r) => (isNa(r.row) ? '' : fmtDate(r.row.ratioHigh.date)) },
    { key: 'rl', header: 'Ratio low', cell: (r) => (isNa(r.row) ? '' : fmtDate(r.row.ratioLow.date)) },
  ];

  const lineRow = rowOf(m, lw);
  const line = m && !isNa(m) ? m.line : [];
  const markAt = (date: string, color: string, label: string) => {
    const x = line.findIndex((p) => p.date === date);
    return x >= 0 ? [{ x, y: line[x]!.wealth100, color, label }] : [];
  };

  return (
    <>
      <Card title="Versus market and sector" info="Price returns on sessions both series share. Differences are percentage points, not percent." sub={mSpy && !isNa(mSpy) ? `Through ${fmtDate(mSpy.anchorDate)}.` : undefined}>
        {symbol === 'SPY' && !sectorEtf ? (
          <StateNote>SPY is the market reference. Choose another benchmark below.</StateNote>
        ) : (
          <DataTable rows={ALL_WINDOWS} cols={both} rowKey={(k) => k} caption="Own return and excess versus SPY and the sector fund by window" />
        )}
      </Card>

      <Card
        title={`Strength versus ${bm}`}
        actions={
          <div className="st-controls">
            <Segmented label="Benchmark" value={quick.includes(bm) ? bm : ''} options={quick.map((q) => ({ value: q, label: q }))} onChange={onBm} />
            <label className="sr-only" htmlFor="st-bm">Any loaded symbol</label>
            <select id="st-bm" className="select" value={bm} onChange={(e) => onBm(e.target.value)}>
              {(all.status === 'ready' ? all.data : []).filter((x) => x.symbol !== symbol).map((x) => (
                <option key={x.id} value={x.symbol}>{x.symbol}</option>
              ))}
            </select>
          </div>
        }
      >
        {bm === symbol && <StateNote>Choose a benchmark other than {symbol}.</StateNote>}
        {bm !== symbol && chosen.status === 'loading' && <Skeleton h={220} />}
        {bm !== symbol && chosen.status === 'error' && <StateNote tone="error" action={<button type="button" className="btn small" onClick={chosen.reload}>Retry</button>}>{chosen.error.message}</StateNote>}
        {bm !== symbol && chosen.status === 'ready' && isNa(chosen.data) && <Missing why={chosen.data} block />}
        {m && isNa(m) && <Missing why={m} block />}
        {m && !isNa(m) && (
          <>
            {m.anchorLagsStock && <StateNote tone="warn">{bm} does not reach the stock's latest session. The comparison ends {fmtDate(m.anchorDate)}.</StateNote>}
            <div className="row" style={{ marginBottom: 6 }}>
              <span className="muted small">Line starts</span>
              <Segmented label="Strength line start" value={lw} options={LINE_WINDOWS.map((k) => ({ value: k, label: k }))} onChange={onLw} />
            </div>
            <LineChart
              series={[{ id: 'rw', label: `${symbol} over ${bm}, start 100`, points: line.map((p, x) => ({ x, y: p.wealth100 })) }]}
              xLabel={(x) => fmtDate(line[x]?.date)}
              yFormat={(y) => fmtNum(y, 1)}
              hLines={[{ y: 100, label: 'Start 100' }]}
              markers={lineRow && !isNa(lineRow) ? [...markAt(lineRow.ratioHigh.date, 'var(--up)', 'Ratio high'), ...markAt(lineRow.ratioLow.date, 'var(--down)', 'Ratio low')] : []}
              ariaLabel={`Relative wealth of ${symbol} versus ${bm} from ${fmtDate(m.lineFrom)}, start 100, latest ${fmtNum(line[line.length - 1]?.wealth100 ?? null, 1)}`}
              height={230}
              legend={false}
            />
            <p className="faint small" style={{ margin: '4px 0 12px' }}>
              Normalized relative wealth from {fmtDate(m.lineFrom)}. Above 100 means {symbol} gained on {bm} since the start.
              {lineRow && !isNa(lineRow) ? ` Ratio high ${fmtDate(lineRow.ratioHigh.date)}, ${lineRow.ratioHigh.sessionsSince} sessions ago. Ratio low ${fmtDate(lineRow.ratioLow.date)}.` : ''}
            </p>
            <DataTable rows={m.rows} cols={detail} rowKey={(r) => r.key} caption={`Relative matrix versus ${bm}`} />
            <Disclosure summary="Alignment and coverage">
              <dl className="kv">
                <dt>Common range</dt>
                <dd>{fmtDate(m.commonFrom)} to {fmtDate(m.commonTo)}, {m.alignedSessions.toLocaleString('en-US')} shared sessions</dd>
                <dt>Dropped rows</dt>
                <dd>{m.droppedRows} sessions inside the common range existed in only one series and are excluded from both legs</dd>
                <dt>Raw price ratio</dt>
                <dd>{fmtNum(line[line.length - 1]?.ratio ?? null, 4)} on {fmtDate(m.anchorDate)}. A price ratio, not a return.</dd>
              </dl>
            </Disclosure>
          </>
        )}
      </Card>

      {div && (
        <Card title={`Divergences versus ${bm}`} info="Tests between price and the stock to benchmark ratio on aligned sessions. Swing pivots count only from their confirm date. These are observations, not validated signals.">
          {isNa(div) ? (
            <Missing why={div} block />
          ) : (
            <div className="st-find">
              <div data-active={!isNa(div.relativeLeading) && div.relativeLeading.active}>
                <div>
                  <strong>Relative leading</strong>{' '}
                  <Chip tone={!isNa(div.relativeLeading) && div.relativeLeading.active ? 'gold' : undefined}>{isNa(div.relativeLeading) ? 'Unavailable' : div.relativeLeading.active ? 'Present' : 'Not present'}</Chip>
                </div>
                <div className="muted small">
                  {isNa(div.relativeLeading)
                    ? reasonDetail(div.relativeLeading)
                    : `On ${fmtDate(div.relativeLeading.date)} the ratio ${div.relativeLeading.ratioAtNewHigh ? 'is' : 'is not'} at a new 3 month high and the close is ${fmtPct(Math.abs(div.relativeLeading.priceGapToHigh), 1, false)} below its 3 month closing high. The rule needs a ratio high with price more than 1% below its high.`}
                </div>
              </div>
              <PivotFinding
                title="Lower price low, ratio improving"
                d={div.lowerLowRatioImproving}
                text={(d) => `Swing lows ${fmtDate(d.first.eventDate)} and ${fmtDate(d.second.eventDate)}. Price ${fmtPct(d.priceChange, 1)}, ratio ${fmtPct(d.ratioChange, 1)}. Knowable from ${fmtDate(d.confirmDate)}.`}
              />
              <PivotFinding
                title="Higher price high, ratio weaker"
                d={div.higherHighRatioWeaker}
                text={(d) => `Swing highs ${fmtDate(d.first.eventDate)} and ${fmtDate(d.second.eventDate)}. Price ${fmtPct(d.priceChange, 1)}, ratio ${fmtPct(d.ratioChange, 1)}. Knowable from ${fmtDate(d.confirmDate)}.`}
              />
            </div>
          )}
        </Card>
      )}
    </>
  );
}
