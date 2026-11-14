/** URL state helpers shared by the Trend and Calendar views. Settings live in search params so Back and deep links restore them. */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

export type ParamPatch = Record<string, string | number | null | undefined>;

/** Read search params and patch them. Tweaks replace the history entry, `push` adds one. */
export function useUrlState(): readonly [URLSearchParams, (patch: ParamPatch, push?: boolean) => void] {
  const [sp, setSp] = useSearchParams();
  const patch = useCallback(
    (p: ParamPatch, push = false) => {
      const n = new URLSearchParams(sp);
      for (const [k, v] of Object.entries(p)) {
        if (v === null || v === undefined || v === '') n.delete(k);
        else n.set(k, String(v));
      }
      setSp(n, { replace: !push });
    },
    [sp, setSp],
  );
  return [sp, patch] as const;
}

/** True on phone widths. Used to swap a wide table for a compact list. */
export function usePhone(maxWidth = 760): boolean {
  const query = `(max-width: ${maxWidth}px)`;
  const [phone, setPhone] = useState(() => (typeof matchMedia === 'function' ? matchMedia(query).matches : false));
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const m = matchMedia(query);
    const on = () => setPhone(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return phone;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'Nov 2026'. */
export const fmtMonthYear = (iso: string): string => `${MONTHS[Number(iso.slice(5, 7)) - 1] ?? '?'} ${iso.slice(0, 4)}`;

/** Whole numbers print bare, halves print with one decimal. */
export const fmtCount = (x: number | null | undefined): string => {
  if (x === null || x === undefined || !Number.isFinite(x)) return 'n/a';
  return Number.isInteger(x) ? x.toLocaleString('en-US') : x.toFixed(1);
};
