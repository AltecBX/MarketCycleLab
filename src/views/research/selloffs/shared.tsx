/** Small helpers shared by the Overview and Selloffs views. */
import { useCallback, useSyncExternalStore, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { researchPath, type SectionId } from '../../../app/routes';
import { isNa, type Distribution, type Maybe, type Proportion } from '../../../engine/core/types';
import { fmtPct, reasonDetail } from '../../../ui/format';

/** Read and patch URL search params. Small tweaks replace the history entry. */
export function useUrlState(): [URLSearchParams, (patch: Record<string, string | null>, push?: boolean) => void] {
  const [sp, setSp] = useSearchParams();
  const set = useCallback(
    (patch: Record<string, string | null>, push = false) => {
      setSp(
        (prev) => {
          const n = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === '') n.delete(k);
            else n.set(k, v);
          }
          return n;
        },
        { replace: !push },
      );
    },
    [setSp],
  );
  return [sp, set];
}

export const numParam = (sp: URLSearchParams, key: string, fallback: number, min: number, max: number): number => {
  const raw = sp.get(key);
  if (raw === null) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
};

/**
 * A frequency cell: rate, then hits of n and the interval. When the sample gate withholds the
 * rate, the counts still show with the reason.
 */
export function FreqCell({ hits, n, p }: { hits: number; n: number; p: Maybe<Proportion> | null }) {
  if (n === 0) return <span className="faint">No cases</span>;
  if (p === null || isNa(p)) {
    return (
      <span title={p && isNa(p) ? reasonDetail(p) : undefined}>
        <span className="num">{hits} of {n}</span>
        <span className="faint small" style={{ display: 'block' }}>rate withheld</span>
      </span>
    );
  }
  return (
    <span>
      <span className="num">{fmtPct(p.rate, 0, false)}</span>
      <span className="faint small num" style={{ display: 'block' }}>
        {hits} of {n}, {fmtPct(p.lo, 0, false)} to {fmtPct(p.hi, 0, false)}
      </span>
    </span>
  );
}

export function DistCell({ d, pick = 'median', digits = 1 }: { d: Maybe<Distribution> | null; pick?: 'median' | 'p10' | 'p25' | 'p75' | 'p90' | 'mean'; digits?: number }) {
  if (d === null || isNa(d)) return <span className="faint" title={d && isNa(d) ? reasonDetail(d) : undefined}>n/a</span>;
  const v = d[pick];
  return <span className={`num ${v > 0 ? 'up' : v < 0 ? 'down' : 'flat'}`}>{fmtPct(v, digits)}</span>;
}

/** Links into neighboring studies with the same symbol and as-of date. */
export function CrossLinks({ symbol, asof, links }: { symbol: string; asof?: string; links: { section: SectionId; label: string; params?: Record<string, string> }[] }) {
  return (
    <nav className="row small" aria-label="Related studies" style={{ gap: 8 }}>
      <span className="muted">Related</span>
      {links.map((l) => (
        <Link key={l.label} className="chip accent" to={researchPath(symbol, l.section, { asof, ...l.params })}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      {label}
      {children}
    </label>
  );
}

/** True on phone widths. Charts use it to draw fewer axis labels. */
export function useNarrow(): boolean {
  return useSyncExternalStore(
    (l) => {
      const m = window.matchMedia('(max-width: 600px)');
      m.addEventListener('change', l);
      return () => m.removeEventListener('change', l);
    },
    () => window.matchMedia('(max-width: 600px)').matches,
    () => false,
  );
}
