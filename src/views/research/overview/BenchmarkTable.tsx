/** Same-date closing drawdown and YTD for the stock, benchmarks and its sector fund. */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useResearch } from '../../../app/research';
import { researchPath } from '../../../app/routes';
import { useBars } from '../../../data/client';
import { indexOfDate, periodToDate } from '../../../engine/core/series';
import { isNa, type Bar } from '../../../engine/core/types';
import { benchmarkDrawdownTable } from '../../../engine/drawdowns';
import { Card, Missing, Pct, Skeleton } from '../../../ui/components';
import { fmtDate, fmtDateShort } from '../../../ui/format';

export function BenchmarkTable() {
  const r = useResearch();
  const asof = r.frozen && r.asOf ? r.asOf : undefined;
  const sym = r.symbol;
  const slots = useMemo(() => {
    const base = ['SPY', 'QQQ', 'SMH', 'XLK', r.instrument.sectorEtf ?? null];
    const seen = new Set<string>([sym]);
    return base.map((s) => {
      if (!s || seen.has(s)) return null;
      seen.add(s);
      return s;
    });
  }, [sym, r.instrument.sectorEtf]);
  const a = useBars(slots[0] ?? null, asof);
  const b = useBars(slots[1] ?? null, asof);
  const c = useBars(slots[2] ?? null, asof);
  const d = useBars(slots[3] ?? null, asof);
  const e = useBars(slots[4] ?? null, asof);
  const loads = [a, b, c, d, e];
  const pending = slots.some((s, i) => s && loads[i]!.status === 'loading');

  const table = useMemo(() => {
    const series: { symbol: string; bars: readonly Bar[]; why?: string }[] = [{ symbol: sym, bars: r.bars }];
    slots.forEach((s, i) => {
      if (!s) return;
      const l = loads[i]!;
      if (l.status === 'ready' && !isNa(l.data)) series.push({ symbol: s, bars: l.data });
      else if (l.status !== 'loading') series.push({ symbol: s, bars: [], why: l.status === 'error' ? l.error.message : l.status === 'ready' && isNa(l.data) ? (l.data.detail ?? 'Unavailable') : 'Unavailable' });
    });
    const t = benchmarkDrawdownTable(series, r.asOf ?? undefined);
    return t.rows.map((row, i) => {
      const s = series[i]!;
      const k = t.asOf ? indexOfDate(s.bars as Bar[], t.asOf) : -1;
      return { ...row, ytd: k >= 0 ? periodToDate(s.bars, k, 'Y') : null, why: s.why };
    });
    // loads are stable per status; key on their data identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sym, r.bars, r.asOf, slots, a.data, b.data, c.data, d.data, e.data, a.status, b.status, c.status, d.status, e.status]);

  return (
    <Card title="Against market and sector" info="Each row uses closes through the same session. Drawdown is the close against that series' own running closing peak in its loaded history. YTD is the price return from the prior year's final close." sub={`Closes on ${fmtDate(r.asOf)}.`}>
      {pending ? (
        <Skeleton h={150} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <caption className="sr-only">Closing drawdown and year to date return by symbol</caption>
            <thead>
              <tr>
                <th className="l" scope="col">Symbol</th>
                <th scope="col">Drawdown</th>
                <th scope="col">Peak</th>
                <th scope="col">YTD</th>
              </tr>
            </thead>
            <tbody>
              {table.map((row) => (
                <tr key={row.symbol} className={row.symbol === sym ? 'selected' : undefined}>
                  <td className="l">
                    {row.symbol === sym ? <strong>{row.symbol}</strong> : <Link to={researchPath(row.symbol, 'overview', { asof })}>{row.symbol}</Link>}
                    {row.symbol === r.instrument.sectorEtf && <span className="faint small"> sector</span>}
                  </td>
                  <td>{isNa(row.point) ? <Missing why={row.why ?? row.point} /> : <Pct v={row.point.drawdown} digits={1} />}</td>
                  <td className="muted">{isNa(row.point) ? '' : row.point.drawdown === 0 ? 'At peak' : `${fmtDateShort(row.point.peakDate)} ${row.point.peakDate.slice(0, 4)}`}</td>
                  <td>{row.ytd === null ? <span className="faint">n/a</span> : isNa(row.ytd) ? <Missing why={row.ytd} /> : <Pct v={row.ytd.ret} digits={1} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
