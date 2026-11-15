/**
 * SVG charts. Small, dependency free, and accessible:
 * - every chart has a text summary through aria-label,
 * - the crosshair works with pointer, touch and keyboard (arrow keys, Home, End),
 * - long series are downsampled with min and max preserved so extremes never vanish.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { Bar } from '../engine/core/types';

export const SERIES_COLORS = ['var(--accent)', 'var(--gold-line)', '#8b5cf6', '#ec4899', '#64748b', '#f97316'] as const;

export function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw !== undefined) setW(Math.round(cw));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export interface Pt {
  x: number;
  y: number | null;
}

/** Min and max preserving downsample. Keeps first, last and both extremes of each bucket. */
export const downsample = (pts: readonly Pt[], buckets: number): Pt[] => {
  if (pts.length <= buckets * 2 || buckets < 2) return [...pts];
  const out: Pt[] = [];
  const size = pts.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * size);
    const e = Math.min(pts.length, Math.floor((b + 1) * size));
    let lo: Pt | null = null;
    let hi: Pt | null = null;
    for (let i = s; i < e; i++) {
      const p = pts[i]!;
      if (p.y === null) continue;
      if (!lo || p.y < lo.y!) lo = p;
      if (!hi || p.y > hi.y!) hi = p;
    }
    if (lo && hi) {
      if (lo.x <= hi.x) {
        out.push(lo);
        if (hi !== lo) out.push(hi);
      } else {
        out.push(hi, lo);
      }
    }
  }
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (out[0] !== first && first.y !== null) out.unshift(first);
  if (out[out.length - 1] !== last && last.y !== null) out.push(last);
  return out;
};

const niceTicks = (min: number, max: number, count = 5): number[] => {
  if (!(max > min)) return [min];
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
};

export interface LineSeries {
  id: string;
  label: string;
  color?: string;
  points: readonly Pt[];
  dashed?: boolean;
  width?: number;
  /** Faded context lines (analog paths) are drawn thin and excluded from the tooltip. */
  context?: boolean;
  area?: boolean;
}

export interface Marker {
  x: number;
  y: number;
  label?: string;
  color?: string;
}

export interface LineChartProps {
  series: readonly LineSeries[];
  xLabel: (x: number) => string;
  yFormat: (y: number) => string;
  ariaLabel: string;
  height?: number;
  xTicks?: readonly number[];
  markers?: readonly Marker[];
  hLines?: readonly { y: number; label?: string; color?: string }[];
  vLines?: readonly { x: number; label?: string; color?: string }[];
  bands?: readonly { x0: number; x1: number; color?: string; label?: string }[];
  /** Shaded y band between two series-like arrays keyed by x (for percentile envelopes). */
  envelope?: { points: readonly { x: number; lo: number; hi: number }[]; color?: string };
  zeroLine?: boolean;
  yDomain?: [number, number];
  onSelect?: (x: number) => void;
  legend?: boolean;
  footer?: ReactNode;
}

export function LineChart(props: LineChartProps) {
  const { series, xLabel, yFormat, ariaLabel, height = 260, markers = [], hLines = [], vLines = [], bands = [], envelope, zeroLine, yDomain, onSelect, legend = true } = props;
  const [ref, width] = useWidth<HTMLDivElement>();
  const [cursor, setCursor] = useState<number | null>(null);
  const padL = 52;
  const padR = 12;
  const padT = 10;
  const padB = 24;
  const w = Math.max(120, width);
  const iw = w - padL - padR;
  const ih = height - padT - padB;

  const { xs, x0, x1, y0, y1, sampled } = useMemo(() => {
    const xsSet = new Set<number>();
    let xa = Infinity;
    let xb = -Infinity;
    let ya = Infinity;
    let yb = -Infinity;
    for (const s of series) {
      for (const p of s.points) {
        if (p.y === null) continue;
        if (!s.context) xsSet.add(p.x);
        if (p.x < xa) xa = p.x;
        if (p.x > xb) xb = p.x;
        if (p.y < ya) ya = p.y;
        if (p.y > yb) yb = p.y;
      }
    }
    for (const e of envelope?.points ?? []) {
      if (e.lo < ya) ya = e.lo;
      if (e.hi > yb) yb = e.hi;
    }
    for (const h of hLines) {
      if (h.y < ya) ya = h.y;
      if (h.y > yb) yb = h.y;
    }
    for (const m of markers) {
      if (m.y < ya) ya = m.y;
      if (m.y > yb) yb = m.y;
    }
    if (zeroLine) {
      ya = Math.min(ya, 0);
      yb = Math.max(yb, 0);
    }
    if (!Number.isFinite(ya)) {
      ya = 0;
      yb = 1;
      xa = 0;
      xb = 1;
    }
    if (ya === yb) {
      ya -= 1;
      yb += 1;
    }
    const pad = (yb - ya) * 0.06;
    const dom: [number, number] = yDomain ?? [ya - pad, yb + pad];
    const buckets = Math.max(40, Math.floor(iw / 2));
    return {
      xs: [...xsSet].sort((a, b) => a - b),
      x0: xa,
      x1: xb === xa ? xa + 1 : xb,
      y0: dom[0],
      y1: dom[1],
      sampled: series.map((s) => downsample(s.points, buckets)),
    };
  }, [series, envelope, hLines, markers, zeroLine, yDomain, iw]);

  const sx = useCallback((x: number) => padL + ((x - x0) / (x1 - x0)) * iw, [x0, x1, iw]);
  const sy = useCallback((y: number) => padT + (1 - (y - y0) / (y1 - y0)) * ih, [y0, y1, ih]);

  const pathOf = (pts: readonly Pt[]): string => {
    let d = '';
    let pen = false;
    for (const p of pts) {
      if (p.y === null) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  const nearest = (clientX: number, el: Element): number | null => {
    if (xs.length === 0) return null;
    const rect = el.getBoundingClientRect();
    const xv = x0 + ((clientX - rect.left - padL) / iw) * (x1 - x0);
    let lo = 0;
    let hi = xs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid]! < xv) lo = mid + 1;
      else hi = mid;
    }
    const a = xs[Math.max(0, lo - 1)]!;
    const b = xs[lo]!;
    return Math.abs(a - xv) <= Math.abs(b - xv) ? a : b;
  };

  const onMove = (e: PointerEvent<SVGSVGElement>) => setCursor(nearest(e.clientX, e.currentTarget));
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (xs.length === 0) return;
    const i = cursor === null ? xs.length - 1 : xs.indexOf(cursor);
    let j = i;
    if (e.key === 'ArrowLeft') j = Math.max(0, i - (e.shiftKey ? 10 : 1));
    else if (e.key === 'ArrowRight') j = Math.min(xs.length - 1, i + (e.shiftKey ? 10 : 1));
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = xs.length - 1;
    else if (e.key === 'Escape') {
      setCursor(null);
      return;
    } else if (e.key === 'Enter' && cursor !== null && onSelect) {
      onSelect(cursor);
      return;
    } else return;
    e.preventDefault();
    setCursor(xs[j] ?? null);
  };

  const yTicks = niceTicks(y0, y1, 4);
  const xTicks = props.xTicks ?? (xs.length ? [0, 0.25, 0.5, 0.75, 1].map((f) => xs[Math.min(xs.length - 1, Math.round(f * (xs.length - 1)))]!) : []);
  const tipRows = cursor === null ? [] : series.filter((s) => !s.context).map((s, i) => ({ s, i, p: s.points.find((p) => p.x === cursor) })).filter((r) => r.p && r.p.y !== null);
  const tipLeft = cursor === null ? 0 : Math.min(Math.max(4, sx(cursor) + 10), w - 170);

  return (
    <div className="chart-wrap" ref={ref}>
      {legend && series.filter((s) => !s.context).length > 1 && (
        <div className="legend" style={{ marginBottom: 6 }}>
          {series.filter((s) => !s.context).map((s, i) => (
            <span key={s.id}>
              <i style={{ background: s.color ?? SERIES_COLORS[i % SERIES_COLORS.length] }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      {width > 0 && (
        <svg
          className="chart"
          role="img"
          aria-label={`${ariaLabel}. Use arrow keys to read values.`}
          tabIndex={0}
          width={w}
          height={height}
          viewBox={`0 0 ${w} ${height}`}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setCursor(null)}
          onKeyDown={onKey}
          onClick={() => cursor !== null && onSelect?.(cursor)}
        >
          {bands.map((b, i) => (
            <rect key={i} x={sx(b.x0)} y={padT} width={Math.max(1, sx(b.x1) - sx(b.x0))} height={ih} fill={b.color ?? 'var(--gold-soft)'} opacity={0.7} />
          ))}
          {yTicks.map((t) => (
            <g key={t}>
              <line className={t === 0 ? 'zero' : 'grid-line'} x1={padL} x2={w - padR} y1={sy(t)} y2={sy(t)} />
              <text x={padL - 6} y={sy(t) + 4} textAnchor="end">{yFormat(t)}</text>
            </g>
          ))}
          {xTicks.map((t, i) => (
            <text key={`${t}-${i}`} x={sx(t)} y={height - 6} textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}>{xLabel(t)}</text>
          ))}
          {envelope && envelope.points.length > 1 && (
            <path
              d={`${envelope.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.hi).toFixed(1)}`).join('')}${[...envelope.points].reverse().map((p) => `L${sx(p.x).toFixed(1)},${sy(p.lo).toFixed(1)}`).join('')}Z`}
              fill={envelope.color ?? 'var(--accent)'}
              opacity={0.13}
            />
          )}
          {hLines.map((h, i) => (
            <g key={i}>
              <line x1={padL} x2={w - padR} y1={sy(h.y)} y2={sy(h.y)} stroke={h.color ?? 'var(--text-3)'} strokeDasharray="4 3" strokeWidth={1} />
              {h.label && <text x={w - padR - 2} y={sy(h.y) - 4} textAnchor="end">{h.label}</text>}
            </g>
          ))}
          {vLines.map((v, i) => (
            <g key={i}>
              <line x1={sx(v.x)} x2={sx(v.x)} y1={padT} y2={padT + ih} stroke={v.color ?? 'var(--gold-line)'} strokeDasharray="3 3" strokeWidth={1} />
              {v.label && <text x={sx(v.x) + 3} y={padT + 10}>{v.label}</text>}
            </g>
          ))}
          {series.map((s, i) => {
            const color = s.color ?? SERIES_COLORS[i % SERIES_COLORS.length];
            const d = pathOf(sampled[i] ?? s.points);
            return (
              <g key={s.id}>
                {s.area && d && <path d={`${d}L${sx(x1).toFixed(1)},${sy(Math.max(y0, Math.min(y1, 0))).toFixed(1)}L${sx(x0).toFixed(1)},${sy(Math.max(y0, Math.min(y1, 0))).toFixed(1)}Z`} fill={color} opacity={0.12} />}
                <path d={d} fill="none" stroke={s.context ? 'var(--text-3)' : color} strokeWidth={s.context ? 1 : (s.width ?? 1.8)} strokeDasharray={s.dashed ? '5 4' : undefined} opacity={s.context ? 0.35 : 1} strokeLinejoin="round" />
              </g>
            );
          })}
          {markers.map((m, i) => (
            <g key={i}>
              <circle cx={sx(m.x)} cy={sy(m.y)} r={4} fill={m.color ?? 'var(--gold-line)'} stroke="var(--surface)" strokeWidth={1.5} />
              {m.label && <text x={sx(m.x)} y={sy(m.y) - 8} textAnchor="middle">{m.label}</text>}
            </g>
          ))}
          {cursor !== null && (
            <g>
              <line className="cross" x1={sx(cursor)} x2={sx(cursor)} y1={padT} y2={padT + ih} />
              {tipRows.map((r) => (
                <circle key={r.s.id} cx={sx(cursor)} cy={sy(r.p!.y!)} r={3.5} fill={r.s.color ?? SERIES_COLORS[r.i % SERIES_COLORS.length]} stroke="var(--surface)" strokeWidth={1.5} />
              ))}
            </g>
          )}
        </svg>
      )}
      {cursor !== null && tipRows.length > 0 && (
        <div className="chart-tip" style={{ left: tipLeft, top: 6 }} aria-live="polite">
          <div className="faint">{xLabel(cursor)}</div>
          {tipRows.map((r) => (
            <div key={r.s.id}>
              <i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, marginRight: 5, background: r.s.color ?? SERIES_COLORS[r.i % SERIES_COLORS.length] }} />
              {tipRows.length > 1 && <span className="muted">{r.s.label} </span>}
              <strong className="num">{yFormat(r.p!.y!)}</strong>
            </div>
          ))}
        </div>
      )}
      {props.footer}
    </div>
  );
}

export interface BarDatum {
  key: string;
  label: string;
  value: number | null;
  /** Second line in the tooltip. */
  detail?: string;
  color?: string;
  flag?: string;
}

/** Vertical signed bars on a zero baseline. Keyboard and touch selectable. */
export function BarChart({
  bars,
  yFormat,
  ariaLabel,
  height = 200,
  selectedKey,
  onSelect,
  tickEvery,
  overlayLine,
}: {
  bars: readonly BarDatum[];
  yFormat: (y: number) => string;
  ariaLabel: string;
  height?: number;
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
  tickEvery?: number;
  overlayLine?: readonly (number | null)[];
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const padL = 52;
  const padR = 8;
  const padT = 10;
  const padB = 22;
  const w = Math.max(120, width);
  const iw = w - padL - padR;
  const ih = height - padT - padB;
  const vals = bars.map((b) => b.value).filter((v): v is number => v !== null);
  const lineVals = (overlayLine ?? []).filter((v): v is number => v !== null);
  let lo = Math.min(0, ...vals);
  let hi = Math.max(0, ...vals);
  if (lo === hi) hi = lo + 1;
  const pad = (hi - lo) * 0.06;
  lo -= lo < 0 ? pad : 0;
  hi += hi > 0 ? pad : 0;
  const lLo = lineVals.length ? Math.min(0, ...lineVals) : 0;
  const lHi = lineVals.length ? Math.max(0, ...lineVals) : 1;
  const sy = (y: number) => padT + (1 - (y - lo) / (hi - lo)) * ih;
  const syL = (y: number) => padT + (1 - (y - lLo) / (lHi - lLo || 1)) * ih;
  const bw = bars.length ? iw / bars.length : iw;
  const every = tickEvery ?? Math.max(1, Math.ceil(bars.length / Math.max(2, Math.floor(iw / 56))));
  const active = hover ?? (selectedKey ? bars.findIndex((b) => b.key === selectedKey) : -1);
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!bars.length) return;
    const i = hover ?? bars.length - 1;
    if (e.key === 'ArrowLeft') setHover(Math.max(0, i - 1));
    else if (e.key === 'ArrowRight') setHover(Math.min(bars.length - 1, i + 1));
    else if (e.key === 'Home') setHover(0);
    else if (e.key === 'End') setHover(bars.length - 1);
    else if (e.key === 'Enter' && hover !== null) onSelect?.(bars[hover]!.key);
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  };
  const at = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left - padL) / bw);
    setHover(i >= 0 && i < bars.length ? i : null);
  };
  const tip = active >= 0 ? bars[active] : undefined;
  return (
    <div className="chart-wrap" ref={ref}>
      {width > 0 && (
        <svg
          className="chart"
          role="img"
          aria-label={`${ariaLabel}. Use arrow keys to read values.`}
          tabIndex={0}
          width={w}
          height={height}
          viewBox={`0 0 ${w} ${height}`}
          onPointerMove={at}
          onPointerDown={at}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKey}
          onClick={() => hover !== null && onSelect?.(bars[hover]!.key)}
        >
          {niceTicks(lo, hi, 4).map((t) => (
            <g key={t}>
              <line className={t === 0 ? 'zero' : 'grid-line'} x1={padL} x2={w - padR} y1={sy(t)} y2={sy(t)} />
              <text x={padL - 6} y={sy(t) + 4} textAnchor="end">{yFormat(t)}</text>
            </g>
          ))}
          {bars.map((b, i) => {
            const x = padL + i * bw;
            const v = b.value;
            const sel = b.key === selectedKey;
            return (
              <g key={b.key}>
                {v !== null && (
                  <rect
                    x={x + Math.min(1.5, bw * 0.12)}
                    width={Math.max(1, bw - Math.min(3, bw * 0.24))}
                    y={Math.min(sy(v), sy(0))}
                    height={Math.max(1, Math.abs(sy(v) - sy(0)))}
                    fill={b.color ?? (v >= 0 ? 'var(--up)' : 'var(--down)')}
                    opacity={active === i || active < 0 ? 1 : 0.55}
                    stroke={sel ? 'var(--gold-line)' : undefined}
                    strokeWidth={sel ? 2 : 0}
                    rx={Math.min(2, bw / 4)}
                  />
                )}
                {b.flag && <text x={x + bw / 2} y={padT + 8} textAnchor="middle" style={{ fill: 'var(--gold)', fontWeight: 700 }}>{b.flag}</text>}
                {i % every === 0 && <text x={x + bw / 2} y={height - 6} textAnchor="middle">{b.label}</text>}
              </g>
            );
          })}
          {overlayLine && (
            <path
              d={overlayLine.map((v, i) => (v === null ? '' : `${i === 0 || overlayLine[i - 1] === null ? 'M' : 'L'}${(padL + i * bw + bw / 2).toFixed(1)},${syL(v).toFixed(1)}`)).join('')}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={1.8}
            />
          )}
        </svg>
      )}
      {tip && hover !== null && (
        <div className="chart-tip" style={{ left: Math.min(Math.max(4, padL + hover * bw + bw), w - 170), top: 6 }} aria-live="polite">
          <div className="faint">{tip.label}</div>
          <strong className="num">{tip.value === null ? 'n/a' : yFormat(tip.value)}</strong>
          {tip.detail && <div className="muted">{tip.detail}</div>}
        </div>
      )}
    </div>
  );
}

/** Daily candles for a short window (about 130 bars), with optional overlay lines. */
export function CandleChart({ bars, overlays = [], ariaLabel, height = 280, dateLabel, yFormat }: { bars: readonly Bar[]; overlays?: readonly { label: string; values: readonly (number | null)[]; color?: string }[]; ariaLabel: string; height?: number; dateLabel: (iso: string) => string; yFormat: (y: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const padL = 52;
  const padR = 8;
  const padT = 8;
  const padB = 22;
  const w = Math.max(120, width);
  const iw = w - padL - padR;
  const ih = height - padT - padB;
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of bars) {
    if (b.low < lo) lo = b.low;
    if (b.high > hi) hi = b.high;
  }
  for (const o of overlays) for (const v of o.values) if (v !== null) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  const pad = (hi - lo) * 0.05 || 1;
  lo -= pad;
  hi += pad;
  const sy = (y: number) => padT + (1 - (y - lo) / (hi - lo)) * ih;
  const bw = bars.length ? iw / bars.length : iw;
  const every = Math.max(1, Math.ceil(bars.length / Math.max(2, Math.floor(iw / 70))));
  const at = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left - padL) / bw);
    setHover(i >= 0 && i < bars.length ? i : null);
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!bars.length) return;
    const i = hover ?? bars.length - 1;
    if (e.key === 'ArrowLeft') setHover(Math.max(0, i - 1));
    else if (e.key === 'ArrowRight') setHover(Math.min(bars.length - 1, i + 1));
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  };
  const hb = hover !== null ? bars[hover] : undefined;
  return (
    <div className="chart-wrap" ref={ref}>
      {width > 0 && (
        <svg className="chart" role="img" aria-label={`${ariaLabel}. Use arrow keys to read values.`} tabIndex={0} width={w} height={height} viewBox={`0 0 ${w} ${height}`} onPointerMove={at} onPointerDown={at} onPointerLeave={() => setHover(null)} onKeyDown={onKey}>
          {niceTicks(lo, hi, 4).map((t) => (
            <g key={t}>
              <line className="grid-line" x1={padL} x2={w - padR} y1={sy(t)} y2={sy(t)} />
              <text x={padL - 6} y={sy(t) + 4} textAnchor="end">{yFormat(t)}</text>
            </g>
          ))}
          {bars.map((b, i) => {
            const x = padL + i * bw + bw / 2;
            const up = b.close >= b.open;
            const c = up ? 'var(--up)' : 'var(--down)';
            return (
              <g key={b.date}>
                <line x1={x} x2={x} y1={sy(b.high)} y2={sy(b.low)} stroke={c} strokeWidth={1} />
                <rect x={x - Math.max(0.6, bw * 0.32)} width={Math.max(1.2, bw * 0.64)} y={sy(Math.max(b.open, b.close))} height={Math.max(1, Math.abs(sy(b.open) - sy(b.close)))} fill={c} />
                {i % every === 0 && <text x={x} y={height - 6} textAnchor="middle">{dateLabel(b.date)}</text>}
              </g>
            );
          })}
          {overlays.map((o, k) => (
            <path key={o.label} d={o.values.map((v, i) => (v === null ? '' : `${i === 0 || o.values[i - 1] === null ? 'M' : 'L'}${(padL + i * bw + bw / 2).toFixed(1)},${sy(v).toFixed(1)}`)).join('')} fill="none" stroke={o.color ?? SERIES_COLORS[k % SERIES_COLORS.length]} strokeWidth={1.5} />
          ))}
          {hover !== null && <line className="cross" x1={padL + hover * bw + bw / 2} x2={padL + hover * bw + bw / 2} y1={padT} y2={padT + ih} />}
        </svg>
      )}
      {hb && hover !== null && (
        <div className="chart-tip" style={{ left: Math.min(Math.max(4, padL + hover * bw + bw), w - 190), top: 6 }} aria-live="polite">
          <div className="faint">{dateLabel(hb.date)}</div>
          <div className="num">O {yFormat(hb.open)} H {yFormat(hb.high)}</div>
          <div className="num">L {yFormat(hb.low)} C <strong>{yFormat(hb.close)}</strong></div>
        </div>
      )}
    </div>
  );
}

export function Sparkline({ values, width = 96, height = 28, color = 'var(--accent)' }: { values: readonly (number | null)[]; width?: number; height?: number; color?: string }) {
  const v = values.filter((x): x is number => x !== null);
  if (v.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const d = values
    .map((y, i) => (y === null ? '' : `${i === 0 || values[i - 1] === null ? 'M' : 'L'}${((i / (values.length - 1)) * (width - 2) + 1).toFixed(1)},${(height - 2 - ((y - lo) / (hi - lo || 1)) * (height - 4)).toFixed(1)}`))
    .join('');
  return (
    <svg width={width} height={height} aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth={1.4} />
    </svg>
  );
}
