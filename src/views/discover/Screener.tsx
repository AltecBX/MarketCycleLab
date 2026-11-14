/** Screener. Every control lives in the URL, so opening a row and pressing Back restores the exact list. */
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { isNum } from '../../engine/core/types';
import {
  addCondition, defaultScreenerState, fieldDef, nextSort, parseQuickRule, removeCondition, runScreener, screenerStateFromParams, screenerStateToParams,
  SCREENER_FIELDS, type Clause, type Condition, type FieldDef, type FieldId, type FilterSet, type Operator, type ScreenerRow, type ScreenerState,
} from '../../engine/screener';
import { Card, Chip, DataTable, Disclosure, Info, Sheet, Skeleton, StateNote, type Column } from '../../ui/components';
import { fmtDate, fmtMoney, fmtMultiple, fmtNum, fmtPrice } from '../../ui/format';
import { useIsPhone, useScrollRestore } from './shared/hooks';
import { CapControl, capLabel, DiscoverIssues, fieldText, Na, Pager, PctCell, PriceCell, SymbolLink } from './shared/parts';
import { useDiscoverData } from './shared/useDiscoverData';

const MAIN: FieldId[] = ['symbol', 'name', 'price', 'cap', 'group', 'pe', 'rsi', 'sma200', 'buy10', 'day', 'wtd', 'mtd', 'qtd', 'ytd'];
const WITH_INFO = new Set<FieldId>(['price', 'cap', 'group', 'pe', 'rsi', 'sma200', 'buy10', 'wtd', 'mtd', 'qtd', 'ytd']);
const PHONE_METRICS: FieldId[] = ['ytd', 'wtd', 'mtd', 'qtd', 'sma200', 'rsi', 'pe', 'cap'];
const BUY_NOTE = 'Unavailable in this build. The Signal Score is not connected to the screener yet.';

const NUM_OPS: { op: Operator; label: string }[] = [
  { op: 'gte', label: 'at least' }, { op: 'lte', label: 'at most' }, { op: 'gt', label: 'above' }, { op: 'lt', label: 'below' },
  { op: 'between', label: 'between' }, { op: 'available', label: 'is available' }, { op: 'missing', label: 'is missing' },
];
const TEXT_OPS: { op: Operator; label: string }[] = [{ op: 'eq', label: 'is' }, { op: 'available', label: 'is available' }, { op: 'missing', label: 'is missing' }];
const UNIT_HINT: Record<FieldDef['unit'], string> = { text: '', price: '$', billions: '$B', multiple: 'x', index: '', percent: '%' };

function Builder({ rows, onAdd, canOr }: { rows: readonly ScreenerRow[]; onAdd: (c: Condition, or: boolean) => void; canOr: boolean }) {
  const fields = SCREENER_FIELDS.filter((f) => f.id !== 'symbol' && f.id !== 'name' && f.id !== 'buy10' && f.id !== 'week');
  const [field, setField] = useState<FieldId>('cap');
  const [op, setOp] = useState<Operator>('gte');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const f = fieldDef(field);
  const ops = f.kind === 'text' ? TEXT_OPS : NUM_OPS;
  const textValues = useMemo(() => {
    if (f.kind !== 'text') return [];
    const s = new Set<string>();
    for (const r of rows) {
      if (f.id === 'group') r.groups.forEach((g) => s.add(g));
      else {
        const v = f.get(r);
        if (typeof v === 'string' && v) s.add(v);
      }
    }
    return [...s].sort();
  }, [rows, f]);
  const pickField = (id: FieldId) => {
    setField(id);
    setOp(fieldDef(id).kind === 'text' ? 'eq' : 'gte');
    setA('');
    setB('');
    setErr(null);
  };
  const build = (or: boolean) => {
    if (op === 'available' || op === 'missing') return onAdd({ field, op }, or);
    if (f.kind === 'text') {
      if (!a) return setErr(`Choose a value for ${f.label}`);
      return onAdd({ field, op: 'eq', value: a }, or);
    }
    const x = Number(a);
    if (a.trim() === '' || !Number.isFinite(x)) return setErr('Enter a number');
    if (op === 'between') {
      const y = Number(b);
      if (b.trim() === '' || !Number.isFinite(y)) return setErr('Enter the upper bound');
      return onAdd({ field, op, value: Math.min(x, y), value2: Math.max(x, y) }, or);
    }
    setErr(null);
    onAdd({ field, op, value: x }, or);
  };
  const needsValue = op !== 'available' && op !== 'missing';
  return (
    <div>
      <div className="dv-builder">
        <label className="field">
          Field
          <select className="select" value={field} onChange={(e) => pickField(e.target.value as FieldId)}>
            {fields.map((x) => (
              <option key={x.id} value={x.id}>{x.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Condition
          <select className="select" value={op} onChange={(e) => setOp(e.target.value as Operator)}>
            {ops.map((o) => (
              <option key={o.op} value={o.op}>{o.label}</option>
            ))}
          </select>
        </label>
        {needsValue && f.kind === 'text' && (
          <label className="field">
            Value
            <select className="select" value={a} onChange={(e) => setA(e.target.value)}>
              <option value="">Choose</option>
              {textValues.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </label>
        )}
        {needsValue && f.kind === 'number' && (
          <label className="field">
            Value{UNIT_HINT[f.unit] ? ` (${UNIT_HINT[f.unit]})` : ''}
            <input className="input" style={{ width: 96 }} inputMode="decimal" value={a} onChange={(e) => setA(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && build(false)} />
          </label>
        )}
        {needsValue && op === 'between' && (
          <label className="field">
            And{UNIT_HINT[f.unit] ? ` (${UNIT_HINT[f.unit]})` : ''}
            <input className="input" style={{ width: 96 }} inputMode="decimal" value={b} onChange={(e) => setB(e.target.value)} />
          </label>
        )}
        <button type="button" className="btn small primary" onClick={() => build(false)}>Add condition</button>
        <button type="button" className="btn small" disabled={!canOr} onClick={() => build(true)} title="Join with the last condition. Either one can hold.">
          Add as OR with last
        </button>
      </div>
      <div className="small muted">{f.definition} Conditions combine with AND. Missing data never passes a numeric condition.</div>
      {err && <div className="dv-err" role="alert">{err}</div>}
    </div>
  );
}

export default function Screener() {
  const d = useDiscoverData();
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const phone = useIsPhone();
  const [rule, setRule] = useState('');
  const [ruleErrors, setRuleErrors] = useState<{ text: string; message: string }[]>([]);
  const [detail, setDetail] = useState<ScreenerRow | null>(null);
  const [phoneMetric, setPhoneMetric] = useState<FieldId>('ytd');

  const parsed = useMemo(() => screenerStateFromParams(Object.fromEntries(sp.entries())), [sp]);
  const state = parsed.state;
  const effective = useMemo<ScreenerState>(() => ({ ...state, sort: state.sort ?? { field: 'cap', dir: 'desc' } }), [state]);
  const view = useMemo(() => (d.status === 'ready' ? runScreener(d.data.rows, effective) : null), [d, effective]);
  useScrollRestore(view !== null);

  const write = (next: ScreenerState, replace = true) => setSp(new URLSearchParams(screenerStateToParams({ ...next, tab: 'main' })), { replace });
  const patch = (p: Partial<ScreenerState>, resetPage = true) => write({ ...state, ...p, page: resetPage ? 1 : (p.page ?? state.page) });
  const setFilter = (filter: FilterSet) => patch({ filter });

  const applyRule = () => {
    if (rule.trim() === '') return;
    const r = parseQuickRule(rule);
    if (!r.ok) return setRuleErrors(r.errors);
    setRuleErrors([]);
    setRule('');
    setFilter({ clauses: [...state.filter.clauses, ...r.filter.clauses] });
  };
  const addBuilt = (c: Condition, or: boolean) => {
    const cl = state.filter.clauses;
    if (or && cl.length) {
      const last = cl[cl.length - 1]!;
      const merged: Clause = { any: ['any' in last ? last.any : [last], [c]].flat() as Condition[] };
      setFilter({ clauses: [...cl.slice(0, -1), merged] });
    } else setFilter(addCondition(state.filter, c));
  };
  const filterGroup = (name: string) => {
    const rest = state.filter.clauses.filter((c) => !(!('any' in c) && c.field === 'group' && c.op === 'eq'));
    setFilter({ clauses: [...rest, { field: 'group', op: 'eq', value: name }] });
  };
  const open = (r: ScreenerRow) => nav(`/research/${encodeURIComponent(r.symbol)}/overview`);
  const isDefault = Object.keys(screenerStateToParams({ ...state, tab: 'main' })).length === 0;

  if (d.status === 'loading') return <Skeleton h={420} />;
  if (d.status === 'error') {
    return (
      <StateNote tone="error" title="The universe could not be loaded." action={<button type="button" className="btn small" onClick={d.reload}>Retry</button>}>
        {d.error.message}
      </StateNote>
    );
  }
  const { asOf } = d.data;
  const v = view!;
  const u = v.universe;
  const stocks = u.candidates - u.notEligibleType;

  const cols: Column<ScreenerRow>[] = MAIN.map((id) => {
    const f = fieldDef(id);
    const info = !WITH_INFO.has(id) ? undefined : id === 'buy10' ? `${f.definition} ${BUY_NOTE}` : id === 'price' ? `${f.definition} Closes are as of ${fmtDate(asOf)} unless a row says otherwise.` : f.definition;
    return {
      key: id,
      header: f.short,
      info,
      sticky: id === 'symbol',
      align: f.kind === 'text' ? 'l' : 'r',
      sort: (r) => f.get(r),
      cell: (r) => {
        switch (id) {
          case 'symbol':
            return (
              <>
                <SymbolLink symbol={r.symbol} />
                {r.type === 'adr' && <span className="faint small"> ADR</span>}
              </>
            );
          case 'name':
            return <span className="dv-name" title={r.name}>{r.name}</span>;
          case 'price':
            return <PriceCell row={r} asOf={asOf} />;
          case 'cap':
            return isNum(r.marketCap) ? <span className="num">{fmtMoney(r.marketCap)}</span> : <Na why={r.marketCap} />;
          case 'group':
            return r.group ? (
              <button type="button" className="dv-link" title={`Show only ${r.group}`} onClick={(e) => { e.stopPropagation(); filterGroup(r.group!); }}>
                <span className="dv-name">{r.group}</span>
              </button>
            ) : (
              <span className="faint">None</span>
            );
          case 'pe':
            return isNum(r.forwardPe) ? <span className="num">{fmtMultiple(r.forwardPe)}</span> : <Na why={r.forwardPe} />;
          case 'rsi':
            return isNum(r.rsi14) ? <span className="num">{fmtNum(r.rsi14, 1)}</span> : <Na why={r.rsi14} />;
          case 'buy10':
            return isNum(r.buy10) && r.buy10Status === 'valid' ? <span className="num">{fieldText(f, r)}</span> : <Na why={BUY_NOTE} />;
          case 'sma200':
            return <PctCell v={r.sma200Dist} />;
          case 'day':
            return <PctCell v={r.dayChange} />;
          default:
            return <PctCell v={r[id as 'wtd' | 'mtd' | 'qtd' | 'ytd']} />;
        }
      },
    };
  });

  const sortField = effective.sort!.field;
  const pm = fieldDef(phoneMetric);

  return (
    <div className="stack">
      <DiscoverIssues issues={d.data.issues} />
      <Card>
        <div className="stack" style={{ gap: 12 }}>
          <div className="dv-toolbar">
            <CapControl value={state.minCapBillions} onChange={(c) => patch({ minCapBillions: c })} />
            <label className="field grow">
              Search ticker, company or group
              <input className="input" type="search" value={state.query} placeholder="For example MU or memory" onChange={(e) => patch({ query: e.target.value })} />
            </label>
            <div className="row" style={{ gap: 8 }}>
              <span className="dv-count num" role="status" aria-live="polite" data-testid="result-count">
                {v.matched.length} of {v.universeCount} stocks
              </span>
              <Info
                label="About the count"
                text={`${v.universeCount} of ${stocks} loaded stocks and ADRs are at or above ${capLabel(state.minCapBillions)}. ${u.belowFloor} below the minimum, ${u.noMarketCap} without a market cap, ${u.notEligibleType} funds outside the stock universe. Closes as of ${fmtDate(asOf)}.`}
              />
              <button type="button" className="btn small" disabled={isDefault} onClick={() => { write(defaultScreenerState()); setRuleErrors([]); }}>
                Reset
              </button>
            </div>
          </div>
          <div>
            <div className="dv-rule">
              <input
                className="input"
                aria-label="Quick filter rule"
                placeholder="cap >= 50, sma200 <= -30, pe <= 25, fcf > 2b, ytd < -1"
                value={rule}
                onChange={(e) => setRule(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && applyRule()}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <button type="button" className="btn small primary" onClick={applyRule}>Apply rule</button>
              <Info
                label="About quick rules"
                text={`Commas mean AND. Use "or" for alternatives. Percent fields take a number of percent, cap, cash and fcf take billions. Also: between 30 and 70, has pe, no fcf, group = "Quantum". Fields: ${SCREENER_FIELDS.filter((f) => f.id !== 'buy10' && f.id !== 'week').map((f) => f.aliases[0]).join(', ')}.`}
              />
            </div>
            {[...ruleErrors, ...parsed.errors].map((e, i) => (
              <div key={i} className="dv-err" role="alert">
                {e.text ? `"${e.text}": ` : ''}{e.message}
              </div>
            ))}
          </div>
          {v.chips.length > 0 && (
            <div className="dv-chips" aria-label="Active filters">
              {v.chips.map((c) => (
                <Chip key={`${c.clause}-${c.or ?? 'x'}`} tone="accent" onRemove={() => setFilter(removeCondition(state.filter, c.clause, c.or))}>
                  {c.label}
                </Chip>
              ))}
              <button type="button" className="btn small ghost" onClick={() => setFilter({ clauses: [] })}>Clear all filters</button>
            </div>
          )}
          <Disclosure summary="Build a condition">
            <Builder rows={d.data.rows} onAdd={addBuilt} canOr={state.filter.clauses.length > 0} />
          </Disclosure>
        </div>
      </Card>

      {phone ? (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 8 }}>
            <label className="field" style={{ flex: 1 }}>
              Sort by
              <select className="select" value={sortField} onChange={(e) => patch({ sort: { field: e.target.value as FieldId, dir: fieldDef(e.target.value as FieldId).kind === 'text' ? 'asc' : 'desc' } })}>
                {MAIN.filter((id) => id !== 'buy10').map((id) => (
                  <option key={id} value={id}>{fieldDef(id).label}</option>
                ))}
              </select>
            </label>
            <button type="button" className="btn" style={{ alignSelf: 'flex-end' }} onClick={() => patch({ sort: nextSort(effective.sort, sortField) })} aria-label={`Sort direction, ${effective.sort!.dir === 'asc' ? 'ascending' : 'descending'}`}>
              {effective.sort!.dir === 'asc' ? '▲ Low first' : '▼ High first'}
            </button>
            <label className="field" style={{ flex: 1 }}>
              Show
              <select className="select" value={phoneMetric} onChange={(e) => setPhoneMetric(e.target.value as FieldId)}>
                {PHONE_METRICS.map((id) => (
                  <option key={id} value={id}>{fieldDef(id).short}</option>
                ))}
              </select>
            </label>
          </div>
          {v.page.rows.length === 0 ? (
            <StateNote>No stock matches. Remove a filter or lower the minimum market cap.</StateNote>
          ) : (
            <ul className="dv-list" aria-label="Screener results">
              {v.page.rows.map((r) => (
                <li key={r.symbol}>
                  <button type="button" className="dv-item" onClick={() => setDetail(r)} aria-label={`${r.symbol}, ${r.name}. Open details`}>
                    <span style={{ minWidth: 0 }}>
                      <span className="dv-sym">{r.symbol}</span>
                      <span className="nm" style={{ display: 'block' }}>{r.name}</span>
                    </span>
                    <span className="r num">
                      {isNum(r.price) ? fmtPrice(r.price) : 'n/a'}
                      <span style={{ display: 'block', fontSize: 12 }}><PctCell v={r.dayChange} /></span>
                    </span>
                    <span className="r num" style={{ minWidth: 64 }}>
                      <span className="lab">{pm.short}</span>
                      {pm.unit === 'percent' && typeof pm.get(r) === 'number' ? <PctCell v={pm.get(r) as number} /> : fieldText(pm, r)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="dv-tight">
        <DataTable
          caption={`Stocks at or above ${capLabel(state.minCapBillions)}, closes as of ${fmtDate(asOf)}`}
          rows={v.page.rows}
          cols={cols}
          rowKey={(r) => r.symbol}
          sort={{ key: effective.sort!.field, dir: effective.sort!.dir }}
          onSort={(s) => patch({ sort: nextSort(effective.sort, s.key as FieldId) })}
          onRow={open}
          empty="No stock matches. Remove a filter or lower the minimum market cap."
        />
        </div>
      )}
      <Pager
        page={v.page.page}
        pageCount={v.page.pageCount}
        from={v.page.from}
        to={v.page.to}
        total={v.page.total}
        pageSize={state.pageSize}
        noun="stocks"
        onPage={(p) => { write({ ...state, page: p }, false); window.scrollTo(0, 0); }}
        onSize={(n) => patch({ pageSize: n })}
      />
      {detail && (
        <Sheet title={`${detail.symbol}  ${detail.name}`} onClose={() => setDetail(null)}>
          <div className="stack" style={{ gap: 12 }}>
            <button type="button" className="btn primary" style={{ minHeight: 44 }} onClick={() => open(detail)}>
              Open research
            </button>
            <dl className="kv">
              {MAIN.filter((id) => id !== 'symbol' && id !== 'name').map((id) => {
                const f = fieldDef(id);
                return (
                  <div key={id} style={{ display: 'contents' }}>
                    <dt>{f.label}</dt>
                    <dd className="num">{id === 'buy10' ? 'Unavailable in this build' : fieldText(f, detail)}{id === 'price' && detail.priceDate ? `, ${fmtDate(detail.priceDate)}` : ''}</dd>
                  </div>
                );
              })}
            </dl>
            {detail.basisNote && <p className="small muted">{detail.basisNote}</p>}
          </div>
        </Sheet>
      )}
    </div>
  );
}
