/** Persistent quote strip. The ticker pill is the one control that changes the stock. */
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { sma } from '../engine/core/indicators';
import { periodToDate } from '../engine/core/series';
import { isNa, na, type Maybe } from '../engine/core/types';
import { nextEarnings, TIME_LABEL } from '../engine/earnings';
import { valuationFacts } from '../engine/valuation';
import { Disclosure, Info, Pct, Segmented } from '../ui/components';
import { fmtDate, fmtDateShort, fmtMoney, fmtMultiple, fmtPrice, reasonDetail, reasonText } from '../ui/format';
import { HISTORY_WINDOWS, useResearch, type HistoryWindow } from './research';
import { researchPath } from './routes';
import { openSearch } from './search';

const LOGO_COLORS = ['#0e7490', '#7c3aed', '#b45309', '#0f766e', '#be123c', '#1d4ed8', '#4d7c0f', '#a21caf'];

/**
 * Company mark. No licensed logo artwork ships with this build, so every symbol shows an honest
 * ticker badge. A generic stand-in image is never shown as if it were the company's logo.
 */
export function Logo({ symbol, size = 36 }: { symbol: string; size?: number }) {
  let h = 0;
  for (const ch of symbol) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className="logo" aria-hidden="true" data-logo="ticker-badge" style={{ background: LOGO_COLORS[h % LOGO_COLORS.length], width: size, height: size, fontSize: symbol.length > 3 ? size * 0.28 : size * 0.34 }}>
      {symbol.slice(0, 4)}
    </span>
  );
}

function Fact({ label, value, sub, info }: { label: string; value: React.ReactNode; sub?: React.ReactNode; info?: React.ReactNode }) {
  return (
    <div className="fact">
      <div className="fact-label">
        {label} {info && <Info text={info} label={`About ${label}`} />}
      </div>
      <div className="fact-value num">{value}</div>
      {sub && <div className="fact-sub">{sub}</div>}
    </div>
  );
}

export function StockStrip() {
  const r = useResearch();
  const [sp, setSp] = useSearchParams();
  const { bars, instrument } = r;

  const f = useMemo(() => {
    const n = bars.length;
    if (n === 0) return null;
    const last = bars[n - 1]!;
    const prev = n > 1 ? bars[n - 2]! : null;
    const closes = bars.map((b) => b.close);
    const s200 = sma(closes, 200)[n - 1] ?? null;
    let peak = -Infinity;
    let peakDate = last.date;
    for (const b of bars) if (b.close > peak) { peak = b.close; peakDate = b.date; }
    const yr = bars.slice(Math.max(0, n - 252));
    let hi52 = -Infinity;
    let lo52 = Infinity;
    for (const b of yr) { if (b.high > hi52) hi52 = b.high; if (b.low < lo52) lo52 = b.low; }
    return {
      last,
      dayChange: prev ? last.close / prev.close - 1 : null,
      ytd: periodToDate(bars, n - 1, 'Y'),
      sma200: s200,
      gap200: s200 !== null ? last.close / s200 - 1 : null,
      fromPeak: last.close / peak - 1,
      peak,
      peakDate,
      hi52,
      lo52,
      yearCovered: n >= 252,
    };
  }, [bars]);

  const val = useMemo(
    () => valuationFacts(f ? { close: f.last.close, date: f.last.date, currency: instrument.currency } : na('source-failed', 'No completed close'), r.fundamentals),
    [f, r.fundamentals, instrument.currency],
  );
  const today = r.frozen && r.asOf ? r.asOf : r.clock.lastCompletedSession;
  const next = useMemo(() => nextEarnings(r.earningsKnown, today, instrument.type), [r.earningsKnown, today, instrument.type]);
  const isFund = instrument.type === 'etf' || instrument.type === 'index';

  const setHist = (h: HistoryWindow) => {
    const n = new URLSearchParams(sp);
    if (h === '10y') n.delete('hist');
    else n.set('hist', h);
    setSp(n, { replace: true });
  };
  const setAsOf = (d: string) => {
    const n = new URLSearchParams(sp);
    if (d) n.set('asof', d);
    else n.delete('asof');
    setSp(n);
  };

  const naText = (m: Maybe<unknown>) => (isNa(m) ? <span className="faint" title={reasonDetail(m)}>{isFund && m.code === 'not-applicable' ? 'Not applicable' : reasonText(m)}</span> : null);

  return (
    <section className="card" aria-label={`${instrument.symbol} quote and key facts`}>
      <div className="strip">
        <div className="strip-id">
          <Logo symbol={instrument.symbol} />
          <div style={{ minWidth: 0 }}>
            <button type="button" className="ticker-pill" onClick={openSearch} aria-label={`Change stock. Current ${instrument.symbol}`} title="Change stock. Press /">
              {instrument.symbol}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            <div className="strip-name" title={instrument.name}>
              {instrument.name}
              {instrument.type !== 'stock' && <span className="faint"> · {instrument.type.toUpperCase()}</span>}
            </div>
          </div>
        </div>
        <div className="strip-facts">
          <Fact
            label="Close"
            info="Latest completed regular session close on the split-consistent quote basis. Not a live or extended-hours quote."
            value={
              f ? (
                <>
                  {fmtPrice(f.last.close)} <span style={{ fontSize: 12.5 }}><Pct v={f.dayChange} glyph /></span>
                </>
              ) : (
                <span className="faint">Unavailable</span>
              )
            }
            sub={f ? fmtDate(f.last.date) : r.barsIssue ? reasonText(r.barsIssue) : undefined}
          />
          <Fact
            label="YTD"
            info="Price return from the final close of the prior year to the latest close. No dividends."
            value={f ? (isNa(f.ytd) ? naText(f.ytd) : <Pct v={f.ytd.ret} />) : <span className="faint">n/a</span>}
            sub={f && !isNa(f.ytd) ? `from ${fmtDate(f.ytd.baseDate)}` : undefined}
          />
          <Fact
            label="200-day"
            info="Close divided by the simple average of the last 200 completed closes, minus 1. Needs 200 sessions."
            value={
              f ? (
                f.gap200 !== null ? (
                  <Link to={researchPath(r.symbol, 'trend', { asof: sp.get('asof') ?? undefined })} style={{ color: 'inherit' }}>
                    <Pct v={f.gap200} /> <span className="muted" style={{ fontSize: 12, fontWeight: 500 }}>{f.gap200 >= 0 ? 'above' : 'below'}</span>
                  </Link>
                ) : (
                  <span className="faint" title={`Needs 200 completed sessions, has ${bars.length}`}>Not enough history</span>
                )
              ) : (
                <span className="faint">n/a</span>
              )
            }
            sub={f?.sma200 !== null && f ? `avg ${fmtPrice(f.sma200)}` : undefined}
          />
          <Fact
            label="From closing high"
            info="Latest close versus the highest close in the loaded history. This is the closing high within history, not a verified all-time high."
            value={f ? <Link to={researchPath(r.symbol, 'selloffs', { asof: sp.get('asof') ?? undefined })} style={{ color: 'inherit' }}><Pct v={f.fromPeak} /></Link> : <span className="faint">n/a</span>}
            sub={f ? `${fmtPrice(f.peak)} on ${fmtDate(f.peakDate)}` : undefined}
          />
          <Fact
            label="Forward P/E"
            info="Latest close divided by the verified positive FY1 annual EPS estimate from one compatible capture. The screener uses this same record."
            value={isNa(val.forwardPe) ? naText(val.forwardPe) : fmtMultiple(val.forwardPe.value)}
            sub={isNa(val.forwardPe) ? undefined : `FY1, est. ${fmtDateShort(val.forwardPe.estimateDate)}`}
          />
          <Fact
            label="Free cash flow"
            info="Operating cash flow minus capital expenditure for the most recent usable fiscal period. The period is stated."
            value={isNa(val.fcf) ? naText(val.fcf) : fmtMoney(val.fcf.value, true)}
            sub={isNa(val.fcf) ? undefined : `${val.fcf.scope} to ${fmtDate(val.fcf.periodEnd)}${val.fcf.isLatestPeriod ? '' : ', prior period'}`}
          />
          <Fact
            label="Cash on hand"
            info="Cash and cash equivalents at the balance sheet date. It does not show current cash generation."
            value={isNa(val.cash) ? naText(val.cash) : fmtMoney(val.cash.value)}
            sub={isNa(val.cash) ? undefined : `at ${fmtDate(val.cash.asOf)}`}
          />
          <Fact
            label="Next earnings"
            info="The next future report date for this stock. Confirmed means the issuer set it. Estimated dates can move."
            value={
              isNa(next) ? (
                naText(next)
              ) : (
                <Link to={researchPath(r.symbol, 'earnings', { asof: sp.get('asof') ?? undefined })} style={{ color: 'inherit' }}>
                  {fmtDate(next.date)}
                </Link>
              )
            }
            sub={isNa(next) ? undefined : `${next.status === 'confirmed' ? 'Confirmed' : 'Estimated'}, ${TIME_LABEL[next.time].toLowerCase()}, in ${next.daysUntil} days`}
          />
        </div>
      </div>
      <div style={{ padding: '0 16px 10px' }}>
        <Disclosure summary="Data details">
          <div className="row" style={{ alignItems: 'flex-end', marginBottom: 10 }}>
            <label className="field">
              History shown
              <Segmented label="History shown" value={r.history} options={HISTORY_WINDOWS.map((h) => ({ value: h.value, label: h.label }))} onChange={setHist} />
            </label>
            <label className="field">
              As of (freeze a past close)
              <input className="input" type="date" value={sp.get('asof') ?? ''} max={r.clock.lastCompletedSession} onChange={(e) => setAsOf(e.target.value)} />
            </label>
            {sp.get('asof') && (
              <button type="button" className="btn small" onClick={() => setAsOf('')}>
                Latest close
              </button>
            )}
          </div>
          <dl className="kv">
            <dt>Price source</dt>
            <dd>{isNa(r.series) ? reasonDetail(r.series) : `${r.series.source.note ?? r.series.source.provider}`}</dd>
            <dt>Price basis</dt>
            <dd>{isNa(r.series) ? 'n/a' : 'Split-consistent quote OHLC. No dividend reinvestment.'}</dd>
            <dt>History</dt>
            <dd>
              {isNa(r.series) ? 'n/a' : `${fmtDate(r.series.coverage.first)} to ${fmtDate(r.series.coverage.last)}, ${r.series.coverage.sessions.toLocaleString('en-US')} sessions, ${r.series.coverage.missingSessions.length} missing`}
            </dd>
            {instrument.basisBoundary && (
              <>
                <dt>Basis boundary</dt>
                <dd>{fmtDate(instrument.basisBoundary.date)}. {instrument.basisBoundary.reason}</dd>
              </>
            )}
            {f && (
              <>
                <dt>52-week traded range</dt>
                <dd>{f.yearCovered ? `${fmtPrice(f.lo52)} to ${fmtPrice(f.hi52)}` : `${fmtPrice(f.lo52)} to ${fmtPrice(f.hi52)} over ${bars.length} sessions (less than one year of history)`}</dd>
                <dt>Volume</dt>
                <dd>{f.last.volume === null ? 'Not verified' : f.last.volume.toLocaleString('en-US')}</dd>
              </>
            )}
            <dt>Market cap</dt>
            <dd>{isNa(val.marketCap) ? reasonText(val.marketCap) : fmtMoney(val.marketCap)}</dd>
            <dt>Exchange</dt>
            <dd>{instrument.exchange}, {instrument.currency}{instrument.country ? `, ${instrument.country}` : ''}</dd>
            <dt>Latest completed session</dt>
            <dd>{fmtDate(r.clock.lastCompletedSession)}</dd>
          </dl>
        </Disclosure>
      </div>
    </section>
  );
}
