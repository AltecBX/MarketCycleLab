/** Big declines: how rare a drop of this size is, and what followed same-stock sessions at least as severe. */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useResearch } from '../../../app/research';
import { researchPath } from '../../../app/routes';
import { useAsync, useBars } from '../../../data/client';
import { runEngine } from '../../../data/engine';
import type { AnalogCase, AnalogResult, FeatureMatrix } from '../../../engine/analogs';
import { isNa, type Bar, type EarningsEvent, type Maybe } from '../../../engine/core/types';
import {
  DECLINE_BASES, DECLINE_BASIS_LABELS, DECLINE_DEFAULTS, declineHorizonTable, drawdownPositions, EXHAUSTION_PATTERNS, exposureScenarios, findDeclines,
  followThrough, lastingBottomStats, moveRarity, recoveryStats, recoveryTargetLabel, sessionMeasures, type DeclineBasis, type DeclineEvent,
  type DeclineHorizonStats, type EarningsCohort, type PatternStudy, type RecoveryTarget,
} from '../../../engine/declines';
import { BarChart, LineChart, type LineSeries } from '../../../ui/charts';
import { Card, Chip, DataTable, Disclosure, Info, Pct, Segmented, Sheet, Skeleton, Stat, StateNote, sortRows, type Column, type SortState } from '../../../ui/components';
import { fmtDate, fmtDollars, fmtInt, fmtMultiple, fmtNum, fmtPct, fmtPrice, reasonDetail } from '../../../ui/format';
import { DistCell, FreqCell, numParam, useUrlState } from './shared';

const BASIS_HELP: Record<DeclineBasis, string> = {
  'close-vs-prev-close': 'The ordinary daily change. Includes any gap.',
  'close-vs-open': 'The drop during the session only. A gap down is not part of it.',
  'close-vs-high': 'Close against the session high. The order of high and low inside the day is not known.',
  'low-vs-prev-close': 'The deepest trade of the day against the previous close, whatever the close did.',
};
const TARGETS: { id: string; t: RecoveryTarget }[] = [
  { id: 'prev', t: { kind: 'previous-close' } },
  { id: 'open', t: { kind: 'event-open' } },
  { id: 'high', t: { kind: 'event-high' } },
];
const PATTERN_HORIZONS = [5, 10, 20];
const ANALOG_HORIZONS = [5, 10, 20, 60];
const COHORTS: { value: 'all' | EarningsCohort; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'ordinary', label: 'Ordinary' },
  { value: 'earnings', label: 'Earnings' },
  { value: 'unknown', label: 'Unknown' },
];

const mb = (v: Maybe<boolean>, yes: string, no: string): string => (isNa(v) ? 'n/a' : v ? yes : no);

export function BigDeclines() {
  const r = useResearch();
  const { bars, symbol } = r;
  const [sp, set] = useUrlState();
  const asof = r.frozen && r.asOf ? r.asOf : undefined;
  const thr = numParam(sp, 'dthr', 5, 0.5, 95);
  const basisRaw = sp.get('basis') as DeclineBasis | null;
  const basis: DeclineBasis = basisRaw && DECLINE_BASES.includes(basisRaw) ? basisRaw : 'close-vs-prev-close';
  const bounce = numParam(sp, 'bounce', 5, 0.5, 100);
  const cohortRaw = sp.get('cohort');
  const cohort = (COHORTS.find((c) => c.value === cohortRaw)?.value ?? 'all') as 'all' | EarningsCohort;
  const ph = numParam(sp, 'ph', 10, 1, 90);
  const ah = numParam(sp, 'ah', 20, 1, 90);
  const recId = TARGETS.find((x) => x.id === sp.get('rt'))?.id ?? 'prev';
  const recH = numParam(sp, 'rh', 60, 1, 250);
  const recMode = sp.get('rm') === 'intraday' ? 'intraday' : 'close';

  // The slider moves locally and commits to the URL after a short pause.
  const [draft, setDraft] = useState(thr);
  useEffect(() => setDraft(thr), [thr]);
  useEffect(() => {
    if (draft === thr) return;
    const t = setTimeout(() => set({ dthr: draft === 5 ? null : String(draft) }), 180);
    return () => clearTimeout(t);
  }, [draft, thr, set]);

  const spy = useBars(symbol === 'SPY' ? null : 'SPY', asof);
  const sector = useBars(r.instrument.sectorEtf && r.instrument.sectorEtf !== symbol ? r.instrument.sectorEtf : null, asof);
  const market = spy.status === 'ready' && !isNa(spy.data) ? spy.data : undefined;
  const sectorBars = sector.status === 'ready' && !isNa(sector.data) ? sector.data : undefined;
  const earnings: EarningsEvent[] | undefined = isNa(r.earningsKnown) ? undefined : r.earningsKnown;
  const from = r.windowStart && bars[0] && r.windowStart > bars[0].date ? r.windowStart : undefined;

  const study = useMemo(() => findDeclines(bars, { threshold: thr / 100, basis, from, market, sector: sectorBars, earnings }), [bars, thr, basis, from, market, sectorBars, earnings]);
  const lastIdx = bars.length - 1;
  const latest = useMemo(() => ({ m: sessionMeasures(bars as Bar[], lastIdx), rarity: moveRarity(bars as Bar[], lastIdx, basis) }), [bars, lastIdx, basis]);

  const anchors = useMemo(() => {
    const byIndex = new Map(study.occurrences.map((o) => [o.index, o]));
    return study.episodes.filter((e) => cohort === 'all' || byIndex.get(e.anchorIndex)?.earnings === cohort).map((e) => e.anchorIndex);
  }, [study, cohort]);
  const bounceLevels = useMemo(() => [...new Set([0.03, 0.05, 0.1, bounce / 100])].sort((a, b) => a - b), [bounce]);
  const table = useMemo(() => declineHorizonTable(bars, anchors, DECLINE_DEFAULTS.spec.horizons, { bounceLevels }), [bars, anchors, bounceLevels]);
  const follow = useMemo(() => followThrough(bars, anchors), [bars, anchors]);
  const recovery = useMemo(() => recoveryStats(bars, anchors, recH, TARGETS.find((x) => x.id === recId)!.t, recMode), [bars, anchors, recH, recId, recMode]);
  const bottoms = useMemo(() => lastingBottomStats(bars, anchors), [bars, anchors]);
  const stageOf = useMemo(() => drawdownPositions(bars), [bars]);

  const keyBase = `${symbol}:${r.asOf}:${r.history}:${thr}:${basis}`;
  const patterns = useAsync<PatternStudy[]>(`declines-patterns:${keyBase}`, async () => {
    const out: PatternStudy[] = [];
    for (const p of EXHAUSTION_PATTERNS) {
      out.push(await runEngine<PatternStudy>('declines', 'studyPattern', [bars, p.id, { threshold: thr / 100, basis, from, horizons: PATTERN_HORIZONS }]));
    }
    return out;
  });

  const queryEvent = study.occurrences[study.occurrences.length - 1] ?? null;
  const analogs = useAsync<Maybe<AnalogResult>>(queryEvent ? `declines-analogs:${keyBase}:${ah}:${queryEvent.index}:${market ? 1 : 0}${sectorBars ? 1 : 0}` : null, async () => {
    const fm = await runEngine<FeatureMatrix>('analogs', 'buildFeatures', [bars, { market, sector: sectorBars, earnings }, symbol]);
    return runEngine<Maybe<AnalogResult>>('analogs', 'findAnalogs', [fm, queryEvent!.index, { horizon: ah }]);
  });

  const [occSort, setOccSort] = useState<SortState | null>({ key: 'date', dir: 'desc' });
  const [occ, setOcc] = useState<DeclineEvent | null>(null);
  const [caseSel, setCaseSel] = useState<AnalogCase | null>(null);
  const [shares, setShares] = useState(100);
  const [trim, setTrim] = useState(50);
  const [add, setAdd] = useState(50);
  const [expH, setExpH] = useState(20);

  const thrLabel = `${fmtNum(thr, thr % 1 ? 1 : 0)}%`;
  const bl = bounce / 100;
  const bstat = (h: DeclineHorizonStats) => h.bounces.find((b) => Math.abs(b.level - bl) < 1e-9);

  const occCols: Column<DeclineEvent>[] = [
    { key: 'date', header: 'Session', sticky: true, sort: (o) => o.date, cell: (o) => fmtDate(o.date) },
    { key: 'm', header: 'Decline', sort: (o) => o.measure, cell: (o) => <Pct v={o.measure} /> },
    { key: 'gap', header: 'Gap at open', sort: (o) => (isNa(o.measures.gap) ? null : o.measures.gap), cell: (o) => <Pct v={o.measures.gap} /> },
    { key: 'cir', header: 'Close in day range', info: 'Close minus low, divided by high minus low. 0% is the low, 100% is the high.', sort: (o) => (isNa(o.measures.closeInRange) ? null : o.measures.closeInRange), cell: (o) => (isNa(o.measures.closeInRange) ? 'n/a' : fmtPct(o.measures.closeInRange, 0, false)) },
    { key: 'rv', header: 'Volume vs 20 sessions', sort: (o) => (isNa(o.relativeVolume) ? null : o.relativeVolume), cell: (o) => (isNa(o.relativeVolume) ? <span className="faint">n/a</span> : fmtMultiple(o.relativeVolume)) },
    { key: 'rsi', header: 'RSI14', sort: (o) => (isNa(o.rsi14) ? null : o.rsi14), cell: (o) => (isNa(o.rsi14) ? <span className="faint">n/a</span> : fmtNum(o.rsi14, 0)) },
    { key: 'ma', header: '200 day', align: 'l', cell: (o) => mb(o.stock.aboveSma200, 'Above', 'Below') },
    { key: 'mk', header: 'SPY that day', sort: (o) => (isNa(o.market) || isNa(o.market.dayReturn) ? null : o.market.dayReturn), cell: (o) => (isNa(o.market) ? <span className="faint">n/a</span> : <Pct v={o.market.dayReturn} />) },
    { key: 'e', header: 'Cohort', align: 'l', cell: (o) => (o.earnings === 'earnings' ? <Chip tone="gold">Earnings</Chip> : o.earnings === 'ordinary' ? 'Ordinary' : <span className="faint">Unknown</span>) },
  ];

  const expo = useMemo(() => {
    const row = table.find((h) => h.horizon === expH);
    const last = bars[lastIdx];
    if (!row || !last) return null;
    return exposureScenarios(row.outcomes, { shares, price: last.close, trimFraction: trim / 100, addShares: add });
  }, [table, expH, shares, trim, add, bars, lastIdx]);

  const analogSeries = useMemo<LineSeries[]>(() => {
    if (analogs.status !== 'ready' || isNa(analogs.data)) return [];
    const a = analogs.data;
    const out: LineSeries[] = a.cases.filter((c) => c !== caseSel).map((c) => ({ id: `${c.symbol}-${c.date}`, label: fmtDate(c.date), points: c.path.map((p) => ({ x: p.offset, y: p.rel })), context: true }));
    out.push({ id: 'median', label: `Median of ${a.cases.length} cases`, color: 'var(--accent)', width: 2.4, points: a.medianPath.map((p) => ({ x: p.offset, y: p.median })) });
    return out;
  }, [analogs, caseSel]);

  return (
    <div className="stack">
      <Card
        title="How rare is a decline this large"
        info="Every session of this stock at least as severe as the threshold, on the chosen basis. Repeated days close together are grouped into one episode for the outcome studies."
        sub={study.from ? `${fmtDate(study.from)} to ${fmtDate(study.to)}, ${fmtInt(study.eligibleSessions)} sessions. Same stock only.` : 'No eligible sessions.'}
      >
        <div className="row" style={{ alignItems: 'flex-end', marginBottom: 12 }}>
          <label className="field">
            Decline of at least {fmtNum(draft, draft % 1 ? 1 : 0)}%
            <input className="so-range" type="range" min={1} max={40} step={0.5} value={Math.min(40, draft)} onChange={(e) => setDraft(Number(e.target.value))} aria-label="Decline threshold in percent" />
          </label>
          <label className="field">
            Exact %
            <input className="input so-num" type="number" min={0.5} max={95} step={0.5} value={draft} onChange={(e) => { const v = Number(e.target.value); if (v >= 0.5 && v <= 95) setDraft(v); }} aria-label="Exact decline threshold in percent" />
          </label>
          <label className="field">
            <span>Measured as <Info text={BASIS_HELP[basis]} label="About this basis" /></span>
            <select className="select" value={basis} onChange={(e) => set({ basis: e.target.value === 'close-vs-prev-close' ? null : e.target.value })}>
              {DECLINE_BASES.map((b) => (
                <option key={b} value={b}>{DECLINE_BASIS_LABELS[b]}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="stats">
          <Stat label={`Sessions down ${thrLabel} or more`} value={fmtInt(study.occurrences.length)} sub={study.eligibleSessions ? `${fmtPct(study.occurrences.length / study.eligibleSessions, 2, false)} of ${fmtInt(study.eligibleSessions)} sessions` : undefined} />
          <Stat label="Episodes" info={`A qualifying day within ${DECLINE_DEFAULTS.proposed.episodeGapSessions} sessions of the previous one joins the same episode. Outcome studies use one anchor per episode.`} value={fmtInt(study.episodes.length)} sub={queryEvent ? `latest ${fmtDate(queryEvent.date)}` : 'none in this history'} />
          <Stat
            label="Latest session, this basis"
            value={isNa(latest.rarity) ? 'n/a' : <Pct v={latest.rarity.measure} />}
            sub={isNa(latest.rarity) ? reasonDetail(latest.rarity) : `${fmtDate(latest.rarity.date)}. ${fmtInt(latest.rarity.atLeastAsSevere.hits)} of ${fmtInt(latest.rarity.priorEligible)} earlier sessions were at least as weak`}
          />
          <Stat
            label="Cohorts"
            info="Earnings means the first session that could react to a report. Sessions before the first known report date are unknown, not ordinary."
            value={study.earningsCoverage ? `${study.earningsCohorts.ordinary} ordinary` : 'Unknown'}
            sub={study.earningsCoverage ? `${study.earningsCohorts.earnings} earnings, ${study.earningsCohorts.unknown} unknown` : 'No earnings dates available, so no session is labeled'}
          />
        </div>
        {study.perYear.length > 1 && (
          <>
            <div className="muted small" style={{ margin: '12px 0 2px', fontWeight: 600 }}>Qualifying sessions per year</div>
            <BarChart bars={study.perYear.map((y) => ({ key: String(y.year), label: String(y.year), value: y.occurrences, color: 'var(--down)', detail: `${y.episodes} episode${y.episodes === 1 ? '' : 's'}` }))} yFormat={(y) => (Number.isInteger(y) ? String(y) : '')} height={120} ariaLabel={`Sessions down ${thrLabel} or more by year`} />
          </>
        )}
        <Disclosure summary={`All ${fmtInt(study.occurrences.length)} qualifying sessions`}>
          <DataTable rows={sortRows(study.occurrences, occCols, occSort)} cols={occCols} sort={occSort} onSort={setOccSort} rowKey={(o) => o.date} onRow={setOcc} caption="Qualifying sessions" empty={`No session fell ${thrLabel} on this basis.`} maxHeight={380} />
          <p className="faint small">Select a row for the full session detail.</p>
        </Disclosure>
      </Card>

      {anchors.length === 0 && cohort === 'all' ? (
        <StateNote>No session in this history fell {thrLabel} or more on this basis. Lower the threshold to study what followed.</StateNote>
      ) : (
        <>
          <Card
            title="What followed"
            info="Outcomes count completed sessions after the event close. One anchor per episode, thinned so windows do not overlap (horizon plus one session). An endpoint return is not the same as ever reaching a level."
            sub={`${anchors.length} episode anchor${anchors.length === 1 ? '' : 's'}${cohort === 'all' ? '' : `, ${cohort} cohort`}. Rates need ${DECLINE_DEFAULTS.proposed.minCases} matured cases.`}
            actions={
              <div className="row">
                <Segmented label="Cohort" value={cohort} options={COHORTS} onChange={(v) => set({ cohort: v === 'all' ? null : v })} />
                <Segmented label="Bounce level" value={[3, 5, 10].includes(bounce) ? bounce : -1} options={[3, 5, 10].map((b) => ({ value: b, label: `+${b}%` }))} onChange={(v) => set({ bounce: v === 5 ? null : String(v) })} />
                <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  Bounce %
                  <input className="input so-num" type="number" min={0.5} max={100} step={0.5} value={bounce} aria-label="Custom bounce level in percent" onChange={(e) => { const v = Number(e.target.value); if (v >= 0.5 && v <= 100) set({ bounce: v === 5 ? null : String(v) }); }} />
                </label>
              </div>
            }
          >
            {anchors.length === 0 ? (
              <StateNote>No episode in the {cohort} cohort.</StateNote>
            ) : (
              <>
                <div className="table-wrap" tabIndex={0} role="region" aria-label="Outcomes by horizon after a qualifying decline">
                  <table className="data">
                    <caption className="sr-only">Outcomes by horizon</caption>
                    <thead>
                      <tr>
                        <th className="l sticky" scope="col">Sessions after</th>
                        <th scope="col">Cases</th>
                        <th scope="col">Up, flat, down</th>
                        <th scope="col">Higher close at the end</th>
                        <th scope="col">Median return</th>
                        <th scope="col">10th to 90th percentile</th>
                        <th scope="col">Median worst close</th>
                        <th scope="col">Event low held, intraday</th>
                        <th scope="col">Traded +{fmtNum(bounce, bounce % 1 ? 1 : 0)}% at some point</th>
                        <th scope="col">Closed +{fmtNum(bounce, bounce % 1 ? 1 : 0)}% at some point</th>
                        <th scope="col">Ended +{fmtNum(bounce, bounce % 1 ? 1 : 0)}% or more</th>
                      </tr>
                    </thead>
                    <tbody>
                      {table.map((h) => {
                        const b = bstat(h);
                        return (
                          <tr key={h.horizon}>
                            <td className="l sticky">{h.horizon}</td>
                            <td title={`${h.anchorsConsidered} anchors. ${h.excludedOverlap} dropped for overlap. ${h.notMatured} not matured.`}>
                              {h.n}
                              <span className="faint small" style={{ display: 'block' }}>
                                of {h.anchorsConsidered}{h.excludedOverlap ? `, ${h.excludedOverlap} overlap` : ''}{h.notMatured ? `, ${h.notMatured} open` : ''}
                              </span>
                            </td>
                            <td className="num">{h.up}, {h.flat}, {h.down}</td>
                            <td><FreqCell hits={h.positive.hits} n={h.positive.n} p={h.positive.proportion} /></td>
                            <td><DistCell d={h.returns} /></td>
                            <td className="num">{!isNa(h.returns) && h.n >= 5 ? `${fmtPct(h.returns.p10, 1)} to ${fmtPct(h.returns.p90, 1)}` : <span className="faint">n/a</span>}</td>
                            <td><DistCell d={h.worstClose} /></td>
                            <td><FreqCell hits={h.eventLowHeld.hits} n={h.eventLowHeld.n} p={h.eventLowHeld.proportion} /></td>
                            <td>{b ? <FreqCell hits={b.touch.hits} n={b.touch.n} p={b.touch.proportion} /> : 'n/a'}</td>
                            <td>{b ? <FreqCell hits={b.close.hits} n={b.close.n} p={b.close.proportion} /> : 'n/a'}</td>
                            <td>{b ? <FreqCell hits={b.endpoint.hits} n={b.endpoint.n} p={b.endpoint.proportion} /> : 'n/a'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <Disclosure summary="Hypothetical share exposure across these cases">
                  <div className="row" style={{ alignItems: 'flex-end', marginBottom: 8 }}>
                    <label className="field">Shares held<input className="input so-num" type="number" min={0} value={shares} onChange={(e) => setShares(Math.max(0, Number(e.target.value)))} /></label>
                    <label className="field">Trim %<input className="input so-num" type="number" min={0} max={100} value={trim} onChange={(e) => setTrim(Math.min(100, Math.max(0, Number(e.target.value))))} /></label>
                    <label className="field">Shares added<input className="input so-num" type="number" min={0} value={add} onChange={(e) => setAdd(Math.max(0, Number(e.target.value)))} /></label>
                    <Segmented label="Horizon" value={expH} options={[5, 10, 20, 60].map((h) => ({ value: h, label: `${h} sessions` }))} onChange={setExpH} />
                  </div>
                  {expo === null || isNa(expo) ? (
                    <StateNote>{expo && isNa(expo) ? reasonDetail(expo) : 'No matured cases at this horizon.'}</StateNote>
                  ) : (
                    <>
                      <div className="table-wrap">
                        <table className="data">
                          <thead>
                            <tr>
                              <th className="l" scope="col">Scenario</th>
                              <th scope="col">Shares exposed</th>
                              <th scope="col">Median change at the end</th>
                              <th scope="col">10th to 90th percentile</th>
                              <th scope="col">Median change at the worst close</th>
                            </tr>
                          </thead>
                          <tbody>
                            {expo.scenarios.map((s) => (
                              <tr key={s.id}>
                                <td className="l">{s.label}</td>
                                <td>{fmtInt(s.shares)}</td>
                                <td>{isNa(s.endpoint) ? 'n/a' : fmtDollars(s.endpoint.median, true)}</td>
                                <td>{isNa(s.endpoint) ? 'n/a' : `${fmtDollars(s.endpoint.p10, true)} to ${fmtDollars(s.endpoint.p90, true)}`}</td>
                                <td>{isNa(s.worstClose) ? 'n/a' : fmtDollars(s.worstClose.median, true)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="faint small">Hypothetical. {expo.n} historical cases applied to the share counts above at the latest close of {fmtPrice(bars[lastIdx]!.close)}. {expo.assumptions.join(' ')}</p>
                    </>
                  )}
                </Disclosure>
              </>
            )}
          </Card>

          <div className="so-two">
            <Card title="The next few sessions" info="Counted from the event close across episode anchors. Each line has its own denominator: an anchor needs enough later sessions to be judged.">
              <div className="stats">
                <Stat label="Next close higher" value={<FreqCell hits={follow.immediateBounce.hits} n={follow.immediateBounce.n} p={follow.immediateBounce.proportion} />} />
                <Stat label="One more lower close" value={<FreqCell hits={follow.one.hits} n={follow.one.n} p={follow.one.proportion} />} />
                <Stat label="Two more in a row" value={<FreqCell hits={follow.two.hits} n={follow.two.n} p={follow.two.proportion} />} />
                <Stat label="Three more in a row" value={<FreqCell hits={follow.three.hits} n={follow.three.n} p={follow.three.proportion} />} />
              </div>
              <hr className="sep" />
              <h3 style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                Did the low last <Info text={`The event low holds for ${bottoms.horizon} sessions and price ${bottoms.reboundMode === 'close' ? 'closes' : 'trades'} ${fmtPct(bottoms.rebound, 0, false)} above the event close inside that window. A case is final only once the window has completed. When the low breaks and the rebound happens in the same daily bar the order is not known and the case is left out.`} />
              </h3>
              <div className="stats" style={{ marginTop: 6 }}>
                <Stat label={`Held and rebounded, ${bottoms.horizon} sessions`} value={<FreqCell hits={bottoms.held.hits} n={bottoms.held.n} p={bottoms.held.proportion} />} />
                <Stat label="Low broken" value={bottoms.counts['low-broken']} />
                <Stat label="Held, no rebound" value={bottoms.counts['no-rebound']} />
                <Stat label="Not judged" value={bottoms.counts['not-matured'] + bottoms.counts.indeterminate} sub={`${bottoms.counts['not-matured']} not matured, ${bottoms.counts.indeterminate} order unknown`} />
              </div>
            </Card>
            <Card
              title="Time to get back"
              info="First return to the chosen level after the event close. Cases where the data ends before the window does are censored: counted, and left out of the rate."
              actions={
                <div className="row">
                  <select className="select" aria-label="Recovery level" value={recId} onChange={(e) => set({ rt: e.target.value === 'prev' ? null : e.target.value })}>
                    {TARGETS.map((t) => (
                      <option key={t.id} value={t.id}>{recoveryTargetLabel(t.t)}</option>
                    ))}
                  </select>
                  <Segmented label="Window" value={recH} options={[20, 60, 90].map((h) => ({ value: h, label: `${h}` }))} onChange={(v) => set({ rh: v === 60 ? null : String(v) })} />
                  <Segmented label="Touch type" value={recMode} options={[{ value: 'close', label: 'Close' }, { value: 'intraday', label: 'Intraday' }]} onChange={(v) => set({ rm: v === 'close' ? null : v })} />
                </div>
              }
            >
              <div className="stats">
                <Stat label={`Back within ${recovery.horizon} sessions`} value={<FreqCell hits={recovery.withinHorizon.hits} n={recovery.withinHorizon.n} p={recovery.withinHorizon.proportion} />} sub={`${recovery.mode === 'close' ? 'a close' : 'a trade'} at or above: ${recovery.targetLabel.toLowerCase()}`} />
                <Stat label="Median sessions, when it got back" value={isNa(recovery.sessions) ? 'n/a' : fmtInt(recovery.sessions.median)} sub={isNa(recovery.sessions) ? undefined : `middle half ${fmtInt(recovery.sessions.p25)} to ${fmtInt(recovery.sessions.p75)}, n ${recovery.sessions.n}`} />
                <Stat label="Survival median" info="Kaplan Meier estimate over all cases, including those that did not return and those cut short by the end of data." value={recovery.kmMedianSessions === null ? 'Not identified' : `${fmtInt(recovery.kmMedianSessions)} sessions`} />
                <Stat label="Left out" value={recovery.censored + recovery.alreadyAtTarget + recovery.noTarget + recovery.excludedOverlap} sub={`${recovery.censored} censored, ${recovery.alreadyAtTarget} already there, ${recovery.noTarget} no level, ${recovery.excludedOverlap} overlap`} />
              </div>
            </Card>
          </div>

          <Card
            title="Selling exhaustion patterns"
            info="Each pattern is a measurable condition. A pattern that needs later sessions becomes usable on its confirm date, and outcomes are measured from that confirm close, never from the earlier selloff day."
            sub={`Threshold ${thrLabel}, ${DECLINE_BASIS_LABELS[basis].toLowerCase()}. Outcomes ${ph} sessions after the confirm close.`}
            actions={<Segmented label="Pattern horizon" value={ph} options={PATTERN_HORIZONS.map((h) => ({ value: h, label: `${h} sessions` }))} onChange={(v) => set({ ph: v === 10 ? null : String(v) })} />}
          >
            {patterns.status === 'loading' && <Skeleton h={220} />}
            {patterns.status === 'error' && <StateNote tone="error" title="Pattern study failed." action={<button type="button" className="btn small" onClick={patterns.reload}>Retry</button>}>{patterns.error.message}</StateNote>}
            {patterns.status === 'ready' && (
              <div className="table-wrap" tabIndex={0} role="region" aria-label="Selling exhaustion patterns">
                <table className="data">
                  <caption className="sr-only">Pattern outcomes</caption>
                  <thead>
                    <tr>
                      <th className="l sticky" scope="col">Pattern</th>
                      <th scope="col">Occurrences</th>
                      <th scope="col">Cases</th>
                      <th scope="col">Higher close at the end</th>
                      <th scope="col">Median return</th>
                      <th scope="col">Median worst close</th>
                      <th scope="col">Event low held</th>
                    </tr>
                  </thead>
                  <tbody>
                    {patterns.data.map((p) => {
                      const h = p.horizons.find((x) => x.horizon === ph);
                      return (
                        <tr key={p.pattern.id}>
                          <td className="l sticky" style={{ whiteSpace: 'normal', minWidth: 150 }}>
                            <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                              {p.pattern.label}
                              <Info text={`${p.pattern.description} ${p.pattern.scope === 'any-session' ? 'Scans every session, not only qualifying declines.' : 'Starts from a qualifying decline.'} ${p.pattern.provenance === 'spec' ? '' : 'Some thresholds are proposed and not yet reconciled with the reference.'}`} label={`About ${p.pattern.label}`} />
                            </span>
                          </td>
                          <td>{fmtInt(p.occurrences.length)}</td>
                          <td>{h ? h.n : 0}{h && (h.excludedOverlap > 0 || h.notMatured > 0) && <span className="faint small" style={{ display: 'block' }}>of {h.anchorsConsidered}</span>}</td>
                          <td>{h ? <FreqCell hits={h.positive.hits} n={h.positive.n} p={h.positive.proportion} /> : 'n/a'}</td>
                          <td>{h ? <DistCell d={h.returns} /> : 'n/a'}</td>
                          <td>{h ? <DistCell d={h.worstClose} /> : 'n/a'}</td>
                          <td>{h ? <FreqCell hits={h.eventLowHeld.hits} n={h.eventLowHeld.n} p={h.eventLowHeld.proportion} /> : 'n/a'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="faint small">Rates are withheld under {DECLINE_DEFAULTS.proposed.minCases} matured, non overlapping cases. Patterns overlap, so their counts are not independent evidence.</p>
          </Card>

          <Card
            title="Closest earlier sessions"
            info="Earlier sessions of this stock whose measurable conditions were closest to the latest qualifying decline. Each feature is standardized with data before the query only. A case is used only when its outcome window had finished before the query date."
            sub={queryEvent ? `Matched to ${fmtDate(queryEvent.date)} (${fmtPct(queryEvent.measure)}). Outcomes ${ah} sessions after each case.` : undefined}
            actions={<Segmented label="Analog horizon" value={ah} options={ANALOG_HORIZONS.map((h) => ({ value: h, label: `${h}` }))} onChange={(v) => set({ ah: v === 20 ? null : String(v) })} />}
          >
            {!queryEvent && <StateNote>No qualifying session to match.</StateNote>}
            {queryEvent && analogs.status === 'loading' && <Skeleton h={260} />}
            {analogs.status === 'error' && <StateNote tone="error" title="Analog search failed." action={<button type="button" className="btn small" onClick={analogs.reload}>Retry</button>}>{analogs.error.message}</StateNote>}
            {analogs.status === 'ready' && isNa(analogs.data) && <StateNote>{reasonDetail(analogs.data)}</StateNote>}
            {analogs.status === 'ready' && !isNa(analogs.data) && (
              <AnalogBody a={analogs.data} series={analogSeries} symbol={symbol} onPick={setCaseSel} picked={caseSel} />
            )}
          </Card>
        </>
      )}

      {occ && (
        <Sheet title={`${symbol} on ${fmtDate(occ.date)}`} onClose={() => setOcc(null)}>
          <dl className="kv">
            <dt>Open, high, low, close</dt>
            <dd className="num">{fmtPrice(occ.open)}, {fmtPrice(occ.high)}, {fmtPrice(occ.low)}, {fmtPrice(occ.close)}</dd>
            <dt>Previous close</dt>
            <dd className="num">{occ.prevClose === null ? 'n/a' : fmtPrice(occ.prevClose)}</dd>
            <dt>Close vs previous close</dt>
            <dd><Pct v={occ.measures.closeVsPrevClose} /></dd>
            <dt>Gap at the open</dt>
            <dd><Pct v={occ.measures.gap} /></dd>
            <dt>Close vs open</dt>
            <dd><Pct v={occ.measures.closeVsOpen} /></dd>
            <dt>Close vs intraday high</dt>
            <dd><Pct v={occ.measures.closeVsHigh} /></dd>
            <dt>Low vs previous close</dt>
            <dd><Pct v={occ.measures.lowVsPrevClose} /></dd>
            <dt>Order of high and low</dt>
            <dd>Not known from daily bars</dd>
            <dt>Lower wick share of range</dt>
            <dd>{isNa(occ.measures.lowerWick) ? 'Flat range' : fmtPct(occ.measures.lowerWick, 0, false)}</dd>
            <dt>Volume</dt>
            <dd>{occ.volume === null ? 'Not verified' : fmtInt(occ.volume)}{isNa(occ.relativeVolume) ? '' : `, ${fmtMultiple(occ.relativeVolume)} the prior 20 session average`}</dd>
            <dt>Stock trend that day</dt>
            <dd>{mb(occ.stock.aboveSma50, 'Above', 'Below')} the 50 day, {mb(occ.stock.aboveSma200, 'above', 'below')} the 200 day</dd>
            <dt>SPY that day</dt>
            <dd>{isNa(occ.market) ? 'Unavailable' : <><Pct v={occ.market.dayReturn} />, {mb(occ.market.aboveSma200, 'above', 'below')} its 200 day</>}</dd>
            <dt>Sector fund that day</dt>
            <dd>{isNa(occ.sector) ? 'Unavailable' : <><Pct v={occ.sector.dayReturn} />, {mb(occ.sector.aboveSma200, 'above', 'below')} its 200 day</>}</dd>
            <dt>Earnings cohort</dt>
            <dd>{occ.earnings}</dd>
            <dt>Place in its drawdown</dt>
            <dd>
              {(() => {
                const s = stageOf(occ.index);
                return isNa(s) ? 'Not described. The drawdown around it has not finished, or there was none.' : `${s.stage.replace('-', ' ')} of a ${fmtPct(s.depth, 1)} drawdown from ${fmtDate(s.peakDate)} to ${fmtDate(s.troughDate)}. Known only after it ended.`;
              })()}
            </dd>
          </dl>
          <p style={{ marginTop: 12 }}>
            <Link to={researchPath(symbol, 'selloffs', { asof: occ.date, tab: 'declines' })}>Open this page as of {fmtDate(occ.date)}</Link>
          </p>
        </Sheet>
      )}
      {caseSel && (
        <Sheet title={`Case ${fmtDate(caseSel.date)}${caseSel.origin === 'group' ? `, ${caseSel.symbol}` : ''}`} onClose={() => setCaseSel(null)}>
          <div className="stats" style={{ marginBottom: 12 }}>
            <Stat label={`Return after ${caseSel.outcome.horizon} sessions`} value={<Pct v={caseSel.outcome.ret} />} sub={`to ${fmtDate(caseSel.outcome.endDate)}`} />
            <Stat label="Worst close" value={<Pct v={caseSel.outcome.minCloseRet} />} sub={`session ${caseSel.outcome.minCloseOffset}`} />
            <Stat label="Best close" value={<Pct v={caseSel.outcome.maxCloseRet} />} sub={`session ${caseSel.outcome.maxCloseOffset}`} />
            <Stat label="First close above the event close" value={caseSel.reversalSessions === null ? 'Not inside the window' : `Session ${caseSel.reversalSessions}`} />
          </div>
          <h3>Why it matched</h3>
          <p className="muted small">Distance {caseSel.distance === null ? 'n/a' : fmtNum(caseSel.distance, 2)}. A small standardized difference means the two sessions were alike on that feature.</p>
          <div className="table-wrap" style={{ marginTop: 6 }}>
            <table className="data">
              <thead>
                <tr>
                  <th className="l" scope="col">Feature</th>
                  <th scope="col">Query</th>
                  <th scope="col">Case</th>
                  <th scope="col">Difference, standardized</th>
                  <th scope="col">Share of distance</th>
                </tr>
              </thead>
              <tbody>
                {[...caseSel.contributions].sort((x, y) => Math.abs(x.zDiff) - Math.abs(y.zDiff)).map((c) => (
                  <tr key={c.key}>
                    <td className="l" style={{ whiteSpace: 'normal' }}>{c.label}</td>
                    <td>{fmtNum(c.queryValue, 3)}</td>
                    <td>{fmtNum(c.caseValue, 3)}</td>
                    <td>{fmtNum(c.zDiff, 2, true)}</td>
                    <td>{fmtPct(c.share, 0, false)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ marginTop: 12 }}>
            <Link to={researchPath(caseSel.symbol ?? symbol, 'selloffs', { asof: caseSel.date, tab: 'declines' })}>Open this page as of {fmtDate(caseSel.date)}</Link>
          </p>
        </Sheet>
      )}
    </div>
  );
}

function AnalogBody({ a, series, symbol, onPick, picked }: { a: AnalogResult; series: LineSeries[]; symbol: string; onPick: (c: AnalogCase) => void; picked: AnalogCase | null }) {
  const [sort, setSort] = useState<SortState | null>(null);
  const s = a.summary;
  const cols: Column<AnalogCase>[] = [
    { key: 'date', header: 'Session', sticky: true, sort: (c) => c.date, cell: (c) => <>{fmtDate(c.date)}{c.origin === 'group' && <span className="faint small"> {c.symbol}</span>}</> },
    { key: 'dist', header: 'Distance', info: 'Weighted root mean square of standardized feature differences. Smaller is closer.', sort: (c) => c.distance, cell: (c) => (c.distance === null ? 'n/a' : fmtNum(c.distance, 2)) },
    { key: 'ret', header: `Return after ${a.horizon}`, sort: (c) => c.outcome.ret, cell: (c) => <Pct v={c.outcome.ret} digits={1} /> },
    { key: 'worst', header: 'Worst close', sort: (c) => c.outcome.minCloseRet, cell: (c) => <Pct v={c.outcome.minCloseRet} digits={1} /> },
    { key: 'rec', header: 'Sessions to regain prior close', sort: (c) => c.recoverySessions, cell: (c) => (!c.recoveryApplicable ? <span className="faint">n/a</span> : c.recoverySessions === null ? <span className="muted">Not inside</span> : fmtInt(c.recoverySessions)) },
    { key: 'why', header: 'Closest on', align: 'l', cell: (c) => <span className="muted small">{[...c.contributions].sort((x, y) => Math.abs(x.zDiff) - Math.abs(y.zDiff)).slice(0, 3).map((x) => x.label).join(', ')}</span> },
  ];
  if (a.status === 'none' || a.status === 'insufficient-features' || a.cases.length === 0) {
    return <StateNote>{a.status === 'insufficient-features' ? 'Too few comparable features at the query session to match on.' : 'No earlier session qualified as a match.'} {a.notes.join(' ')}</StateNote>;
  }
  return (
    <div className="stack" style={{ gap: 12 }}>
      {a.status === 'sparse' && <StateNote tone="warn" title="Sparse match set.">{a.notes.join(' ') || 'Few cases matched. Treat the summary as description only.'}</StateNote>}
      <div className="stats">
        <Stat label="Cases" value={s.n} sub={`${a.counts.ownCases} own stock${a.counts.groupCases ? `, ${a.counts.groupCases} group` : ''}. ${fmtInt(a.counts.scanned)} scanned, ${fmtInt(a.counts.overlapDropped)} dropped for overlap`} />
        <Stat label={`Higher close after ${a.horizon} sessions`} value={<FreqCell hits={s.positive.hits} n={s.positive.n} p={s.positive.proportion} />} />
        <Stat label="Median return" value={<DistCell d={s.returns} />} sub={isNa(s.returns) ? undefined : `${fmtPct(s.returns.p10, 1)} to ${fmtPct(s.returns.p90, 1)}, 10th to 90th`} />
        <Stat label="Median worst close" value={<DistCell d={s.worstClose} />} />
      </div>
      <LineChart
        series={series}
        envelope={{ points: a.medianPath.filter((p) => p.n >= 3).map((p) => ({ x: p.offset, lo: p.p25, hi: p.p75 })) }}
        xLabel={(x) => (x === 0 ? 'Event close' : `${x > 0 ? '+' : '\u2212'}${Math.abs(x)} sessions`)}
        yFormat={(y) => fmtPct(y, 0)}
        vLines={[{ x: 0, label: 'Event' }]}
        zeroLine
        height={260}
        ariaLabel={`Close relative to the event close for ${a.cases.length} matched sessions, with the median path and its middle half`}
      />
      <p className="faint small">Grey lines are the matched historical cases. The band is the middle half of cases. This is what happened after similar sessions, not a forecast. {a.matchedDimensions.length} features compared, at least {a.cases[0]?.sharedFeatures.length ?? 0} shared per case.</p>
      <DataTable rows={sortRows(a.cases, cols, sort)} cols={cols} sort={sort} onSort={setSort} rowKey={(c) => `${c.symbol ?? symbol}-${c.date}`} onRow={onPick} selectedKey={picked ? `${picked.symbol ?? symbol}-${picked.date}` : null} caption="Matched sessions" maxHeight={360} />
      <p className="faint small">Select a case to see why it matched.</p>
    </div>
  );
}
