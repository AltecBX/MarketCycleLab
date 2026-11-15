/** Positions and risk: holdings with dated marks, import with review, exposure, correlation and hypothetical shocks. */
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { researchPath } from '../../app/routes';
import { getProvider, invalidate, useGroups } from '../../data/client';
import { newId, useWorkspace, type Workspace, type WorkspacePosition } from '../../data/workspace';
import { isNa, type Bar, type Maybe } from '../../engine/core/types';
import { nextEarnings, type NextEarnings } from '../../engine/earnings';
import {
  applyReconciliation, correlationMatrix, CORRELATION_DEFAULTS, exposureBreakdown, holdingDrawdown, markPositions, parsePositionsCsv, reconcileImport, scenarioShock,
  type CsvError, type HoldingDrawdown, type Mark, type MarkedPosition, type ReconcilePreview,
} from '../../engine/portfolio';
import { Card, Chip, DataTable, Disclosure, Missing, Pct, Skeleton, sortRows, Stat, StateNote, type Column, type SortState } from '../../ui/components';
import { fmtDate, fmtDateShort, fmtDollars, fmtNum, fmtPct, fmtPrice, heatBg, reasonDetail, reasonText } from '../../ui/format';
import { barsOf, etDate, markOf, parseNum, storageScopeText, toBook, useBundles, useIsNarrow, useResolver } from './shared/data';
import { Field, NumInput, SymbolPicker } from './shared/ui';
import './shared/pf.css';

interface Row {
  m: MarkedPosition;
  ws: WorkspacePosition | undefined;
  dayChange: number | null;
  dd: Maybe<HoldingDrawdown>;
  next: Maybe<NextEarnings>;
}

const SOURCE_LABEL: Record<WorkspacePosition['source'], string> = { manual: 'Manual', csv: 'CSV', import: 'Import', demo: 'Demo' };
const STATE_LABEL = { long: '', short: 'Short', zero: 'Zero quantity', watch: 'Watch' } as const;
const DEMO: { symbol: string; shares: number; costFactor: number | null; acquiredOn: string | null }[] = [
  { symbol: 'NVDA', shares: 150, costFactor: 0.82, acquiredOn: '2025-03-14' },
  { symbol: 'MU', shares: 80, costFactor: 1.12, acquiredOn: '2026-02-03' },
  { symbol: 'LLY', shares: 20, costFactor: 0.95, acquiredOn: '2024-09-18' },
  { symbol: 'SNDK', shares: 60, costFactor: 1.3, acquiredOn: '2026-06-09' },
  { symbol: 'AAOI', shares: 300, costFactor: null, acquiredOn: null },
];

const isWorkspaceShape = (x: unknown): x is Workspace => {
  const w = x as Partial<Workspace> | null;
  return !!w && typeof w === 'object' && Array.isArray(w.watchlist) && Array.isArray(w.positions) && Array.isArray(w.journal) && typeof w.settings === 'object' && w.settings !== null && typeof w.revision === 'number';
};

export default function Positions() {
  const [ws, update] = useWorkspace();
  const { instruments, bySymbol, resolve, ready } = useResolver();
  const groups = useGroups();
  const clock = getProvider().clock();
  const today = etDate(clock.now);
  const narrow = useIsNarrow();
  const [sort, setSort] = useState<SortState | null>(null);
  const [panel, setPanel] = useState<'none' | 'add' | 'csv' | 'json'>('none');
  const [notice, setNotice] = useState<{ tone: 'info' | 'warn' | 'error'; text: string } | null>(null);
  // manual form
  const [fSym, setFSym] = useState('');
  const [fShares, setFShares] = useState('');
  const [fCost, setFCost] = useState('');
  const [fDate, setFDate] = useState('');
  // csv
  const [csvText, setCsvText] = useState('');
  const [preview, setPreview] = useState<{ p: ReconcilePreview; errors: CsvError[] } | null>(null);
  // json
  const [jsonIn, setJsonIn] = useState<Workspace | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // risk
  const [mkt, setMkt] = useState('-10');
  const [stockSym, setStockSym] = useState('');
  const [stockShock, setStockShock] = useState('');
  const [budgetText, setBudgetText] = useState(ws.settings.lossBudget === null ? '' : String(ws.settings.lossBudget));

  const symbols = useMemo(() => {
    const out: string[] = [];
    for (const p of ws.positions) {
      const r = resolve(p.symbol);
      const s = isNa(r) ? p.symbol.toUpperCase() : r.symbol;
      if (!out.includes(s)) out.push(s);
    }
    return out;
  }, [ws.positions, resolve]);
  const bundles = useBundles(ready ? symbols : []);

  const view = useMemo(() => {
    if (!ready || (symbols.length > 0 && bundles.status !== 'ready')) return null;
    const book = toBook(ws, resolve);
    const marks = new Map<string, Maybe<Mark>>();
    const barsBy = new Map<string, readonly Bar[]>();
    const betas: Record<string, Maybe<number>> = {};
    for (const p of book.positions) {
      const b = bundles.status === 'ready' ? bundles.data.get(p.symbol) : undefined;
      marks.set(p.instrumentId, markOf(b));
      const bars = barsOf(b);
      if (!isNa(bars)) barsBy.set(p.symbol, bars);
      if (b && !isNa(b) && !isNa(b.fundamentals)) betas[p.symbol] = b.fundamentals.beta;
    }
    const marked = markPositions(book.positions, marks);
    const rows: Row[] = marked.rows.map((m, i) => {
      const bars = barsBy.get(m.position.symbol);
      const b = bundles.status === 'ready' ? bundles.data.get(m.position.symbol) : undefined;
      const inst = bySymbol.get(m.position.symbol);
      return {
        m,
        ws: ws.positions[i],
        dayChange: bars && bars.length > 1 ? bars[bars.length - 1]!.close / bars[bars.length - 2]!.close - 1 : null,
        dd: bars ? holdingDrawdown(bars, 252) : barsOf(b) as Maybe<HoldingDrawdown>,
        next: b && !isNa(b) ? nextEarnings(b.earnings, today, inst?.type ?? 'stock') : (b ?? { unavailable: true, code: 'no-coverage' }) as Maybe<NextEarnings>,
      };
    });
    const groupOf = (s: string) => (groups.status === 'ready' ? (groups.data.find((g) => g.members.includes(s))?.name ?? null) : null);
    const exposure = exposureBreakdown(marked, (s) => ({ group: groupOf(s), sector: bySymbol.get(s)?.sector ?? (bySymbol.get(s)?.type === 'etf' ? 'Fund' : null) }));
    const series = [...barsBy.entries()].map(([symbol, bars]) => ({ symbol, bars }));
    const corr = series.length >= 2 ? correlationMatrix(series, CORRELATION_DEFAULTS.window) : [];
    let belowHigh = 0;
    let belowCount = 0;
    for (const r of rows) {
      if (r.m.state === 'long' && !isNa(r.m.mark) && !isNa(r.dd)) {
        belowHigh += r.m.position.shares * (r.m.mark.close - r.dd.closingHigh);
        belowCount++;
      }
    }
    return { book, marked, rows, exposure, corr, betas, series, belowHigh, belowCount };
  }, [ready, symbols.length, bundles, ws, resolve, bySymbol, groups, today]);

  const scenario = useMemo(() => {
    if (!view) return null;
    const m = parseNum(mkt);
    const ss = parseNum(stockShock);
    const stock: Record<string, number> = {};
    if (stockSym && ss !== null) stock[stockSym] = ss / 100;
    if (m === null && Object.keys(stock).length === 0) return null;
    return scenarioShock(view.marked, { stock, market: m === null ? undefined : m / 100, betas: view.betas });
  }, [view, mkt, stockSym, stockShock]);

  const write = (mutate: (w: Workspace) => Omit<Workspace, 'revision' | 'updatedAt'>, okText: string): boolean => {
    const ok = update(mutate);
    setNotice(ok ? { tone: 'info', text: okText } : { tone: 'warn', text: 'Another tab changed your workspace first. The latest copy is loaded and nothing was written. Review it and repeat the action.' });
    return ok;
  };

  const addManual = () => {
    const r = resolve(fSym);
    const shares = parseNum(fShares);
    const cost = parseNum(fCost);
    if (isNa(r)) return setNotice({ tone: 'error', text: reasonDetail(r) });
    if (shares === null) return setNotice({ tone: 'error', text: 'Enter the number of shares.' });
    if (cost !== null && cost < 0) return setNotice({ tone: 'error', text: 'Cost per share must be zero or more.' });
    const now = new Date().toISOString();
    const ok = write((w) => {
      const existing = w.positions.find((p) => p.symbol === r.symbol);
      const others = w.positions.filter((p) => p.symbol !== r.symbol);
      if (shares === 0) {
        return { ...w, positions: others, archivedPositions: existing ? [...w.archivedPositions, { ...existing, archivedAt: now, reason: 'Manual edit set the quantity to zero' }] : w.archivedPositions };
      }
      return { ...w, positions: [...others, { symbol: r.symbol, shares, cost, acquiredOn: fDate || null, source: 'manual' }] };
    }, shares === 0 ? `${r.symbol} archived.` : `${r.symbol} saved.`);
    if (ok) {
      setFSym(''); setFShares(''); setFCost(''); setFDate('');
      setPanel('none');
    }
  };

  const archive = (symbol: string) => {
    const now = new Date().toISOString();
    write((w) => {
      const existing = w.positions.find((p) => p.symbol === symbol);
      return existing ? { ...w, positions: w.positions.filter((p) => p.symbol !== symbol), archivedPositions: [...w.archivedPositions, { ...existing, archivedAt: now, reason: 'Removed by owner' }] } : w;
    }, `${symbol} archived. It stays in the archive below.`);
  };

  const loadDemo = async () => {
    const map = new Map<string, number>();
    for (const d of DEMO) {
      const r = resolve(d.symbol);
      if (isNa(r)) continue;
      const s = await getProvider().getDaily(r.instrumentId).catch(() => null);
      if (s && !isNa(s) && s.bars.length) map.set(d.symbol, s.bars[s.bars.length - 1]!.close);
    }
    write((w) => ({
      ...w,
      positions: DEMO.map((d) => {
        const c = map.get(d.symbol);
        return { symbol: d.symbol, shares: d.shares, cost: d.costFactor !== null && c !== undefined ? Math.round(c * d.costFactor * 100) / 100 : null, acquiredOn: d.acquiredOn, source: 'demo' as const, note: 'Demo position. Not a real holding.' };
      }),
    }), 'Demo positions loaded. They are sample rows, not real holdings.');
  };

  const previewCsv = () => {
    const parsed = parsePositionsCsv(csvText);
    setPreview({ p: reconcileImport(toBook(ws, resolve), parsed.rows, resolve, 'csv'), errors: parsed.errors });
    setNotice(null);
  };

  const decide = (accept: boolean) => {
    if (!preview) return;
    const now = new Date().toISOString();
    const receiptId = newId();
    const res = applyReconciliation(toBook(ws, resolve), preview.p, { accept, decidedAt: now, receiptId });
    if (isNa(res)) {
      setPreview(null);
      return setNotice({ tone: 'warn', text: `${res.detail ?? 'Revision conflict.'} Your positions changed after this preview was made, in this tab or another one. Nothing was applied. Preview the file again.` });
    }
    const ok = write((w) => {
      const prior = new Map(w.positions.map((p) => [p.symbol, p]));
      const touched = new Set([...res.receipt.added, ...res.receipt.changed.map((c) => c.symbol)]);
      const positions: WorkspacePosition[] = accept
        ? res.book.positions.map((p) => {
            const old = prior.get(p.symbol);
            return { symbol: p.symbol, shares: p.shares, cost: p.cost ?? null, acquiredOn: p.acquiredOn ?? null, source: touched.has(p.symbol) || !old ? 'csv' : old.source, ...(old?.note && !touched.has(p.symbol) ? { note: old.note } : {}) };
          })
        : w.positions;
      const archived = accept
        ? [...w.archivedPositions, ...preview.p.removals.map((p) => ({ ...(prior.get(p.symbol) ?? { symbol: p.symbol, shares: p.shares, cost: p.cost ?? null, acquiredOn: p.acquiredOn ?? null, source: 'csv' as const }), archivedAt: now, reason: `Absent from the CSV import, receipt ${receiptId}` }))]
        : w.archivedPositions;
      return {
        ...w,
        positions,
        archivedPositions: archived,
        journal: [...w.journal, { id: receiptId, createdAt: now, symbol: null, kind: 'import-receipt', text: `CSV import ${res.receipt.decision}. ${res.receipt.summary}`, payload: { type: 'import-receipt', ...res.receipt, parseErrors: preview.errors } }],
      };
    }, accept ? `Import accepted. ${res.receipt.summary} A receipt is in the journal.` : 'Import rejected. Nothing changed. A receipt is in the journal.');
    setPreview(null);
    if (ok) {
      setCsvText('');
      setPanel('none');
    }
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(ws, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `market-cycle-workspace-r${ws.revision}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const readFile = async (file: File | undefined, kind: 'csv' | 'json') => {
    if (!file) return;
    const text = await file.text();
    if (kind === 'csv') {
      setCsvText(text);
      setPreview(null);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isWorkspaceShape(parsed)) throw new Error('The file is not a workspace export.');
      setJsonIn(parsed);
      setNotice(null);
    } catch (e) {
      setJsonIn(null);
      setNotice({ tone: 'error', text: e instanceof Error ? e.message : 'The file could not be read.' });
    }
  };

  const applyJson = () => {
    if (!jsonIn) return;
    const { revision: _r, updatedAt: _u, ...rest } = jsonIn;
    if (write(() => ({ ...rest, archivedPositions: rest.archivedPositions ?? [], alertsAcknowledged: rest.alertsAcknowledged ?? [], notes: rest.notes ?? {} }), 'Workspace replaced from the file.')) {
      setJsonIn(null);
      setPanel('none');
    }
  };

  const saveBudget = () => {
    const b = parseNum(budgetText);
    if (b !== null && b < 0) return setNotice({ tone: 'error', text: 'The loss budget must be zero or more.' });
    write((w) => ({ ...w, settings: { ...w.settings, lossBudget: b } }), b === null ? 'Loss budget cleared.' : 'Loss budget saved.');
  };

  const cols: Column<Row>[] = [
    {
      key: 'symbol', header: 'Symbol', sticky: true, sort: (r) => r.m.position.symbol,
      cell: (r) => (
        <span>
          <Link className="pf-sym" to={researchPath(r.m.position.symbol)}>{r.m.position.symbol}</Link>
          {STATE_LABEL[r.m.state] && <span style={{ marginLeft: 6 }}><Chip tone="warn">{STATE_LABEL[r.m.state]}</Chip></span>}
        </span>
      ),
    },
    { key: 'shares', header: 'Shares', sort: (r) => r.m.position.shares, cell: (r) => <span className="num">{fmtNum(r.m.position.shares, Number.isInteger(r.m.position.shares) ? 0 : 2, r.m.position.shares < 0)}</span> },
    { key: 'cost', header: 'Cost per share', sort: (r) => r.m.position.cost ?? null, cell: (r) => (typeof r.m.position.cost === 'number' ? <span className="num">{fmtPrice(r.m.position.cost)}</span> : <span className="faint">Not recorded</span>) },
    { key: 'close', header: 'Close', sort: (r) => (isNa(r.m.mark) ? null : r.m.mark.close), cell: (r) => (isNa(r.m.mark) ? <Missing why={r.m.mark} /> : <span className="num" title={`Close on ${fmtDate(r.m.mark.date)}`}>{fmtPrice(r.m.mark.close)}</span>) },
    { key: 'value', header: 'Value', info: 'Shares times the dated completed close. Negative for a short position.', sort: (r) => (isNa(r.m.value) ? null : r.m.value), cell: (r) => (isNa(r.m.value) ? <Missing why={r.m.value} /> : <span className="num">{fmtDollars(r.m.value, r.m.value < 0)}</span>) },
    {
      key: 'pnl', header: 'Unrealized P and L', info: 'Shares times close minus cost. Shown only when a cost is recorded.', sort: (r) => (isNa(r.m.pnl) ? null : r.m.pnl),
      cell: (r) => (isNa(r.m.pnl) ? <Missing why={r.m.pnl.code === 'no-coverage' && r.m.state !== 'zero' && !isNa(r.m.mark) ? 'Cost not recorded' : r.m.pnl} /> : <span className={`num ${r.m.pnl >= 0 ? 'up' : 'down'}`}>{fmtDollars(r.m.pnl, true)} <span className="small">({fmtPct(isNa(r.m.pnlPct) ? null : r.m.pnlPct, 1)})</span></span>),
    },
    { key: 'day', header: 'Day', sort: (r) => r.dayChange, cell: (r) => <Pct v={r.dayChange} glyph /> },
    {
      key: 'dd', header: 'From closing high', info: 'Latest close against the highest close of the last 252 sessions.', sort: (r) => (isNa(r.dd) ? null : r.dd.drawdown),
      cell: (r) => (isNa(r.dd) ? <Missing why={r.dd} /> : <Link to={researchPath(r.m.position.symbol, 'selloffs')} style={{ color: 'inherit' }} title={`High ${fmtPrice(r.dd.closingHigh)} on ${fmtDate(r.dd.highDate)}`}><Pct v={r.dd.drawdown} /></Link>),
    },
    { key: 'earn', header: 'Next earnings', sort: (r) => (isNa(r.next) ? null : r.next.date), cell: (r) => (isNa(r.next) ? <Missing why={r.next} /> : <span>{fmtDateShort(r.next.date)} <span className="faint small">{r.next.status}</span></span>) },
    { key: 'src', header: 'Source', align: 'l', sort: (r) => r.ws?.source ?? null, cell: (r) => (r.ws ? <Chip tone={r.ws.source === 'demo' ? 'warn' : undefined}>{SOURCE_LABEL[r.ws.source]}</Chip> : null) },
    { key: 'x', header: <span className="sr-only">Archive</span>, cell: (r) => <button type="button" className="btn ghost small" aria-label={`Archive ${r.m.position.symbol}`} onClick={() => archive(r.m.position.symbol)}>Archive</button> },
  ];

  const empty = ws.positions.length === 0;
  const hasDemo = ws.positions.some((p) => p.source === 'demo');
  const mb = view?.marked;
  const corrSyms = view ? view.series.map((s) => s.symbol) : [];
  const corrOf = (a: string, b: string) => view?.corr.find((c) => (c.a === a && c.b === b) || (c.a === b && c.b === a));

  return (
    <div className="stack">
      <div className="pf-head">
        <h1>Positions and risk</h1>
        <span className="pf-health">{storageScopeText()} Revision {ws.revision}.</span>
      </div>
      <div className="row">
        <button type="button" className={`btn ${empty ? 'primary' : ''}`} aria-expanded={panel === 'add'} onClick={() => setPanel(panel === 'add' ? 'none' : 'add')}>Add position</button>
        <button type="button" className="btn" aria-expanded={panel === 'csv'} onClick={() => setPanel(panel === 'csv' ? 'none' : 'csv')}>Import CSV</button>
        {empty && <button type="button" className="btn" disabled={!ready} onClick={() => void loadDemo()}>Load demo positions</button>}
        <span style={{ flex: 1 }} />
        <button type="button" className="btn ghost small" onClick={exportJson}>Export workspace</button>
        <button type="button" className="btn ghost small" aria-expanded={panel === 'json'} onClick={() => setPanel(panel === 'json' ? 'none' : 'json')}>Restore from file</button>
      </div>
      {notice && <StateNote tone={notice.tone}>{notice.text}</StateNote>}
      {hasDemo && <StateNote tone="warn" title="Demo positions.">These rows are a sample set on synthetic prices. They are not real holdings. Archive them or import your own.</StateNote>}

      {panel === 'add' && (
        <Card title="Add or correct a position" sub="Saving an existing symbol replaces its row. Zero shares archives it.">
          <div className="pf-form">
            <Field label="Symbol"><SymbolPicker instruments={instruments} label="Position symbol" onPick={setFSym} value={fSym} clearOnPick={false} key={fSym} /></Field>
            <Field label="Shares" hint="Negative for a short"><NumInput label="Shares" value={fShares} onChange={setFShares} /></Field>
            <Field label="Cost per share" hint="Optional"><NumInput label="Cost per share" value={fCost} onChange={setFCost} min="0" /></Field>
            <Field label="Acquired" hint="Optional"><input className="input" type="date" aria-label="Acquired date" value={fDate} max={today} onChange={(e) => setFDate(e.target.value)} /></Field>
            <button type="button" className="btn primary" onClick={addManual} disabled={!fSym}>Save position</button>
          </div>
        </Card>
      )}

      {panel === 'csv' && (
        <Card title="Import positions from CSV" sub="Header row with symbol and shares. Optional cost and acquired (YYYY-MM-DD) columns. Nothing changes until you accept the preview.">
          <div className="pf-stack-sm">
            <textarea className="pf-textarea" aria-label="CSV text" placeholder={'symbol,shares,cost,acquired\nNVDA,100,38.50,2025-03-14'} value={csvText} onChange={(e) => { setCsvText(e.target.value); setPreview(null); }} />
            <div className="row">
              <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" className="sr-only" aria-label="Choose a CSV file" onChange={(e) => void readFile(e.target.files?.[0], 'csv')} />
              <button type="button" className="btn small" onClick={() => fileRef.current?.click()}>Choose file</button>
              <button type="button" className="btn primary" disabled={!csvText.trim() || !ready} onClick={previewCsv}>Preview changes</button>
            </div>
            {preview && <ImportPreview preview={preview.p} errors={preview.errors} onAccept={() => decide(true)} onReject={() => decide(false)} />}
          </div>
        </Card>
      )}

      {panel === 'json' && (
        <Card title="Restore the workspace from a file" sub="Replaces watchlist, positions, journal and settings with the file's contents.">
          <div className="pf-stack-sm">
            <input type="file" accept="application/json,.json" aria-label="Choose a workspace export file" onChange={(e) => void readFile(e.target.files?.[0], 'json')} />
            {jsonIn && (
              <>
                <dl className="pf-diff">
                  <dt>File</dt><dd>Revision {jsonIn.revision}{jsonIn.updatedAt ? `, saved ${fmtDate(jsonIn.updatedAt.slice(0, 10))}` : ''}. {jsonIn.positions.length} positions, {jsonIn.watchlist.length} watched, {jsonIn.journal.length} journal entries.</dd>
                  <dt>Current</dt><dd>Revision {ws.revision}. {ws.positions.length} positions, {ws.watchlist.length} watched, {ws.journal.length} journal entries.</dd>
                </dl>
                {jsonIn.revision < ws.revision && <StateNote tone="warn" title="The file is older than the current workspace.">It was exported at revision {jsonIn.revision}. Restoring it discards {ws.revision - jsonIn.revision} later revisions. Export the current workspace first if you may need it.</StateNote>}
                <div className="row">
                  <button type="button" className="btn primary" onClick={applyJson}>Replace workspace</button>
                  <button type="button" className="btn" onClick={() => setJsonIn(null)}>Cancel</button>
                </div>
              </>
            )}
          </div>
        </Card>
      )}

      {empty && panel === 'none' && (
        <StateNote>No positions yet. Add one by hand, import a CSV, or load the demo set to see how this page works. Watch only names live on <Link to="/">Today</Link>.</StateNote>
      )}
      {!empty && bundles.status === 'error' && <StateNote tone="error" title="Prices could not be loaded." action={<button type="button" className="btn small" onClick={() => invalidate()}>Retry</button>}>{bundles.error.message}</StateNote>}
      {!empty && !view && bundles.status !== 'error' && <Skeleton h={220} />}

      {!empty && view && mb && (
        <>
          <Card
            title="Positions"
            sub={mb.markDates ? (mb.markDates.oldest === mb.markDates.newest ? `Marked at the ${fmtDate(mb.markDates.newest)} close.` : `Mark dates differ, ${fmtDate(mb.markDates.oldest)} to ${fmtDate(mb.markDates.newest)}.`) : 'No position could be marked.'}
          >
            <div className="pf-stack-sm">
              <div className="stats">
                <Stat label="Marked value" value={isNa(mb.totalValue) ? fmtDollars(mb.coveredValue) : fmtDollars(mb.totalValue)} sub={`${mb.coveredCount} of ${mb.coveredCount + mb.missing.length} holdings marked`} />
                <Stat label="Unrealized P and L" value={mb.pnlCoveredCount ? fmtDollars(mb.coveredPnl, true) : 'n/a'} tone={mb.pnlCoveredCount ? (mb.coveredPnl >= 0 ? 'up' : 'down') : undefined} sub={`Cost recorded for ${mb.pnlCoveredCount} of ${mb.coveredCount}`} />
                <Stat label="Below closing highs" info="Shares times the gap between the latest close and the highest close of the last 252 sessions, summed over long holdings." value={view.belowCount ? fmtDollars(view.belowHigh, true) : 'n/a'} tone={view.belowHigh < 0 ? 'down' : 'flat'} sub={`${view.belowCount} long holdings`} />
                <Stat label="Largest holding" value={view.exposure.topWeight === null ? 'n/a' : fmtPct(view.exposure.topWeight, 1, false)} sub={view.exposure.names[0] ? `${view.exposure.names[0].symbol}, share of gross value` : undefined} />
              </div>
              {mb.missing.length > 0 && <StateNote tone="warn" title="Totals are incomplete.">No dated close for {mb.missing.map((m) => `${m.symbol} (${reasonText(m.reason)})`).join(', ')}. These holdings are not in any total above.</StateNote>}
              {narrow ? (
                <ul className="pf-list">
                  {sortRows(view.rows, cols, sort).map((r) => (
                    <li key={r.m.position.symbol}>
                      <div className="pf-row-top">
                        <Link className="pf-sym" to={researchPath(r.m.position.symbol)}>{r.m.position.symbol}</Link>
                        <span className="grow faint small">{fmtNum(r.m.position.shares, 0, r.m.position.shares < 0)} sh{STATE_LABEL[r.m.state] ? `, ${STATE_LABEL[r.m.state].toLowerCase()}` : ''}{r.ws ? `, ${SOURCE_LABEL[r.ws.source].toLowerCase()}` : ''}</span>
                        <span className="num">{isNa(r.m.value) ? reasonText(r.m.value) : fmtDollars(r.m.value, r.m.value < 0)}</span>
                        <Pct v={r.dayChange} glyph />
                      </div>
                      <div className="pf-row-sub">
                        <span>P and L {isNa(r.m.pnl) ? (typeof r.m.position.cost === 'number' ? reasonText(r.m.pnl) : 'cost not recorded') : <span className={r.m.pnl >= 0 ? 'up' : 'down'}>{fmtDollars(r.m.pnl, true)}</span>}</span>
                        <span>From high {isNa(r.dd) ? reasonText(r.dd) : <Pct v={r.dd.drawdown} digits={1} />}</span>
                        <span>Earnings {isNa(r.next) ? reasonText(r.next) : fmtDateShort(r.next.date)}</span>
                        <button type="button" className="btn ghost small" style={{ marginLeft: 'auto' }} aria-label={`Archive ${r.m.position.symbol}`} onClick={() => archive(r.m.position.symbol)}>Archive</button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <DataTable rows={sortRows(view.rows, cols, sort)} cols={cols} sort={sort} onSort={setSort} rowKey={(r) => r.m.position.symbol} caption="Positions" />
              )}
              {ws.archivedPositions.length > 0 && (
                <Disclosure summary={`Archived positions (${ws.archivedPositions.length})`}>
                  <ul className="muted small" style={{ margin: 0, paddingLeft: 18 }}>
                    {[...ws.archivedPositions].reverse().map((a, i) => <li key={i}>{a.symbol}, {fmtNum(a.shares, 0, a.shares < 0)} shares. {a.reason}. {fmtDate(a.archivedAt.slice(0, 10))}</li>)}
                  </ul>
                </Disclosure>
              )}
            </div>
          </Card>

          <div className="grid">
            <Card title="Exposure" info={view.exposure.note} sub="Share of gross marked value. Direct holdings only.">
              <div className="pf-stack-sm">
                <ExposureList title="By trading group" rows={view.exposure.byGroup} />
                <ExposureList title="By sector" rows={view.exposure.bySector} />
                <p className="small muted">
                  Concentration index {view.exposure.herfindahl === null ? 'n/a' : fmtNum(view.exposure.herfindahl, 2)} <span className="faint">(1.00 is one name, {fmtNum(1 / Math.max(1, view.exposure.names.length), 2)} is equal weight across {view.exposure.names.length})</span>
                </p>
              </div>
            </Card>

            <Card title="Hypothetical shock" sub="Dollar change if prices moved by the amounts you enter. Not a forecast.">
              <div className="pf-stack-sm">
                <div className="pf-form">
                  <Field label="Market move, %" hint="Applied as beta times move"><NumInput label="Market move percent" value={mkt} onChange={setMkt} /></Field>
                  <Field label="One stock">
                    <select className="select" aria-label="Stock to shock directly" value={stockSym} onChange={(e) => setStockSym(e.target.value)}>
                      <option value="">None</option>
                      {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </Field>
                  <Field label="Its move, %" hint="Overrides beta"><NumInput label="Stock move percent" value={stockShock} onChange={setStockShock} /></Field>
                </div>
                {!scenario ? (
                  <p className="muted">Enter a market move or a stock move.</p>
                ) : (
                  <>
                    <div className="stats">
                      <Stat label="Total change" value={isNa(scenario.totalChange) ? fmtDollars(scenario.coveredChange, true) : fmtDollars(scenario.totalChange, true)} tone={scenario.coveredChange < 0 ? 'down' : scenario.coveredChange > 0 ? 'up' : 'flat'} sub={`${scenario.coveredCount} holdings${scenario.missing.length ? `, ${scenario.missing.join(', ')} not included` : ''}`} />
                      {ws.settings.lossBudget !== null && <Stat label="Against loss budget" value={scenario.coveredChange < 0 ? fmtPct(-scenario.coveredChange / Math.max(1e-9, ws.settings.lossBudget), 0, false) : '0%'} sub={`of ${fmtDollars(ws.settings.lossBudget)}`} />}
                    </div>
                    <div className="table-wrap">
                      <table className="data">
                        <caption className="sr-only">Hypothetical shock by holding</caption>
                        <thead><tr><th className="l" scope="col">Symbol</th><th scope="col">Move</th><th className="l" scope="col">Basis</th><th scope="col">Change</th></tr></thead>
                        <tbody>
                          {scenario.rows.map((r) => (
                            <tr key={r.symbol}>
                              <td className="l">{r.symbol}</td>
                              <td>{isNa(r.shock) ? <Missing why={r.shock} /> : <Pct v={r.shock} digits={1} />}</td>
                              <td className="l muted">{r.basis === 'stock' ? 'Entered' : r.basis === 'beta x market' ? `Beta ${fmtNum(view.betas[r.symbol] as number, 2)}` : 'None'}</td>
                              <td>{isNa(r.change) ? <Missing why={r.change} /> : <span className={`num ${r.change >= 0 ? 'up' : 'down'}`}>{fmtDollars(r.change, true)}</span>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            </Card>

            <Card title="Loss budget" info="The further dollar loss you are willing to bear across these holdings. Used on this page and in the protection planner." sub="Your own limit. It is a reference line, not an order.">
              <div className="pf-stack-sm">
                <div className="row" style={{ alignItems: 'flex-end' }}>
                  <Field label="Budget, dollars"><NumInput label="Loss budget in dollars" value={budgetText} onChange={setBudgetText} min="0" placeholder="Not set" /></Field>
                  <button type="button" className="btn" onClick={saveBudget}>Save</button>
                </div>
                {ws.settings.lossBudget === null ? (
                  <p className="muted">No budget set.</p>
                ) : (
                  <p>
                    Budget {fmtDollars(ws.settings.lossBudget)}. Long holdings sit <strong className={view.belowHigh < 0 ? 'down' : ''}>{fmtDollars(Math.abs(view.belowHigh))}</strong> below their 252 session closing highs
                    {ws.settings.lossBudget > 0 && <>, {fmtPct(Math.abs(view.belowHigh) / ws.settings.lossBudget, 0, false)} of the budget</>}. <Link to="/portfolio/protection">Plan protection</Link>
                  </p>
                )}
              </div>
            </Card>
          </div>

          <Card title="Correlation between holdings" info={`Pearson correlation of same date daily returns over the last ${CORRELATION_DEFAULTS.window} sessions. A pair needs at least ${CORRELATION_DEFAULTS.minObservations(CORRELATION_DEFAULTS.window)} shared sessions.`} sub="Descriptive and backward looking.">
            {corrSyms.length < 2 ? (
              <p className="muted">Needs at least two holdings with price history.</p>
            ) : (
              <div className="table-wrap" tabIndex={0} role="region" aria-label="Correlation matrix" style={{ border: 0 }}>
                <table className="pf-corr">
                  <caption className="sr-only">Correlation of daily returns between holdings</caption>
                  <thead><tr><th />{corrSyms.map((s) => <th key={s} scope="col">{s}</th>)}</tr></thead>
                  <tbody>
                    {corrSyms.map((a) => (
                      <tr key={a}>
                        <th className="l" scope="row">{a}</th>
                        {corrSyms.map((b) => {
                          if (a === b) return <td key={b} className="faint">1.00</td>;
                          const c = corrOf(a, b);
                          if (!c || isNa(c.correlation)) return <td key={b} className="faint" title={c && isNa(c.correlation) ? `${reasonDetail(c.correlation)} ${c.observations} shared sessions.` : undefined}>sparse</td>;
                          return <td key={b} className="num" style={{ background: heatBg(c.correlation, 1) }} title={`${c.observations} sessions, ${fmtDate(c.from)} to ${fmtDate(c.to)}`}>{fmtNum(c.correlation, 2, true)}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function ExposureList({ title, rows }: { title: string; rows: readonly { key: string; weight: number; value: number; symbols: string[] }[] }) {
  return (
    <div>
      <h3 style={{ marginBottom: 6 }}>{title}</h3>
      <div className="pf-mini" role="list" aria-label={title}>
        {rows.map((g) => (
          <div key={g.key} role="listitem" style={{ display: 'contents' }}>
            <span title={g.symbols.join(', ')} style={{ maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.key}</span>
            <div className="pf-mini-track" aria-hidden="true"><div className="pf-mini-fill" style={{ width: `${g.weight * 100}%`, right: 'auto', left: 0, background: 'var(--accent)' }} /></div>
            <span className="num">{fmtPct(g.weight, 0, false)} <span className="faint small">{g.symbols.join(', ')}</span></span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ImportPreview({ preview, errors, onAccept, onReject }: { preview: ReconcilePreview; errors: CsvError[]; onAccept: () => void; onReject: () => void }) {
  const p = preview;
  const fmtVal = (v: number | string | null) => (v === null ? 'none' : String(v));
  const nothing = p.adds.length + p.changes.length + p.removals.length === 0;
  return (
    <div className="pf-stack-sm" role="region" aria-label="Import preview">
      <hr className="sep" />
      <h3>Preview. {p.summary}</h3>
      {errors.length > 0 && <StateNote tone="error" title={`${errors.length} rows could not be read and are skipped.`}>{errors.map((e) => `Row ${e.row}: ${e.message}`).join(' ')}</StateNote>}
      <dl className="pf-diff">
        {p.adds.length > 0 && (<><dt><Chip tone="up">Add</Chip></dt><dd>{p.adds.map((a) => `${a.symbol} ${a.shares} sh${typeof a.cost === 'number' ? ` at $${a.cost}` : ''}`).join(', ')}</dd></>)}
        {p.changes.length > 0 && (<><dt><Chip tone="accent">Change</Chip></dt><dd>{p.changes.map((c) => `${c.after.symbol}: ${c.fields.map((f) => `${f.field} ${fmtVal(f.from)} to ${fmtVal(f.to)}`).join(', ')}`).join('. ')}</dd></>)}
        {p.removals.length > 0 && (<><dt><Chip tone="down">Remove</Chip></dt><dd>{p.removals.map((r) => r.symbol).join(', ')}. Not in the file. Accepting moves them to the archive, nothing is deleted.</dd></>)}
        {p.unchanged.length > 0 && (<><dt><Chip>Same</Chip></dt><dd>{p.unchanged.map((r) => r.symbol).join(', ')}</dd></>)}
        {p.duplicates.length > 0 && (<><dt><Chip tone="warn">Duplicate</Chip></dt><dd>{p.duplicates.map((d) => `${d.symbol} on rows ${d.rows.map((r) => r.row).join(', ')}`).join('. ')}. Held out and not summed. The existing row is left as is.</dd></>)}
        {p.unmapped.length > 0 && (<><dt><Chip tone="warn">Not recognized</Chip></dt><dd>{p.unmapped.map((u) => `${u.row.symbol} (row ${u.row.row})`).join(', ')}. Skipped.</dd></>)}
        {p.aliasMapped.length > 0 && (<><dt><Chip>Former ticker</Chip></dt><dd>{p.aliasMapped.map((a) => `${a.row.symbol} imports as ${a.symbol}`).join(', ')}</dd></>)}
        {p.shorts.length > 0 && (<><dt><Chip tone="warn">Short</Chip></dt><dd>{p.shorts.map((s) => `${s.symbol} ${s.shares}`).join(', ')}. Negative quantity imports as a short position.</dd></>)}
        {p.zeroQuantity.length > 0 && (<><dt><Chip>Zero</Chip></dt><dd>{p.zeroQuantity.map((s) => s.symbol).join(', ')}. Treated as not held.</dd></>)}
      </dl>
      <div className="row">
        <button type="button" className="btn primary" onClick={onAccept} disabled={nothing}>Accept import</button>
        <button type="button" className="btn" onClick={onReject}>Reject</button>
        {nothing && <span className="muted small">Nothing to apply.</span>}
      </div>
    </div>
  );
}
