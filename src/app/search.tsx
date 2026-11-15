/** Stock search dialog. One control changes the stock everywhere: ticker pill, "/" key, Cmd or Ctrl K. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useInstruments } from '../data/client';
import type { Instrument } from '../engine/core/types';
import { isSection, researchPath } from './routes';

let open = false;
const listeners = new Set<() => void>();
export const openSearch = (): void => {
  open = true;
  listeners.forEach((l) => l());
};
const closeSearch = (): void => {
  open = false;
  listeners.forEach((l) => l());
};
const useOpen = (): boolean =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
  );

interface Hit {
  inst: Instrument;
  via?: string;
  rank: number;
}

/** Rank: exact ticker, former ticker, ticker prefix, name prefix, name contains. */
export const searchInstruments = (all: readonly Instrument[], query: string, limit = 12): Hit[] => {
  const q = query.trim().toUpperCase();
  if (!q) return all.slice(0, limit).map((inst) => ({ inst, rank: 9 }));
  const hits: Hit[] = [];
  for (const inst of all) {
    const name = inst.name.toUpperCase();
    const alias = inst.aliases.find((a) => a.symbol === q);
    if (inst.symbol === q) hits.push({ inst, rank: 0 });
    else if (alias) hits.push({ inst, via: alias.symbol, rank: 1 });
    else if (inst.symbol.startsWith(q)) hits.push({ inst, rank: 2 });
    else if (name.startsWith(q)) hits.push({ inst, rank: 3 });
    else if (name.includes(q)) hits.push({ inst, rank: 4 });
  }
  return hits.sort((a, b) => a.rank - b.rank || a.inst.symbol.localeCompare(b.inst.symbol)).slice(0, limit);
};

export function SymbolSearch() {
  const isOpen = useOpen();
  const nav = useNavigate();
  const loc = useLocation();
  const all = useInstruments();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        openSearch();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (isOpen) {
      opener.current = document.activeElement as HTMLElement | null;
      setQ('');
      setSel(0);
      requestAnimationFrame(() => input.current?.focus());
    } else opener.current?.focus?.();
  }, [isOpen]);

  const hits = useMemo(() => (all.status === 'ready' ? searchInstruments(all.data, q) : []), [all, q]);

  if (!isOpen) return null;

  const go = (h: Hit | undefined, raw?: string) => {
    const symbol = h?.inst.symbol ?? raw?.trim().toUpperCase();
    if (!symbol) return;
    const parts = loc.pathname.split('/');
    const section = parts[1] === 'research' && isSection(parts[3]) ? parts[3] : 'overview';
    const asof = new URLSearchParams(loc.search).get('asof') ?? undefined;
    closeSearch();
    nav(researchPath(symbol, section, { asof }));
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && closeSearch()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Find a stock">
        <input
          ref={input}
          className="search"
          type="text"
          inputMode="search"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          placeholder="Ticker or company"
          aria-label="Ticker or company"
          role="combobox"
          aria-expanded="true"
          aria-controls="search-results"
          aria-activedescendant={hits[sel] ? `hit-${hits[sel]!.inst.symbol}` : undefined}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(hits.length - 1, s + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              go(hits[sel], q);
            } else if (e.key === 'Escape') closeSearch();
          }}
        />
        <ul className="results" id="search-results" role="listbox" aria-label="Matches">
          {all.status === 'loading' && <li className="muted">Loading the universe</li>}
          {all.status === 'ready' && hits.length === 0 && (
            <li className="muted" onClick={() => go(undefined, q)}>
              No match in the loaded universe. Press Enter to open {q.trim().toUpperCase()} and see why it is unavailable.
            </li>
          )}
          {hits.map((h, i) => (
            <li key={h.inst.id} id={`hit-${h.inst.symbol}`} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => go(h)}>
              <span className="sym">{h.inst.symbol}</span>
              <span className="nm">
                {h.inst.name}
                {h.via && <span className="faint"> (formerly {h.via})</span>}
              </span>
              {h.inst.type !== 'stock' && <span className="chip">{h.inst.type.toUpperCase()}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
