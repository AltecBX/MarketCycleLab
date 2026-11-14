/** Cross stock earnings calendar for the coming days and weeks. */
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { researchPath } from '../../app/routes';
import { getProvider, invalidate, useAsync, useHealth } from '../../data/client';
import { useWorkspace } from '../../data/workspace';
import { addDays, isIsoDate, toDayNum } from '../../engine/core/calendar';
import { isNa, type EarningsTime, type ISODate } from '../../engine/core/types';
import { calendarWindow, filterCalendar, groupCalendar, mergeCalendar, TIME_LABEL } from '../../engine/earnings';
import { Card, Chip, Segmented, Skeleton, StateNote } from '../../ui/components';
import { fmtDate, fmtMoney, fmtTimeET, plural, reasonDetail } from '../../ui/format';
import { dateET, fmtDay, fmtDayShort } from '../research/earnings/util';
import './calendar/calendar.css';

type Range = 'tomorrow' | 'this-week' | 'next-week' | '2w' | '5w' | 'custom';
type Scope = 'all' | 'watchlist' | 'positions';
const RANGES: { value: Range; label: string; title?: string }[] = [
  { value: 'tomorrow', label: 'Tomorrow', title: 'The next exchange session' },
  { value: 'this-week', label: 'This week' },
  { value: 'next-week', label: 'Next week' },
  { value: '2w', label: '14 days' },
  { value: '5w', label: '5 weeks' },
  { value: 'custom', label: 'Dates' },
];
const TIMES: EarningsTime[] = ['bmo', 'amc', 'unknown'];
const MAX_SPAN = 120;

export default function EarningsCalendar() {
  const [sp, setSp] = useSearchParams();
  const [ws] = useWorkspace();
  const health = useHealth();
  const clock = getProvider().clock();
  const today = dateET(clock.now);
  const set = (patch: Record<string, string | null>) => {
    const n = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') n.delete(k);
      else n.set(k, v);
    }
    setSp(n, { replace: true });
  };

  const range: Range = RANGES.some((x) => x.value === sp.get('range')) ? (sp.get('range') as Range) : '2w';
  const scope: Scope = sp.get('scope') === 'watchlist' || sp.get('scope') === 'positions' ? (sp.get('scope') as Scope) : 'all';
  const q = sp.get('q') ?? '';
  const times = (sp.get('time') ?? '').split(',').filter((t): t is EarningsTime => (TIMES as string[]).includes(t));
  const confirmedOnly = sp.get('status') === 'confirmed';

  const win = useMemo<{ from: ISODate; to: ISODate; label: string; note?: string }>(() => {
    if (range === '2w') return { from: today, to: addDays(today, 13), label: 'Next 14 days' };
    if (range === '5w') return { from: today, to: addDays(today, 34), label: 'Next 5 weeks' };
    if (range === 'custom') {
      const f = sp.get('from');
      const t = sp.get('to');
      const from = f && isIsoDate(f) ? f : today;
      let to = t && isIsoDate(t) && t >= from ? t : addDays(from, 6);
      let note: string | undefined;
      if (toDayNum(to) - toDayNum(from) > MAX_SPAN) {
        to = addDays(from, MAX_SPAN);
        note = `Range limited to ${MAX_SPAN} days.`;
      }
      return { from, to, label: `${fmtDate(from)} to ${fmtDate(to)}`, note };
    }
    const w = calendarWindow(today, range);
    return { from: w.from, to: w.to, label: range === 'tomorrow' ? `Next session, ${fmtDay(w.from)}` : `${fmtDayShort(w.from)} to ${fmtDayShort(w.to)}` };
  }, [range, today, sp]);

  const cal = useAsync(`cal:${win.from}:${win.to}`, () => getProvider().getEarningsCalendar(win.from, win.to));
  const scopeSymbols = scope === 'watchlist' ? ws.watchlist : scope === 'positions' ? ws.positions.map((p) => p.symbol) : undefined;

  const view = useMemo(() => {
    if (cal.status !== 'ready' || isNa(cal.data)) return null;
    const merged = mergeCalendar(cal.data);
    const filtered = filterCalendar(merged, { times, status: confirmedOnly ? 'confirmed' : undefined, search: q, symbols: scopeSymbols });
    const days = groupCalendar(filtered, win.from, win.to);
    return { days, total: filtered.length, before: merged.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cal.status, cal.data, sp.get('time'), confirmedOnly, q, scope, ws.watchlist, ws.positions, win.from, win.to]);

  const src = health.status === 'ready' ? health.data.find((s) => s.id === 'earnings') : undefined;
  const toggleTime = (t: EarningsTime) => {
    const next = times.includes(t) ? times.filter((x) => x !== t) : [...times, t];
    set({ time: next.length ? next.join(',') : null });
  };
  const filtersOn = times.length > 0 || confirmedOnly || q !== '' || scope !== 'all';

  return (
    <div className="stack">
      <Card
        title="Earnings calendar"
        info="Report dates across the loaded universe. Confirmed dates are marked by the source as issuer set. Estimated dates can move."
        sub={
          src
            ? `Earnings source ${src.state === 'ok' ? 'working' : src.state}. Covers through ${fmtDate(src.dataThrough)}, last success ${fmtTimeET(src.lastSuccess)}.${src.kind === 'synthetic-fixture' ? ' Synthetic fixture dates.' : ''}`
            : undefined
        }
      >
        <div className="cal-controls">
          <div className="field">
            Window
            <Segmented label="Window" value={range} options={RANGES} onChange={(v) => set({ range: v === '2w' ? null : v })} />
          </div>
          {range === 'custom' && (
            <>
              <label className="field">
                From
                <input className="input" type="date" value={win.from} onChange={(e) => set({ from: e.target.value })} />
              </label>
              <label className="field">
                To
                <input className="input" type="date" value={win.to} min={win.from} onChange={(e) => set({ to: e.target.value })} />
              </label>
            </>
          )}
          <div className="field">
            Scope
            <Segmented label="Scope" value={scope} options={[{ value: 'all', label: 'All loaded' }, { value: 'watchlist', label: `Watchlist (${ws.watchlist.length})` }, { value: 'positions', label: `Positions (${ws.positions.length})` }]} onChange={(v) => set({ scope: v === 'all' ? null : v })} />
          </div>
          <label className="field" style={{ flex: '1 1 160px' }}>
            Symbol or company
            <input className="input" type="search" value={q} onChange={(e) => set({ q: e.target.value })} placeholder="Search" />
          </label>
          <div className="field">
            Show only
            <div className="row" style={{ gap: 6 }}>
              {TIMES.map((t) => (
                <button key={t} type="button" className="btn small cal-toggle" aria-pressed={times.includes(t)} onClick={() => toggleTime(t)}>
                  {TIME_LABEL[t]}
                </button>
              ))}
              <button type="button" className="btn small cal-toggle" aria-pressed={confirmedOnly} onClick={() => set({ status: confirmedOnly ? null : 'confirmed' })}>
                Confirmed
              </button>
              {filtersOn && (
                <button type="button" className="btn small ghost" onClick={() => set({ time: null, status: null, q: null, scope: null })}>
                  Clear
                </button>
              )}
            </div>
          </div>
        </div>
      </Card>

      <Card
        title={win.label}
        sub={view ? `${plural(view.total, 'report')} in view${view.total !== view.before ? ` of ${view.before} in the window` : ''}, ${plural(view.days.filter((d) => d.isSession).length, 'session')}. ${win.note ?? ''}` : undefined}
      >
        {cal.status === 'loading' && <Skeleton h={200} />}
        {cal.status === 'error' && (
          <StateNote tone="error" title="The calendar could not be loaded." action={<button type="button" className="btn small" onClick={cal.reload}>Retry</button>}>
            {cal.error.message}
          </StateNote>
        )}
        {cal.status === 'ready' && isNa(cal.data) && (
          <StateNote tone="error" title="Earnings dates are unavailable." action={<button type="button" className="btn small" onClick={() => invalidate()}>Retry</button>}>
            {reasonDetail(cal.data)} {src?.dataThrough ? `The last good capture covers through ${fmtDate(src.dataThrough)}. ` : ''}Price research stays usable. <Link to="/data">See source status</Link>
          </StateNote>
        )}
        {view && view.days.length === 0 && (
          <StateNote>
            {range === 'this-week' ? 'No sessions remain this week. Use Next week or 14 days.' : 'No exchange sessions in this window.'}
          </StateNote>
        )}
        {view && view.days.length > 0 && view.total === 0 && (
          <StateNote>
            {scope !== 'all' && (scopeSymbols?.length ?? 0) === 0
              ? `Your ${scope === 'watchlist' ? 'watchlist' : 'positions list'} is empty, so nothing is in scope. Switch to All loaded.`
              : filtersOn
                ? 'No report matches the filters in this window. Clear a filter or widen the window.'
                : 'No report is listed in this window. Widen the window.'}
          </StateNote>
        )}
        {view && view.total > 0 &&
          view.days.map((d) => (
            <section key={d.date} className="cal-day" aria-label={fmtDay(d.date)}>
              <div className="cal-day-head">
                <h3>{fmtDayShort(d.date)}</h3>
                {d.items.length > 0 ? (
                  <span className="muted small">
                    {plural(d.items.length, 'report')}
                    {d.counts.bmo ? `, ${d.counts.bmo} before open` : ''}
                    {d.counts.during ? `, ${d.counts.during} during` : ''}
                    {d.counts.amc ? `, ${d.counts.amc} after close` : ''}
                    {d.counts.unknown ? `, ${d.counts.unknown} time unknown` : ''}
                  </span>
                ) : (
                  <span className="faint small">No reports in view</span>
                )}
                {!d.isSession && <Chip tone="warn">{d.closure ? `Exchange closed, ${d.closure}` : 'Weekend'}. Date expected to move</Chip>}
              </div>
              {d.items.length > 0 && (
                <ul className="cal-rows">
                  {d.items.map((it) => {
                    const e = it.entry;
                    return (
                      <li key={it.id}>
                        <Link className="cal-sym" to={researchPath(e.symbol, 'earnings')} aria-label={`${e.symbol} earnings research`}>
                          {e.symbol}
                        </Link>
                        <span className="cal-name" title={e.name}>{e.name}</span>
                        <span className="cal-tags">
                          <Chip tone={e.time === 'unknown' ? 'warn' : undefined}>{TIME_LABEL[e.time]}</Chip>
                          <Chip tone={e.status === 'confirmed' ? 'accent' : 'warn'}>{e.status === 'confirmed' ? 'Confirmed' : 'Estimated'}</Chip>
                          {it.conflictDates.length > 0 && <Chip tone="warn" title={`Other source dates: ${it.conflictDates.map(fmtDate).join(', ')}`}>Sources disagree</Chip>}
                        </span>
                        <span className="cal-cap num" title="Market cap">{e.marketCap === null ? <span className="faint">n/a</span> : fmtMoney(e.marketCap)}</span>
                        <span className="cal-react">{isNa(it.reactionDate) ? 'Reacting session withheld, time unknown' : `Reacts ${fmtDayShort(it.reactionDate)}`}{e.fiscalPeriod ? `. ${e.fiscalPeriod}` : ''}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ))}
      </Card>
    </div>
  );
}
