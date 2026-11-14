/** Price, volume and closing drawdown for one range. Optional averages, candles and a comparison. */
import { useMemo } from 'react';
import { useResearch } from '../../../app/research';
import { useBars } from '../../../data/client';
import { sma } from '../../../engine/core/indicators';
import { minusMonths } from '../../../engine/core/series';
import { isNa } from '../../../engine/core/types';
import { drawdownSeries } from '../../../engine/drawdowns';
import { BarChart, CandleChart, LineChart, SERIES_COLORS, type BarDatum, type LineSeries } from '../../../ui/charts';
import { Card, Segmented, StateNote } from '../../../ui/components';
import { fmtDate, fmtDateShort, fmtInt, fmtPct, fmtPrice, reasonDetail } from '../../../ui/format';
import { useNarrow, useUrlState } from '../selloffs/shared';

const RANGES = [
  { value: '1m', label: '1M', months: 1 },
  { value: '3m', label: '3M', months: 3 },
  { value: '6m', label: '6M', months: 6 },
  { value: '1y', label: '1Y', months: 12 },
  { value: '5y', label: '5Y', months: 60 },
  { value: '10y', label: '10Y', months: 120 },
  { value: 'max', label: 'Max', months: null },
] as const;
type RangeId = (typeof RANGES)[number]['value'];
const MAS = [5, 10, 20, 50, 100, 200] as const;
const CANDLE_MAX = 135;

const fmtVol = (v: number): string => (v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : fmtInt(v));

export function PriceCard() {
  const r = useResearch();
  const { bars, instrument } = r;
  const [sp, set] = useUrlState();
  const rangeRaw = sp.get('range');
  const range: RangeId = RANGES.some((x) => x.value === rangeRaw) ? (rangeRaw as RangeId) : '1y';
  const n = bars.length;
  const last = bars[n - 1]!;

  const start = useMemo(() => {
    const months = RANGES.find((x) => x.value === range)!.months;
    if (months === null) return 0;
    const cut = minusMonths(last.date, months);
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid]!.date <= cut) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }, [bars, range, last.date, n]);
  const count = n - start;
  const short = count <= CANDLE_MAX;
  const candles = short && sp.get('style') === 'candle';

  const maRaw = sp.get('ma');
  const activeMas: number[] = maRaw === null ? (short ? [5, 20] : [50, 200]) : maRaw.split(',').map(Number).filter((x) => (MAS as readonly number[]).includes(x));
  const toggleMa = (m: number) => {
    const next = activeMas.includes(m) ? activeMas.filter((x) => x !== m) : [...activeMas, m].sort((a, b) => a - b);
    set({ ma: next.length ? next.join(',') : 'none' });
  };

  const cmpOptions = useMemo(() => {
    const list = ['SPY', 'QQQ', instrument.sectorEtf, 'SMH'].filter((s): s is string => !!s && s !== instrument.symbol);
    return [...new Set(list)];
  }, [instrument]);
  const cmpRaw = sp.get('cmp');
  const cmp = cmpRaw && cmpOptions.includes(cmpRaw) ? cmpRaw : null;
  const cmpBars = useBars(cmp, r.frozen && r.asOf ? r.asOf : undefined);

  const closes = useMemo(() => bars.map((b) => b.close), [bars]);
  const maSeries = useMemo(() => new Map(MAS.map((m) => [m, sma(closes, m)] as const)), [closes]);
  const dd = useMemo(() => drawdownSeries(bars), [bars]);

  const comparison = useMemo(() => {
    if (!cmp || cmpBars.status !== 'ready' || isNa(cmpBars.data)) return null;
    const byDate = new Map(cmpBars.data.map((b) => [b.date, b.close]));
    let k = Math.max(0, start - 1);
    while (k < n && !byDate.has(bars[k]!.date)) k++;
    if (k >= n - 1) return null;
    const sBase = bars[k]!.close;
    const cBase = byDate.get(bars[k]!.date)!;
    const stock: { x: number; y: number | null }[] = [];
    const other: { x: number; y: number | null }[] = [];
    let missing = 0;
    for (let i = k; i < n; i++) {
      stock.push({ x: i, y: bars[i]!.close / sBase - 1 });
      const c = byDate.get(bars[i]!.date);
      if (c === undefined) missing++;
      other.push({ x: i, y: c === undefined ? null : c / cBase - 1 });
    }
    return { stock, other, baseDate: bars[k]!.date, missing };
  }, [cmp, cmpBars, bars, start, n]);

  const lineSeries = useMemo<LineSeries[]>(() => {
    if (comparison) {
      return [
        { id: 's', label: instrument.symbol, points: comparison.stock, color: 'var(--accent)', width: 2 },
        { id: 'c', label: cmp!, points: comparison.other, color: 'var(--gold-line)' },
      ];
    }
    const out: LineSeries[] = [{ id: 'px', label: 'Close', color: 'var(--accent)', width: 2, points: bars.slice(start).map((b, j) => ({ x: start + j, y: b.close })) }];
    activeMas.forEach((m, k) => {
      const s = maSeries.get(m as (typeof MAS)[number])!;
      out.push({ id: `ma${m}`, label: `${m} day avg`, color: SERIES_COLORS[(k + 1) % SERIES_COLORS.length], width: 1.3, points: s.slice(start).map((v, j) => ({ x: start + j, y: v })) });
    });
    return out;
    // activeMas is derived from the URL string and range
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comparison, bars, start, maRaw, short, maSeries, instrument.symbol, cmp]);

  const volume = useMemo(() => {
    const win = bars.slice(start);
    if (win.some((b) => b.volume === null)) return null;
    const size = Math.max(1, Math.ceil(win.length / 130));
    const out: BarDatum[] = [];
    for (let i = 0; i < win.length; i += size) {
      const chunk = win.slice(i, i + size);
      const avg = chunk.reduce((s, b) => s + (b.volume ?? 0), 0) / chunk.length;
      const end = chunk[chunk.length - 1]!;
      out.push({ key: end.date, label: fmtDateShort(end.date), value: avg, color: 'var(--border-strong)', detail: size > 1 ? `Average of ${chunk.length} sessions to ${fmtDate(end.date)}` : fmtDate(end.date) });
    }
    return { bars: out, size };
  }, [bars, start]);

  const ddPoints = useMemo(() => dd.slice(start).map((p) => ({ x: p.index, y: p.drawdown })), [dd, start]);
  const xLabel = (x: number) => fmtDate(bars[Math.round(x)]?.date);
  const narrow = useNarrow();
  const xTicks = narrow ? [start, Math.round((start + n - 1) / 2), n - 1] : undefined;
  const first = bars[start]!;
  const winRet = start > 0 ? last.close / bars[start - 1]!.close - 1 : last.close / first.close - 1;

  return (
    <Card
      title="Price and drawdown"
      info="Completed session closes on the split-consistent quote basis, no dividends. The drawdown is each close against the running closing peak of the loaded history, so it reads zero at every new peak."
      sub={`${fmtDate(first.date)} to ${fmtDate(last.date)}, ${fmtInt(count)} sessions. Price change over the range ${fmtPct(winRet)}${start > 0 ? '' : ' from the first close in history'}.`}
    >
      <div className="row" style={{ marginBottom: 10 }}>
        <Segmented label="Range" value={range} options={RANGES.map((x) => ({ value: x.value, label: x.label }))} onChange={(v) => set({ range: v === '1y' ? null : v })} />
        <Segmented
          label="Chart style"
          value={candles ? 'candle' : 'line'}
          options={[
            { value: 'line', label: 'Line' },
            { value: 'candle', label: 'Candles', title: short ? undefined : 'Candles are available for ranges up to about six months' },
          ]}
          onChange={(v) => (v === 'candle' && !short ? undefined : set({ style: v === 'candle' ? 'candle' : null }))}
        />
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          Compare
          <select className="select" value={cmp ?? ''} onChange={(e) => set({ cmp: e.target.value || null })}>
            <option value="">None</option>
            {cmpOptions.map((s) => (
              <option key={s} value={s}>
                {s}
                {s === instrument.sectorEtf ? ' (sector)' : ''}
              </option>
            ))}
          </select>
        </label>
        {!comparison && (
          <span className="ov-ma" role="group" aria-label="Moving averages">
            {MAS.map((m) => (
              <button key={m} type="button" aria-pressed={activeMas.includes(m)} onClick={() => toggleMa(m)} title={`${m} session simple average`}>
                {m}
              </button>
            ))}
          </span>
        )}
      </div>
      {!short && sp.get('style') === 'candle' && <p className="muted small">Candles show for ranges up to about six months. Showing the line.</p>}
      {cmp && cmpBars.status === 'ready' && isNa(cmpBars.data) && <StateNote tone="warn" title={`${cmp} is unavailable.`}>{reasonDetail(cmpBars.data)}</StateNote>}
      {comparison && (
        <p className="muted small" style={{ marginBottom: 4 }}>
          Price return from the {fmtDate(comparison.baseDate)} close, on sessions both have.
          {comparison.missing > 0 ? ` ${cmp} lacks ${comparison.missing} of these sessions.` : ''} No dividends.
        </p>
      )}
      {candles ? (
        <CandleChart
          bars={bars.slice(start)}
          overlays={activeMas.map((m) => ({ label: `${m} day avg`, values: maSeries.get(m as (typeof MAS)[number])!.slice(start) }))}
          ariaLabel={`${instrument.symbol} daily candles from ${fmtDate(first.date)} to ${fmtDate(last.date)}`}
          dateLabel={fmtDateShort}
          yFormat={(y) => fmtPrice(y)}
        />
      ) : (
        <LineChart
          series={lineSeries}
          xLabel={xLabel}
          xTicks={comparison ? undefined : xTicks}
          yFormat={comparison ? (y) => fmtPct(y, 0) : (y) => fmtPrice(y)}
          zeroLine={!!comparison}
          height={280}
          ariaLabel={
            comparison
              ? `${instrument.symbol} against ${cmp}, price return since ${fmtDate(comparison.baseDate)}`
              : `${instrument.symbol} close from ${fmtDate(first.date)} to ${fmtDate(last.date)}, change ${fmtPct(winRet)}`
          }
        />
      )}
      {volume ? (
        <>
          <div className="ov-sub">Volume{volume.size > 1 ? `, average per ${volume.size} sessions` : ''}</div>
          <BarChart bars={volume.bars} yFormat={fmtVol} height={124} ariaLabel={`${instrument.symbol} volume over the same range`} />
        </>
      ) : (
        <p className="muted small">Volume is not verified for every session in this range.</p>
      )}
      <div className="ov-sub">Closing drawdown from the running peak</div>
      <LineChart
        series={[{ id: 'dd', label: 'Drawdown', color: 'var(--down)', points: ddPoints, area: true }]}
        xLabel={xLabel}
        xTicks={xTicks}
        yFormat={(y) => fmtPct(y, 0, false)}
        zeroLine
        height={150}
        legend={false}
        ariaLabel={`${instrument.symbol} closing drawdown over the same range. Latest ${fmtPct(dd[n - 1]!.drawdown, 1)}`}
      />
    </Card>
  );
}
