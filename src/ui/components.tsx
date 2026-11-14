/** Shared presentational components. Every view composes these so states and labels stay consistent. */
import { Component, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { isNa, isNum, type Maybe, type Proportion, type Unavailable } from '../engine/core/types';
import { dirClass, dirGlyph, fmtPct, reasonDetail, reasonText } from './format';

/** Definition popover. Opens on click, tap, Enter or Space. Closes on Escape or outside press. */
export function Info({ text, label = 'Definition' }: { text: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const [align, setAlign] = useState<'center' | 'left' | 'right'>('center');
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    setAlign(r.left < 160 ? 'left' : vw - r.right < 160 ? 'right' : 'center');
  }, [open]);
  return (
    <span className="info" ref={ref}>
      <button type="button" aria-label={label} aria-expanded={open} aria-describedby={open ? id : undefined} onClick={() => setOpen((o) => !o)}>
        i
      </button>
      {open && (
        <span role="tooltip" id={id} className="info-pop" data-align={align}>
          {text}
        </span>
      )}
    </span>
  );
}

interface BoundaryProps {
  label: string;
  children: ReactNode;
}
interface BoundaryState {
  error: Error | null;
  key: number;
}

/** Scoped failure boundary. One card can fail without taking the page with it. */
export class CardBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null, key: 0 };
  static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { error };
  }
  override componentDidCatch(error: Error) {
    console.error(`[${this.props.label}]`, error);
  }
  override render() {
    if (this.state.error) {
      return (
        <div className="state error" role="alert">
          <div>
            <strong>{this.props.label} could not be displayed.</strong> {this.state.error.message}
            <div style={{ marginTop: 8 }}>
              <button type="button" className="btn small" onClick={() => this.setState((s) => ({ error: null, key: s.key + 1 }))}>
                Retry this card
              </button>
            </div>
          </div>
        </div>
      );
    }
    return <div key={this.state.key} style={{ display: 'contents' }}>{this.props.children}</div>;
  }
}

export function Card({
  title,
  info,
  sub,
  actions,
  children,
  id,
  style,
}: {
  title?: ReactNode;
  info?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
  style?: CSSProperties;
}) {
  const label = typeof title === 'string' ? title : 'This card';
  return (
    <section className="card" id={id} style={style} aria-label={typeof title === 'string' ? title : undefined}>
      {(title || actions) && (
        <div className="card-head">
          {title && (
            <h2>
              {title}
              {info && <Info text={info} label={`About ${label}`} />}
            </h2>
          )}
          <span className="spacer" />
          {actions}
        </div>
      )}
      {sub && <div className="card-sub">{sub}</div>}
      <div className="card-body">
        <CardBoundary label={label}>{children}</CardBoundary>
      </div>
    </section>
  );
}

export function Stat({ label, value, sub, info, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; info?: ReactNode; tone?: 'up' | 'down' | 'flat' }) {
  return (
    <div className="stat">
      <div className="stat-label">
        {label}
        {info && <Info text={info} />}
      </div>
      <div className={`stat-value num ${tone ?? ''}`}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

/** Signed percent with color and a non-color direction cue. */
export function Pct({ v, digits = 2, glyph = false, plain = false }: { v: Maybe<number> | null | undefined; digits?: number; glyph?: boolean; plain?: boolean }) {
  if (v === null || v === undefined || isNa(v) || !isNum(v)) {
    return (
      <span className="faint num" title={isNa(v) ? reasonDetail(v) : undefined}>
        n/a
      </span>
    );
  }
  return (
    <span className={`num ${plain ? '' : dirClass(v)}`}>
      {glyph && v !== 0 && <span aria-hidden="true" style={{ fontSize: '0.7em', marginRight: 3 }}>{dirGlyph(v)}</span>}
      {fmtPct(v, digits)}
    </span>
  );
}

/** A frequency always shows hits, denominator and interval. */
export function Freq({ p, digits = 0 }: { p: Proportion | null | undefined; digits?: number }) {
  if (!p) return <span className="faint">n/a</span>;
  return (
    <span className="num">
      {fmtPct(p.rate, digits, false)}{' '}
      <span className="faint small">
        ({p.hits} of {p.n}, {Math.round(p.level * 100)}% interval {fmtPct(p.lo, 0, false)} to {fmtPct(p.hi, 0, false)})
      </span>
    </span>
  );
}

/** Inline reason for a missing value. */
export function Missing({ why, block = false }: { why: Unavailable | string; block?: boolean }) {
  const text = typeof why === 'string' ? why : reasonDetail(why);
  if (block) return <div className="state">{text}</div>;
  return (
    <span className="faint" title={text}>
      {typeof why === 'string' ? why : reasonText(why)}
    </span>
  );
}

export function StateNote({ tone = 'info', title, children, action }: { tone?: 'info' | 'warn' | 'error'; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={`state ${tone === 'info' ? '' : tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && <strong>{title} </strong>}
        {children}
      </div>
      {action}
    </div>
  );
}

export function Skeleton({ h = 120 }: { h?: number }) {
  return <div className="skeleton" style={{ height: h }} role="status" aria-label="Loading" />;
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Chip({ tone, children, onRemove, title }: { tone?: 'accent' | 'gold' | 'warn' | 'up' | 'down'; children: ReactNode; onRemove?: () => void; title?: string }) {
  return (
    <span className={`chip ${tone ?? ''}`} title={title}>
      {children}
      {onRemove && (
        <button type="button" aria-label="Remove" onClick={onRemove}>
          ×
        </button>
      )}
    </span>
  );
}

export function Disclosure({ summary, children, defaultOpen = false }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details className="disclosure" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{summary}</summary>
      {open && children}
    </details>
  );
}

/** Side panel on desktop, bottom sheet on phones. Restores focus to the opener on close. */
export function Sheet({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <>
      <div className="overlay" style={{ padding: 0, background: 'rgb(8 12 18 / 0.35)' }} onClick={onClose} aria-hidden="true" />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Details'} tabIndex={-1} ref={ref}>
        <div className="sheet-head">
          <h2 style={{ flex: 1 }}>{title}</h2>
          <button type="button" className="btn small" onClick={onClose}>
            Close
          </button>
        </div>
        <div style={{ padding: 16 }}>{children}</div>
      </div>
    </>
  );
}

export interface Column<R> {
  key: string;
  header: ReactNode;
  info?: ReactNode;
  align?: 'l' | 'r';
  sticky?: boolean;
  /** Sort accessor. Null and undefined sort last in both directions. */
  sort?: (r: R) => number | string | null | undefined;
  cell: (r: R) => ReactNode;
}

export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

/** Stable sort with missing values last in both directions. */
export function sortRows<R>(rows: readonly R[], cols: readonly Column<R>[], sort: SortState | null): R[] {
  if (!sort) return [...rows];
  const col = cols.find((c) => c.key === sort.key);
  if (!col?.sort) return [...rows];
  const acc = col.sort;
  const mul = sort.dir === 'asc' ? 1 : -1;
  return rows
    .map((r, i) => ({ r, i, v: acc(r) }))
    .sort((a, b) => {
      const am = a.v === null || a.v === undefined || (typeof a.v === 'number' && !Number.isFinite(a.v));
      const bm = b.v === null || b.v === undefined || (typeof b.v === 'number' && !Number.isFinite(b.v));
      if (am && bm) return a.i - b.i;
      if (am) return 1;
      if (bm) return -1;
      const c = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : String(a.v).localeCompare(String(b.v));
      return c !== 0 ? c * mul : a.i - b.i;
    })
    .map((x) => x.r);
}

export function DataTable<R>({
  rows,
  cols,
  sort,
  onSort,
  rowKey,
  onRow,
  selectedKey,
  caption,
  empty = 'No rows match.',
  maxHeight,
}: {
  rows: readonly R[];
  cols: readonly Column<R>[];
  sort?: SortState | null;
  onSort?: (s: SortState) => void;
  rowKey: (r: R) => string;
  onRow?: (r: R) => void;
  selectedKey?: string | null;
  caption: string;
  empty?: ReactNode;
  maxHeight?: number;
}) {
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label={caption} style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined}>
      <table className="data">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {cols.map((c) => {
              const sorted = sort?.key === c.key;
              const cls = `${c.align === 'l' || c.sticky ? 'l' : ''} ${c.sticky ? 'sticky' : ''}`;
              return (
                <th key={c.key} className={cls} scope="col" aria-sort={sorted ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                  <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 4 }}>
                    {c.sort && onSort ? (
                      <button
                        type="button"
                        className="th-btn"
                        data-sorted={sorted}
                        onClick={() => onSort({ key: c.key, dir: sorted && sort!.dir === 'desc' ? 'asc' : 'desc' })}
                      >
                        {c.header}
                        <span className="sort-ind" aria-hidden="true">{sorted ? (sort!.dir === 'asc' ? '▲' : '▼') : ''}</span>
                      </button>
                    ) : (
                      c.header
                    )}
                    {c.info && <Info text={c.info} />}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={cols.length} className="l muted" style={{ padding: 16 }}>
                {empty}
              </td>
            </tr>
          )}
          {rows.map((r) => {
            const k = rowKey(r);
            return (
              <tr
                key={k}
                className={selectedKey === k ? 'selected' : undefined}
                onClick={onRow ? () => onRow(r) : undefined}
                style={onRow ? { cursor: 'pointer' } : undefined}
              >
                {cols.map((c) => (
                  <td key={c.key} className={`${c.align === 'l' || c.sticky ? 'l' : ''} ${c.sticky ? 'sticky' : ''}`}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Position inside a low to high range. */
export function RangeGauge({ pos, lowLabel, highLabel, label }: { pos: number | null; lowLabel: ReactNode; highLabel: ReactNode; label: string }) {
  return (
    <div role="img" aria-label={`${label}. ${pos === null ? 'Position unavailable' : `${Math.round(pos * 100)}% of the way from low to high`}`}>
      <div className="gauge">{pos !== null && <i style={{ left: `${Math.max(0, Math.min(1, pos)) * 100}%` }} />}</div>
      <div className="gauge-ends">
        <span>{lowLabel}</span>
        <span>{highLabel}</span>
      </div>
    </div>
  );
}

/** Horizontal signed bars on one common zero scale. */
export function SignedBars<T>({
  rows,
  value,
  label,
  format,
  onSelect,
  max,
  caption,
}: {
  rows: readonly T[];
  value: (r: T) => number | null;
  label: (r: T) => ReactNode;
  format: (v: number) => string;
  onSelect?: (r: T) => void;
  max?: number;
  caption: string;
}) {
  const vals = rows.map(value);
  const m = max ?? Math.max(1e-9, ...vals.map((v) => (v === null ? 0 : Math.abs(v))));
  const hasNeg = vals.some((v) => v !== null && v < 0);
  const hasPos = vals.some((v) => v !== null && v > 0);
  const zero = hasNeg && hasPos ? 50 : hasNeg ? 100 : 0;
  const span = hasNeg && hasPos ? 50 : 100;
  return (
    <div className="hbar" role="list" aria-label={caption}>
      {rows.map((r, i) => {
        const v = vals[i] ?? null;
        const w = v === null ? 0 : (Math.min(m, Math.abs(v)) / m) * span;
        const left = v !== null && v < 0 ? zero - w : zero;
        const lab = label(r);
        return (
          <div key={i} role="listitem" style={{ display: 'contents' }}>
            {onSelect ? (
              <button type="button" className="btn ghost small" style={{ justifyContent: 'flex-start', padding: '2px 4px' }} onClick={() => onSelect(r)}>
                {lab}
              </button>
            ) : (
              <span>{lab}</span>
            )}
            <div className="hbar-track" aria-hidden="true">
              {v !== null && <div className="hbar-fill" style={{ left: `${left}%`, width: `${w}%`, background: v >= 0 ? 'var(--up)' : 'var(--down)' }} />}
              <div className="hbar-zero" style={{ left: `${zero}%` }} />
            </div>
            <span className={`num ${dirClass(v)}`} style={{ textAlign: 'right' }}>{v === null ? 'n/a' : format(v)}</span>
          </div>
        );
      })}
    </div>
  );
}
