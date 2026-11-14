/** Pieces shared by the Discover tabs: cap control, source issues, common cells. */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { invalidate } from '../../../data/client';
import { isNa, isNum, type Maybe } from '../../../engine/core/types';
import { capScaleSteps, parseCapInput, SCREENER_DEFAULTS, type FieldDef, type ScreenerRow } from '../../../engine/screener';
import { Info, StateNote } from '../../../ui/components';
import { fmtDate, fmtMoney, fmtMultiple, fmtNum, fmtPct, fmtPrice, reasonDetail } from '../../../ui/format';
import type { DiscoverIssue } from './useDiscoverData';
import './discover.css';

const STEPS = capScaleSteps();
const capText = (v: number): string => String(Math.round(v * 1000) / 1000);
export const capLabel = (v: number): string => (v >= 1000 ? `$${capText(v / 1000)}T` : `$${capText(v)}B`);

/** Minimum market cap: slider on a broad step scale, exact numeric entry in billions, two quick values. */
export function CapControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(capText(value));
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setText(capText(value));
    setErr(null);
  }, [value]);
  const stepIndex = useMemo(() => {
    let i = 0;
    for (let k = 0; k < STEPS.length; k++) if (STEPS[k]! <= value) i = k;
    return i;
  }, [value]);
  const commit = () => {
    const v = parseCapInput(text);
    if (isNa(v)) setErr(v.detail ?? 'Enter billions, for example 55');
    else {
      setErr(null);
      if (v !== value) onChange(v);
    }
  };
  const quick = [SCREENER_DEFAULTS.minCapBillions.value, SCREENER_DEFAULTS.quickCapBillions.value];
  return (
    <div className="dv-cap">
      <span className="dv-cap-label">
        Minimum market cap
        <Info text="Stocks and ADRs at or above this market cap are listed. Drag for common steps or type any exact value in billions, for example 15 or 55. Funds are outside the stock universe." label="About minimum market cap" />
      </span>
      <div className="dv-cap-row">
        <input
          type="range"
          min={0}
          max={STEPS.length - 1}
          step={1}
          value={stepIndex}
          aria-label="Minimum market cap, step scale"
          aria-valuetext={capLabel(value)}
          onChange={(e) => onChange(STEPS[Number(e.target.value)]!)}
        />
        <span className="dv-cap-num">
          <span aria-hidden="true">$</span>
          <input
            type="text"
            inputMode="decimal"
            aria-label="Minimum market cap in billions of dollars"
            aria-invalid={err !== null}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
          />
          <span aria-hidden="true">B</span>
        </span>
        {quick.map((q) => (
          <button key={q} type="button" className="btn small" aria-pressed={value === q} onClick={() => onChange(q)}>
            ${q}B
          </button>
        ))}
      </div>
      {err && <span className="dv-err" role="alert">{err}</span>}
    </div>
  );
}

const SOURCE_LABEL: Record<DiscoverIssue['source'], string> = {
  prices: 'Daily price history',
  fundamentals: 'Fundamentals and estimates',
  groups: 'Trading groups',
};
const SOURCE_EFFECT: Record<DiscoverIssue['source'], string> = {
  prices: 'Price, returns, RSI, the 200 day gap and drawdowns show as unavailable.',
  fundamentals: 'Market cap, forward P/E, cash and free cash flow show as unavailable, so the market cap floor cannot place those stocks.',
  groups: 'Group labels and group views show as unavailable. Single stock fields are unaffected.',
};

/** Scoped source failures for the universe build, each with what it degrades and a retry. */
export function DiscoverIssues({ issues }: { issues: readonly DiscoverIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <>
      {issues.map((i) => (
        <StateNote
          key={i.source}
          tone="error"
          title={`${SOURCE_LABEL[i.source]} failed for ${i.affected} symbol${i.affected === 1 ? '' : 's'}.`}
          action={
            <button type="button" className="btn small" onClick={() => invalidate()}>
              Retry
            </button>
          }
        >
          {i.message} {SOURCE_EFFECT[i.source]} <Link to="/data">See source status</Link>
        </StateNote>
      ))}
    </>
  );
}

/** A missing value with its reason on hover and for assistive technology. */
export function Na({ why }: { why?: Maybe<unknown> | string | null }) {
  const title = typeof why === 'string' ? why : why !== null && why !== undefined && isNa(why) ? reasonDetail(why) : undefined;
  return (
    <span className="faint num" title={title}>
      n/a{title && <span className="sr-only">. {title}</span>}
    </span>
  );
}

/** Signed percent cell. */
export function PctCell({ v, digits = 2 }: { v: Maybe<number>; digits?: number }) {
  if (!isNum(v)) return <Na why={v} />;
  return (
    <span className={`num ${v > 0 ? 'up' : v < 0 ? 'down' : 'flat'}`}>
      {fmtPct(v, digits)}
    </span>
  );
}

/** Format a row value for a registry field in its display unit. */
export const fieldText = (f: FieldDef, row: ScreenerRow): string => {
  const v = f.get(row);
  if (v === null) return 'n/a';
  if (typeof v === 'string') return v;
  switch (f.unit) {
    case 'percent':
      return fmtPct(v, f.id === 'buy10' ? 0 : 2, f.id !== 'buy10');
    case 'billions':
      return fmtMoney(v, f.id === 'fcf');
    case 'price':
      return fmtPrice(v);
    case 'multiple':
      return fmtMultiple(v);
    case 'index':
      return fmtNum(v, 1);
    default:
      return fmtNum(v);
  }
};

export function SymbolLink({ symbol, section = 'overview', children }: { symbol: string; section?: string; children?: ReactNode }) {
  return (
    <Link className="dv-sym" to={`/research/${encodeURIComponent(symbol)}/${section}`} onClick={(e) => e.stopPropagation()}>
      {children ?? symbol}
    </Link>
  );
}

/** Close with its date. The date shows only when it differs from the common as-of session. */
export function PriceCell({ row, asOf }: { row: ScreenerRow; asOf: string }) {
  if (!isNum(row.price)) return <Na why={row.price} />;
  return (
    <span className="num">
      {fmtPrice(row.price)}
      {row.priceDate !== asOf && <span className="dv-sub" style={{ color: 'var(--warn)' }}>stale, {fmtDate(row.priceDate)}</span>}
    </span>
  );
}

/** Pager with page size. */
export function Pager({
  page,
  pageCount,
  from,
  to,
  total,
  pageSize,
  onPage,
  onSize,
  noun,
}: {
  page: number;
  pageCount: number;
  from: number;
  to: number;
  total: number;
  pageSize: number;
  onPage: (p: number) => void;
  onSize: (n: number) => void;
  noun: string;
}) {
  return (
    <div className="dv-pager">
      <span className="muted small num">
        {total === 0 ? `No ${noun}` : `${from} to ${to} of ${total} ${noun}`}
      </span>
      <div className="row" style={{ gap: 8 }}>
        <label className="small muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          Rows per page
          <select className="select" value={pageSize} onChange={(e) => onSize(Number(e.target.value))} aria-label="Rows per page">
            {[10, 25, 50, 100].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <button type="button" className="btn small" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <span className="small num muted">
          Page {page} of {pageCount}
        </span>
        <button type="button" className="btn small" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}
