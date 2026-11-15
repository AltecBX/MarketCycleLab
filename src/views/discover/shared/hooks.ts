/** Small hooks shared by the Discover views. */
import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useLocation, useNavigationType, useSearchParams } from 'react-router-dom';
import { isNa } from '../../../engine/core/types';
import { parseCapInput, SCREENER_DEFAULTS } from '../../../engine/screener';

const PHONE_QUERY = '(max-width: 760px)';

/** True at phone widths. The views render a compact list there instead of a wide table. */
export const useIsPhone = (): boolean =>
  useSyncExternalStore(
    (l) => {
      const mq = window.matchMedia(PHONE_QUERY);
      mq.addEventListener('change', l);
      return () => mq.removeEventListener('change', l);
    },
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );

const scrollKey = (path: string, search: string): string => `mcl.scroll:${path}${search}`;

/**
 * Remember the page scroll for the current URL and put it back on a Back or Forward visit,
 * once the content is ready. Each distinct list (URL) has its own position.
 */
export function useScrollRestore(ready: boolean): void {
  const loc = useLocation();
  const navType = useNavigationType();
  const key = scrollKey(loc.pathname, loc.search);
  const restored = useRef(false);

  useLayoutEffect(() => {
    if (!ready || restored.current) return;
    restored.current = true;
    if (navType !== 'POP') return;
    let y = 0;
    try {
      y = Number(sessionStorage.getItem(key) ?? 0);
    } catch {
      return;
    }
    if (y > 0) {
      window.scrollTo(0, y);
      // A late layout shift (fonts, charts) can clamp the first attempt. Try once more next frame.
      requestAnimationFrame(() => window.scrollTo(0, y));
    }
  }, [ready, navType, key]);

  useEffect(() => {
    let raf = 0;
    const save = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        try {
          sessionStorage.setItem(key, String(Math.round(window.scrollY)));
        } catch {
          /* storage unavailable */
        }
      });
    };
    window.addEventListener('scroll', save, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', save);
    };
  }, [key]);
}

/** Minimum market cap in billions from the `cap` query parameter, shared by every Discover tab. */
export function useCapParam(): [number, (v: number) => void] {
  const [sp, setSp] = useSearchParams();
  const raw = sp.get('cap');
  const parsed = raw === null ? SCREENER_DEFAULTS.minCapBillions.value : parseCapInput(raw);
  const cap = isNa(parsed) ? SCREENER_DEFAULTS.minCapBillions.value : parsed;
  const set = useCallback(
    (v: number) => {
      setSp(
        (prev) => {
          const n = new URLSearchParams(prev);
          if (v === SCREENER_DEFAULTS.minCapBillions.value) n.delete('cap');
          else n.set('cap', String(Math.round(v * 1e6) / 1e6));
          n.delete('page');
          return n;
        },
        { replace: true },
      );
    },
    [setSp],
  );
  return [cap, set];
}

/** Read and write one string query parameter with a default that is omitted from the URL. */
export function useParam<T extends string>(name: string, fallback: T, allowed?: readonly T[]): [T, (v: T) => void] {
  const [sp, setSp] = useSearchParams();
  const raw = sp.get(name);
  const value = raw !== null && (!allowed || allowed.includes(raw as T)) ? (raw as T) : fallback;
  const set = useCallback(
    (v: T) => {
      setSp(
        (prev) => {
          const n = new URLSearchParams(prev);
          if (v === fallback || v === '') n.delete(name);
          else n.set(name, v);
          return n;
        },
        { replace: true },
      );
    },
    [setSp, name, fallback],
  );
  return [value, set];
}
