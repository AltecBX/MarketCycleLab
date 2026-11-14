/** Realized weekly returns board. Owner specification section 7. Observed history, not a forecast. */
import { useMemo, useState } from 'react';
import { useResearch } from '../../../app/research';
import { useBars } from '../../../data/client';
import { useEngine } from '../../../data/engine';
import { isNa, isNum, type Maybe } from '../../../engine/core/types';
import {
  sortWeeklyRows, weeklyBoard, weeklySeasonality,
  type NextWeekStudy, type SeasonalityBucket, type WeekRecord, type WeeklyBoard, type WeeklySortKey, type WeeklyTableRow, type WeekStreak,
} from '../../../engine/weeklyBoard';
import { BarChart, LineChart } from '../../../ui/charts';
import { Card, Chip, DataTable, Disclosure, Freq, Pct, Segmented, Skeleton, Stat, StateNote, type Column, type SortState } from '../../../ui/components';
import { fmtDate, fmtDateShort, fmtMultiple, fmtNum, fmtPct, fmtPp, fmtPrice, heatBg, MONTH_NAMES, plural, reasonDetail } from '../../../ui/format';
import { usePhone, useUrlState } from '../trend/params';
import { DipChart, WeeklyRangeChart } from './WeeklyCharts';

const mb = (v: Maybe<number>): number | null => (isNum(v) ? v : null);
const sig = (v: number | null): string => (v === null ? 'n/a' : `${fmtNum(v, 2, true)}σ`);
const why = (v: Maybe<unknown>): string | undefined => (isNa(v) ? reasonDetail(v) : undefined);

const streakText = (s: WeekStreak): string =>
  `${plural(s.length, 'week')} ${s.direction}, ${fmtPct(s.chained)} from the ${fmtDate(s.fromDate)} close to ${fmtDate(s.toDate)}`;

function WeekDetail({ w, hasSpy }: { w: WeekRecord; hasSpy: boolean }) {
  const base = isNa(w.base) ? null : w.base;
  const pts = w.days.map((d, i) => ({ x: i + 1, y: mb(d.rel) }));
  const hLines = [];
  if (isNum(w.highRet)) hLines.push({ y: w.highRet, label: 'week high', color: 'var(--up)' });
  if (isNum(w.lowRet)) hLines.push({ y: w.lowRet, label: 'week low', color: 'var(--down)' });
  return (
    <div className="stack" style={{ gap: 12 }}>
      {w.status !== 'complete' && <StateNote tone="warn" title={w.status === 'partial' ? 'Partial week.' : 'Missing session.'}>{w.statusNote ?? 'Not counted in the statistics.'}</StateNote>}
      {!base && <StateNote tone="warn">{reasonDetail(w.base as never)}</StateNote>}
      <div className="stats cal-stats">
        <Stat label="Week return" value={<Pct v={mb(w.ret)} />} sub={base ? `${fmtPrice(base.close)} on ${fmtDate(base.date)} to ${fmtPrice(w.close)}` : undefined} />
        <Stat label="Low and high" info="Lowest and highest traded price of the week against the prior week close." value={<><Pct v={mb(w.lowRet)} digits={1} /> <span className="faint">/</span> <Pct v={mb(w.highRet)} digits={1} /></>} sub={w.lowWeekday && w.highWeekday ? `low ${w.lowWeekday} ${fmtDateShort(w.lowDate)}, high ${w.highWeekday} ${fmtDateShort(w.highDate)}` : undefined} />
        <Stat label="Move in sigmas" info="Week return divided by the sample standard deviation of the 20 daily returns before the week, scaled by the square root of the days traded." value={<span title={why(w.sigma)}>{sig(mb(w.sigma))}</span>} />
      </div>
      {pts.some((p) => p.y !== null) && (
        <LineChart
          ariaLabel={`Daily closes of the week ending ${fmtDate(w.label)} against the prior week close. Week return ${fmtPct(mb(w.ret))}`}
          series={[{ id: 'path', label: 'Close vs prior week close', points: [{ x: 0, y: 0 }, ...pts] }]}
          hLines={hLines}
          zeroLine
          xTicks={[0, ...pts.map((p) => p.x)]}
          xLabel={(x) => (x === 0 ? 'Prior' : (w.days[x - 1]?.weekdayName ?? ''))}
          yFormat={(y) => fmtPct(y, 1)}
          height={180}
          legend={false}
        />
      )}
      <dl className="kv">
        <dt>Sessions</dt>
        <dd>{fmtDate(w.firstSession)} to {fmtDate(w.lastSession)}, {w.tradedDays} of {w.expectedDays} traded{w.expectedDays < 5 ? '. Holiday short week' : ''}</dd>
        <dt>Opening gap</dt>
        <dd title={why(w.gap)}><Pct v={mb(w.gap)} /> first open against the prior week close</dd>
        <dt>Close in range</dt>
        <dd title={why(w.closeInRange)}>{isNum(w.closeInRange) ? `${fmtPct(w.closeInRange, 0, false)} of the way from the week low to the week high` : isNa(w.closeInRange) ? reasonDetail(w.closeInRange) : 'n/a'}</dd>
        <dt>Volume</dt>
        <dd title={why(w.relVolume)}>{isNum(w.relVolume) ? `${fmtMultiple(w.relVolume, 2)} the average of the 20 sessions before the week` : 'n/a'}</dd>
        <dt>SPY, same sessions</dt>
        <dd title={why(w.spyRet)}>{hasSpy && isNum(w.spyRet) ? <><Pct v={w.spyRet} /> SPY, difference <span className="num">{fmtPp(mb(w.excess))}</span></> : 'Comparison unavailable for this week'}</dd>
        <dt>Against the year</dt>
        <dd>
          {isNa(w.closeVsYearHigh) ? 'n/a' : <><Pct v={w.closeVsYearHigh.value} digits={1} /> from the year closing high of {fmtDate(w.closeVsYearHigh.date)}</>}
          {!isNa(w.closeVsYearLow) && <>, <Pct v={w.closeVsYearLow.value} digits={1} /> from the closing low of {fmtDate(w.closeVsYearLow.date)}</>}
        </dd>
        <dt>Against the 50 day average</dt>
        <dd title={why(w.closeVsSma50)}><Pct v={mb(w.closeVsSma50)} /></dd>
        {w.earnings.map((e) => (
          <div key={e.reportDate} style={{ display: 'contents' }}>
            <dt>Earnings</dt>
            <dd>{e.detail}</dd>
          </div>
        ))}
        <dt>Following week</dt>
        <dd>{isNum(w.nextWeekRet) ? <Pct v={w.nextWeekRet} /> : isNa(w.nextWeekRet) ? reasonDetail(w.nextWeekRet) : 'n/a'}</dd>
      </dl>
    </div>
  );
}

function NextWeekLine({ s, word }: { s: NextWeekStudy; word: string }) {
  if (s.weeks.length === 0) return <li>No week moved {word} {fmtPct(Math.abs(s.threshold), 0, false)} or more.</li>;
  return (
    <li>
      {plural(s.weeks.length, 'week')} {word} {fmtPct(Math.abs(s.threshold), 0, false)} or more.{' '}
      {s.matured > 0 && s.nextWeek ? <>The following week was higher in <Freq p={s.nextWeekUp} />, median <Pct v={s.nextWeek.median} digits={1} />, range {fmtPct(s.nextWeek.min, 1)} to {fmtPct(s.nextWeek.max, 1)}.</> : 'No following week has completed yet.'}
    </li>
  );
}

function SeasonBars({ buckets, name, label }: { buckets: SeasonalityBucket[]; name: string; label: (k: number) => string }) {
  return (
    <BarChart
      ariaLabel={`Median weekly price return by ${name} over the seasonality window`}
      bars={buckets.map((b) => ({ key: String(b.key), label: label(b.key), value: mb(b.median), detail: `${b.winRate ? `${b.winRate.hits} of ${b.n} up` : 'no weeks'}${b.sparse ? ', sparse' : ''}`, flag: b.sparse ? '·' : undefined }))}
      yFormat={(y) => fmtPct(y, 1)}
      height={200}
    />
  );
}

export function WeeklyView() {
  const r = useResearch();
  const { bars, symbol, asOf } = r;
  const phone = usePhone();
  const [sp, patch] = useUrlState();
  const spy = useBars(symbol === 'SPY' ? null : 'SPY', asOf ?? undefined);
  const spyBars = spy.status === 'ready' && !isNa(spy.data) ? spy.data : null;
  const spyPending = symbol !== 'SPY' && spy.status === 'loading';
  const earnings = isNa(r.earningsKnown) ? null : r.earningsKnown;
  const [sort, setSort] = useState<SortState>({ key: 'label', dir: 'desc' });

  const weeks = useEngine<WeekRecord[]>(spyPending ? null : `${symbol}:${asOf}:${spyBars ? 'spy' : 'nospy'}:${earnings ? earnings.length : 'noearn'}`, 'weeklyBoard', 'buildWeeks', () => [
    { bars, spy: spyBars, earnings, expectedThrough: r.frozen ? undefined : r.clock.lastCompletedSession },
  ]);

  const yearParam = Number(sp.get('wy'));
  const mode = sp.get('wmode') === 'season' ? 'season' : 'year';
  const board = useMemo<WeeklyBoard | null>(() => {
    if (weeks.status !== 'ready') return null;
    const year = Number.isInteger(yearParam) && yearParam > 1900 ? yearParam : undefined;
    return weeklyBoard({ bars, spy: spyBars, earnings, year }, weeks.data);
  }, [weeks, bars, spyBars, earnings, yearParam]);
  const season = useMemo(() => (weeks.status === 'ready' && mode === 'season' ? weeklySeasonality(weeks.data) : null), [weeks, mode]);

  if (weeks.status === 'error') {
    return (
      <StateNote tone="error" title="The weekly board could not be computed." action={<button type="button" className="btn small" onClick={weeks.reload}>Retry</button>}>
        {weeks.error.message}
      </StateNote>
    );
  }
  if (!board) return <Skeleton h={480} />;

  const s = board.summary;
  const years = [...board.availableYears].reverse();
  const lastCounted = [...board.weeks].reverse().find((w) => w.counted) ?? board.weeks[board.weeks.length - 1];
  const selLabel = sp.get('wk');
  const selWeek = board.weeks.find((w) => w.label === selLabel) ?? lastCounted ?? null;
  const select = (label: string) => patch({ wk: label });
  const streak = isNa(s.currentStreak) ? null : s.currentStreak;
  const last = isNa(s.lastWeek) ? null : s.lastWeek;
  const spySum = isNa(s.spy) ? null : s.spy;
  const t = board.tells;

  const toolbar = (
    <div className="cal-toolbar">
      <Segmented label="Weekly mode" value={mode} options={[{ value: 'year', label: 'One year' }, { value: 'season', label: 'Ten year seasonality' }]} onChange={(v) => patch({ wmode: v === 'year' ? null : v })} />
      {mode === 'year' && (
        <label className="field">
          <span className="sr-only">Year</span>
          <select className="select" aria-label="Year" value={board.year} onChange={(e) => patch({ wy: e.target.value, wk: null })}>
            {years.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </label>
      )}
      <span className="muted small">Price returns from quote closes, Monday to Friday weeks labeled by their Friday. Through {fmtDate(board.asOf)}.</span>
    </div>
  );

  if (mode === 'season' && season) {
    return (
      <div className="stack">
        {toolbar}
        <Card
          title="Weekly seasonality"
          info="Completed weeks of about the last ten years, grouped by their place in the month and by ISO week of the year. Observed frequencies. A bucket under ten weeks is marked sparse."
          sub={season.weeksCounted ? `${plural(season.weeksCounted, 'completed week')}, ${fmtDate(season.fromLabel)} to ${fmtDate(season.toLabel)}, ${plural(season.yearsCovered.length, 'calendar year')}.` : 'No completed weeks.'}
        >
          {season.weeksCounted === 0 ? (
            <StateNote>No completed week with a valid prior close yet.</StateNote>
          ) : (
            <div className="stack">
              <div>
                <h3>By week of the month</h3>
                <div className="table-wrap" style={{ marginTop: 6 }}>
                  <table className="data">
                    <thead>
                      <tr><th className="l" scope="col">Week</th><th scope="col">Median</th><th scope="col">Average</th><th className="l" scope="col">Up weeks</th><th scope="col">Best</th><th scope="col">Worst</th></tr>
                    </thead>
                    <tbody>
                      {season.byOrdinalInMonth.map((b) => (
                        <tr key={b.key}>
                          <td className="l">Week {b.key} {b.sparse && <Chip tone="warn">Sparse</Chip>}</td>
                          <td><Pct v={mb(b.median)} /></td>
                          <td><Pct v={mb(b.average)} /></td>
                          <td className="l"><Freq p={b.winRate} /></td>
                          <td><Pct v={b.best} digits={1} /></td>
                          <td><Pct v={b.worst} digits={1} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div>
                <h3>Median by ISO week of the year</h3>
                <p className="muted small">About ten weeks per bar at most, so each bar is a description, not odds. A dot marks a sparse bucket. Week 53 exists only in some years.</p>
                <SeasonBars buckets={season.byIsoWeek} name="ISO week of the year" label={(k) => `W${k}`} />
              </div>
              <Disclosure summary="ISO week table">
                <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }} tabIndex={0} role="region" aria-label="Seasonality by ISO week">
                  <table className="data">
                    <thead>
                      <tr><th className="l" scope="col">ISO week</th><th scope="col">Weeks</th><th scope="col">Median</th><th scope="col">Average</th><th className="l" scope="col">Up weeks</th></tr>
                    </thead>
                    <tbody>
                      {season.byIsoWeek.map((b) => (
                        <tr key={b.key}>
                          <td className="l">Week {b.key}{b.sparse ? ' (sparse)' : ''}</td>
                          <td className="num">{b.n}</td>
                          <td><Pct v={mb(b.median)} /></td>
                          <td><Pct v={mb(b.average)} /></td>
                          <td className="l"><Freq p={b.winRate} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Disclosure>
            </div>
          )}
        </Card>
      </div>
    );
  }

  const tableCols: Column<WeeklyTableRow>[] = [
    { key: 'label', header: 'Week ending', sticky: true, sort: (x) => x.label, cell: (x) => <>{fmtDate(x.label)}{x.earnings ? <span className="gold" style={{ color: 'var(--gold)', fontWeight: 700 }}> E</span> : ''}{!x.counted ? <span className="faint">*</span> : ''}</> },
    { key: 'ret', header: 'Return', sort: (x) => x.ret, cell: (x) => <Pct v={x.ret} /> },
    { key: 'sigma', header: 'Sigmas', sort: (x) => x.sigma, cell: (x) => <span className="num">{sig(x.sigma)}</span> },
    { key: 'gap', header: 'Gap', sort: (x) => x.gap, cell: (x) => <Pct v={x.gap} /> },
    { key: 'lowRet', header: 'Low', sort: (x) => x.lowRet, cell: (x) => <Pct v={x.lowRet} /> },
    { key: 'highRet', header: 'High', sort: (x) => x.highRet, cell: (x) => <Pct v={x.highRet} /> },
    { key: 'closeInRange', header: <>Close in<br />range</>, sort: (x) => x.closeInRange, cell: (x) => <span className="num">{x.closeInRange === null ? 'n/a' : fmtPct(x.closeInRange, 0, false)}</span> },
    { key: 'lowWeekday', header: <>Low<br />day</>, sort: (x) => x.lowWeekday, cell: (x) => x.lowWeekday ?? 'n/a' },
    { key: 'highWeekday', header: <>High<br />day</>, sort: (x) => x.highWeekday, cell: (x) => x.highWeekday ?? 'n/a' },
    { key: 'relVolume', header: 'Volume', sort: (x) => x.relVolume, cell: (x) => <span className="num">{fmtMultiple(x.relVolume, 2)}</span> },
    { key: 'spyRet', header: 'SPY', sort: (x) => x.spyRet, cell: (x) => <Pct v={x.spyRet} plain /> },
    { key: 'excess', header: <>Minus<br />SPY</>, sort: (x) => x.excess, cell: (x) => <span className="num">{fmtPp(x.excess)}</span> },
    { key: 'closeVsYearHigh', header: <>From year<br />high</>, sort: (x) => x.closeVsYearHigh, cell: (x) => <Pct v={x.closeVsYearHigh} digits={1} /> },
    { key: 'closeVsSma50', header: <>Vs 50<br />day</>, sort: (x) => x.closeVsSma50, cell: (x) => <Pct v={x.closeVsSma50} digits={1} /> },
    { key: 'tradedDays', header: 'Days', sort: (x) => x.tradedDays, cell: (x) => x.tradedDays },
    { key: 'nextWeekRet', header: <>Next<br />week</>, sort: (x) => x.nextWeekRet, cell: (x) => <Pct v={x.nextWeekRet} /> },
  ];
  const tableRows = sortWeeklyRows(board.table, sort.key as WeeklySortKey, sort.dir);

  return (
    <div className="stack">
      {toolbar}
      <Card title={`${board.year} weeks at a glance`}>
        {s.completedWeeks === 0 ? (
          <StateNote>No completed week with a valid prior close in {board.year}.</StateNote>
        ) : (
          <div className="stats cal-stats">
            <Stat label="Up weeks" value={<Freq p={s.upRate} />} sub={`${plural(s.completedWeeks, 'completed week')}, median ${fmtPct(mb(s.medianReturn))}${s.partialWeeks ? `, ${s.partialWeeks} partial not counted` : ''}${s.missingWeeks ? `, ${s.missingWeeks} with missing sessions` : ''}`} />
            <Stat
              label="Current streak"
              value={streak ? <span className={streak.direction === 'up' ? 'up' : streak.direction === 'down' ? 'down' : 'flat'}>{plural(streak.length, 'week')} {streak.direction}</span> : <span className="faint" title={why(s.currentStreak)}>n/a</span>}
              sub={streak ? <>{fmtPct(streak.chained)} from the {fmtDate(streak.fromDate)} close{streak.isLongestOfYear ? '. Longest of the year' : ''}{streak.startedBeforeYear ? '. Began the year before' : ''}</> : undefined}
            />
            <Stat label="Last week" value={last ? <Pct v={last.ret} /> : <span className="faint">n/a</span>} sub={last ? `${fmtDate(last.label)}, ${sig(mb(last.sigma))}, volume ${fmtMultiple(mb(last.relVolume), 2)}, low ${fmtPct(mb(last.lowRet), 1)}` : undefined} />
            <Stat label="Best and worst week" value={!isNa(s.best) && !isNa(s.worst) ? <><Pct v={s.best.ret} digits={1} /> <span className="faint">/</span> <Pct v={s.worst.ret} digits={1} /></> : <span className="faint">n/a</span>} sub={!isNa(s.best) && !isNa(s.worst) ? `${fmtDateShort(s.best.label)} and ${fmtDateShort(s.worst.label)}` : undefined} />
            <Stat label="Typical week low" info="Lowest traded price of the week against the prior week close. The second figure is the level four out of five counted weeks stayed above." value={<Pct v={mb(s.medianWeekLow)} digits={1} />} sub={`80% of weeks stayed above ${fmtPct(mb(s.stayedAbove80), 1)}`} />
            <Stat label="Weeks ahead of SPY" value={spySum ? <Freq p={spySum.beatRate} /> : <span className="faint" title={why(s.spy)}>Unavailable</span>} sub={spySum ? `running sum of weekly differences ${fmtPp(spySum.runningExcess, 1)}` : symbol === 'SPY' ? 'This is SPY' : 'SPY did not cover the same sessions'} />
          </div>
        )}
      </Card>

      <div className="grid-2">
        <Card title="Week by week" info="Rows are months, columns are the first to fifth Friday of the month. Each cell is the week's price return against the prior week close and its week ending date. E marks an earnings week, V marks volume at 1.3 times the prior 20 sessions or more, and a day count marks a holiday short week.">
          <div className="cal-scroll" tabIndex={0} role="region" aria-label={`Weekly returns of ${board.year} by month and week of month. Scrolls sideways on narrow screens`}>
            <table className="heat cal-heat cal-wk">
              <thead>
                <tr>
                  <th className="cal-year l" scope="col">Month</th>
                  {[1, 2, 3, 4, 5].map((k) => <th key={k} scope="col">Week {k}</th>)}
                  <th scope="col" className="cal-sep">Up weeks</th>
                  <th scope="col">Highest</th>
                  <th scope="col">Deepest dip</th>
                </tr>
              </thead>
              <tbody>
                {board.grid.rows.map((row) => (
                  <tr key={row.month}>
                    <td className="cal-year">{MONTH_NAMES[row.month - 1]}</td>
                    {row.cells.map((c, k) => {
                      if (!c) return <td key={k}><span aria-hidden="true">&nbsp;</span></td>;
                      const w = c.week;
                      const v = mb(w.ret);
                      const flags = [w.flags.earnings ? 'E' : '', w.flags.highVolume ? 'V' : '', w.flags.shortWeekDays !== null ? `${w.flags.shortWeekDays}d` : ''].filter(Boolean).join(' ');
                      return (
                        <td key={k} data-selected={selWeek?.label === w.label}>
                          <button type="button" style={{ background: w.counted ? heatBg(v, 0.09) : undefined }} className={w.counted ? undefined : 'partial'} title={w.statusNote ?? undefined}
                            aria-label={`Week ending ${fmtDate(w.label)}, ${v === null ? 'no return' : fmtPct(v)}${w.counted ? '' : ', not counted'}${w.flags.earnings ? ', earnings week' : ''}${w.flags.highVolume ? ', high volume' : ''}${w.flags.shortWeekDays !== null ? `, ${w.flags.shortWeekDays} day week` : ''}`}
                            aria-pressed={selWeek?.label === w.label} onClick={() => select(w.label)}>
                            <span className="cal-wk-ret">{v === null ? 'n/a' : fmtPct(v, 2)}</span>
                            <span className="cal-wk-date">{fmtDateShort(w.label)}</span>
                            <span className="cal-wk-flags">{flags}</span>
                          </button>
                        </td>
                      );
                    })}
                    <td className="cal-agg cal-sep"><span>{row.counted ? `${row.upWeeks} of ${row.counted}` : ''}</span></td>
                    <td className="cal-agg"><span>{isNa(row.highest) ? '' : <Pct v={row.highest.ret} digits={1} />}</span></td>
                    <td className="cal-agg"><span>{isNa(row.deepestDip) ? '' : <Pct v={row.deepestDip.lowRet} digits={1} />}</span></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                {([
                  ['Median', (f) => <Pct v={mb(f.median)} digits={1} />],
                  ['Win rate', (f) => (f.winRate ? fmtPct(f.winRate.rate, 0, false) : 'n/a')],
                  ['Average', (f) => <Pct v={mb(f.average)} digits={1} />],
                  ['Weeks counted', (f) => f.weeksCounted],
                ] as [string, (f: WeeklyBoard['grid']['footer'][number]) => React.ReactNode][]).map(([name, render]) => (
                  <tr key={name}>
                    <th scope="row" className="l">{name}</th>
                    {board.grid.footer.map((f) => <td key={f.ordinal}><span>{render(f)}</span></td>)}
                    <td className="cal-sep" /><td /><td />
                  </tr>
                ))}
              </tfoot>
            </table>
          </div>
          <div className="cal-key">
            <span><strong style={{ color: 'var(--gold)' }}>E</strong> earnings week</span>
            <span><strong style={{ color: 'var(--gold)' }}>V</strong> volume 1.3{'×'} or more</span>
            <span><strong style={{ color: 'var(--gold)' }}>4d</strong> days traded in a short week</span>
            <span><em>Italic with *</em> partial or missing data, not counted</span>
            <span>Color strength is capped at 9%</span>
          </div>
        </Card>
        <Card title={selWeek ? `Week ending ${fmtDate(selWeek.label)}` : 'Week detail'} sub={selWeek && selWeek === lastCounted && !selLabel ? 'Latest completed week. Select any week in the grid or the charts.' : undefined}>
          {selWeek ? <WeekDetail w={selWeek} hasSpy={board.comparisonProvided} /> : <StateNote>No week to inspect in {board.year}.</StateNote>}
        </Card>
      </div>

      <div className="grid">
        <Card title="Weekly range" sub="Low to high of each week against the prior week close.">
          <WeeklyRangeChart points={board.rangeChart} selected={selWeek?.label ?? null} onSelect={select} height={phone ? 200 : 230} />
        </Card>
        <Card title="How deep weeks dipped" info="Lowest traded price of each counted week against the prior week close. The dashed levels are the median and the levels 80% and 90% of weeks stayed above." sub={`${plural(board.dip.n, 'counted week')}.`}>
          {board.dip.n === 0 ? (
            <StateNote>No counted week yet.</StateNote>
          ) : (
            <>
              <DipChart dip={board.dip} selected={selWeek?.label ?? null} onSelect={select} height={phone ? 200 : 230} />
              <p className="small muted" style={{ marginTop: 6 }}>
                {board.dip.below.map((b) => `${b.count} dipped below ${fmtPct(b.level, 0)}`).join(', ')}. Of {plural(board.dip.dipped5, 'week')} that dipped 5% or more, {board.dip.dipped5Recovered} still closed higher on the week.
              </p>
            </>
          )}
        </Card>
      </div>

      <div className="grid">
        <Card title="Tells" info="Counts of specific weekly patterns in the selected year. Observed history. None of these is a signal on its own.">
          <ul className="cal-tells">
            <li>{t.weakCloseDownWeeks.count} of {plural(t.weakCloseDownWeeks.ofDownWeeks, 'down week')} closed in the bottom 20% of the range. {t.strongCloseUpWeeks.count} of {plural(t.strongCloseUpWeeks.ofUpWeeks, 'up week')} closed in the top 20%.</li>
            <li>{t.gapUpClosedRed.count} of {plural(t.gapUpClosedRed.ofGapUps, 'gap up')} closed the week lower. {t.gapDownClosedGreen.count} of {plural(t.gapDownClosedGreen.ofGapDowns, 'gap down')} closed the week higher.</li>
            <li>Weekly low set on Thursday or Friday: <Freq p={t.thursdayFridayLows} /></li>
            <NextWeekLine s={t.bigDown} word="down" />
            <NextWeekLine s={t.bigUp} word="up" />
            {t.longestUp && <li>Longest up streak: {streakText(t.longestUp)}.</li>}
            {t.longestDown && <li>Longest down streak: {streakText(t.longestDown)}.</li>}
            {t.mostUnusual.length > 0 && (
              <li>
                Most unusual moves:{' '}
                {t.mostUnusual.slice(0, 4).map((m, i) => (
                  <span key={m.label}>
                    {i > 0 && ', '}
                    <button type="button" className="btn ghost small" style={{ padding: '0 4px', minHeight: 24 }} onClick={() => select(m.label)}>{fmtDateShort(m.label)}</button> {fmtPct(m.ret, 1)} ({sig(m.sigma)})
                  </span>
                ))}
              </li>
            )}
            {board.earningsProvided ? (
              t.earningsWeeks.length > 0 ? (
                <li>
                  Earnings weeks:{' '}
                  {t.earningsWeeks.map((e, i) => (
                    <span key={e.label} title={e.detail}>
                      {i > 0 && ', '}
                      <button type="button" className="btn ghost small" style={{ padding: '0 4px', minHeight: 24 }} onClick={() => select(e.label)}>{fmtDateShort(e.label)}</button> {fmtPct(e.ret, 1)}{e.range !== null ? `, range ${fmtPct(e.range, 1, false)}` : ''}{e.closeInRange !== null ? `, closed ${fmtPct(e.closeInRange, 0, false)} up the range` : ''}
                    </span>
                  ))}
                </li>
              ) : (
                <li>No earnings week in {board.year}.</li>
              )
            ) : (
              <li className="muted">Earnings markers are unavailable for this symbol.</li>
            )}
          </ul>
        </Card>

        <Card title="By day of the week" info="Daily close to close returns grouped by weekday, and how often each weekday set the weekly high or low among counted weeks.">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th className="l" scope="col">Day</th><th scope="col">Average</th><th className="l" scope="col">Up days</th><th scope="col">Set week<br />high</th><th scope="col">Set week<br />low</th></tr>
              </thead>
              <tbody>
                {board.dayOfWeek.map((d) => (
                  <tr key={d.weekday}>
                    <td className="l">{d.name}</td>
                    <td><Pct v={mb(d.average)} /></td>
                    <td className="l">{d.winRate ? <span className="num">{fmtPct(d.winRate.rate, 0, false)} <span className="faint small">({d.winRate.hits} of {d.winRate.n})</span></span> : <span className="faint">n/a</span>}</td>
                    <td className="num">{d.highsSet}</td>
                    <td className="num">{d.lowsSet}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small" style={{ marginTop: 6 }}>Highs and lows out of {plural(board.dayOfWeek[0]?.weeksCounted ?? 0, 'counted week')}.</p>
        </Card>

        <Card title="Against SPY, week by week" info="Bars are the stock's weekly return minus SPY's over the same sessions, in percentage points. The line is the running sum of those weekly differences. It is not a compounded relative return.">
          {board.spyView.available && board.spyView.bars.length > 0 ? (
            <>
              <BarChart
                ariaLabel={`Weekly return minus SPY in ${board.year}. Running sum ${fmtPp(board.spyView.bars[board.spyView.bars.length - 1]!.running, 1)}`}
                bars={board.spyView.bars.map((x) => ({ key: x.label, label: fmtDateShort(x.label), value: x.excess, detail: `running sum ${fmtPp(x.running, 1)}` }))}
                overlayLine={board.spyView.bars.map((x) => x.running)}
                yFormat={(y) => fmtPp(y, 0)}
                selectedKey={selWeek?.label ?? null}
                onSelect={select}
                height={200}
              />
              <p className="muted small" style={{ marginTop: 6 }}>The running sum line uses its own scale and ends at {fmtPp(board.spyView.bars[board.spyView.bars.length - 1]!.running, 1)}.{board.spyView.excluded > 0 ? ` ${board.spyView.excluded} weeks left out because SPY did not cover the same sessions.` : ''}</p>
            </>
          ) : (
            <StateNote>{symbol === 'SPY' ? 'This is SPY, so there is nothing to compare.' : (board.spyView.reason ?? 'SPY comparison is unavailable for these weeks.')}</StateNote>
          )}
        </Card>
      </div>

      <Card title="All weeks">
        <Disclosure summary={`Full table, ${plural(board.table.length, 'week')}`}>
          <DataTable rows={tableRows} cols={tableCols} sort={sort} onSort={setSort} rowKey={(x) => x.label} onRow={(x) => select(x.label)} selectedKey={selWeek?.label ?? null} caption={`Every week of ${board.year} with all measures`} maxHeight={460} />
          <p className="muted small" style={{ marginTop: 6 }}>* partial or missing data, not counted. Low, high and gap are against the prior week close. Select a row to inspect it above.</p>
        </Disclosure>
      </Card>
    </div>
  );
}
