/**
 * Trend. Which side of each average the stock is on, how old the run is, and how long runs like
 * it usually last. Owner specification section 8.
 */
import { useMemo } from 'react';
import { RequireBars, useResearch } from '../../app/research';
import { useAsync } from '../../data/client';
import { runEngine } from '../../data/engine';
import { sma } from '../../engine/core/indicators';
import { isNa, isNum } from '../../engine/core/types';
import {
  buildRuns, completedRunHistogram, durationStats, exitOdds, MA_WINDOWS, studyAfterAge,
  type MaOverviewCell, type Side, type StudySide,
} from '../../engine/maRuns';
import { BarChart, LineChart } from '../../ui/charts';
import { Card, Chip, Disclosure, Freq, Info, Pct, Segmented, Skeleton, Stat, StateNote } from '../../ui/components';
import { fmtDate, fmtPct, fmtPrice, plural, reasonDetail } from '../../ui/format';
import { fmtCount, fmtMonthYear, usePhone, useUrlState } from './trend/params';
import { RunTable } from './trend/RunTable';
import './trend/trend.css';

const AFTER_DAY =
  'Counts the trading sessions still to come until the first close back across the average, measured from the chosen day of the run. A finished run of 3 sessions seen on day 3 has 1 session to its exit. Runs that ended before the chosen day are left out.';

function OverviewCells({ cells, selected, onSelect }: { cells: MaOverviewCell[]; selected: number; onSelect: (w: number) => void }) {
  return (
    <div className="ma-cells" role="group" aria-label="Moving averages. Select one to study">
      {cells.map((c) => {
        const cur = isNa(c.current) ? null : c.current;
        const side = cur?.side ?? null;
        return (
          <button key={c.window} type="button" className="ma-cell" aria-pressed={c.window === selected} onClick={() => onSelect(c.window)}>
            <span className="ma-cell-head">
              <span className="ma-cell-name">{c.window} day</span>
              {side === 'above' && <Chip tone="up"><span aria-hidden="true" style={{ fontSize: 9 }}>{'▲'}</span>Above</Chip>}
              {side === 'below' && <Chip tone="down"><span aria-hidden="true" style={{ fontSize: 9 }}>{'▼'}</span>Below</Chip>}
              {side === 'touch' && <Chip>On it</Chip>}
            </span>
            {cur ? (
              <span className="ma-cell-main num">
                {side === 'touch' ? 'At the average' : `Day ${cur.age}`} <span style={{ fontSize: 12.5 }}><Pct v={cur.distance} digits={1} /></span>
              </span>
            ) : (
              <span className="ma-cell-main faint" title={isNa(c.current) ? reasonDetail(c.current) : undefined}>Not enough history</span>
            )}
            <span className="ma-cell-sub">
              Typical above {c.above ? fmtCount(c.above.median) : 'n/a'}, below {c.below ? fmtCount(c.below.median) : 'n/a'}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function TrendInner() {
  const r = useResearch();
  const { bars, symbol, asOf, windowStart, history } = r;
  const [sp, patch] = useUrlState();
  const phone = usePhone();

  const maParam = Number(sp.get('ma'));
  const ma = (MA_WINDOWS as readonly number[]).includes(maParam) ? maParam : 200;
  const sideParam: StudySide = sp.get('side') === 'above' ? 'above' : sp.get('side') === 'below' ? 'below' : 'current';

  // Study history starts at the window start. Each average gets exactly the warm-up it needs before it.
  const startIdx = useMemo(() => {
    if (!windowStart) return 0;
    const i = bars.findIndex((b) => b.date >= windowStart);
    return i < 0 ? 0 : i;
  }, [bars, windowStart]);
  const sliceStart = Math.max(0, startIdx - (ma - 1));

  const overview = useAsync<MaOverviewCell[]>(`trend-overview:${symbol}:${asOf}:${history}`, () =>
    Promise.all(
      MA_WINDOWS.map((w) =>
        runEngine<MaOverviewCell[]>('maRuns', 'maOverview', [bars.slice(Math.max(0, startIdx - (w - 1))), { windows: [w] }]).then((x) => x[0]!),
      ),
    ),
  );

  const set = useMemo(() => buildRuns(bars.slice(sliceStart), ma), [bars, sliceStart, ma]);
  const cur = isNa(set.current) ? null : set.current;
  const liveSide: Side | null = cur && cur.side !== 'touch' ? cur.side : null;
  const side: Side | null = sideParam === 'current' ? liveSide : sideParam;
  const liveRun = cur?.run && cur.run.side === side ? cur.run : null;
  const ageParam = Number(sp.get('age'));
  const age = Number.isInteger(ageParam) && ageParam >= 1 ? ageParam : (liveRun?.length ?? 1);

  const study = useMemo(() => (side ? studyAfterAge(set, { side, age }) : null), [set, side, age]);
  const odds = useMemo(() => (side ? exitOdds(set, { side, age }) : null), [set, side, age]);
  const hist = useMemo(() => (side ? completedRunHistogram(set, side) : []), [set, side]);
  const stats = useMemo(() => (side ? durationStats(set, side) : null), [set, side]);

  const chart = useMemo(() => {
    const closes = bars.map((b) => b.close);
    const avg = sma(closes, ma);
    const price = [];
    const line = [];
    for (let i = startIdx; i < bars.length; i++) {
      price.push({ x: i, y: closes[i]! });
      line.push({ x: i, y: avg[i] ?? null });
    }
    const bands = set.runs
      .filter((x) => x.side === 'below')
      .map((x) => ({ x0: Math.max(startIdx, sliceStart + x.entryIndex) - 0.5, x1: sliceStart + x.lastIndex + 0.5, color: 'var(--down-soft)' }))
      .filter((b) => b.x1 > startIdx);
    return { price, line, bands };
  }, [bars, ma, startIdx, sliceStart, set]);

  const sideWord = side === 'above' ? 'above' : 'below';
  const studyStart = bars[startIdx]?.date ?? null;
  const st = study && !isNa(study) ? study : null;
  const od = odds && !isNa(odds) ? odds : null;
  const ageBin = hist.find((b) => age >= b.lo && age <= b.hi);

  return (
    <div className="stack">
      <Card
        title="Position against each average"
        info="Simple average of the last N completed closes. Day counts sessions in a row on the current side. Typical lengths are medians of finished runs in the study history."
        sub={`Close ${fmtDate(asOf)}. Study history from ${fmtDate(studyStart)}. Select an average to study it.`}
      >
        {overview.status === 'loading' && <Skeleton h={96} />}
        {overview.status === 'error' && (
          <StateNote tone="error" title="The overview could not be computed." action={<button type="button" className="btn small" onClick={overview.reload}>Retry</button>}>
            {overview.error.message}
          </StateNote>
        )}
        {overview.status === 'ready' && <OverviewCells cells={overview.data} selected={ma} onSelect={(w) => patch({ ma: w === 200 ? null : w, age: null })} />}
      </Card>

      <Card title={side ? `Runs ${sideWord} the ${ma} day average` : `Runs against the ${ma} day average`}>
        <div className="ma-controls">
          <div className="field">
            Side studied
            <Segmented
              label="Side studied"
              value={sideParam}
              options={[
                { value: 'current', label: liveSide ? `Current, ${liveSide}` : 'Current' },
                { value: 'above', label: 'Above' },
                { value: 'below', label: 'Below' },
              ]}
              onChange={(v) => patch({ side: v === 'current' ? null : v, age: null })}
            />
          </div>
          <div className="field">
            <span>Compare from day <Info text={AFTER_DAY} label="About comparing from a chosen day" /></span>
            <span className="ma-age">
              <button type="button" className="btn small" aria-label="One day earlier" disabled={age <= 1} onClick={() => patch({ age: age - 1 })}>−</button>
              <input className="input" type="number" inputMode="numeric" min={1} step={1} aria-label="Elapsed sessions on this side" value={age} onChange={(e) => { const v = Math.floor(Number(e.target.value)); if (v >= 1) patch({ age: v }); }} />
              <button type="button" className="btn small" aria-label="One day later" onClick={() => patch({ age: age + 1 })}>+</button>
              {liveRun && age !== liveRun.length && (
                <button type="button" className="btn small ghost" onClick={() => patch({ age: null })}>Use today, day {liveRun.length}</button>
              )}
            </span>
          </div>
        </div>

        {isNa(set.current) && <StateNote tone="warn" title={`No ${ma} day average yet.`}>{reasonDetail(set.current)}</StateNote>}
        {!side && cur && <StateNote>The last close sits on the average, so there is no current side. Choose Above or Below to study finished runs.</StateNote>}

        {side && (
          <div className="stack">
            <div className="stats">
              {liveRun ? (
                <>
                  <Stat
                    label="Run age"
                    value={`Day ${liveRun.length}`}
                    sub={<>since {fmtDate(liveRun.entryDate)} at {fmtPrice(liveRun.entryClose)}{liveRun.startKind === 'leading' ? '. Start not observed in the study history' : ''}</>}
                  />
                  <Stat
                    label="Farthest from average"
                    info="The most extreme close against that day's average during this run. The average moves every day, so this date can differ from the date of the biggest change since the crossing."
                    value={<Pct v={liveRun.farthestDistance} />}
                    sub={`close on ${fmtDate(liveRun.farthestDistanceDate)}`}
                  />
                  <Stat
                    label={side === 'below' ? 'Worst change from crossing' : 'Best change from crossing'}
                    info="The biggest move of the close against the crossing close during this run."
                    value={<Pct v={liveRun.extremeFromEntry} />}
                    sub={liveRun.extremeDatesCoincide ? 'same date as the farthest distance' : `close on ${fmtDate(liveRun.extremeFromEntryDate)}, a different date`}
                  />
                </>
              ) : (
                <Stat label="Live run" value={<span className="faint">None on this side</span>} sub={liveSide ? `The last close is ${liveSide} the average` : undefined} />
              )}
              {st && (
                <>
                  <Stat label={`Finished runs that reached day ${age}`} value={`${st.reached} of ${st.completed}`} sub={`${st.notReached} ended earlier and do not enter`} />
                  <Stat
                    label={`Sessions to exit after day ${age}`}
                    info={AFTER_DAY}
                    value={st.median === null ? <span className="faint">n/a</span> : `${fmtCount(st.median)} median`}
                    sub={st.mean === null ? 'No comparable finished run' : `mean ${st.mean.toFixed(1)}, middle half ${fmtCount(st.p25)} to ${fmtCount(st.p75)}, longest ${fmtCount(st.longest)}`}
                  />
                </>
              )}
              {od && (
                <Stat
                  label="Typical remaining"
                  info="The smallest number of further sessions by which at least half of comparable runs had ended. Unfinished runs stay in the count until their last observed session."
                  value={isNum(od.typicalRemaining) ? plural(od.typicalRemaining, 'session') : <span className="faint">Withheld</span>}
                  sub={isNum(od.typicalRemaining) ? `${od.atRisk} runs reached day ${age}` : isNa(od.typicalRemaining) ? reasonDetail(od.typicalRemaining) : undefined}
                />
              )}
            </div>

            {study && isNa(study) && <StateNote>{reasonDetail(study)}</StateNote>}
            {st?.warning && <StateNote tone="warn">{st.warning}</StateNote>}

            {od && (
              <div>
                <h3 style={{ marginBottom: 6 }}>Share of runs that ended soon after day {age}</h3>
                {od.status !== 'valid' && <StateNote tone="warn" title="Conditional estimate withheld.">{od.atRisk} runs reached day {age} and {od.minAtRisk} are needed. The counts below are descriptive.</StateNote>}
                <div className="ma-odds-wrap"><table className="ma-odds">
                  <thead>
                    <tr>
                      <th scope="col">Ended within</th>
                      {od.status === 'valid' && <th scope="col">Estimate with unfinished runs</th>}
                      <th scope="col">Finished runs only</th>
                    </tr>
                  </thead>
                  <tbody>
                    {od.rows.map((row) => (
                      <tr key={row.within}>
                        <td>{plural(row.within, 'session')}</td>
                        {od.status === 'valid' && (
                          <td className="num">
                            {isNum(row.probability) ? <strong>{fmtPct(row.probability, 0, false)}</strong> : <span className="faint">{isNa(row.probability) ? reasonDetail(row.probability) : 'n/a'}</span>}
                            {row.unresolved > 0 && <span className="faint small"> ({row.unresolved} unresolved)</span>}
                          </td>
                        )}
                        <td><Freq p={row.completedOnly} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
                {od.status === 'valid' && <p className="muted small" style={{ marginTop: 6 }}>{od.note} Historical frequency, not a forecast.</p>}
              </div>
            )}

            {st && st.rows.length > 0 && (
              <Disclosure summary={`The ${st.rows.length} finished runs behind these figures`}>
                <div className="table-wrap" style={{ maxHeight: 280, overflowY: 'auto' }} tabIndex={0} role="region" aria-label="Comparable finished runs">
                  <table className="data">
                    <thead>
                      <tr>
                        <th className="l" scope="col">Entry</th>
                        <th className="l" scope="col">Exit</th>
                        <th scope="col">Sessions</th>
                        <th scope="col">To exit after day {age}</th>
                        <th scope="col">Move to exit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...st.rows].reverse().map((x) => (
                        <tr key={x.entryDate}>
                          <td className="l">{fmtDate(x.entryDate)}</td>
                          <td className="l">{fmtDate(x.exitDate)}</td>
                          <td className="num">{x.length}</td>
                          <td className="num">{x.sessionsToExit}</td>
                          <td><Pct v={x.moveToExit} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Disclosure>
            )}
          </div>
        )}
      </Card>

      <div className="grid-2">
        <Card title={`Close and the ${ma} day average`} sub="Split-consistent closes. Shaded spans are runs below the average.">
          <LineChart
            ariaLabel={`${symbol} close and its ${ma} day average from ${fmtDate(studyStart)} to ${fmtDate(asOf)}. ${cur ? `The last close is ${fmtPct(cur.distance)} from the average` : 'The average is not available'}`}
            series={[
              { id: 'close', label: 'Close', points: chart.price },
              { id: 'sma', label: `${ma} day average`, points: chart.line, color: 'var(--gold-line)' },
            ]}
            bands={chart.bands}
            xLabel={(x) => (history === '1y' ? fmtDate(bars[x]?.date) : fmtMonthYear(bars[x]?.date ?? ''))}
            yFormat={(y) => fmtPrice(y)}
            xTicks={phone ? [startIdx, Math.round((startIdx + bars.length - 1) / 2), bars.length - 1] : undefined}
            height={phone ? 220 : 280}
          />
        </Card>
        <Card
          title={side ? `Lengths of finished runs ${sideWord}` : 'Lengths of finished runs'}
          sub={stats ? `${plural(stats.n, 'finished run')}. Median ${fmtCount(stats.median)} sessions, longest ${stats.longest} from ${fmtDate(stats.longestEntryDate)}.` : undefined}
        >
          {hist.length === 0 ? (
            <StateNote>No finished run on this side in the study history. A longer history window may add some.</StateNote>
          ) : (
            <>
              <BarChart
                ariaLabel={`Finished run lengths ${sideWord} the ${ma} day average in session bins. ${stats ? `Median ${fmtCount(stats.median)} sessions` : ''}`}
                bars={hist.map((b) => ({ key: b.label, label: b.label, value: b.count, color: 'var(--accent)', detail: `${plural(b.count, 'run')} lasted ${b.label} sessions` }))}
                yFormat={(y) => String(Math.round(y))}
                selectedKey={ageBin?.label ?? null}
                height={220}
              />
              <p className="muted small" style={{ marginTop: 6 }}>
                Sessions per run, in even bins. {ageBin ? `Day ${age} falls in the outlined bin. ` : ''}
                Not counted: {set.counts.active} live, {set.counts.leading} already under way when the study history begins, {set.counts.interrupted + set.counts.afterGap} with missing data.
              </p>
            </>
          )}
        </Card>
      </div>

      <Card title="Crossing history" sub={`Every run against the ${ma} day average since ${fmtDate(set.firstObservableDate)}. Select a row for its dates and extremes.`}>
        <RunTable key={`${symbol}:${ma}:${side ?? 'x'}`} runs={set.runs} window={ma} studySide={side} />
      </Card>
    </div>
  );
}

export default function Trend() {
  return (
    <RequireBars min={6}>
      <TrendInner />
    </RequireBars>
  );
}
