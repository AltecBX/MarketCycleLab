/** Small helpers shared by the Lab tabs. */
import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/** Patch search params. Null removes a key. Small tweaks replace the history entry. */
export const useParamPatch = (): [URLSearchParams, (patch: Record<string, string | null>, replace?: boolean) => void] => {
  const [sp, setSp] = useSearchParams();
  const patch = useCallback(
    (p: Record<string, string | null>, replace = true) => {
      setSp(
        (prev) => {
          const n = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(p)) {
            if (v === null) n.delete(k);
            else n.set(k, v);
          }
          return n;
        },
        { replace },
      );
    },
    [setSp],
  );
  return [sp, patch];
};

export function Pager({ page, pages, total, onPage, noun }: { page: number; pages: number; total: number; onPage: (p: number) => void; noun: string }) {
  if (pages <= 1) return <div className="lab-pager muted small">{total} {noun}</div>;
  return (
    <div className="lab-pager">
      <span className="muted small">
        Page {page + 1} of {pages}, {total} {noun}
      </span>
      <button type="button" className="btn small" disabled={page <= 0} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <button type="button" className="btn small" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </div>
  );
}

export const PAGE_SIZE = 25;
