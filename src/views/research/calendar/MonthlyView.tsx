/** Monthly returns board, year extremes and the elapsed session comparison. Owner specification section 6. */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useResearch } from '../../../app/research';
import { researchPath } from '../../../app/routes';
import { useEngine } from '../../../data/engine';
import { yearOf } from '../../../engine/core/calendar';
import { isNa, isNum, type Maybe } from '../../../engine/core/types';
import { monthElapsedComparison, ytdSummary, type ElapsedCohort, type MonthCell, type MonthlyBoard, type PeriodStats, type YearRow } from '../../../engine/monthlyBoard';
import { BarChart } from '../../../ui/charts';
import { Card, Freq, Info, Pct, RangeGauge, Skeleton, Stat, StateNote } from '../../../ui/components';
import { dirClass, fmtDate, fmtPct, fmtPrice, heatBg, MONTH_NAMES, plural, reasonDetail } from '../../../ui/format';
import { useUrlState } from '../trend/params';

const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const HEAT_CAP = 0.2;

const cellTitle = (c: MonthCell): string => {
  switch (c.status) {
    case 'complete':
      return `${fmtDate(c.baseDate)} close ${fmtPrice(c.baseClose)} to ${fmtDate(c.endDate)} close ${fmtPrice(c.endClose)}${c.missingSessions ? `. ${c.missingSessions} sessions missing inside the month` : ''}`;
    case 'current-partial':
      return `Month to date through ${fmtDate(c.endDate)}, ${c.sessions} of ${c.expectedSessions} sessions. Not counted in the statistics`;
    case 'listing-partial':
      return `History starts ${fmtDate(c.firstDate)}, inside this month, so there is no base close${c.sinceFirst ? `. Since first date ${fmtPct(c.sinceFirst.ret)}, for illustration only` : ''}`;
    case 'missing-data':
      return isNa(c.ret) ? reasonDetail(c.ret) : 'A required session is missing';
    default:
      return 'No data';
  }
};

function StatsRow({ label, stats, yearStats, render, info }: { label: string; stats: PeriodStats[]; yearStats: PeriodStats; render: (s: PeriodStats) => React.ReactNode; info?: string }) {
  return (
    <tr>
      <th scope="row" className="l">
        {label} {info && <Info text={info} />}
      </th>
      {stats.map((s, i) => (
        <td key={i}><span>{render(s)}</span></td>
      ))}
      <td className="cal-sep"><span>{render(yearStats)}</span></td>
      <td /><td />
    </tr>
  );
}

const mb = (v: Maybe<number>): number | null => (isNum(v) ? v : null);

function CohortLine({ c, current }: { c: ElapsedCohort; current: number }) {
  if (c.n === 0) return <p className="muted small">{c.label}. No earlier period qualifies.</p>;
  const ex = c.excluded.noBase + c.excluded.tooFewSessions + c.excluded.missingSessions;
  return (
    <p className="small" style={{ margin: '4px 0' }}>
      <strong>{c.label}.</strong> Median at the same point <Pct v={mb(c.median)} />. The current {fmtPct(current)} is lower than {c.higher} and higher than {c.lower} of {plural(c.n, 'earlier period')}
      {isNum(c.percentileOfCurrent) ? `, percentile ${Math.round(c.percentileOfCurrent * 100)}` : ''}.{ex > 0 ? ` ${ex} left out for a missing base or too few sessions.` : ''}
    </p>
  );
}

export function MonthlyView() {
  const r = useResearch();
  const { bars, symbol, asOf, windowStart, history } = r;
  const [sp, patch] = useUrlState();
  const [selYear, setSelYear] = useState<number | null>(null);

  // Rows start with the calendar year that contains the window start. One earlier bar supplies the base close.
  const studyBars = useMemo(() => {
    if (!windowStart) return bars;
    const y = String(yearOf(windowStart));
    const i = bars.findIndex((b) => b.date.slice(0, 4) >= y);
    return i <= 0 ? bars : bars.slice(i - 1);
  }, [bars, windowStart]);

  const board = useEngine<MonthlyBoard>(`${symbol}:${asOf}:${history}`, 'monthlyBoard', 'monthlyBoard', () => [studyBars]);
  const elapsed = useMemo(() => monthElapsedComparison(studyBars), [studyBars]);
  const ytd = useMemo(() => ytdSummary(bars), [bars]);

  if (board.status === 'loading') return <Skeleton h={420} />;
  if (board.status === 'error') {
    return (
      <StateNote tone="error" title="The monthly board could not be computed." action={<button type="button" className="btn small" onClick={board.reload}>Retry</button>}>
        {board.error.message}
      </StateNote>
    );
  }
  const b = board.data;
  const mParam = Number(sp.get('m'));
  const selMonth = mParam >= 1 && mParam <= 12 ? mParam : (b.currentMonth?.month ?? 1);
  // The base bar of the first year would otherwise show as an extra one-session year.
  const years = [...b.years].filter((y) => y.sessions > 1 || y.status === 'complete').reverse();
  const anyPartial = years.some((y) => y.status !== 'complete' || y.months.some((m) => m.status === 'current-partial' || m.status === 'listing-partial' || m.status === 'missing-data'));
  const ms = b.monthStats[selMonth - 1]!;
  const monthBars = [...years].reverse().map((y) => {
    const c = y.months[selMonth - 1]!;
    const v = mb(c.ret);
    return { key: String(y.year), label: String(y.year), value: c.status === 'complete' || c.status === 'current-partial' ? v : null, detail: c.status === 'current-partial' ? 'Month to date, not counted' : undefined, flag: c.status === 'current-partial' ? '*' : undefined };
  });
  const selRow: YearRow | undefined = years.find((y) => y.year === selYear);
  const isCurrentSel = b.currentMonth?.month === selMonth;
  const asofParam = sp.get('asof') ?? undefined;

  return (
    <div className="stack">
      <Card
        title="Monthly price returns"
        info="Each month is the final close of the month against the final close of the month before. The year column and the highest and lowest year to date figures all start from the final close of the prior year. Quote closes on one split basis. Dividends are not included."
        sub={`Price returns, not total returns. ${fmtDate(b.firstDate)} to ${fmtDate(b.asOf)}. ${plural(b.completeYears, 'complete year')} counted.`}
      >
        <div className="cal-scroll" tabIndex={0} role="region" aria-label="Monthly price returns by year. Scrolls sideways on narrow screens">
          <table className="heat cal-heat">
            <thead>
              <tr>
                <th className="cal-year l" scope="col">Year</th>
                {MONTH_NAMES.map((m, i) => (
                  <th key={m} scope="col" className={i + 1 === selMonth ? 'cal-col-sel' : undefined}>
                    <button type="button" aria-pressed={i + 1 === selMonth} aria-label={`Select ${FULL_MONTHS[i]}`} onClick={() => patch({ m: i + 1 })}>{m}</button>
                  </th>
                ))}
                <th scope="col" className="cal-sep">Year</th>
                <th scope="col">High YTD <Info text="Highest daily close of the year against the prior year end close. Closing values only. Select a value for its date." /></th>
                <th scope="col">Low YTD <Info text="Lowest daily close of the year against the prior year end close. It can be positive in a year that never closed below its starting level. Select a value for its date." /></th>
              </tr>
            </thead>
            <tbody>
              {years.map((y) => (
                <tr key={y.year}>
                  <td className="cal-year">{y.year}</td>
                  {y.months.map((c) => {
                    const v = mb(c.ret);
                    const partial = c.status === 'current-partial';
                    const show = c.status === 'complete' || partial;
                    const sel = c.month === selMonth;
                    return (
                      <td key={c.month} className={sel ? 'cal-col-sel' : undefined}>
                        {show && v !== null ? (
                          <button type="button" className={partial ? 'partial' : undefined} style={{ background: heatBg(v, HEAT_CAP) }} title={cellTitle(c)} aria-label={`${FULL_MONTHS[c.month - 1]} ${y.year} ${fmtPct(v)}${partial ? ', month to date, partial' : ''}`} onClick={() => { patch({ m: c.month }); setSelYear(y.year); }}>
                            {fmtPct(v, 1)}
                          </button>
                        ) : c.status === 'listing-partial' || c.status === 'missing-data' ? (
                          <span className="faint partial" title={cellTitle(c)}>n/a</span>
                        ) : (
                          <span aria-hidden="true">&nbsp;</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="cal-sep">
                    {isNum(y.yearReturn) ? (
                      <button type="button" className={y.isYtd ? 'partial' : undefined} style={{ background: heatBg(y.yearReturn, 0.5), fontWeight: 650 }} title={y.isYtd ? `Year to date through ${fmtDate(y.endDate)}. Not counted in the statistics` : `${fmtDate(y.baseDate)} to ${fmtDate(y.endDate)}`} aria-label={`${y.year} ${y.isYtd ? 'year to date' : 'full year'} ${fmtPct(y.yearReturn)}`} onClick={() => setSelYear(y.year)}>
                        {fmtPct(y.yearReturn, 1)}
                      </button>
                    ) : (
                      <span className="faint partial" title={isNa(y.yearReturn) ? `${reasonDetail(y.yearReturn)}${y.sinceFirst ? `. Since first date ${fmtPct(y.sinceFirst.ret)} from ${fmtDate(y.sinceFirst.fromDate)}, for illustration only` : ''}` : undefined}>n/a</span>
                    )}
                  </td>
                  {[y.highestYtd, y.lowestYtd].map((e, k) => (
                    <td key={k}>
                      {isNa(e) ? (
                        <span className="faint" title={reasonDetail(e)}>n/a</span>
                      ) : (
                        <button type="button" className={dirClass(e.ret)} title={`Close ${fmtPrice(e.close)} on ${fmtDate(e.date)}`} aria-label={`${k === 0 ? 'Highest' : 'Lowest'} year to date ${y.year} ${fmtPct(e.ret)} on ${fmtDate(e.date)}`} onClick={() => setSelYear(y.year)}>
                          {fmtPct(e.ret, 1)}
                        </button>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <StatsRow label="Positive" stats={b.monthStats} yearStats={b.yearStats} render={(s) => (s.n ? `${s.positive} of ${s.n}` : 'n/a')} info="Complete periods with a positive return, out of complete periods counted." />
              <StatsRow label="Median" stats={b.monthStats} yearStats={b.yearStats} render={(s) => <Pct v={mb(s.median)} digits={1} />} />
              <StatsRow label="Average" stats={b.monthStats} yearStats={b.yearStats} render={(s) => <Pct v={mb(s.mean)} digits={1} />} />
              <StatsRow label="Win rate" stats={b.monthStats} yearStats={b.yearStats} render={(s) => (s.win ? fmtPct(s.win.rate, 0, false) : 'n/a')} info="Positive periods divided by periods counted. With about ten observations per month the interval is wide. Select a month for the interval." />
            </tfoot>
          </table>
        </div>
        <div className="cal-key">
          {anyPartial && <span><em>Italic with *</em> is a partial period (month or year to date, or history starting inside it). Partial periods are left out of the statistics.</span>}
          <span>Color strength is capped at {fmtPct(HEAT_CAP, 0, false)} per month. The sign carries the direction.</span>
        </div>
        {selRow && (
          <StateNote>
            <strong>{selRow.year}.</strong>{' '}
            {isNum(selRow.yearReturn) ? `${selRow.isYtd ? 'Year to date' : 'Full year'} ${fmtPct(selRow.yearReturn)} from the ${fmtDate(selRow.baseDate)} close of ${fmtPrice(selRow.baseClose)} to ${fmtDate(selRow.endDate)}. ` : isNa(selRow.yearReturn) ? `${reasonDetail(selRow.yearReturn)}. ` : ''}
            {!isNa(selRow.highestYtd) && `Highest close ${fmtPct(selRow.highestYtd.ret)} on ${fmtDate(selRow.highestYtd.date)}. `}
            {!isNa(selRow.lowestYtd) && `Lowest close ${fmtPct(selRow.lowestYtd.ret)} on ${fmtDate(selRow.lowestYtd.date)}. `}
            {selRow.sinceFirst && `Since the first available close on ${fmtDate(selRow.sinceFirst.fromDate)}: ${fmtPct(selRow.sinceFirst.ret)}, for illustration only. `}
            {selRow.missingSessions > 0 && `${selRow.missingSessions} sessions are missing, so an extreme could be missed.`}
          </StateNote>
        )}
      </Card>

      <div className="grid">
        <Card
          title={`${FULL_MONTHS[selMonth - 1]} across years`}
          actions={
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <span className="sr-only">Month</span>
              <select className="select" aria-label="Month" value={selMonth} onChange={(e) => patch({ m: e.target.value })}>
                {FULL_MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>{m}</option>
                ))}
              </select>
            </label>
          }
        >
          <div className="stats cal-stats" style={{ marginBottom: 12 }}>
            <Stat label="Positive months" value={ms.win ? <Freq p={ms.win} /> : <span className="faint">n/a</span>} />
            <Stat label="Median" value={<Pct v={mb(ms.median)} />} sub={`average ${fmtPct(mb(ms.mean))}`} />
            <Stat label="Best and worst" value={ms.best && ms.worst ? <><Pct v={ms.best.ret} digits={1} /> <span className="faint">/</span> <Pct v={ms.worst.ret} digits={1} /></> : <span className="faint">n/a</span>} sub={ms.best && ms.worst ? `${ms.best.year} and ${ms.worst.year}` : undefined} />
          </div>
          <BarChart ariaLabel={`${FULL_MONTHS[selMonth - 1]} price return by year. ${ms.n ? `${ms.positive} of ${ms.n} complete months were positive` : 'No complete month yet'}`} bars={monthBars} yFormat={(y) => fmtPct(y, 0)} height={190} />
          {ms.n < 10 && <p className="muted small" style={{ marginTop: 6 }}>{plural(ms.n, 'complete month')} counted. A sample this small describes the past and supports no odds.</p>}
        </Card>

        <Card
          title={isNa(elapsed) ? 'Current month so far' : `${FULL_MONTHS[(elapsed.month ?? 1) - 1]} so far, after ${plural(elapsed.elapsedSessions, 'session')}`}
          info="Compares the month to date return with earlier months measured after the same number of completed sessions. Observed history only."
        >
          {isNa(elapsed) ? (
            <StateNote>{reasonDetail(elapsed)}</StateNote>
          ) : (
            <>
              <div className="stats cal-stats" style={{ marginBottom: 8 }}>
                <Stat label="Month to date" value={<Pct v={elapsed.currentRet} />} sub={`from ${fmtDate(elapsed.baseDate)} close ${fmtPrice(elapsed.baseClose)}`} />
                {elapsed.sameMonth && elapsed.sameMonth.n > 0 && (
                  <Stat label="Same month, earlier years" value={<Pct v={mb(elapsed.sameMonth.median)} />} sub={`median after ${elapsed.elapsedSessions} sessions, ${plural(elapsed.sameMonth.n, 'year')}`} />
                )}
              </div>
              {elapsed.sameMonth && elapsed.sameMonth.n > 0 && (
                <BarChart
                  ariaLabel={`Return after ${elapsed.elapsedSessions} sessions of ${FULL_MONTHS[(elapsed.month ?? 1) - 1]} in each earlier year, with the current year last`}
                  bars={[
                    ...elapsed.sameMonth.rows.map((x) => ({ key: String(x.year), label: String(x.year), value: x.retAtElapsed, detail: isNum(x.periodReturn) ? `full month ${fmtPct(x.periodReturn)}` : undefined })),
                    { key: 'now', label: String(elapsed.year), value: elapsed.currentRet, color: 'var(--gold-line)', detail: 'current, month to date' },
                  ]}
                  selectedKey="now"
                  yFormat={(y) => fmtPct(y, 0)}
                  height={170}
                />
              )}
              {elapsed.sameMonth && <CohortLine c={elapsed.sameMonth} current={elapsed.currentRet} />}
              <CohortLine c={elapsed.all} current={elapsed.currentRet} />
              <p style={{ marginTop: 8 }}>
                <Link to={researchPath(symbol, 'selloffs', { tab: 'monthly', asof: asofParam })}>Study this month in Monthly Reversal</Link>
              </p>
              {!isCurrentSel && <p className="muted small">This card always shows the current month. The chart on the left follows the month you select.</p>}
            </>
          )}
        </Card>

        <Card title="This year's closing range" info="Where the latest close sits between the lowest and highest daily close of the year. Closing values on the prior year end base.">
          {isNa(ytd) ? (
            <StateNote>{reasonDetail(ytd)}</StateNote>
          ) : (
            <>
              <RangeGauge
                label={`${ytd.year} closing range`}
                pos={isNum(ytd.rangePosition) ? ytd.rangePosition : null}
                lowLabel={<>{fmtPct(ytd.low.ret, 1)} on {fmtDate(ytd.low.date)}</>}
                highLabel={<>{fmtPct(ytd.high.ret, 1)} on {fmtDate(ytd.high.date)}</>}
              />
              <div className="stats cal-stats" style={{ marginTop: 12 }}>
                <Stat label="From year closing high" value={<Pct v={ytd.fromYearHigh} />} sub={fmtPrice(ytd.high.close)} />
                <Stat label="From year closing low" value={<Pct v={ytd.fromYearLow} />} sub={fmtPrice(ytd.low.close)} />
                <Stat label="Range position" value={isNum(ytd.rangePosition) ? fmtPct(ytd.rangePosition, 0, false) : <span className="faint">Flat range</span>} sub={`${ytd.sessions} sessions this year`} />
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
