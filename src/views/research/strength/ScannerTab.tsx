/** Scanner tab: the loaded universe on one common completed date. Separate metrics, no composite score. */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { loadBars, useAsync, useInstruments } from '../../../data/client';
import { isNa, type Bar, type Instrument } from '../../../engine/core/types';
import { scannerPresets, scannerRow, type RangeBasis, type ScannerRow } from '../../../engine/relativeStrength';
import { researchPath } from '../../../app/routes';
import { Card, Chip, DataTable, Disclosure, Pct, Segmented, Skeleton, sortRows, StateNote, type Column, type SortState } from '../../../ui/components';
import { dirClass, fmtDate, fmtMultiple, fmtPct, fmtPp, fmtPrice } from '../../../ui/format';
import { useNarrow } from './util';

const PRESETS = [
  { id: 'all', label: 'All rows' },
  { id: 'near1M', label: 'Near the 1 month high' },
  { id: 'near3M', label: 'Near the 3 month high' },
  { id: 'near6M', label: 'Near the 6 month high' },
  { id: 'near1Y', label: 'Near the 1 year high' },
  { id: 'newHigh', label: 'New 1, 3 or 6 month high' },
  { id: 'early', label: 'Early strength, far from the 1 year high' },
  { id: 'falling', label: 'Rising stock, falling ratio' },
  { id: 'compress', label: 'Breakout after compression' },
  { id: 'holding', label: 'Holding up while the market falls' },
] as const;
export type PresetId = (typeof PRESETS)[number]['id'];
export const PRESET_IDS = PRESETS.map((p) => p.id);

const applyPreset = (rows: readonly ScannerRow[], id: PresetId): ScannerRow[] => {
  switch (id) {
    case 'near1M': return scannerPresets.nearHigh(rows, '1M');
    case 'near3M': return scannerPresets.nearHigh(rows, '3M');
    case 'near6M': return scannerPresets.nearHigh(rows, '6M');
    case 'near1Y': return scannerPresets.nearHigh(rows, '1Y');
    case 'newHigh': return scannerPresets.newIntermediateHigh(rows);
    case 'early': return scannerPresets.earlyStrength(rows);
    case 'falling': return scannerPresets.fallingRatioRisingStock(rows);
    case 'compress': return scannerPresets.breakoutAfterCompression(rows);
    case 'holding': return scannerPresets.holdingUpInDownMarket(rows);
    default: return [...rows];
  }
};

interface Scan {
  date: string;
  rows: ScannerRow[];
  excluded: { symbol: string; reason: string }[];
}

/** Build rows in small chunks so the main thread never holds for long. */
const runScan = async (instruments: readonly Instrument[], date: string, proximity: number, basis: RangeBasis): Promise<Scan> => {
  const barsOf = new Map<string, Bar[]>();
  const excluded: Scan['excluded'] = [];
  const get = async (symbol: string): Promise<Bar[] | null> => {
    const hit = barsOf.get(symbol);
    if (hit) return hit;
    const b = await loadBars(symbol, date);
    if (isNa(b)) return null;
    barsOf.set(symbol, b);
    return b;
  };
  const spy = await get('SPY');
  const market = spy ? { symbol: 'SPY', bars: spy, role: 'market' as const } : undefined;
  const rows: ScannerRow[] = [];
  let k = 0;
  for (const inst of instruments) {
    const bars = await get(inst.symbol);
    if (!bars) {
      excluded.push({ symbol: inst.symbol, reason: 'Price history unavailable' });
      continue;
    }
    const sec = inst.sectorEtf && inst.sectorEtf !== inst.symbol ? await get(inst.sectorEtf) : null;
    const r = scannerRow({ instrumentId: inst.id, symbol: inst.symbol, bars }, date, { market, proximity, basis, sectorOf: () => (sec && inst.sectorEtf ? { symbol: inst.sectorEtf, bars: sec, role: 'sector' } : null) });
    if (isNa(r)) excluded.push({ symbol: inst.symbol, reason: r.detail ?? r.code });
    else rows.push(r);
    if (++k % 2 === 0) await new Promise((res) => setTimeout(res, 0));
  }
  return { date, rows, excluded };
};

const N = ({ v, f }: { v: number | null; f: (x: number) => string }) => (v === null ? <span className="faint">n/a</span> : <span className={`num ${dirClass(v)}`}>{f(v)}</span>);

export function ScannerTab({ date, basis, preset, prox, funds, set, current }: { date: string; basis: RangeBasis; preset: PresetId; prox: string; funds: boolean; set: (c: Record<string, string | null>) => void; current: string }) {
  const narrow = useNarrow();
  const all = useInstruments();
  const proximity = Number(prox) / 100;
  const scan = useAsync<Scan>(all.status === 'ready' ? `strength-scan:${date}:${prox}:${basis}` : null, () => runScan(all.status === 'ready' ? all.data : [], date, proximity, basis));
  const [sort, setSort] = useState<SortState | null>({ key: 'g3', dir: 'desc' });
  const typeOf = useMemo(() => new Map((all.status === 'ready' ? all.data : []).map((x) => [x.symbol, x.type])), [all]);

  const flags = (r: ScannerRow): string[] => {
    const out: string[] = [];
    for (const k of ['1M', '3M', '6M'] as const) if (r.newHigh[k]) out.push(`New ${k} high`);
    if (r.earlyStrength) out.push('Early strength');
    if (r.fallingRatioRisingStock) out.push('Falling ratio');
    if (r.breakoutAfterCompression) out.push('After compression');
    if (r.holdingUpInDownMarket) out.push('Holding up');
    return out;
  };

  const cols: Column<ScannerRow>[] = [
    { key: 'sym', header: 'Symbol', sticky: true, sort: (r) => r.symbol, cell: (r) => <Link to={researchPath(r.symbol, 'strength')} onClick={(e) => e.stopPropagation()}><strong>{r.symbol}</strong></Link> },
    { key: 'state', header: 'State', align: 'l', info: 'Threshold classification of range positions. Not a validated signal.', sort: (r) => r.state, cell: (r) => r.state },
    ...(narrow ? [] : ([{ key: 'close', header: 'Close', sort: (r) => r.close, cell: (r) => fmtPrice(r.close) }] as Column<ScannerRow>[])),
    { key: 'g1', header: <>To 1M<br />high</>, sort: (r) => r.gapToHigh['1M'], cell: (r) => <N v={r.gapToHigh['1M']} f={(x) => fmtPct(x, 1)} /> },
    { key: 'g3', header: <>To 3M<br />high</>, sort: (r) => r.gapToHigh['3M'], cell: (r) => <N v={r.gapToHigh['3M']} f={(x) => fmtPct(x, 1)} /> },
    ...(narrow
      ? []
      : ([
          { key: 'g6', header: <>To 6M<br />high</>, sort: (r) => r.gapToHigh['6M'], cell: (r) => <N v={r.gapToHigh['6M']} f={(x) => fmtPct(x, 1)} /> },
          { key: 'gy', header: <>To 1Y<br />high</>, sort: (r) => r.gapToHigh['1Y'], cell: (r) => <N v={r.gapToHigh['1Y']} f={(x) => fmtPct(x, 1)} /> },
          { key: 'age', header: <>Sessions since<br />3M high</>, sort: (r) => r.sessionsSinceHigh['3M'], cell: (r) => r.sessionsSinceHigh['3M'] ?? <span className="faint">n/a</span> },
          { key: 'pos', header: <>3M<br />position</>, sort: (r) => r.rangePosition['3M'], cell: (r) => (r.rangePosition['3M'] === null ? <span className="faint">n/a</span> : fmtPct(r.rangePosition['3M'], 0, false)) },
          { key: 'r1', header: <>1M<br />return</>, sort: (r) => r.ret1M, cell: (r) => <Pct v={r.ret1M} digits={1} /> },
          { key: 'r3', header: <>3M<br />return</>, sort: (r) => r.ret3M, cell: (r) => <Pct v={r.ret3M} digits={1} /> },
          { key: 'em', header: <>3M versus<br />SPY</>, sort: (r) => r.excessMarket3M, cell: (r) => <N v={r.excessMarket3M} f={(x) => fmtPp(x, 1)} /> },
          { key: 'es', header: <>3M versus<br />sector</>, sort: (r) => r.excessSector3M, cell: (r) => <N v={r.excessSector3M} f={(x) => fmtPp(x, 1)} /> },
          { key: 'rv', header: <>Relative<br />volume</>, sort: (r) => r.relativeVolume, cell: (r) => (r.relativeVolume === null ? <span className="faint">n/a</span> : fmtMultiple(r.relativeVolume)) },
          { key: 'fl', header: 'Observed', align: 'l', cell: (r) => <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>{flags(r).map((f) => <Chip key={f}>{f}</Chip>)}</span> },
          { key: 'val', header: 'Outcome score', align: 'l', info: 'Outcome validation runs on the Breakouts tab for one stock at a time. An unscored row is not a zero or a poor score.', cell: (r) => <span className="faint">{r.validation.status === 'unscored' ? 'Unscored' : `${fmtPct(r.validation.value, 0, false)} n ${r.validation.n}`}</span> },
        ] as Column<ScannerRow>[])),
  ];

  const controls = (
    <div className="st-controls" style={{ marginBottom: 10 }}>
      <label className="sr-only" htmlFor="st-preset">Preset</label>
      <select id="st-preset" className="select" value={preset} onChange={(e) => set({ preset: e.target.value === 'all' ? null : e.target.value })}>
        {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      <span className="muted small">Near means within</span>
      <Segmented label="Proximity to a high" value={prox} options={[{ value: '1', label: '1%' }, { value: '2', label: '2%' }, { value: '5', label: '5%' }]} onChange={(v) => set({ prox: v === '2' ? null : v })} />
      <label className="row small" style={{ gap: 6, minHeight: 32 }}>
        <input type="checkbox" checked={funds} onChange={(e) => set({ funds: e.target.checked ? '1' : null })} /> Include funds
      </label>
    </div>
  );

  if (all.status === 'error' || scan.status === 'error') {
    const err = all.status === 'error' ? all : scan;
    return <Card title="Scanner"><StateNote tone="error" title="The scanner could not load the universe." action={<button type="button" className="btn small" onClick={err.reload}>Retry</button>}>{err.status === 'error' ? err.error.message : ''}</StateNote></Card>;
  }
  if (scan.status !== 'ready') return <Card title="Scanner">{controls}<Skeleton h={260} /></Card>;

  const eligible = scan.data.rows.filter((r) => funds || (typeOf.get(r.symbol) ?? 'stock') === 'stock' || typeOf.get(r.symbol) === 'adr');
  const matched = applyPreset(eligible, preset);
  const rows = sortRows(matched, cols, sort);

  return (
    <Card
      title="Scanner"
      info="Every loaded symbol measured on the same completed session. Sort by any single metric. There is no composite score."
      sub={`${rows.length} of ${eligible.length} symbols on ${fmtDate(scan.data.date)}. ${basis === 'close' ? 'Closing' : 'Traded'} basis.`}
    >
      {controls}
      <DataTable rows={rows} cols={cols} sort={sort} onSort={setSort} rowKey={(r) => r.symbol} selectedKey={current} caption="Strength scanner" maxHeight={620} empty="No symbol matches this preset on this date. Try a wider proximity or another preset." />
      {scan.data.excluded.length > 0 && (
        <Disclosure summary={`${scan.data.excluded.length} symbols without a session on this date`}>
          <ul className="muted small" style={{ margin: 0, paddingLeft: 18 }}>
            {scan.data.excluded.map((x) => <li key={x.symbol}>{x.symbol}. {x.reason}</li>)}
          </ul>
        </Disclosure>
      )}
    </Card>
  );
}
