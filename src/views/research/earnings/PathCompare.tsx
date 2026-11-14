/**
 * Normalized price paths around past reports.
 * Session alignment is the study basis. Calendar day alignment is a legacy display option where
 * weekend and holiday dates repeat the prior close for alignment only.
 */
import { useMemo } from 'react';
import { quantile } from '../../../engine/core/stats';
import { isNa, type Bar, type Maybe } from '../../../engine/core/types';
import { calendarOffsetPath, EARNINGS_DEFAULTS, pathEnvelope, type CalendarOffsetPath, type EarningsStudy, type PathEnvelope, type ReactionRow } from '../../../engine/earnings';
import { LineChart, type LineSeries } from '../../../ui/charts';
import { Segmented, StateNote } from '../../../ui/components';
import { fmtDate, fmtPct, plural, reasonDetail } from '../../../ui/format';

export type Align = 'sessions' | 'calendar';
export type QuarterChoice = 'all' | 1 | 2 | 3 | 4;

const SELECTED_COLOR = '#8b5cf6';
const MAX_CONTEXT = 80;

const signed = (x: number): string => (x === 0 ? '0' : `${x > 0 ? '+' : '−'}${Math.abs(x)}`);

interface Built {
  series: LineSeries[];
  envelope?: { points: { x: number; lo: number; hi: number }[] };
  footer: string[];
  xTicks: number[];
  xLabel: (x: number) => string;
  aria: string;
  band?: { x0: number; x1: number };
  vLine?: { x: number; label: string };
}

const endpointLine = (env: PathEnvelope, what: string, unit: string): string => {
  const med = quantile(env.endpoint, 0.5);
  const lo = quantile(env.endpoint, 0.1);
  const hi = quantile(env.endpoint, 0.9);
  return `${what}: ${plural(env.n, 'report')} cover the whole window${env.excluded ? `, ${env.excluded} left out for a shorter path` : ''}. At ${unit} the median is ${fmtPct(med, 1)}, 10th to 90th percentile ${fmtPct(lo, 1)} to ${fmtPct(hi, 1)}.`;
};

const buildSessions = (study: EarningsStudy, quarter: QuarterChoice, selected: ReactionRow | null): Maybe<Built> => {
  const from = -EARNINGS_DEFAULTS.pathBefore;
  const to = EARNINGS_DEFAULTS.pathAfter;
  const group = quarter === 'all' ? study.rows : study.rows.filter((r) => r.fiscalQuarter === quarter);
  const withPath = group.filter((r) => r.path.length > 1);
  const env = pathEnvelope(group, from, to);
  const allEnv = quarter === 'all' ? env : pathEnvelope(study.rows, from, to);
  if (withPath.length === 0) return isNa(env) ? env : { unavailable: true, code: 'sample-too-small', detail: 'No report has a price path' };
  const shown = withPath.slice(-MAX_CONTEXT);
  const series: LineSeries[] = shown
    .filter((r) => r.id !== selected?.id)
    .map((r) => ({ id: r.id, label: r.label, context: true, points: r.path.map((p) => ({ x: p.offset, y: p.ret })) }));
  const footer: string[] = [];
  let envelope: Built['envelope'];
  const groupName = quarter === 'all' ? 'All reports' : `Fiscal Q${quarter} reports`;
  if (!isNa(env)) {
    envelope = { points: env.offsets.map((x, j) => ({ x, lo: env.p10[j]!, hi: env.p90[j]! })) };
    series.push({ id: 'median', label: `${groupName}, median of ${env.n}`, color: 'var(--accent)', width: 2.2, points: env.offsets.map((x, j) => ({ x, y: env.median[j]! })) });
    footer.push(endpointLine(env, groupName, `${signed(to)} sessions`));
  } else footer.push(`${groupName}: ${reasonDetail(env)}. Individual paths are shown without a median.`);
  if (quarter !== 'all' && !isNa(allEnv)) {
    series.push({ id: 'all-median', label: `All reports, median of ${allEnv.n}`, color: 'var(--gold-line)', dashed: true, points: allEnv.offsets.map((x, j) => ({ x, y: allEnv.median[j]! })) });
    footer.push(endpointLine(allEnv, 'All reports', `${signed(to)} sessions`));
  }
  if (selected && selected.path.length > 1) {
    series.push({ id: 'selected', label: selected.label, color: SELECTED_COLOR, width: 2.2, points: selected.path.map((p) => ({ x: p.offset, y: p.ret })) });
    if (!selected.pathComplete) {
      const a = selected.path[0]!.offset;
      const b = selected.path[selected.path.length - 1]!.offset;
      footer.push(`${selected.label} has a truncated path. It covers sessions ${signed(a)} to ${signed(b)} and is not part of the median.`);
    }
  }
  if (withPath.length > shown.length) footer.push(`Showing the ${shown.length} most recent of ${withPath.length} individual paths.`);
  const medNote = !isNa(env) ? ` Median at ${signed(to)} sessions ${fmtPct(env.median[env.median.length - 1]!, 1)} across ${env.n} reports.` : '';
  return {
    series,
    envelope,
    footer,
    xTicks: [from, -10, 0, 10, to],
    xLabel: (x) => (x === 0 ? 'Reaction close' : x === -1 ? 'Pre close' : `Session ${signed(x)}`),
    aria: `Close relative to the last close before the report, ${-from} sessions before to ${to} sessions after the first reacting close.${medNote}`,
    band: { x0: -1, x1: 0 },
  };
};

const buildCalendar = (bars: readonly Bar[], study: EarningsStudy, quarter: QuarterChoice, selected: ReactionRow | null): Maybe<Built> => {
  const from = EARNINGS_DEFAULTS.calendarFrom;
  const to = EARNINGS_DEFAULTS.calendarTo;
  const group = quarter === 'all' ? study.rows : study.rows.filter((r) => r.fiscalQuarter === quarter);
  const paths: CalendarOffsetPath[] = [];
  let unavailable = 0;
  for (const r of group) {
    const p = calendarOffsetPath(bars, r.event, from, to);
    if (isNa(p)) unavailable++;
    else paths.push(p);
  }
  if (paths.length === 0) return { unavailable: true, code: 'sample-too-small', detail: 'No report has a calendar aligned path' };
  const shown = paths.slice(-MAX_CONTEXT);
  const series: LineSeries[] = shown
    .filter((p) => p.id !== selected?.id)
    .map((p) => ({ id: p.id, label: p.label, context: true, points: p.tradingPoints.map((q) => ({ x: q.offset, y: q.ret })) }));
  const footer: string[] = [];
  const full = paths.filter((p) => p.truncatedAt === null && p.points.length === to - from + 1);
  let envelope: Built['envelope'];
  if (full.length > 0) {
    const cols = full[0]!.points.map((_, j) => full.map((p) => p.points[j]!.ret));
    envelope = { points: cols.map((c, j) => ({ x: from + j, lo: quantile(c, 0.1), hi: quantile(c, 0.9) })) };
    series.push({ id: 'median', label: `Display median of ${full.length}`, color: 'var(--accent)', width: 2.2, points: cols.map((c, j) => ({ x: from + j, y: quantile(c, 0.5) })) });
    footer.push(`Display median and 10th to 90th percentile band use ${plural(full.length, 'report')} that cover all ${to - from + 1} calendar days${paths.length - full.length ? `, ${paths.length - full.length} truncated at the data cutoff are left out` : ''}.`);
  }
  const sel = selected ? paths.find((p) => p.id === selected.id) : undefined;
  if (sel) {
    series.push({ id: 'selected', label: sel.label, color: SELECTED_COLOR, width: 2.2, points: sel.tradingPoints.map((q) => ({ x: q.offset, y: q.ret })) });
    const carried = sel.points.length - sel.tradingPoints.length;
    footer.push(`${sel.label}: base close ${fmtDate(sel.baseDate)}. ${carried} of ${sel.points.length} calendar dates are weekends or holidays.${sel.truncatedAt ? ` Truncated at ${fmtDate(sel.truncatedAt)}.` : ''}`);
  }
  footer.push('Calendar alignment is for display. Non trading dates repeat the prior close and are never return inputs. Lines connect trading dates only.');
  if (unavailable) footer.push(`${plural(unavailable, 'report')} left out because history does not reach the base date.`);
  return {
    series,
    envelope,
    footer,
    xTicks: [from, -28, -14, 0, 14, to],
    xLabel: (x) => (x === 0 ? 'Release date' : `Day ${signed(x)}`),
    aria: `Close relative to the close ${-from} calendar days before the release date, through ${to} days after.`,
    vLine: { x: 0, label: 'Release' },
  };
};

export function PathCompare({
  bars,
  study,
  quarter,
  align,
  selected,
  nextQuarter,
  onQuarter,
  onAlign,
}: {
  bars: readonly Bar[];
  study: EarningsStudy;
  quarter: QuarterChoice;
  align: Align;
  selected: ReactionRow | null;
  nextQuarter: number | null;
  onQuarter: (q: QuarterChoice) => void;
  onAlign: (a: Align) => void;
}) {
  const built = useMemo(
    () => (align === 'sessions' ? buildSessions(study, quarter, selected) : buildCalendar(bars, study, quarter, selected)),
    [align, bars, study, quarter, selected],
  );
  const quarters = useMemo(() => {
    const counts = new Map<number, number>();
    for (const r of study.rows) if (r.fiscalQuarter !== null) counts.set(r.fiscalQuarter, (counts.get(r.fiscalQuarter) ?? 0) + 1);
    return counts;
  }, [study]);
  const unlabeled = study.rows.filter((r) => r.fiscalQuarter === null).length;
  const options: { value: QuarterChoice; label: string; title?: string }[] = [
    { value: 'all', label: `All (${study.rows.length})` },
    ...([1, 2, 3, 4] as const)
      .filter((q) => quarters.has(q))
      .map((q) => ({ value: q as QuarterChoice, label: `Q${q}${q === nextQuarter ? ', next' : ''} (${quarters.get(q)})`, title: q === nextQuarter ? 'The fiscal quarter of the upcoming report' : undefined })),
  ];
  return (
    <div>
      <div className="er-controls">
        <label className="field">
          Reports compared
          <Segmented label="Reports compared" value={quarter} options={options} onChange={onQuarter} />
        </label>
        <label className="field">
          Alignment
          <Segmented
            label="Alignment"
            value={align}
            options={[
              { value: 'sessions', label: 'Trading sessions' },
              { value: 'calendar', label: 'Calendar days', title: 'Legacy display alignment, 42 days before to 28 days after the release date' },
            ]}
            onChange={onAlign}
          />
        </label>
      </div>
      {isNa(built) ? (
        <StateNote>{reasonDetail(built)}</StateNote>
      ) : (
        <LineChart
          series={built.series}
          envelope={built.envelope}
          xLabel={built.xLabel}
          xTicks={built.xTicks}
          yFormat={(y) => fmtPct(y, 1)}
          ariaLabel={built.aria}
          zeroLine
          height={300}
          bands={built.band ? [built.band] : undefined}
          vLines={built.vLine ? [built.vLine] : undefined}
          footer={
            <div className="er-foot">
              <p>
                Thin grey lines are individual reports. The shaded band is the 10th to 90th percentile.
                {align === 'sessions' ? ' The gold band is the first reacting session.' : ''}
              </p>
              {built.footer.map((t) => (
                <p key={t}>{t}</p>
              ))}
              {unlabeled > 0 && quarter !== 'all' && <p>{plural(unlabeled, 'report')} without a fiscal period label appear only under All.</p>}
            </div>
          }
        />
      )}
    </div>
  );
}
