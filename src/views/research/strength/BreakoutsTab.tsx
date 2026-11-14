/** Breakouts tab: current status, episodes, outcomes with a baseline, and market stress. */
import { useMemo, useState } from 'react';
import { useEngine } from '../../../data/engine';
import { isNa, type Bar, type Maybe } from '../../../engine/core/types';
import {
  BREAK_HORIZONS,
  BREAK_WINDOWS,
  marketStress,
  type BreakoutEpisode,
  type BreakoutHorizon,
  type BreakoutStudy,
  type BreakSide,
  type BreakWindowKey,
  type EpisodeFilter,
  type EpisodeStatus,
  type StressEpisode,
} from '../../../engine/breakouts';
import { WINDOW_SPECS, type RangeBasis, type WindowKey } from '../../../engine/relativeStrength';
import { Card, Chip, DataTable, Disclosure, Freq, Missing, Pct, Segmented, Sheet, Skeleton, sortRows, Stat, StateNote, type Column, type SortState } from '../../../ui/components';
import { fmtDate, fmtMultiple, fmtNum, fmtPct, fmtPp, fmtPrice } from '../../../ui/format';
import { priorLevelNow, shortWindow, useNarrow } from './util';

const STATUS: Record<EpisodeStatus, { label: string; tone?: 'up' | 'down' | 'warn' | 'accent' }> = {
  unconfirmed: { label: 'No confirming close', tone: 'warn' },
  active: { label: 'Open', tone: 'accent' },
  held: { label: 'Held', tone: 'up' },
  failed: { label: 'Failed', tone: 'down' },
  'false-breakout': { label: 'False break', tone: 'down' },
};

export interface BreakoutParams {
  bw: BreakWindowKey;
  side: BreakSide;
  mode: 'close' | 'intraday';
  h: number;
  fy: string;
  rv: string;
  cmp: string;
  mat: boolean;
  st: string;
}

const PAGE = 15;

export function BreakoutsTab({
  bars,
  basis,
  cacheKey,
  spy,
  p,
  set,
}: {
  bars: readonly Bar[];
  basis: RangeBasis;
  cacheKey: string;
  spy: Maybe<Bar[]> | null;
  p: BreakoutParams;
  set: (c: Record<string, string | null>) => void;
}) {
  const narrow = useNarrow();
  const spyBars = spy && !isNa(spy) ? spy : null;
  const filter = useMemo<EpisodeFilter | undefined>(() => {
    const f: EpisodeFilter = {};
    if (p.fy) f.minBelowYearHigh = Number(p.fy) / 100;
    if (p.rv) f.minRelativeVolume = Number(p.rv);
    if (p.cmp === 'yes') f.compressed = true;
    if (p.cmp === 'no') f.compressed = false;
    if (p.mat) f.maturedOnly = true;
    return Object.keys(f).length ? f : undefined;
  }, [p.fy, p.rv, p.cmp, p.mat]);

  const study = useEngine<Maybe<BreakoutStudy>>(
    `${cacheKey}:${p.bw}:${p.side}:${basis}:${p.mode}:${JSON.stringify(filter ?? {})}:${spyBars ? 'm' : ''}`,
    'breakouts',
    'breakoutStudy',
    () => [bars, p.bw, p.side, { basis, mode: p.mode, market: spyBars ?? undefined, filter }],
  );
  const level = useMemo(() => priorLevelNow(bars, p.bw, p.side, basis), [bars, p.bw, p.side, basis]);
  const stress = useMemo(() => (spyBars ? marketStress(bars, { symbol: 'SPY', bars: spyBars }) : null), [bars, spyBars]);

  const [sort, setSort] = useState<SortState | null>({ key: 'date', dir: 'desc' });
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<BreakoutEpisode | null>(null);

  const word = p.side === 'up' ? 'high' : 'low';
  const wl = WINDOW_SPECS[p.bw as WindowKey].label;
  const levelName = `prior ${wl} ${basis === 'close' ? 'closing' : 'traded'} ${word}`;

  const chips: { label: string; clear: Record<string, null> }[] = [];
  if (p.fy) chips.push({ label: `At least ${p.fy}% below the 1 year high`, clear: { fy: null } });
  if (p.rv) chips.push({ label: `Relative volume at least ${p.rv}×`, clear: { rv: null } });
  if (p.cmp) chips.push({ label: p.cmp === 'yes' ? 'After compression' : 'Not after compression', clear: { cmp: null } });
  if (p.mat) chips.push({ label: 'Follow window matured', clear: { mat: null } });

  const controls = (
    <Card>
      <div className="st-controls">
        <Segmented label="Breakout window" value={p.bw} options={BREAK_WINDOWS.map((k) => ({ value: k, label: shortWindow(k) }))} onChange={(v) => { setPage(0); set({ bw: v === '3M' ? null : v }); }} />
        <Segmented label="Side" value={p.side} options={[{ value: 'up', label: 'Up, new highs' }, { value: 'down', label: 'Down, new lows' }]} onChange={(v) => { setPage(0); set({ side: v === 'up' ? null : v }); }} />
        <Segmented label="Touch basis" value={p.mode} options={[{ value: 'close', label: 'Closes only', title: 'Targets and excursions use closes' }, { value: 'intraday', label: 'Intraday', title: 'Targets and excursions use daily highs and lows. Order inside one bar is unknown.' }]} onChange={(v) => set({ mode: v === 'close' ? null : v })} />
      </div>
      <Disclosure summary={`Filters${chips.length ? ` (${chips.length} active)` : ''}`}>
        <div className="st-inputs" style={{ marginBottom: 8 }}>
          <label className="field">
            Below the 1 year high
            <select className="select" value={p.fy} onChange={(e) => set({ fy: e.target.value || null })}>
              <option value="">Any distance</option>
              {[5, 10, 15, 25].map((x) => <option key={x} value={x}>At least {x}% below</option>)}
            </select>
          </label>
          <label className="field">
            Relative volume
            <select className="select" value={p.rv} onChange={(e) => set({ rv: e.target.value || null })}>
              <option value="">Any volume</option>
              {['1', '1.3', '2'].map((x) => <option key={x} value={x}>At least {x}×</option>)}
            </select>
          </label>
          <label className="field">
            Compression before the signal
            <select className="select" value={p.cmp} onChange={(e) => set({ cmp: e.target.value || null })}>
              <option value="">Either</option>
              <option value="yes">Compressed</option>
              <option value="no">Not compressed</option>
            </select>
          </label>
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 34, alignSelf: 'end' }}>
            <input type="checkbox" checked={p.mat} onChange={(e) => set({ mat: e.target.checked ? '1' : null })} /> Follow window matured
          </label>
        </div>
      </Disclosure>
      {chips.length > 0 && (
        <div className="row" style={{ marginTop: 6 }}>
          {chips.map((c) => <Chip key={c.label} tone="accent" onRemove={() => set(c.clear)}>{c.label}</Chip>)}
          <button type="button" className="btn small ghost" onClick={() => set({ fy: null, rv: null, cmp: null, mat: null })}>Clear all</button>
        </div>
      )}
    </Card>
  );

  if (study.status === 'loading') return <>{controls}<Skeleton h={260} /></>;
  if (study.status === 'error') return <>{controls}<StateNote tone="error" title="The breakout study could not run." action={<button type="button" className="btn small" onClick={study.reload}>Retry</button>}>{study.error.message}</StateNote></>;
  if (isNa(study.data)) return <>{controls}<Missing why={study.data} block /></>;
  const s = study.data;
  const eps = s.filter ? s.filter.kept : s.episodes;
  const hz = s.horizons.find((x) => x.horizon === p.h) ?? s.horizons[0];
  const lastSignal = s.latest?.signals[s.latest.signals.length - 1];

  const cols: Column<BreakoutEpisode>[] = [
    { key: 'date', header: 'First attempt', sticky: true, sort: (e) => e.firstAttemptDate, cell: (e) => fmtDate(e.firstAttemptDate) },
    { key: 'status', header: 'Status', align: 'l', sort: (e) => STATUS[e.status].label, cell: (e) => <Chip tone={STATUS[e.status].tone}>{STATUS[e.status].label}</Chip> },
    { key: 'level', header: <>Level<br />broken</>, sort: (e) => e.level, cell: (e) => <span title={`Set ${fmtDate(e.levelDate)}`}>{fmtPrice(e.level)}</span> },
    ...(narrow
      ? []
      : ([
          { key: 'age', header: <>Level age,<br />sessions</>, sort: (e) => e.levelAge, cell: (e) => e.levelAge },
          { key: 'confirm', header: 'Confirm close', sort: (e) => e.confirmDate, cell: (e) => (e.confirmDate ? fmtDate(e.confirmDate) : <span className="faint">None</span>) },
          { key: 'failed', header: <>Failed intraday<br />attempts</>, sort: (e) => e.failedAttempts, cell: (e) => e.failedAttempts },
          { key: 'retest', header: 'Retest', sort: (e) => e.lifecycle?.retestDate ?? null, cell: (e) => (e.lifecycle?.retestDate ? `${fmtDate(e.lifecycle.retestDate)}${e.lifecycle.retestHeld === null ? '' : e.lifecycle.retestHeld ? ', held' : ', lost'}` : <span className="faint">None</span>) },
          { key: 'fail', header: 'Close back inside', sort: (e) => e.lifecycle?.failureDate ?? null, cell: (e) => (e.lifecycle?.failureDate ? fmtDate(e.lifecycle.failureDate) : <span className="faint">None</span>) },
          { key: 'yh', header: <>Versus prior<br />1 year high</>, sort: (e) => e.context.distanceBelowYearHigh, cell: (e) => (e.context.distanceBelowYearHigh === null ? <span className="faint">n/a</span> : fmtPct(e.context.distanceBelowYearHigh, 1)) },
          { key: 'rv', header: <>Relative<br />volume</>, sort: (e) => e.context.relativeVolume, cell: (e) => (e.context.relativeVolume === null ? <span className="faint">Not verified</span> : fmtMultiple(e.context.relativeVolume)) },
        ] as Column<BreakoutEpisode>[])),
  ];
  const sorted = sortRows(eps, cols, sort);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE));
  const pg = Math.min(page, pages - 1);

  const hcols: Column<BreakoutHorizon>[] = [
    { key: 'h', header: 'Sessions', sticky: true, cell: (x) => x.horizon },
    { key: 'n', header: 'Matured', info: 'Confirmed episodes after spacing, with the full horizon completed. The denominator of each rate.', cell: (x) => x.n },
    { key: 'ov', header: <>Overlap<br />dropped</>, cell: (x) => x.droppedOverlap },
    { key: 'nm', header: <>Not<br />matured</>, cell: (x) => x.notMatured },
    { key: 'base', header: 'All days rate', cell: (x) => (x.baseline.rate === null ? 'n/a' : fmtPct(x.baseline.rate, 1, false)) },
    { key: 'cont', header: 'Continued', cell: (x) => (x.sampleSufficient && x.continued ? `${fmtPct(x.continued.rate, 0, false)} (${x.continued.hits} of ${x.continued.n})` : x.continued ? `${x.continued.hits} of ${x.continued.n}` : 'n/a') },
    { key: 'tg', header: <>Reached<br />2% beyond</>, cell: (x) => (x.reachedTarget ? `${x.reachedTarget.hits} of ${x.reachedTarget.n}` : 'n/a') },
    { key: 'adv', header: <>Adverse<br />move</>, cell: (x) => (x.adverse ? `${x.adverse.hits} of ${x.adverse.n}` : 'n/a') },
    { key: 'med', header: <>Median<br />return</>, cell: (x) => (x.returns ? <Pct v={x.returns.median} digits={1} /> : 'n/a') },
    { key: 'val', header: 'Model', align: 'l', cell: (x) => (x.validation.status === 'valid' ? 'Validated' : x.validation.status === 'not-reliable' ? 'No validated edge' : 'Insufficient evidence') },
  ];

  const contWord = p.side === 'up' ? 'higher' : 'lower';

  return (
    <>
      {controls}
      <Card title="Current status" sub={`${s.signals} signals in ${s.episodes.length} episodes through ${fmtDate(s.asOfDate)}. ${s.confirmedSignals} confirming closes, ${s.intradayFailedSignals} intraday attempts that closed back inside.`}>
        <div className="stats">
          <Stat
            label={`Close versus ${levelName}`}
            info="The reference level is the extreme of the prior window, excluding the latest session."
            value={level ? <Pct v={level.gap} digits={1} /> : 'n/a'}
            sub={level ? `${fmtPrice(level.level)} set ${fmtDate(level.date)}, ${level.age} sessions ago` : 'Window not covered'}
          />
          <Stat label="Last signal" value={lastSignal ? fmtDate(lastSignal.date) : 'None'} sub={lastSignal ? `${lastSignal.kind === 'confirmed-close' ? 'Confirming close' : 'Intraday attempt, closed inside'}, ${s.sessionsSinceLastSignal} sessions ago` : undefined} />
          <Stat label="Latest episode" value={s.latest ? STATUS[s.latest.status].label : 'None'} sub={s.latest ? `${s.latest.attempts} signal sessions, ${s.latest.failedAttempts} failed intraday before confirm` : undefined} />
          <Stat label="False breaks" info="Among confirmed episodes whose false break window has closed. A close back at or inside the level within 5 sessions of the confirm close." value={s.falseBreakouts ? `${s.falseBreakouts.hits} of ${s.falseBreakouts.n}` : 'n/a'} sub={s.falseBreakouts ? `${fmtPct(s.falseBreakouts.rate, 0, false)}, interval ${fmtPct(s.falseBreakouts.lo, 0, false)} to ${fmtPct(s.falseBreakouts.hi, 0, false)}` : undefined} />
        </div>
        {s.filter && (
          <p className="muted small" style={{ marginTop: 8 }}>
            Filters keep {s.filter.kept.length} of {s.episodes.length} episodes. {s.filter.removed} removed by a filter, {s.filter.removedForMissingData} removed because a field the filter needs is unavailable.
          </p>
        )}
      </Card>

      {hz && (
        <Card
          title={`What followed, ${hz.horizon} sessions after the confirm close`}
          info="Outcomes after the first confirming close of each episode. Episodes are thinned so anchors sit at least the horizon plus one session apart. An episode enters whether or not it later succeeded."
          actions={<Segmented label="Horizon in sessions" value={hz.horizon} options={BREAK_HORIZONS.map((h) => ({ value: h, label: String(h) }))} onChange={(v) => set({ h: v === 20 ? null : String(v) })} />}
          sub={`${hz.n} matured episodes of ${hz.episodes} confirmed. ${hz.droppedOverlap} dropped for overlap, ${hz.notMatured} not matured.`}
        >
          {!hz.sampleSufficient && <StateNote tone="warn" title="Small sample.">Fewer matured episodes than the minimum. Counts are shown. Rates are not a basis for odds.</StateNote>}
          <div className="stats" style={{ margin: '10px 0' }}>
            <Stat label={`${contWord[0]!.toUpperCase()}${contWord.slice(1)} close at the horizon`} value={hz.sampleSufficient ? <Freq p={hz.continued} /> : hz.continued ? `${hz.continued.hits} of ${hz.continued.n}` : 'n/a'} />
            <Stat
              label="All days rate, same target"
              info="How often any session was followed by the same outcome over the same horizon. The interval uses a spaced sample."
              value={hz.baseline.rate === null ? 'n/a' : fmtPct(hz.baseline.rate, 1, false)}
              sub={hz.baseline.spaced ? `${hz.baseline.hits.toLocaleString('en-US')} of ${hz.baseline.n.toLocaleString('en-US')} sessions. Spaced interval ${fmtPct(hz.baseline.spaced.lo, 0, false)} to ${fmtPct(hz.baseline.spaced.hi, 0, false)}` : undefined}
            />
            <Stat label="Difference" value={hz.differenceVsBaselinePp === null || !hz.sampleSufficient ? 'n/a' : fmtPp(hz.differenceVsBaselinePp, 1)} sub="descriptive, not a validated edge" />
            <Stat label="Reached 2% beyond the level" value={<Freq p={hz.sampleSufficient ? hz.reachedTarget : null} />} sub={`${hz.alreadyBeyondTarget} already beyond at confirm${hz.medianSessionsToTarget !== null ? `. Median ${fmtNum(hz.medianSessionsToTarget, 0)} sessions to reach` : ''}`} />
            <Stat label={`Adverse move of ${fmtPct(hz.adverseThreshold, 0, false)} or more`} value={<Freq p={hz.sampleSufficient ? hz.adverse : null} />} sub={p.mode === 'close' ? 'closes only' : 'intraday lows and highs'} />
            <Stat label="Close beyond the level at the horizon" value={<Freq p={hz.sampleSufficient ? hz.closeBeyondLevel : null} />} />
            <Stat label="Some close back inside" value={<Freq p={hz.sampleSufficient ? hz.closedBackInside : null} />} />
            <Stat label="Endpoint return" value={hz.returns ? <Pct v={hz.returns.median} digits={1} /> : 'n/a'} sub={hz.returns ? `median. p10 ${fmtPct(hz.returns.p10, 1)}, p90 ${fmtPct(hz.returns.p90, 1)}` : undefined} />
            <Stat label="Lowest later close" value={hz.lowestLaterClose ? <Pct v={hz.lowestLaterClose.median} digits={1} /> : 'n/a'} sub={hz.lowestLaterClose ? `median. p10 ${fmtPct(hz.lowestLaterClose.p10, 1)}` : undefined} />
            <Stat label="Highest later close" value={hz.highestLaterClose ? <Pct v={hz.highestLaterClose.median} digits={1} /> : 'n/a'} sub={hz.highestLaterClose ? `median. p90 ${fmtPct(hz.highestLaterClose.p90, 1)}` : undefined} />
          </div>
          {hz.validation.status === 'valid' && typeof hz.probability === 'number' ? (
            <StateNote title="Validated estimate.">
              {fmtPct(hz.probability, 0, false)} for a {contWord} close {hz.horizon} sessions after a new confirming close. Out of sample Brier {fmtNum(hz.validation.brier, 4)} versus baseline {fmtNum(hz.validation.baselineBrier, 4)} on {hz.validation.scored} scored forecasts.
            </StateNote>
          ) : (
            <StateNote tone="warn" title={hz.validation.status === 'not-reliable' ? 'No validated edge.' : 'Model withheld.'}>
              {hz.validation.reason}
              {hz.validation.brier !== null && hz.validation.baselineBrier !== null ? ` Brier ${fmtNum(hz.validation.brier, 4)} versus baseline ${fmtNum(hz.validation.baselineBrier, 4)} on ${hz.validation.scored} scored forecasts.` : ` ${hz.validation.scored} scored forecasts.`} No modeled probability is shown.
            </StateNote>
          )}
          <Disclosure summary="All horizons">
            <DataTable rows={s.horizons} cols={hcols} rowKey={(x) => String(x.horizon)} caption="Breakout outcomes by horizon" />
          </Disclosure>
        </Card>
      )}

      <Card title="Episodes" info="Repeated signals within five sessions of each other are one episode. First attempt, confirming close, retest and failure are separate dated facts." sub={`${sorted.length} episodes. Select a row for the full sequence.`}>
        <DataTable rows={sorted.slice(pg * PAGE, pg * PAGE + PAGE)} cols={cols} sort={sort} onSort={setSort} rowKey={(e) => e.id} onRow={setOpen} caption="Breakout episodes" empty="No episode matches. Widen the filters or choose another window." />
        {pages > 1 && (
          <div className="row" style={{ marginTop: 8 }}>
            <button type="button" className="btn small" disabled={pg === 0} onClick={() => setPage(pg - 1)}>Previous</button>
            <span className="muted small">Page {pg + 1} of {pages}</span>
            <button type="button" className="btn small" disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}>Next</button>
          </div>
        )}
      </Card>

      <Card
        title="Market stress"
        info="SPY closing drawdown episodes of each depth, with this stock measured over exactly the same sessions. A trough is a hindsight label. It is known only from its confirm date, ten sessions later without a lower close."
        actions={<Segmented label="SPY drawdown depth" value={p.st} options={[{ value: '2', label: '2%' }, { value: '5', label: '5%' }, { value: '10', label: '10%' }]} onChange={(v) => set({ st: v === '5' ? null : v })} />}
      >
        {!stress && <StateNote>SPY history is unavailable, so market stress episodes cannot be measured.</StateNote>}
        {stress && isNa(stress) && <Missing why={stress} block />}
        {stress && !isNa(stress) && (() => {
          const t = stress.byThreshold.find((x) => Math.round(x.threshold * 100) === Number(p.st)) ?? stress.byThreshold[1]!;
          const scols: Column<StressEpisode>[] = [
            { key: 'peak', header: 'SPY peak', sticky: true, cell: (e) => fmtDate(e.peakDate) },
            { key: 'tr', header: 'SPY trough', align: 'l', cell: (e) => <>{fmtDate(e.troughDate)} <span className="faint small">{e.troughConfirmed ? `known ${fmtDate(e.troughConfirmDate)}` : 'not yet confirmed'}</span></> },
            { key: 'bd', header: <>SPY<br />drawdown</>, cell: (e) => <Pct v={e.benchmarkDrawdown} digits={1} /> },
            { key: 'sr', header: <>Stock,<br />same span</>, cell: (e) => <Pct v={e.stockReturn} digits={1} /> },
            { key: 'ex', header: 'Excess', cell: (e) => fmtPp(e.excessPp, 1) },
            { key: 'sd', header: <>Stock max<br />drawdown</>, cell: (e) => <Pct v={e.stockMaxDrawdown} digits={1} /> },
            { key: 'res', header: 'Fell less', align: 'l', cell: (e) => (e.resilient ? 'Yes' : 'No') },
            { key: 'after', header: <>10 sessions after<br />trough, hindsight</>, cell: (e) => (e.stockAfterTrough === null ? <span className="faint">n/a</span> : <><Pct v={e.stockAfterTrough} digits={1} /> <span className="faint small">SPY {fmtPct(e.benchmarkAfterTrough, 1)}</span></>) },
          ];
          return (
            <>
              <div className="stats" style={{ marginBottom: 10 }}>
                <Stat label="Episodes" value={t.episodes.length} sub={`${fmtDate(stress.commonFrom)} to ${fmtDate(stress.commonTo)}`} />
                <Stat label="Stock fell less than SPY" value={<Freq p={t.resilient} />} />
                <Stat label="Median excess" value={t.medianExcessPp === null ? 'n/a' : fmtPp(t.medianExcessPp, 1)} sub="peak to trough" />
              </div>
              <DataTable rows={[...t.episodes].reverse()} cols={scols} rowKey={(e) => `${e.peakDate}-${e.threshold}`} caption="Market stress episodes" maxHeight={360} empty="No SPY drawdown of this depth in the shared history." />
              <p className="faint small" style={{ marginTop: 6 }}>{stress.alignedSessions.toLocaleString('en-US')} shared sessions, {stress.droppedRows} dropped.</p>
            </>
          );
        })()}
      </Card>

      {open && (
        <Sheet title={`Episode, ${fmtDate(open.firstAttemptDate)}`} onClose={() => setOpen(null)}>
          <dl className="kv">
            <dt>Status</dt>
            <dd>{STATUS[open.status].label}</dd>
            <dt>Level broken</dt>
            <dd>{fmtPrice(open.level)}, set {fmtDate(open.levelDate)}, {open.levelAge} sessions before the first attempt</dd>
            <dt>First attempt</dt>
            <dd>{fmtDate(open.firstAttemptDate)}</dd>
            <dt>Failed intraday attempts</dt>
            <dd>{open.failedAttempts} before the confirming close</dd>
            <dt>Confirming close</dt>
            <dd>{open.confirmDate ? `${fmtDate(open.confirmDate)} at ${fmtPrice(open.confirmClose)}` : 'None. Price traded through the level and closed back inside.'}</dd>
            <dt>Retest</dt>
            <dd>{open.lifecycle?.retestDate ? `${fmtDate(open.lifecycle.retestDate)}, ${open.lifecycle.retestHeld ? 'closed beyond the level' : 'closed back inside'}` : 'None inside the follow window'}</dd>
            <dt>Rebound</dt>
            <dd>{open.lifecycle?.reboundDate ? fmtDate(open.lifecycle.reboundDate) : 'None'}</dd>
            <dt>Close back inside</dt>
            <dd>{open.lifecycle?.failureDate ? fmtDate(open.lifecycle.failureDate) : 'None'}</dd>
            <dt>False break</dt>
            <dd>{open.lifecycle?.falseBreakout === null || !open.lifecycle ? 'Window still open or not confirmed' : open.lifecycle.falseBreakout ? 'Yes' : 'No'}</dd>
            <dt>Follow window</dt>
            <dd>{open.lifecycle ? `${open.lifecycle.followSessions} sessions, ${open.lifecycle.matured ? 'matured' : 'not matured'}` : 'n/a'}</dd>
            <dt>Versus prior 1 year high</dt>
            <dd>{open.context.distanceBelowYearHigh === null ? 'Not covered' : fmtPct(open.context.distanceBelowYearHigh, 1)}</dd>
            <dt>Relative volume</dt>
            <dd>{open.context.relativeVolume === null ? 'Not verified' : fmtMultiple(open.context.relativeVolume)}</dd>
            <dt>Compressed before</dt>
            <dd>{open.context.compressed === null ? 'Unavailable' : open.context.compressed ? 'Yes' : 'No'}</dd>
            <dt>SPY versus its 200 session average</dt>
            <dd>{open.context.marketAbove200 === null ? 'Unavailable' : open.context.marketAbove200 ? 'Above' : 'Below'}</dd>
            <dt>Signal sessions</dt>
            <dd>{open.signals.map((g) => `${fmtDate(g.date)} ${g.kind === 'confirmed-close' ? 'close' : 'intraday'}`).join(', ')}</dd>
          </dl>
        </Sheet>
      )}
    </>
  );
}
