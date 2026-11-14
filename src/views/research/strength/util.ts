/** Shared helpers for the Strength view: URL params, layout probe, small formatters. */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { isNa, type Bar, type ISODate, type Maybe } from '../../../engine/core/types';
import { WINDOW_SPECS, windowBase, type RangeBasis, type WindowKey } from '../../../engine/relativeStrength';
import type { BreakSide, BreakWindowKey } from '../../../engine/breakouts';

export type StrengthTab = 'ranges' | 'relative' | 'breakouts' | 'scanner';
export const TABS: { value: StrengthTab; label: string }[] = [
  { value: 'ranges', label: 'Ranges' },
  { value: 'relative', label: 'Relative' },
  { value: 'breakouts', label: 'Breakouts' },
  { value: 'scanner', label: 'Scanner' },
];

/** Read and write view settings in the URL so Back and deep links restore them. */
export function useParams2() {
  const [sp, setSp] = useSearchParams();
  const get = useCallback((key: string, fallback: string): string => sp.get(key) ?? fallback, [sp]);
  const set = useCallback(
    (changes: Record<string, string | null>, replace = true) => {
      const n = new URLSearchParams(sp);
      for (const [k, v] of Object.entries(changes)) {
        if (v === null || v === '') n.delete(k);
        else n.set(k, v);
      }
      setSp(n, { replace });
    },
    [sp, setSp],
  );
  return { sp, get, set };
}

export const oneOf = <T extends string>(v: string, allowed: readonly T[], fallback: T): T => ((allowed as readonly string[]).includes(v) ? (v as T) : fallback);

/** True below the phone breakpoint. Used to pick a compact column set. */
export function useNarrow(px = 760): boolean {
  const q = `(max-width: ${px}px)`;
  const [narrow, setNarrow] = useState(() => (typeof matchMedia === 'undefined' ? false : matchMedia(q).matches));
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const m = matchMedia(q);
    const on = () => setNarrow(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [q]);
  return narrow;
}

export const BASIS_LABEL: Record<RangeBasis, string> = {
  close: 'Closing basis. Highs and lows are daily closes.',
  traded: 'Traded basis. Highs and lows are intraday quote extremes.',
};

export const num = (v: Maybe<number> | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Short window label for table cells. */
export const shortWindow = (k: WindowKey | BreakWindowKey): string => (k.endsWith('D') ? `${k.slice(0, -1)} sess.` : k);

export interface PriorLevel {
  level: number;
  date: ISODate;
  /** Sessions between the level and the anchor. */
  age: number;
  /** Anchor close divided by the level, minus 1. */
  gap: number;
}

/**
 * Extreme of the prior window strictly excluding the anchor bar, the same reference a breakout
 * signal is measured against. Session windows use the n sessions before the anchor. Calendar
 * windows use the rows after the window base and before the anchor.
 */
export const priorLevelNow = (bars: readonly Bar[], window: BreakWindowKey, side: BreakSide, basis: RangeBasis): PriorLevel | null => {
  const i = bars.length - 1;
  if (i < 1) return null;
  const field = basis === 'close' ? 'close' : side === 'up' ? 'high' : 'low';
  const spec = WINDOW_SPECS[window as WindowKey];
  let from: number;
  if (spec.kind === 'sessions') {
    from = i - spec.n;
    if (from < 0) return null;
  } else {
    const base = windowBase(bars, i, window as WindowKey);
    if (isNa(base)) return null;
    from = base + 1;
  }
  if (from > i - 1) return null;
  let idx = from;
  let v = bars[from]![field];
  for (let k = from + 1; k <= i - 1; k++) {
    const x = bars[k]![field];
    if (side === 'up' ? x > v : x < v) {
      v = x;
      idx = k;
    }
  }
  return { level: v, date: bars[idx]!.date, age: i - idx, gap: bars[i]!.close / v - 1 };
};

