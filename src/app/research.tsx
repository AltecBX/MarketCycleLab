/**
 * Research workspace: one symbol, one as-of date, shared by every section.
 * The symbol comes from the URL, so Back, Forward and deep links restore the exact context.
 */
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { NavLink, Navigate, Outlet, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { invalidate, useBundle, type StockBundle } from '../data/client';
import { isIsoDate } from '../engine/core/calendar';
import { minusMonths, sliceAsOf } from '../engine/core/series';
import { isNa, type Bar, type EarningsEvent, type ISODate, type Maybe, type Unavailable } from '../engine/core/types';
import { Card, Skeleton, StateNote } from '../ui/components';
import { fmtDate, reasonDetail } from '../ui/format';
import { isSection, rememberSymbol, researchPath, SECTIONS } from './routes';
import { openSearch } from './search';
import { StockStrip } from './StockStrip';

export type HistoryWindow = '1y' | '3y' | '5y' | '10y' | 'max';
export const HISTORY_WINDOWS: { value: HistoryWindow; label: string; months: number | null }[] = [
  { value: '1y', label: '1Y', months: 12 },
  { value: '3y', label: '3Y', months: 36 },
  { value: '5y', label: '5Y', months: 60 },
  { value: '10y', label: '10Y', months: 120 },
  { value: 'max', label: 'Max', months: null },
];

export interface ResearchCtx extends StockBundle {
  symbol: string;
  /**
   * Completed sessions through the as-of date. Engines receive all of them so indicators have
   * their warm-up. Empty when the price source is unavailable.
   */
  bars: Bar[];
  /** Why bars are empty, when they are. */
  barsIssue: Unavailable | null;
  /** Last completed session in view. */
  asOf: ISODate | null;
  /** True when the user froze a historical cut. */
  frozen: boolean;
  /** Output window start. Studies show results from this date while warm-up uses earlier bars. */
  windowStart: ISODate | null;
  history: HistoryWindow;
  /** Earnings events known by the as-of date (point in time when frozen). */
  earningsKnown: Maybe<EarningsEvent[]>;
}

const Ctx = createContext<ResearchCtx | null>(null);

export const useResearch = (): ResearchCtx => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useResearch must be used inside the research workspace');
  return c;
};

/** Wrap a section that needs price history. Shows the scoped outage with a retry when it is missing. */
export function RequireBars({ children, min = 2 }: { children: ReactNode; min?: number }) {
  const r = useResearch();
  if (r.barsIssue) {
    return (
      <StateNote
        tone="error"
        title="Price history is unavailable."
        action={
          <button type="button" className="btn small" onClick={() => invalidate()}>
            Retry
          </button>
        }
      >
        {reasonDetail(r.barsIssue)} <NavLink to="/data">See source status</NavLink>
      </StateNote>
    );
  }
  if (r.bars.length < min) return <StateNote>Only {r.bars.length} completed sessions are available. This study needs at least {min}.</StateNote>;
  return <>{children}</>;
}

export function ResearchRedirect() {
  const { symbol } = useParams();
  const [sp] = useSearchParams();
  const qs = sp.toString();
  return <Navigate to={`/research/${symbol}/overview${qs ? `?${qs}` : ''}`} replace />;
}

export function ResearchLayout() {
  const params = useParams();
  const symbol = (params.symbol ?? '').toUpperCase();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const b = useBundle(symbol || null);
  const asOfParam = sp.get('asof');
  const asOfCut = asOfParam && isIsoDate(asOfParam) ? asOfParam : null;
  const histParam = sp.get('hist');
  const history: HistoryWindow = HISTORY_WINDOWS.some((h) => h.value === histParam) ? (histParam as HistoryWindow) : '10y';

  const bundle = b.status === 'ready' && !isNa(b.data) ? b.data : null;

  // A former ticker resolves to the current one. The URL follows so bookmarks converge.
  useEffect(() => {
    if (bundle && bundle.instrument.symbol !== symbol) {
      nav(researchPath(bundle.instrument.symbol, isSection(params.section) ? params.section : 'overview', { asof: asOfCut ?? undefined, from: symbol }), { replace: true });
    }
  }, [bundle, symbol, nav, params.section, asOfCut]);

  useEffect(() => {
    if (bundle) rememberSymbol(bundle.instrument.symbol);
  }, [bundle]);

  const ctx = useMemo<ResearchCtx | null>(() => {
    if (!bundle) return null;
    const full = isNa(bundle.series) ? [] : bundle.series.bars;
    const bars = asOfCut ? sliceAsOf(full, asOfCut) : full;
    const asOf = bars.length ? bars[bars.length - 1]!.date : null;
    const months = HISTORY_WINDOWS.find((h) => h.value === history)?.months ?? null;
    const windowStart = asOf && months ? minusMonths(asOf, months) : (bars[0]?.date ?? null);
    const earningsKnown: Maybe<EarningsEvent[]> =
      isNa(bundle.earnings) || !asOfCut
        ? bundle.earnings
        : bundle.earnings.filter((e) => e.date <= asOfCut || (e.knownAt !== undefined && e.knownAt.slice(0, 10) <= asOfCut));
    return {
      ...bundle,
      symbol: bundle.instrument.symbol,
      bars,
      barsIssue: isNa(bundle.series) ? bundle.series : null,
      asOf,
      frozen: asOfCut !== null,
      windowStart,
      history,
      earningsKnown,
    };
  }, [bundle, asOfCut, history]);

  if (!symbol) return <Navigate to="/" replace />;

  const qs = sp.toString();
  const subnav = (
    <nav className="subnav" aria-label="Research sections">
      {SECTIONS.map((s) => (
        <NavLink key={s.id} to={`/research/${symbol}/${s.id}${qs ? `?${qs}` : ''}`} title={s.question}>
          {s.label}
        </NavLink>
      ))}
    </nav>
  );

  if (b.status === 'loading') {
    return (
      <div className="stack">
        <div className="card">
          <div className="strip">
            <div className="strip-id">
              <button type="button" className="ticker-pill" onClick={openSearch} aria-label={`Change stock. Current ${symbol}`}>
                {symbol}
              </button>
              <span className="muted">Loading {symbol}</span>
            </div>
          </div>
        </div>
        {subnav}
        <Skeleton h={220} />
      </div>
    );
  }

  if (b.status === 'error' || !ctx) {
    const why = b.status === 'error' ? b.error.message : b.status === 'ready' && isNa(b.data) ? reasonDetail(b.data) : 'Unavailable';
    return (
      <div className="stack">
        <Card title={symbol}>
          <StateNote
            tone="warn"
            title={`${symbol} cannot be opened.`}
            action={
              <div className="row">
                {b.status === 'error' && (
                  <button type="button" className="btn small" onClick={b.reload}>
                    Retry
                  </button>
                )}
                <button type="button" className="btn small primary" onClick={openSearch}>
                  Find another stock
                </button>
              </div>
            }
          >
            {why}
          </StateNote>
        </Card>
      </div>
    );
  }

  const former = sp.get('from');
  return (
    <Ctx.Provider value={ctx}>
      <div className="stack">
        <StockStrip />
        {former && former !== ctx.symbol && (
          <StateNote>
            {former} now trades as {ctx.symbol}. {ctx.resolved.viaAlias?.evidence ?? ctx.instrument.aliases.find((a) => a.symbol === former)?.evidence}
          </StateNote>
        )}
        {ctx.frozen && (
          <StateNote tone="warn" title="Historical cut.">
            Every study on this page uses data through {fmtDate(ctx.asOf)} only.{' '}
            <NavLink to={`/research/${ctx.symbol}/${isSection(params.section) ? params.section : 'overview'}`}>Return to the latest close</NavLink>
          </StateNote>
        )}
        {subnav}
        <Outlet />
      </div>
    </Ctx.Provider>
  );
}
