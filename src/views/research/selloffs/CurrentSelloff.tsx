/** Drawdown research: the active or latest episode, what followed earlier selloffs at this depth, and episode history. */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useResearch } from '../../../app/research';
import { researchPath } from '../../../app/routes';
import { isNa, type Bar } from '../../../engine/core/types';
import {
  currentDrawdown, currentSelloffStudy, drawdownSeries, DRAWDOWN_DEFAULTS, episodeAges, episodeDurationSummary, episodeIncidenceByThreshold,
  episodeYearIncidence, findDrawdownEpisodes, type DrawdownEpisode, type DurationStats, type SelloffAnalog,
} from '../../../engine/drawdowns';
import { BarChart, LineChart, type LineSeries } from '../../../ui/charts';
import { Card, Chip, DataTable, Disclosure, Pct, Segmented, Stat, StateNote, sortRows, type Column, type SortState } from '../../../ui/components';
import { fmtDate, fmtInt, fmtNum, fmtPct, fmtPrice, reasonDetail } from '../../../ui/format';
import { DistCell, FreqCell, numParam, useNarrow, useUrlState } from './shared';

const PRESETS = [5, 10, 15, 20, 30];

const dur = (d: DurationStats | { unavailable: true }): string => ('unavailable' in d ? 'n/a' : `${fmtInt(d.median)} sessions`);
const durSub = (d: DurationStats | { unavailable: true }): string => ('unavailable' in d ? 'No completed episode' : `middle half ${fmtInt(d.p25)} to ${fmtInt(d.p75)}, longest ${fmtInt(d.max)}, n ${d.n}`);

export function CurrentSelloff() {
  const r = useResearch();
  const [sp, set] = useUrlState();
  const thr = numParam(sp, 'thr', 10, 1, 95);
  const [sort, setSort] = useState<SortState | null>({ key: 'depth', dir: 'asc' });
  const [aSort, setASort] = useState<SortState | null>({ key: 'anchor', dir: 'desc' });
  const [picked, setPicked] = useState<string | null>(null);
  const narrow = useNarrow();

  // The study window starts at the running peak in force on the window start date, so peaks inside
  // the window equal the full-history peaks and an episode already under way is kept and tagged.
  const bars = useMemo<Bar[]>(() => {
    const ws = r.windowStart;
    if (!ws) return r.bars;
    const idx = r.bars.findIndex((b) => b.date >= ws);
    if (idx <= 0) return r.bars;
    return r.bars.slice(drawdownSeries(r.bars)[idx]!.peakIndex);
  }, [r.bars, r.windowStart]);
  const windowStart = r.windowStart && bars[0] && bars[0].date < r.windowStart ? r.windowStart : undefined;

  const cur = useMemo(() => currentDrawdown(bars), [bars]);
  const episodes = useMemo(() => findDrawdownEpisodes(bars, thr / 100, { windowStart }), [bars, thr, windowStart]);
  const latest = episodes[episodes.length - 1];
  const ages = useMemo(() => (latest ? episodeAges(bars, latest) : null), [bars, latest]);
  const study = useMemo(() => currentSelloffStudy(bars), [bars]);
  const incidence = useMemo(() => episodeYearIncidence(bars, thr / 100), [bars, thr]);
  const byThreshold = useMemo(() => episodeIncidenceByThreshold(bars), [bars]);
  const durations = useMemo(() => episodeDurationSummary(episodes), [episodes]);

  const first = bars[0]!;
  const last = bars[bars.length - 1]!;
  const historyNote = `History used ${fmtDate(first.date)} to ${fmtDate(last.date)}${windowStart ? `, including the peak in force when the ${r.history.toUpperCase()} window opened` : ''}.`;

  const epCols: Column<DrawdownEpisode>[] = [
    { key: 'peak', header: 'Peak', sticky: true, sort: (e) => e.peakDate, cell: (e) => <Link to={researchPath(r.symbol, 'selloffs', { asof: e.peakDate })} title="Open the view as of this date">{fmtDate(e.peakDate)}</Link> },
    { key: 'depth', header: 'Deepest close', info: 'Trough close divided by the peak close, minus 1. For an active episode, the deepest so far.', sort: (e) => e.depth, cell: (e) => <Pct v={e.depth} digits={1} /> },
    { key: 'breach', header: `First ${fmtNum(thr, thr % 1 ? 1 : 0)}% breach`, sort: (e) => e.breachDate, cell: (e) => fmtDate(e.breachDate) },
    { key: 'trough', header: 'Trough', sort: (e) => e.troughDate, cell: (e) => fmtDate(e.troughDate) },
    { key: 'toTrough', header: 'Sessions peak to trough', sort: (e) => e.sessionsPeakToTrough, cell: (e) => fmtInt(e.sessionsPeakToTrough) },
    { key: 'rec', header: 'Recovery', info: 'First close at or above the peak close.', sort: (e) => e.recoveryDate, cell: (e) => (e.recoveryDate ? fmtDate(e.recoveryDate) : <span className="muted">Not yet</span>) },
    { key: 'toRec', header: 'Sessions peak to recovery', sort: (e) => e.sessionsPeakToRecovery, cell: (e) => (e.sessionsPeakToRecovery === null ? <span className="muted">{fmtInt(e.sessionsObserved)} so far</span> : fmtInt(e.sessionsPeakToRecovery)) },
    {
      key: 'tags',
      header: 'Notes',
      align: 'l',
      cell: (e) => (
        <span className="so-tags">
          {e.active && <Chip tone="gold">Active</Chip>}
          {e.startedBeforeWindow && <Chip title="The peak is earlier than the history window">Began before window</Chip>}
          {e.crossesYear && <Chip>Crosses year end</Chip>}
          {e.peakAtHistoryStart && !windowStart && <Chip tone="warn" title="The peak is the first close of the history, so the true peak may be earlier and higher">Peak at history start</Chip>}
        </span>
      ),
    },
  ];

  const pathSeries = useMemo<LineSeries[]>(() => {
    if (isNa(study)) return [];
    const clip = (p: { offset: number; value: number }[]) => p.filter((x) => x.offset >= -60 && x.offset <= 120).map((x) => ({ x: x.offset, y: x.value - 1 }));
    const out: LineSeries[] = study.analogs.filter((a) => a.anchorDate !== picked).map((a) => ({ id: a.anchorDate, label: fmtDate(a.anchorDate), points: clip(a.path), context: true }));
    const sel = study.analogs.find((a) => a.anchorDate === picked);
    out.push({ id: 'active', label: `Current, peak ${fmtDate(study.active.peakDate)}`, points: clip(study.activePath), color: 'var(--accent)', width: 2.4 });
    if (sel) out.push({ id: 'sel', label: `Selloff matched ${fmtDate(sel.anchorDate)}`, points: clip(sel.path), color: 'var(--gold-line)', width: 2 });
    return out;
  }, [study, picked]);

  const analogCols: Column<SelloffAnalog>[] = [
    { key: 'anchor', header: 'Matched on', sticky: true, info: 'First close of that selloff at least as deep as the current drawdown. The link opens the page as of that date.', sort: (a) => a.anchorDate, cell: (a) => <Link to={researchPath(r.symbol, 'selloffs', { asof: a.anchorDate })} onClick={(e) => e.stopPropagation()}>{fmtDate(a.anchorDate)}</Link> },
    { key: 'peak', header: 'Peak', sort: (a) => a.episode.peakDate, cell: (a) => fmtDate(a.episode.peakDate) },
    { key: 'at', header: 'Drawdown at match', sort: (a) => a.drawdownAtAnchor, cell: (a) => <Pct v={a.drawdownAtAnchor} digits={1} /> },
    { key: 'more', header: 'Further fall to trough', info: 'Trough close against the matched close. Known only after the selloff finished.', sort: (a) => a.additionalDecline, cell: (a) => <Pct v={a.additionalDecline} digits={1} /> },
    { key: 'final', header: 'Deepest close', sort: (a) => a.episode.depth, cell: (a) => <Pct v={a.episode.depth} digits={1} /> },
    { key: 'toTrough', header: 'Sessions to trough', sort: (a) => a.sessionsAnchorToTrough, cell: (a) => fmtInt(a.sessionsAnchorToTrough) },
    { key: 'toRec', header: 'Sessions to recovery', sort: (a) => a.sessionsAnchorToRecovery, cell: (a) => (a.sessionsAnchorToRecovery === null ? <span className="muted">Not recovered</span> : fmtInt(a.sessionsAnchorToRecovery)) },
  ];

  return (
    <div className="stack">
      <Card
        title={latest?.active ? 'Active selloff' : latest ? 'Most recent selloff' : 'Selloffs'}
        info="An episode starts at the prior running closing peak, is breached on the first close beyond the threshold, troughs at its deepest close and recovers on the first close back at the peak. Closes only."
        sub={historyNote}
        actions={
          <div className="row">
            <Segmented label="Episode threshold" value={PRESETS.includes(thr) ? thr : -1} options={PRESETS.map((p) => ({ value: p, label: `${p}%` }))} onChange={(v) => set({ thr: v === 10 ? null : String(v) })} />
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              Custom %
              <input className="input so-num" type="number" min={1} max={95} step={0.5} value={thr} aria-label="Custom episode threshold in percent" onChange={(e) => { const v = Number(e.target.value); if (v >= 1 && v <= 95) set({ thr: v === 10 ? null : String(v) }); }} />
            </label>
          </div>
        }
      >
        <div className="stats">
          <Stat
            label="Drawdown now"
            info="Latest close against the running closing peak of the history used. Not a verified all time high."
            value={isNa(cur) ? 'n/a' : cur.drawdown === 0 ? 'At closing high' : <Pct v={cur.drawdown} digits={1} />}
            sub={isNa(cur) || cur.drawdown === 0 ? undefined : `needs ${fmtPct(cur.requiredGain, 1)} to regain ${fmtPrice(cur.peakClose)}`}
          />
          {latest && ages && !isNa(ages) ? (
            <>
              <Stat label="Peak" value={fmtDate(latest.peakDate)} sub={`${fmtPrice(latest.peakClose)}, ${fmtInt(ages.sessionsSincePeak)} sessions ago`} />
              <Stat label={`First close ${fmtNum(thr, thr % 1 ? 1 : 0)}% down`} value={fmtDate(latest.breachDate)} sub={`${fmtPct(latest.breachDrawdown, 1)}, ${fmtInt(ages.sessionsSinceBreach)} sessions ago`} />
              <Stat label={latest.active ? 'Deepest close so far' : 'Trough'} value={<Pct v={latest.depth} digits={1} />} sub={`${fmtDate(latest.troughDate)}, ${fmtInt(ages.sessionsSinceTrough)} sessions ago`} />
              <Stat
                label="Recovery"
                value={latest.active ? 'Not yet' : fmtDate(latest.recoveryDate)}
                sub={latest.active ? 'Active, counted as unfinished' : `${fmtInt(latest.sessionsPeakToRecovery)} sessions after the peak, ${fmtInt(ages.sessionsSinceRecovery)} ago`}
              />
            </>
          ) : (
            <Stat label="Episodes" value="None" sub={`No close fell ${fmtNum(thr, 1)}% from a closing peak in this history`} />
          )}
        </div>
        {latest && !latest.active && !isNa(cur) && cur.drawdown < 0 && (
          <p className="muted small" style={{ marginTop: 10 }}>
            The current drawdown of {fmtPct(cur.drawdown, 1)} has not reached the {fmtNum(thr, 1)}% threshold, so the figures above describe the last episode that did.
          </p>
        )}
      </Card>

      <Card
        title="What followed earlier selloffs at this depth"
        info={isNa(study) ? undefined : study.definition}
        sub={isNa(study) ? undefined : `Current drawdown ${fmtPct(study.current.drawdown, 1)}, first reached ${fmtDate(study.activeAnchorDate)}, ${fmtInt(study.sessionsSinceActiveAnchor)} sessions ago. ${study.analogs.length} earlier selloff${study.analogs.length === 1 ? '' : 's'} reached it. Same stock only.`}
      >
        {isNa(study) ? (
          <StateNote>{reasonDetail(study)}. There is no active selloff to match.</StateNote>
        ) : study.analogs.length === 0 ? (
          <StateNote>No earlier selloff in this history reached {fmtPct(study.current.drawdown, 1)}. Nothing to compare with.</StateNote>
        ) : (
          <div className="stack" style={{ gap: 12 }}>
            {study.horizons.every((h) => h.summary.n < study.minMaturedCases) && (
              <StateNote tone="warn" title="Sample too small for frequencies.">
                Fewer than {study.minMaturedCases} matured, non overlapping cases at every horizon. Counts and the cases themselves are shown. Rates are withheld.
              </StateNote>
            )}
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Outcomes after earlier selloffs reached the current depth">
              <table className="data">
                <caption className="sr-only">Outcomes by horizon after the matched close</caption>
                <thead>
                  <tr>
                    <th className="l sticky" scope="col">Sessions after match</th>
                    <th scope="col">Cases</th>
                    <th scope="col">Up, flat, down</th>
                    <th scope="col">Higher close at the end</th>
                    <th scope="col">Median return</th>
                    <th scope="col">10th to 90th percentile</th>
                    <th scope="col">Closed {fmtPct(study.furtherDeclineLevel, 0, false)} lower at some point</th>
                    <th scope="col">Traded {fmtPct(study.furtherDeclineLevel, 0, false)} lower at some point</th>
                    <th scope="col">Typical worst close</th>
                  </tr>
                </thead>
                <tbody>
                  {study.horizons.map((h) => (
                    <tr key={h.horizon}>
                      <td className="l sticky">{h.horizon}</td>
                      <td title={`${h.candidates} selloffs reached this depth. ${h.overlapExcluded} dropped for overlapping windows. ${h.notMatured} not matured.`}>
                        {h.summary.n}
                        <span className="faint small" style={{ display: 'block' }}>
                          of {h.candidates}{h.overlapExcluded ? `, ${h.overlapExcluded} overlap` : ''}{h.notMatured ? `, ${h.notMatured} open` : ''}
                        </span>
                      </td>
                      <td className="num">{h.summary.up}, {h.summary.flat}, {h.summary.down}</td>
                      <td><FreqCell hits={h.higherClose.hits} n={h.higherClose.n} p={h.higherClose.value} /></td>
                      <td><DistCell d={h.summary.returns} /></td>
                      <td className="num">{h.summary.returns && h.summary.n >= 5 ? `${fmtPct(h.summary.returns.p10, 1)} to ${fmtPct(h.summary.returns.p90, 1)}` : <span className="faint">n/a</span>}</td>
                      <td><FreqCell hits={h.furtherDeclineClose.hits} n={h.furtherDeclineClose.n} p={h.furtherDeclineClose.value} /></td>
                      <td><FreqCell hits={h.furtherDeclineIntraday.hits} n={h.furtherDeclineIntraday.n} p={h.furtherDeclineIntraday.value} /></td>
                      <td><DistCell d={h.additionalAdverse} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="faint small">
              Returns are close to close from the matched close. Rates need {study.minMaturedCases} matured cases spaced at least the horizon plus {DRAWDOWN_DEFAULTS.overlapGapExtra} session apart. Intervals are 95% and widened for cases that cluster in the same years.
            </p>
            <LineChart
              series={pathSeries}
              xLabel={(x) => (x === 0 ? 'Match' : `${x > 0 ? '+' : '\u2212'}${Math.abs(x)}${narrow ? '' : ' sessions'}`)}
              xTicks={narrow ? [-60, 0, 60, 120] : [-60, -30, 0, 30, 60, 90, 120]}
              yFormat={(y) => fmtPct(y, 0, false)}
              hLines={[{ y: study.current.drawdown, label: `Current ${fmtPct(study.current.drawdown, 1)}` }]}
              vLines={[{ x: 0, label: 'Depth reached' }]}
              zeroLine
              height={280}
              ariaLabel={`Close against the peak close for the current selloff and ${study.analogs.length} earlier selloffs, aligned on the session each first reached ${fmtPct(study.current.drawdown, 1)}`}
            />
            <p className="faint small">Each line is close divided by that selloff's peak close, minus 1. Grey lines are earlier selloffs and show what happened after the match. They are history, not a forecast. Select a row to highlight its path.</p>
            <DataTable
              rows={sortRows(study.analogs, analogCols, aSort)}
              cols={analogCols}
              sort={aSort}
              onSort={setASort}
              rowKey={(a) => a.anchorDate}
              onRow={(a) => setPicked((p) => (p === a.anchorDate ? null : a.anchorDate))}
              selectedKey={picked}
              caption="Earlier selloffs that reached the current depth"
              maxHeight={340}
            />
          </div>
        )}
      </Card>

      <div className="so-two">
        <Card title={`Selloffs of ${fmtNum(thr, thr % 1 ? 1 : 0)}% or more per year`} info="Counted in the year of the first close beyond the threshold. The typical count uses completed calendar years only." sub={isNa(incidence.typical) ? reasonDetail(incidence.typical) : `Typical year: median ${fmtNum(incidence.typical.median, 1)}, average ${fmtNum(incidence.typical.mean, 1)}, over ${incidence.typical.years} completed years.`}>
          {incidence.current && (
            <div className="stats" style={{ marginBottom: 10 }}>
              <Stat label={`${incidence.current.year} so far`} value={incidence.current.count} sub={`through ${fmtDate(incidence.current.asOf)}, year not complete`} />
              <Stat label="Against the median year" value={isNa(incidence.current.versusMedian) ? 'n/a' : fmtNum(incidence.current.versusMedian, 1, true)} sub="an unfinished year can still add episodes" />
            </div>
          )}
          <BarChart
            bars={incidence.rows.map((y) => ({ key: String(y.year), label: `${y.year}${y.complete ? '' : '*'}`, value: y.count, color: y.complete ? 'var(--accent)' : 'var(--border-strong)', detail: y.complete ? undefined : y.partialReason === 'current-year' ? 'Year not complete' : 'History starts inside this year' }))}
            yFormat={(y) => (Number.isInteger(y) ? String(y) : '')}
            height={170}
            ariaLabel={`Count of ${thr}% selloffs by year`}
          />
          <p className="faint small">* Partial year, left out of the typical count.</p>
          <Disclosure summary="Other thresholds">
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th className="l" scope="col">Threshold</th>
                    <th scope="col">This year</th>
                    <th scope="col">Median year</th>
                    <th scope="col">Completed years</th>
                  </tr>
                </thead>
                <tbody>
                  {byThreshold.map((t) => (
                    <tr key={t.threshold}>
                      <td className="l">{fmtPct(t.threshold, 0, false)}</td>
                      <td>{t.current ? t.current.count : 'n/a'}</td>
                      <td>{isNa(t.typical) ? 'n/a' : fmtNum(t.typical.median, 1)}</td>
                      <td>{isNa(t.typical) ? 0 : t.typical.years}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Disclosure>
        </Card>
        <Card title="How long they lasted" info="Sessions between the dated points of completed episodes. The survival median also uses the unfinished episode, counted as still running." sub={durations.note}>
          <div className="stats">
            <Stat label="Peak to trough, median" value={dur(durations.toTrough)} sub={durSub(durations.toTrough)} />
            <Stat label="Peak to recovery, median" value={dur(durations.toRecovery)} sub={durSub(durations.toRecovery)} />
            <Stat label="Trough to recovery, median" value={dur(durations.troughToRecovery)} sub={durSub(durations.troughToRecovery)} />
            <Stat
              label="Peak to recovery, survival median"
              info="Kaplan Meier estimate. An unfinished episode counts as at risk for as long as it has been observed."
              value={isNa(durations.recoverySurvivalMedian) ? 'Not identified' : `${fmtInt(durations.recoverySurvivalMedian)} sessions`}
              sub={isNa(durations.recoverySurvivalMedian) ? reasonDetail(durations.recoverySurvivalMedian) : `${durations.completed} completed, ${durations.active} unfinished`}
            />
          </div>
        </Card>
      </div>

      <Card title={`Every selloff of ${fmtNum(thr, thr % 1 ? 1 : 0)}% or more`} sub={`${episodes.length} episode${episodes.length === 1 ? '' : 's'}. Select a column to sort. A peak date opens the page as of that date.`}>
        <DataTable rows={sortRows(episodes, epCols, sort)} cols={epCols} sort={sort} onSort={setSort} rowKey={(e) => e.peakDate} caption="Drawdown episodes" empty={`No close fell ${fmtNum(thr, 1)}% from a closing peak in this history.`} maxHeight={420} />
      </Card>
    </div>
  );
}
