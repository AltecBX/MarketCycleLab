/** Small shared controls for Today and the Portfolio views. */
import { useId, useMemo, useState, type ReactNode } from 'react';
import { searchInstruments } from '../../../app/search';
import type { Instrument } from '../../../engine/core/types';

/** Inline ticker picker over the loaded universe. Arrow keys, Enter and tap select. */
export function SymbolPicker({ instruments, onPick, placeholder = 'Ticker or company', label, value, clearOnPick = true }: { instruments: readonly Instrument[]; onPick: (symbol: string) => void; placeholder?: string; label: string; value?: string; clearOnPick?: boolean }) {
  const [q, setQ] = useState(value ?? '');
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const id = useId();
  const hits = useMemo(() => (q.trim() ? searchInstruments(instruments, q, 6) : []), [instruments, q]);
  const pick = (symbol: string) => {
    onPick(symbol);
    setQ(clearOnPick ? '' : symbol);
    setOpen(false);
  };
  return (
    <div className="pf-picker">
      <input
        className="input"
        style={{ width: '100%' }}
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded={open && hits.length > 0}
        aria-controls={id}
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setSel(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSel((s) => Math.min(hits.length - 1, s + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSel((s) => Math.max(0, s - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const h = hits[sel];
            if (h) pick(h.inst.symbol);
          } else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && hits.length > 0 && (
        <ul className="pf-picker-list" id={id} role="listbox" aria-label={`${label} matches`}>
          {hits.map((h, i) => (
            <li key={h.inst.id} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onMouseDown={(e) => { e.preventDefault(); pick(h.inst.symbol); }}>
              <strong>{h.inst.symbol}</strong>
              <span className="nm">{h.inst.name}{h.via ? ` (formerly ${h.via})` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <span className="faint">{hint}</span>}
    </label>
  );
}

/** Text input for a number. Keeps the raw text so an empty field stays empty, never zero. */
export function NumInput({ value, onChange, label, placeholder, step, min }: { value: string; onChange: (v: string) => void; label: string; placeholder?: string; step?: string; min?: string }) {
  return <input className="input" type="number" inputMode="decimal" aria-label={label} value={value} placeholder={placeholder} step={step ?? 'any'} min={min} onChange={(e) => onChange(e.target.value)} style={{ width: '100%' }} />;
}
