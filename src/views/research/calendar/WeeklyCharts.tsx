/** Two small SVG charts for the weekly board: the low to high range chart and the dip plot. Keyboard and touch readable. */
import { useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { DipPlot, RangeChartPoint } from '../../../engine/weeklyBoard';
import { isNum } from '../../../engine/core/types';
import { useWidth } from '../../../ui/charts';
import { fmtDate, fmtPct, MONTH_NAMES } from '../../../ui/format';

const ticks = (lo: number, hi: number): number[] => {
  const span = hi - lo || 1;
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = (raw / mag >= 5 ? 5 : raw / mag >= 2 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-12; v += step) out.push(Math.abs(v) < 1e-12 ? 0 : v);
  return out;
};

function useCursor(n: number, onSelect?: (i: number) => void) {
  const [cur, setCur] = useState<number | null>(null);
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!n) return;
    const i = cur ?? n - 1;
    if (e.key === 'ArrowLeft') setCur(Math.max(0, i - 1));
    else if (e.key === 'ArrowRight') setCur(Math.min(n - 1, i + 1));
    else if (e.key === 'Home') setCur(0);
    else if (e.key === 'End') setCur(n - 1);
    else if (e.key === 'Escape') setCur(null);
    else if (e.key === 'Enter' && cur !== null) onSelect?.(cur);
    else return;
    e.preventDefault();
  };
  return { cur, setCur, onKey };
}

/** Thin span from weekly low to high against the prior close, thicker tick at the weekly close, earnings band behind. */
export function WeeklyRangeChart({ points, selected, onSelect, height = 230 }: { points: readonly RangeChartPoint[]; selected: string | null; onSelect: (label: string) => void; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { cur, setCur, onKey } = useCursor(points.length, (i) => onSelect(points[i]!.label));
  const padL = 46;
  const padR = 8;
  const padT = 8;
  const padB = 22;
  const w = Math.max(160, width);
  const iw = w - padL - padR;
  const ih = height - padT - padB;
  let lo = 0;
  let hi = 0;
  for (const p of points) {
    if (p.lowRet !== null) lo = Math.min(lo, p.lowRet);
    if (p.highRet !== null) hi = Math.max(hi, p.highRet);
  }
  const pad = (hi - lo) * 0.06 || 0.01;
  lo -= pad;
  hi += pad;
  const sy = (y: number) => padT + (1 - (y - lo) / (hi - lo)) * ih;
  const bw = points.length ? iw / points.length : iw;
  const at = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left - padL) / bw);
    setCur(i >= 0 && i < points.length ? i : null);
  };
  const tip = cur !== null ? points[cur] : undefined;
  return (
    <div className="chart-wrap" ref={ref}>
      {width > 0 && (
        <svg className="chart" role="img" tabIndex={0} width={w} height={height} viewBox={`0 0 ${w} ${height}`}
          aria-label="Weekly range against the prior week close. Each week shows its low to high span and its close. Use arrow keys to read weeks, Enter to inspect one."
          onPointerMove={at} onPointerDown={at} onPointerLeave={() => setCur(null)} onKeyDown={onKey} onClick={() => cur !== null && onSelect(points[cur]!.label)}>
          {ticks(lo, hi).map((t) => (
            <g key={t}>
              <line className={t === 0 ? 'zero' : 'grid-line'} x1={padL} x2={w - padR} y1={sy(t)} y2={sy(t)} />
              <text x={padL - 6} y={sy(t) + 4} textAnchor="end">{fmtPct(t, 0)}</text>
            </g>
          ))}
          {points.map((p, i) => {
            const x = padL + i * bw + bw / 2;
            const up = (p.closeRet ?? 0) >= 0;
            const c = !p.counted ? 'var(--text-3)' : up ? 'var(--up)' : 'var(--down)';
            const firstOfMonth = i === 0 || points[i - 1]!.month !== p.month;
            return (
              <g key={p.label}>
                {p.earnings && <rect x={x - bw / 2} y={padT} width={bw} height={ih} fill="var(--gold-soft)" />}
                {p.label === selected && <rect x={x - bw / 2} y={padT} width={bw} height={ih} fill="none" stroke="var(--gold-line)" strokeWidth={1.5} />}
                {p.lowRet !== null && p.highRet !== null && <line x1={x} x2={x} y1={sy(p.highRet)} y2={sy(p.lowRet)} stroke={c} strokeWidth={1.5} opacity={p.counted ? 0.75 : 0.5} strokeDasharray={p.counted ? undefined : '2 2'} />}
                {p.closeRet !== null && <line x1={x - Math.min(5, bw * 0.38)} x2={x + Math.min(5, bw * 0.38)} y1={sy(p.closeRet)} y2={sy(p.closeRet)} stroke={c} strokeWidth={3} strokeLinecap="round" />}
                {firstOfMonth && <text x={x - bw / 2 + 1} y={height - 6}>{MONTH_NAMES[p.month - 1]}</text>}
              </g>
            );
          })}
          {cur !== null && <line className="cross" x1={padL + cur * bw + bw / 2} x2={padL + cur * bw + bw / 2} y1={padT} y2={padT + ih} />}
        </svg>
      )}
      {tip && cur !== null && (
        <div className="chart-tip" style={{ left: Math.min(Math.max(4, padL + cur * bw + bw), w - 190), top: 6 }} aria-live="polite">
          <div className="faint">Week ending {fmtDate(tip.label)}{tip.earnings ? ', earnings' : ''}</div>
          <div className="num">Close <strong>{fmtPct(tip.closeRet)}</strong></div>
          <div className="num muted">Low {fmtPct(tip.lowRet)}, high {fmtPct(tip.highRet)}</div>
          {!tip.counted && <div className="muted">{tip.status === 'partial' ? 'Partial week, not counted' : 'Not counted'}</div>}
        </div>
      )}
      <div className="cal-dot-legend">
        <span>Thin line: low to high of the week against the prior week close</span>
        <span>Thick tick: weekly close</span>
        <span><i style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--gold-soft)', border: '1px solid var(--gold-line)', marginRight: 4, verticalAlign: -1 }} />Earnings week</span>
      </div>
    </div>
  );
}

/** Weekly low against the prior close, one mark per week, with the levels most weeks stayed above. */
export function DipChart({ dip, selected, onSelect, height = 230 }: { dip: DipPlot; selected: string | null; onSelect: (label: string) => void; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const pts = dip.points;
  const { cur, setCur, onKey } = useCursor(pts.length, (i) => onSelect(pts[i]!.label));
  const padL = 46;
  const padR = 64;
  const padT = 8;
  const padB = 22;
  const w = Math.max(160, width);
  const iw = w - padL - padR;
  const ih = height - padT - padB;
  let lo = 0;
  for (const p of pts) lo = Math.min(lo, p.lowRet);
  let hi = 0;
  for (const p of pts) hi = Math.max(hi, p.lowRet);
  hi = Math.max(hi, 0.005);
  const pad = (hi - lo) * 0.07 || 0.01;
  lo -= pad;
  hi += pad;
  const sy = (y: number) => padT + (1 - (y - lo) / (hi - lo)) * ih;
  const bw = pts.length ? iw / pts.length : iw;
  const at = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left - padL) / bw);
    setCur(i >= 0 && i < pts.length ? i : null);
  };
  const levels: { y: number; label: string }[] = [];
  if (isNum(dip.median)) levels.push({ y: dip.median, label: 'median' });
  if (isNum(dip.p20)) levels.push({ y: dip.p20, label: '80% above' });
  if (isNum(dip.p10)) levels.push({ y: dip.p10, label: '90% above' });
  const tip = cur !== null ? pts[cur] : undefined;
  const every = Math.max(1, Math.ceil(pts.length / Math.max(2, Math.floor(iw / 60))));
  return (
    <div className="chart-wrap" ref={ref}>
      {width > 0 && (
        <svg className="chart" role="img" tabIndex={0} width={w} height={height} viewBox={`0 0 ${w} ${height}`}
          aria-label={`Weekly low against the prior week close for ${dip.n} counted weeks. Filled marks closed the week higher, hollow marks closed lower. Use arrow keys to read weeks.`}
          onPointerMove={at} onPointerDown={at} onPointerLeave={() => setCur(null)} onKeyDown={onKey} onClick={() => cur !== null && onSelect(pts[cur]!.label)}>
          {ticks(lo, hi).map((t) => (
            <g key={t}>
              <line className={t === 0 ? 'zero' : 'grid-line'} x1={padL} x2={w - padR} y1={sy(t)} y2={sy(t)} />
              <text x={padL - 6} y={sy(t) + 4} textAnchor="end">{fmtPct(t, 0)}</text>
            </g>
          ))}
          {levels.map((l) => (
            <g key={l.label}>
              <line x1={padL} x2={w - padR} y1={sy(l.y)} y2={sy(l.y)} stroke="var(--accent)" strokeDasharray="5 3" strokeWidth={1} />
              <text x={w - padR + 4} y={sy(l.y) + 4} style={{ fill: 'var(--accent)' }}>{l.label}</text>
            </g>
          ))}
          {pts.map((p, i) => {
            const x = padL + i * bw + bw / 2;
            const c = p.outcome === 'up' ? 'var(--up)' : p.outcome === 'down' ? 'var(--down)' : 'var(--text-3)';
            const sel = p.label === selected;
            return (
              <g key={p.label}>
                <circle cx={x} cy={sy(p.lowRet)} r={p.isLast || sel ? 5.5 : 3.6} fill={p.outcome === 'up' ? c : 'var(--surface)'} stroke={p.isLast || sel ? 'var(--gold-line)' : c} strokeWidth={p.isLast || sel ? 2.4 : 1.6} />
                {i % every === 0 && <text x={x} y={height - 6} textAnchor="middle">{MONTH_NAMES[Number(p.label.slice(5, 7)) - 1]}</text>}
              </g>
            );
          })}
        </svg>
      )}
      {tip && cur !== null && (
        <div className="chart-tip" style={{ left: Math.min(Math.max(4, padL + cur * bw + bw), w - 200), top: 6 }} aria-live="polite">
          <div className="faint">Week ending {fmtDate(tip.label)}{tip.isLast ? ', latest' : ''}</div>
          <div className="num">Low <strong>{fmtPct(tip.lowRet)}</strong></div>
          <div className="num muted">Friday close {fmtPct(tip.closeRet)}, closed {tip.outcome === 'up' ? 'higher' : tip.outcome === 'down' ? 'lower' : 'flat'}</div>
        </div>
      )}
      <div className="cal-dot-legend">
        <span>Filled: week closed higher</span>
        <span>Hollow: week closed lower</span>
        <span>Gold ring: latest week</span>
      </div>
    </div>
  );
}
