/** Small helpers shared by the earnings, business and calendar views. */
import { useEffect, useState } from 'react';
import { weekdayName } from '../../../engine/core/calendar';
import type { ISODate } from '../../../engine/core/types';
import { fmtDate, fmtDateShort } from '../../../ui/format';

/** True when the viewport is phone sized. Used to swap a wide table for a compact one. */
export function useIsNarrow(maxWidth = 640): boolean {
  const query = `(max-width: ${maxWidth}px)`;
  const [narrow, setNarrow] = useState(() => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return narrow;
}

/** Exchange-local calendar date of an instant. */
export const dateET = (isoInstant: string): ISODate =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(isoInstant));

/** 'Mon, Nov 16, 2026'. */
export const fmtDay = (iso: ISODate): string => `${weekdayName(iso)}, ${fmtDate(iso)}`;
/** 'Mon, Nov 16'. */
export const fmtDayShort = (iso: ISODate): string => `${weekdayName(iso)}, ${fmtDateShort(iso)}`;
