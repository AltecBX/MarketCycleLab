/** Owner checkpoints and notes for one symbol. Journal entries are append only. A change supersedes. */
import { useEffect, useMemo, useState } from 'react';
import { getWorkspaceStore, newId, useWorkspace, type JournalEntry } from '../../../data/workspace';
import { isIsoDate } from '../../../engine/core/calendar';
import { Chip, Disclosure, StateNote } from '../../../ui/components';
import { fmtDate, plural } from '../../../ui/format';

type Status = 'open' | 'met' | 'missed' | 'dropped';
interface CheckpointPayload {
  type: 'checkpoint';
  title: string;
  targetDate: string | null;
  status: Status;
  source: string | null;
}
const STATUS_LABEL: Record<Status, string> = { open: 'Open', met: 'Met', missed: 'Missed', dropped: 'Dropped' };
const TONE: Record<Status, 'accent' | 'up' | 'down' | undefined> = { open: 'accent', met: 'up', missed: 'down', dropped: undefined };

const isCheckpoint = (e: JournalEntry): e is JournalEntry & { payload: CheckpointPayload } =>
  e.kind === 'observation' && typeof e.payload === 'object' && e.payload !== null && (e.payload as { type?: unknown }).type === 'checkpoint';

export function Checkpoints({ symbol }: { symbol: string }) {
  const [ws, update] = useWorkspace();
  const scope = getWorkspaceStore().scope === 'this-browser' ? 'Stored in this browser only.' : 'Stored in your owner account.';
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState('');
  const [source, setSource] = useState('');
  const [adding, setAdding] = useState(false);
  const [conflict, setConflict] = useState(false);
  const saved = ws.notes[symbol] ?? '';
  const [note, setNote] = useState(saved);
  useEffect(() => setNote(saved), [saved, symbol]);

  const { current, history } = useMemo(() => {
    const all = ws.journal.filter((e) => e.symbol === symbol && isCheckpoint(e)) as (JournalEntry & { payload: CheckpointPayload })[];
    const superseded = new Set(all.map((e) => e.supersedes).filter(Boolean));
    const cur = all.filter((e) => !superseded.has(e.id)).sort((a, b) => (a.payload.targetDate ?? '9999').localeCompare(b.payload.targetDate ?? '9999') || a.createdAt.localeCompare(b.createdAt));
    return { current: cur, history: all.length - cur.length };
  }, [ws.journal, symbol]);
  const live = current.filter((e) => e.payload.status !== 'dropped');
  const dropped = current.filter((e) => e.payload.status === 'dropped');

  const append = (payload: CheckpointPayload, supersedes?: string) => {
    const entry: JournalEntry = { id: newId(), createdAt: new Date().toISOString(), symbol, kind: 'observation', text: payload.title, payload, ...(supersedes ? { supersedes } : {}) };
    setConflict(!update((w) => ({ ...w, journal: [...w.journal, entry] })));
  };
  const add = () => {
    const t = title.trim();
    if (!t) return;
    append({ type: 'checkpoint', title: t, targetDate: target && isIsoDate(target) ? target : null, status: 'open', source: source.trim() || null });
    setTitle('');
    setTarget('');
    setSource('');
    setAdding(false);
  };
  const saveNote = () => setConflict(!update((w) => ({ ...w, notes: { ...w.notes, [symbol]: note } })));

  const item = (e: JournalEntry & { payload: CheckpointPayload }) => (
    <li key={e.id}>
      <div className="bz-main">
        <strong>{e.payload.title}</strong>
        <div className="faint small">
          {e.payload.targetDate ? `Target ${fmtDate(e.payload.targetDate)}` : 'No target date'}
          {e.payload.source ? `. Source ${e.payload.source}` : ''}. Updated {fmtDate(e.createdAt.slice(0, 10))}
        </div>
      </div>
      <Chip tone={TONE[e.payload.status]}>{STATUS_LABEL[e.payload.status]}</Chip>
      <label className="sr-only" htmlFor={`st-${e.id}`}>Status of {e.payload.title}</label>
      <select id={`st-${e.id}`} className="select" value={e.payload.status} onChange={(ev) => append({ ...e.payload, status: ev.target.value as Status }, e.id)}>
        {(Object.keys(STATUS_LABEL) as Status[]).map((s) => (
          <option key={s} value={s}>{STATUS_LABEL[s]}</option>
        ))}
      </select>
    </li>
  );

  return (
    <div>
      {conflict && <StateNote tone="warn" title="Not saved.">Another tab saved first. Review the list and try again.</StateNote>}
      {live.length === 0 ? (
        <p className="muted" style={{ marginBottom: 10 }}>No checkpoints for {symbol} yet. Add an observable milestone with a date, such as a product ramp or a margin target, and mark it met or missed later.</p>
      ) : (
        <ul className="bz-list">{live.map(item)}</ul>
      )}
      {adding ? (
        <div className="bz-form">
          <label className="field wide">
            Milestone
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} autoFocus maxLength={160} />
          </label>
          <label className="field">
            Target date
            <input className="input" type="date" value={target} onChange={(e) => setTarget(e.target.value)} />
          </label>
          <label className="field">
            Source
            <input className="input" value={source} onChange={(e) => setSource(e.target.value)} placeholder="Filing, call, release" maxLength={120} />
          </label>
          <button type="button" className="btn primary" onClick={add} disabled={!title.trim()}>Add</button>
          <button type="button" className="btn ghost" onClick={() => setAdding(false)}>Cancel</button>
        </div>
      ) : (
        <button type="button" className="btn" onClick={() => setAdding(true)}>Add checkpoint</button>
      )}
      {dropped.length > 0 && (
        <div>
          <Disclosure summary={`Dropped (${dropped.length})`}>
            <ul className="bz-list">{dropped.map(item)}</ul>
          </Disclosure>
        </div>
      )}
      <hr className="sep" />
      <label className="field" htmlFor="bz-note">Notes on {symbol}</label>
      <textarea id="bz-note" className="bz-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you are watching and why" />
      <div className="row" style={{ marginTop: 6 }}>
        <button type="button" className="btn small" onClick={saveNote} disabled={note === saved}>Save note</button>
        <span className="faint small">
          {scope} {history > 0 ? `${plural(history, 'earlier version')} kept in the journal.` : 'Status changes keep the earlier version in the journal.'}
        </span>
      </div>
    </div>
  );
}
