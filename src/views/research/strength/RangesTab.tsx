/** Ranges tab: where price sits in each window, the selected window in detail, compression and transitions. */
import { useMemo } from 'react';
import { useEngine } from '../../../data/engine';
import { isNa, type Bar, type Maybe } from '../../../engine/core/types';
import {
  distanceAttribution,
  rangeGauges,
  type Compression,
  type DistanceAttribution,
  type RangeBasis,
  type RangeGauge as Gauge,
  type RangeStats,
  type Transition,
  type WindowKey,
} from '../../../engine/relativeStrength';
import { CandleChart, LineChart } from '../../../ui/charts';
import { Card, Chip, Freq, Info, Missing, Pct, RangeGauge, Skeleton, Stat, StateNote } from '../../../ui/components';
import { fmtDate, fmtDateShort, fmtInt, fmtNum, fmtPct, fmtPp, fmtPrice, reasonDetail } from '../../../ui/format';
import { BASIS_LABEL, num, shortWindow } from './util';

const pair = (s: RangeStats, basis: RangeBasis) => (basis === 'close' ? s.closing : s.traded);

function Attribution({ a }: { a: Maybe<DistanceAttribution> }) {
  if (isNa(a)) return <td colSpan={5} className="faint">{reasonDetail(a)}</td>;
  return (
    <>
      <td className="num">{fmtPct(a.oldDistance, 1)}</td>
      <td className="num">{fmtPct(a.nowDistance, 1)}</td>
      <td className="num"><strong>{fmtPp(a.change, 1)}</strong></td>
      <td className="num">{fmtPp(a.pricePart, 1)}</td>
      <td className="num">
        {fmtPp(a.rolloverPart, 1)}
        {a.oldLevelExpired && <span className="faint small"> old level expired</span>}
        {!a.oldLevelExpired && a.newLevelSet && <span className="faint small"> new level set</span>}
      </td>
    </>
  );
}

export function RangesTab({
  bars,
  basis,
  win,
  onWin,
  cacheKey,
  spy,
}: {
  bars: readonly Bar[];
  basis: RangeBasis;
  win: WindowKey;
  onWin: (k: WindowKey) => void;
  cacheKey: string;
  spy: Maybe<Bar[]> | null;
}) {
  const i = bars.length - 1;
  const fast = useMemo(() => rangeGauges(bars, i, { basis, withPercentile: false }), [bars, i, basis]);
  const pct = useEngine<Gauge[]>(`${cacheKey}:${basis}`, 'relativeStrength', 'rangeGauges', () => [bars, i, { basis, withPercentile: true }]);
  const comp = useEngine<Maybe<Compression>>(`${cacheKey}:${basis}`, 'relativeStrength', 'compressionAt', () => [bars, i, { basis }]);
  const spyBars = spy && !isNa(spy) ? spy : null;
  const trans = useEngine<Maybe<Transition[]>>(`${cacheKey}:${basis}:${spyBars ? 'spy' : 'none'}`, 'relativeStrength', 'emergentTransitions', () => [
    bars,
    { basis, benchmark: spyBars ? { symbol: 'SPY', bars: spyBars, role: 'market' } : undefined },
  ]);

  const pctOf = (k: WindowKey): { p: number | null; n: number } | 'loading' => {
    if (pct.status !== 'ready') return 'loading';
    const g = pct.data.find((x) => x.key === k);
    if (!g || isNa(g.stats)) return { p: null, n: 0 };
    return { p: num(g.stats.percentile), n: g.stats.percentileN };
  };

  const available = fast.filter((g) => !isNa(g.stats));
  const selKey = available.some((g) => g.key === win) ? win : (available.find((g) => g.key === '3M') ?? available[available.length - 1])?.key;
  const sel = fast.find((g) => g.key === selKey);
  const s = sel && !isNa(sel.stats) ? sel.stats : null;

  const attrHigh = useMemo(() => (selKey ? distanceAttribution(bars, i, selKey, 'high', 5, basis) : null), [bars, i, selKey, basis]);
  const attrLow = useMemo(() => (selKey ? distanceAttribution(bars, i, selKey, 'low', 5, basis) : null), [bars, i, selKey, basis]);

  const slice = useMemo(() => {
    if (!s) return [];
    const from = bars.findIndex((b) => b.date === s.startDate);
    return from < 0 ? [] : bars.slice(from, i + 1);
  }, [bars, i, s]);
  const ex = s ? pair(s, basis) : null;
  const sp = pctOf(selKey ?? '3M');

  return (
    <>
      <Card
        title="Where price sits in each range"
        info="For each window the marker shows the latest close between the window low and high. Session windows are true rolling sessions. Month and year windows start after the last close on or before the calendar boundary."
        sub={BASIS_LABEL[basis]}
      >
        <div className="st-rows" role="group" aria-label="Range windows. Select one for detail.">
          <div className="st-head" aria-hidden="true">
            <span>Window</span>
            <span style={{ textAlign: 'left' }}>Low to high</span>
            <span>Position</span>
            <span>To high</span>
            <span className="st-hide-sm">To low</span>
            <span className="st-hide-sm">Return</span>
            <span className="st-hide-md">Width</span>
            <span className="st-hide-md">Since high</span>
            <span className="st-hide-md">Percentile</span>
          </div>
          {fast.map((g) => {
            if (isNa(g.stats)) {
              return (
                <div key={g.key} className="st-row st-na">
                  <span>{shortWindow(g.key)}</span>
                  <span className="small">{reasonDetail(g.stats)}</span>
                </div>
              );
            }
            const st = g.stats;
            const e = pair(st, basis);
            const pos = num(st.rangePosition);
            const pp = pctOf(g.key);
            return (
              <button
                key={g.key}
                type="button"
                className="st-row"
                aria-pressed={g.key === selKey}
                onClick={() => onWin(g.key)}
                title={`${g.label}. Low ${fmtPrice(e.low.value)} on ${fmtDate(e.low.date)}. High ${fmtPrice(e.high.value)} on ${fmtDate(e.high.date)}.`}
              >
                <span>{shortWindow(g.key)}</span>
                <span className="st-gauge">
                  <RangeGauge pos={pos} label={`${g.label} range position`} lowLabel={fmtPrice(e.low.value)} highLabel={fmtPrice(e.high.value)} />
                </span>
                <span className="num">{pos === null ? 'flat' : fmtPct(pos, 0, false)}</span>
                <span><Pct v={e.high.gap} digits={1} /></span>
                <span className="st-hide-sm"><Pct v={e.low.gap} digits={1} /></span>
                <span className="st-hide-sm"><Pct v={st.ret} digits={1} /></span>
                <span className="num st-hide-md">{fmtPct(st.width, 1, false)}</span>
                <span className="num st-hide-md">{e.high.sessionsSince}</span>
                <span className="num st-hide-md">
                  {pp === 'loading' ? <span className="faint">…</span> : pp.p === null ? <span className="faint">n/a</span> : <>{fmtPct(pp.p, 0, false)} <span className="faint small">n {fmtInt(pp.n)}</span></>}
                </span>
              </button>
            );
          })}
        </div>
      </Card>

      {s && ex && sel && (
        <Card title={`${sel.label} range`} sub={`${fmtDate(s.startDate)} to ${fmtDate(s.anchorDate)}, ${s.sessions} sessions. Return measured from the ${fmtDate(s.baseDate)} close.`}>
          {slice.length > 1 && slice.length <= 130 ? (
            <CandleChart
              bars={slice}
              overlays={[
                { label: 'Window high', values: slice.map(() => ex.high.value), color: 'var(--up)' },
                { label: 'Window low', values: slice.map(() => ex.low.value), color: 'var(--down)' },
              ]}
              ariaLabel={`${sel.label} daily candles. Close ${fmtPrice(s.close)} sits ${fmtPct(Math.abs(ex.high.gap), 1, false)} below the high of ${fmtPrice(ex.high.value)} and ${fmtPct(ex.low.gap, 1, false)} above the low of ${fmtPrice(ex.low.value)}`}
              dateLabel={fmtDateShort}
              yFormat={(y) => fmtNum(y, 2)}
              height={260}
            />
          ) : (
            <LineChart
              series={[{ id: 'c', label: 'Close', points: slice.map((b, k) => ({ x: k, y: b.close })) }]}
              xLabel={(x) => fmtDate(slice[x]?.date)}
              yFormat={(y) => fmtNum(y, 2)}
              hLines={[
                { y: ex.high.value, label: `High ${fmtPrice(ex.high.value)}`, color: 'var(--up)' },
                { y: ex.low.value, label: `Low ${fmtPrice(ex.low.value)}`, color: 'var(--down)' },
              ]}
              markers={[
                { x: slice.findIndex((b) => b.date === ex.high.date), y: ex.high.value, color: 'var(--up)' },
                { x: slice.findIndex((b) => b.date === ex.low.date), y: ex.low.value, color: 'var(--down)' },
              ].filter((m) => m.x >= 0)}
              ariaLabel={`${sel.label} closes. Close ${fmtPrice(s.close)} sits ${fmtPct(Math.abs(ex.high.gap), 1, false)} below the high and ${fmtPct(ex.low.gap, 1, false)} above the low`}
              height={260}
            />
          )}
          <div className="stats" style={{ marginTop: 12 }}>
            <Stat label="High" value={fmtPrice(ex.high.value)} sub={`${fmtDate(ex.high.date)}, ${ex.high.sessionsSince} sessions ago`} />
            <Stat label="Low" value={fmtPrice(ex.low.value)} sub={`${fmtDate(ex.low.date)}, ${ex.low.sessionsSince} sessions ago`} />
            <Stat label="Close to high" value={<Pct v={ex.high.gap} digits={1} />} sub={`close ${fmtPrice(s.close)}`} />
            <Stat label="Close to low" value={<Pct v={ex.low.gap} digits={1} />} />
            <Stat label="Width" value={fmtPct(s.width, 1, false)} sub="high minus low, over close" />
            <Stat label="Daily volatility" value={num(s.dailyVol) === null ? 'n/a' : fmtPct(num(s.dailyVol), 2, false)} sub="std of daily returns" />
            <Stat label="Max drawdown" value={<Pct v={s.maxDrawdown} digits={1} />} sub="inside the window" />
            <Stat label="New highs" value={s.newHighCount} sub={num(s.newHighFrequency) === null ? undefined : `${fmtPct(num(s.newHighFrequency), 0, false)} of sessions`} />
            <Stat
              label="Position percentile"
              info="Midrank percentile of today's range position among earlier anchors of the same window for this stock."
              value={sp === 'loading' ? '…' : sp.p === null ? 'n/a' : fmtPct(sp.p, 0, false)}
              sub={sp === 'loading' || sp.p === null ? undefined : `${fmtInt(sp.n)} earlier sessions`}
            />
          </div>
          <h3 style={{ margin: '16px 0 6px' }}>
            Change in distance over 5 sessions{' '}
            <Info text="The change in distance to the high or low splits into the part from price moving against the old level, and the part from the level itself rolling as old extremes leave the window or new ones are set. The two parts add to the change." />
          </h3>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Distance attribution">
            <table className="st-mini">
              <thead>
                <tr>
                  <th scope="col">Level</th>
                  <th scope="col">5 sessions ago</th>
                  <th scope="col">Now</th>
                  <th scope="col">Change</th>
                  <th scope="col">Price part</th>
                  <th scope="col">Level part</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>To high</td>
                  {attrHigh && <Attribution a={attrHigh} />}
                </tr>
                <tr>
                  <td>To low</td>
                  {attrLow && <Attribution a={attrLow} />}
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div className="grid">
        <Card title="Compression" info="The 1 month range width divided by the 3 month range width. At or below 45% the range counts as compressed. Lower percentile means unusually tight for this stock.">
          {comp.status === 'loading' && <Skeleton h={90} />}
          {comp.status === 'error' && <StateNote tone="error" action={<button type="button" className="btn small" onClick={comp.reload}>Retry</button>}>{comp.error.message}</StateNote>}
          {comp.status === 'ready' &&
            (isNa(comp.data) ? (
              <Missing why={comp.data} block />
            ) : (
              <>
                <div className="row" style={{ marginBottom: 8 }}>
                  <Chip tone={comp.data.compressed ? 'gold' : undefined}>{comp.data.compressed ? 'Compressed' : 'Not compressed'}</Chip>
                  <span className="muted small">for {comp.data.elapsedSessions} {comp.data.elapsedSessions === 1 ? 'session' : 'sessions'} through {fmtDate(comp.data.date)}</span>
                </div>
                <div className="stats">
                  <Stat label="1M over 3M width" value={fmtPct(comp.data.ratio, 0, false)} sub={`threshold ${fmtPct(comp.data.threshold, 0, false)}`} />
                  <Stat label="Percentile" value={num(comp.data.percentile) === null ? 'n/a' : fmtPct(num(comp.data.percentile), 0, false)} sub={`${fmtInt(comp.data.percentileN)} earlier sessions`} />
                  <Stat label="ATR14" value={num(comp.data.atrPct) === null ? 'n/a' : fmtPct(num(comp.data.atrPct), 1, false)} sub="of close" />
                  <Stat label="Bollinger width" value={num(comp.data.bollingerWidth) === null ? 'n/a' : fmtPct(num(comp.data.bollingerWidth), 1, false)} sub="4 std over 20 session mean" />
                  <Stat label="20 session vol" value={num(comp.data.volNow) === null ? 'n/a' : fmtPct(num(comp.data.volNow), 2, false)} sub={num(comp.data.volPrior) === null ? undefined : `prior 20: ${fmtPct(num(comp.data.volPrior), 2, false)}`} />
                </div>
                <p className="faint small" style={{ marginTop: 8 }}>
                  Sensitivity. {comp.data.sensitivity.map((x) => `At ${fmtPct(x.threshold, 0, false)}: ${x.compressed ? 'compressed' : 'not compressed'}`).join('. ')}.
                </p>
              </>
            ))}
        </Card>
        <Card title="Transitions on this session" info="Observable changes on the latest session, each with how often it fired on earlier sessions for this stock. Rarer is more notable. These are observations, not validated signals.">
          {trans.status === 'loading' && <Skeleton h={90} />}
          {trans.status === 'error' && <StateNote tone="error" action={<button type="button" className="btn small" onClick={trans.reload}>Retry</button>}>{trans.error.message}</StateNote>}
          {trans.status === 'ready' &&
            (isNa(trans.data) ? (
              <Missing why={trans.data} block />
            ) : (
              <div className="st-find">
                {trans.data.map((t) => (
                  <div key={t.id} data-active={t.active}>
                    <div>
                      <strong>{t.label}</strong> <Chip tone={t.active ? 'gold' : undefined}>{t.active ? 'Fired' : 'Not fired'}</Chip>
                    </div>
                    <div className="muted small">{t.detail}</div>
                    <div className="small">Own history <Freq p={t.ownHistory} digits={1} /></div>
                  </div>
                ))}
              </div>
            ))}
        </Card>
      </div>
    </>
  );
}
