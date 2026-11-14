/** Research journal. Append only: entries are never edited, a correction is a new linked entry. */
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { researchPath } from '../../app/routes';
import { newId, useWorkspace, type JournalEntry } from '../../data/workspace';
import { isNa } from '../../engine/core/types';
import { Card, Chip, StateNote } from '../../ui/components';
import { fmtDate, fmtDollars, fmtPrice, fmtTimeET } from '../../ui/format';
import { storageScopeText, useResolver } from './shared/data';
import { Field, SymbolPicker } from './shared/ui';
import './shared/pf.css';

const KIND_LABEL: Record<JournalEntry['kind'], string> = {
  note: 'Note', observation: 'Observation', forecast: 'Forecast', outcome: 'Outcome', correction: 'Correction', 'import-receipt': 'Import receipt', 'alert-ack': 'Alert acknowledged',
};
const KIND_TONE: Partial<Record<JournalEntry['kind'], 'accent' | 'gold' | 'warn' | 'up' | 'down'>> = { observation: 'accent', forecast: 'gold', correction: 'warn', 'import-receipt': 'up' };
const PAGE = 40;

interface AnyPayload { type?: string; [k: string]: unknown }
const payloadOf = (e: JournalEntry): AnyPayload | null => (e.payload && typeof e.payload === 'object' ? (e.payload as AnyPayload) : null);
const list = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : []);

function PayloadSummary({ e }: { e: JournalEntry }) {
  const p = payloadOf(e);
  if (!p) return null;
  if (p.type === 'import-receipt') {
    const changed = Array.isArray(p.changed) ? (p.changed as { symbol: string }[]).map((c) => c.symbol) : [];
    const skipped = Array.isArray(p.skipped) ? (p.skipped as { symbol: string; row: number; reason: string }[]) : [];
    const rows: [string, string][] = [
      ['Decision', `${String(p.decision)}, revision ${String(p.fromRevision)} to ${String(p.toRevision)}`],
      ['Added', list(p.added).join(', ') || 'None'],
      ['Changed', changed.join(', ') || 'None'],
      ['Archived', list(p.archived).join(', ') || 'None'],
    ];
    if (skipped.length) rows.push(['Skipped', skipped.map((s) => `${s.symbol} row ${s.row}. ${s.reason}`).join(' ')]);
    return <dl className="pf-diff" style={{ marginTop: 6 }}>{rows.map(([k, v]) => (<div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v}</dd></div>))}</dl>;
  }
  if (p.type === 'protection-scenario') {
    const plan = p.plan as { shares: number; spot: number; spotDate: string; call?: { strike: number; premium: number; contracts: number; expiry: string }; put?: { strike: number; premium: number; contracts: number; expiry: string }; trim?: { shares: number } } | undefined;
    const s = p.summary as { maxLoss: number | null; maxGain: number | null; lossUnbounded: boolean; gainUnbounded: boolean; breakevens: number[] } | undefined;
    if (!plan || !s) return null;
    return (
      <dl className="pf-diff" style={{ marginTop: 6 }}>
        <dt>Start</dt><dd>{plan.shares} shares at {fmtPrice(plan.spot)}, close on {fmtDate(plan.spotDate)}</dd>
        {plan.trim && (<><dt>Trim</dt><dd>{plan.trim.shares} shares</dd></>)}
        {plan.call && (<><dt>Short call</dt><dd>{plan.call.contracts} at {fmtPrice(plan.call.strike)}, premium {fmtPrice(plan.call.premium)} assumed, expiry {fmtDate(plan.call.expiry)}</dd></>)}
        {plan.put && (<><dt>Long put</dt><dd>{plan.put.contracts} at {fmtPrice(plan.put.strike)}, premium {fmtPrice(plan.put.premium)} assumed, expiry {fmtDate(plan.put.expiry)}</dd></>)}
        <dt>At expiry</dt><dd>Largest loss {s.lossUnbounded ? 'uncapped' : fmtDollars(s.maxLoss, true)}, largest gain {s.gainUnbounded ? 'uncapped' : fmtDollars(s.maxGain, true)}, breakeven {s.breakevens.length ? s.breakevens.map((x) => fmtPrice(x)).join(', ') : 'none'}</dd>
        <dt>Status</dt><dd>Hypothetical scenario. Not a quote, a fill or an order.</dd>
      </dl>
    );
  }
  if (p.type === 'checkpoint') {
    return <div className="small muted" style={{ marginTop: 4 }}>Checkpoint{p.targetDate ? `, target ${fmtDate(String(p.targetDate))}` : ''}{p.status ? `, ${String(p.status)}` : ''}</div>;
  }
  return null;
}

export default function Journal() {
  const [ws, update] = useWorkspace();
  const [sp, setSp] = useSearchParams();
  const { instruments, resolve } = useResolver();
  const kind = sp.get('kind') ?? 'all';
  const symFilter = sp.get('sym') ?? 'all';
  const [text, setText] = useState('');
  const [newKind, setNewKind] = useState<'note' | 'observation'>('note');
  const [newSym, setNewSym] = useState('');
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [corrText, setCorrText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);

  const supersededBy = useMemo(() => {
    const m = new Map<string, JournalEntry>();
    for (const e of ws.journal) if (e.supersedes) m.set(e.supersedes, e);
    return m;
  }, [ws.journal]);
  const byId = useMemo(() => new Map(ws.journal.map((e) => [e.id, e])), [ws.journal]);
  const symbols = useMemo(() => [...new Set(ws.journal.map((e) => e.symbol).filter((s): s is string => !!s))].sort(), [ws.journal]);
  const kinds = useMemo(() => [...new Set(ws.journal.map((e) => e.kind))], [ws.journal]);
  const entries = useMemo(
    () => [...ws.journal].filter((e) => (kind === 'all' || e.kind === kind) && (symFilter === 'all' || e.symbol === symFilter)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)),
    [ws.journal, kind, symFilter],
  );

  const setFilter = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v === 'all') n.delete(k);
    else n.set(k, v);
    setSp(n, { replace: true });
    setShown(PAGE);
  };

  const append = (entry: Omit<JournalEntry, 'id' | 'createdAt'>): boolean => {
    const ok = update((w) => ({ ...w, journal: [...w.journal, { ...entry, id: newId(), createdAt: new Date().toISOString() }] }));
    setNotice(ok ? null : 'Another tab changed your workspace first. The latest copy is loaded and your entry was not saved. Save it again.');
    return ok;
  };

  const add = () => {
    if (!text.trim()) return;
    const r = newSym ? resolve(newSym) : null;
    if (append({ symbol: r && !isNa(r) ? r.symbol : newSym ? newSym.toUpperCase() : null, kind: newKind, text: text.trim() })) {
      setText('');
    }
  };

  const correct = (orig: JournalEntry) => {
    if (!corrText.trim()) return;
    if (append({ symbol: orig.symbol, kind: 'correction', text: corrText.trim(), supersedes: orig.id })) {
      setCorrecting(null);
      setCorrText('');
    }
  };

  return (
    <div className="stack">
      <div className="pf-head">
        <h1>Journal</h1>
        <span className="pf-health">{storageScopeText()} Entries are never edited. A correction adds a linked entry and the original stays visible.</span>
      </div>
      {notice && <StateNote tone="warn">{notice}</StateNote>}
      <Card title="Add an entry">
        <div className="pf-form">
          <Field label="Kind">
            <select className="select" aria-label="Entry kind" value={newKind} onChange={(e) => setNewKind(e.target.value as 'note' | 'observation')}>
              <option value="note">Note</option>
              <option value="observation">Observation</option>
            </select>
          </Field>
          <Field label="Stock" hint="Optional"><SymbolPicker instruments={instruments} label="Stock for the entry" onPick={setNewSym} value={newSym} clearOnPick={false} key={newSym} /></Field>
          <label className="field wide">
            <span>Text</span>
            <textarea className="pf-textarea" style={{ fontFamily: 'var(--font)', fontSize: 14, minHeight: 64 }} aria-label="Entry text" value={text} onChange={(e) => setText(e.target.value)} placeholder="What you saw, with the date and the figure it rests on" />
          </label>
          <div className="row">
            <button type="button" className="btn primary" onClick={add} disabled={!text.trim()}>Save entry</button>
            {newSym && <button type="button" className="btn ghost small" onClick={() => setNewSym('')}>Clear stock</button>}
          </div>
        </div>
      </Card>

      <Card
        title="Entries"
        sub={`${entries.length} of ${ws.journal.length} shown, newest first.`}
        actions={
          <div className="row">
            <select className="select" aria-label="Filter by kind" value={kind} onChange={(e) => setFilter('kind', e.target.value)}>
              <option value="all">All kinds</option>
              {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
            <select className="select" aria-label="Filter by stock" value={symFilter} onChange={(e) => setFilter('sym', e.target.value)}>
              <option value="all">All stocks</option>
              {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        }
      >
        {ws.journal.length === 0 && <p className="muted">Nothing recorded yet. Notes you add, import receipts, saved protection scenarios and acknowledged alerts collect here.</p>}
        {ws.journal.length > 0 && entries.length === 0 && <p className="muted">No entry matches these filters.</p>}
        <div>
          {entries.slice(0, shown).map((e) => {
            const sup = supersededBy.get(e.id);
            const orig = e.supersedes ? byId.get(e.supersedes) : undefined;
            const canCorrect = !sup && (e.kind === 'note' || e.kind === 'observation' || e.kind === 'correction' || e.kind === 'forecast');
            return (
              <article key={e.id} className="pf-entry" data-superseded={!!sup} id={`entry-${e.id}`}>
                <div className="pf-entry-head">
                  <Chip tone={KIND_TONE[e.kind]}>{KIND_LABEL[e.kind]}</Chip>
                  {e.symbol && <Link className="pf-sym" to={researchPath(e.symbol)}>{e.symbol}</Link>}
                  <span>{fmtTimeET(e.createdAt)}, {e.createdAt.slice(0, 4)}</span>
                  {sup && <Chip tone="warn">Superseded {fmtDate(sup.createdAt.slice(0, 10))}</Chip>}
                  {e.supersedes && <span>Corrects the entry of {orig ? fmtDate(orig.createdAt.slice(0, 10)) : 'an earlier date'}</span>}
                  <span style={{ flex: 1 }} />
                  {canCorrect && correcting !== e.id && <button type="button" className="btn ghost small" onClick={() => { setCorrecting(e.id); setCorrText(e.text); }}>Correct</button>}
                </div>
                <div className="pf-entry-text">{e.text}</div>
                <PayloadSummary e={e} />
                {correcting === e.id && (
                  <div className="pf-stack-sm" style={{ marginTop: 8 }}>
                    <textarea className="pf-textarea" style={{ fontFamily: 'var(--font)', fontSize: 14, minHeight: 64 }} aria-label="Corrected text" value={corrText} onChange={(ev) => setCorrText(ev.target.value)} />
                    <div className="row">
                      <button type="button" className="btn primary small" onClick={() => correct(e)} disabled={!corrText.trim() || corrText.trim() === e.text}>Save correction</button>
                      <button type="button" className="btn small" onClick={() => setCorrecting(null)}>Cancel</button>
                      <span className="small muted">The original stays in the journal, marked superseded.</span>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
        {entries.length > shown && <button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, entries.length - shown)} more</button>}
      </Card>
    </div>
  );
}
