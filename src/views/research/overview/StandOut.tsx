/** Observed, dated facts about the latest close. Each links to the study that explains it. */
import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useResearch } from '../../../app/research';
import { researchPath, type SectionId } from '../../../app/routes';
import { sma } from '../../../engine/core/indicators';
import { median } from '../../../engine/core/stats';
import { isNa, type Bar } from '../../../engine/core/types';
import { findDeclines, moveRarity } from '../../../engine/declines';
import { currentDrawdown, findDrawdownEpisodes, rangeFacts } from '../../../engine/drawdowns';
import { DEFAULT_ALERT_CONFIG } from '../../../engine/today';
import { Card, RangeGauge, StateNote } from '../../../ui/components';
import { fmtDate, fmtDateShort, fmtInt, fmtPct, fmtPrice } from '../../../ui/format';

interface Fact {
  id: string;
  date: string;
  title: string;
  body: ReactNode;
  to: { section: SectionId; params?: Record<string, string>; label: string };
}

const buildFacts = (bars: readonly Bar[]): Fact[] => {
  const n = bars.length;
  const out: Fact[] = [];
  if (n < 2) return out;
  const last = bars[n - 1]!;
  const closes = bars.map((b) => b.close);

  // 1. Closing drawdown against the stock's own 10% episodes.
  const cur = currentDrawdown(bars);
  if (!isNa(cur)) {
    if (cur.drawdown === 0 && n > 20) {
      out.push({ id: 'peak', date: last.date, title: 'At the closing high of the loaded history', body: <>No close since {fmtDate(bars[0]!.date)} was higher. This is the high within the loaded history, not a verified all time high.</>, to: { section: 'selloffs', label: 'Earlier selloffs' } });
    } else if (cur.drawdown <= -0.05) {
      const eps = findDrawdownEpisodes(bars, 0.1).filter((e) => !e.active);
      const deeper = eps.filter((e) => e.depth <= cur.drawdown).length;
      const rec = eps.map((e) => e.sessionsPeakToRecovery!).filter((x) => x !== null);
      const age = cur.index - cur.peakIndex;
      out.push({
        id: 'dd',
        date: last.date,
        title: `${fmtPct(cur.drawdown, 1)} below the ${fmtDate(cur.peakDate)} closing high`,
        body: (
          <>
            {fmtInt(age)} sessions since that peak.{' '}
            {eps.length > 0
              ? `${deeper} of ${eps.length} completed selloffs of 10% or more went at least this deep. Their median time from peak to recovery was ${fmtInt(median(rec))} sessions.`
              : 'No completed selloff of 10% or more in the loaded history to compare with.'}
          </>
        ),
        to: { section: 'selloffs', label: 'Compare selloffs' },
      });
    }
  }

  // 2. Last session move and how rare it is.
  const prev = bars[n - 2]!;
  const move = last.close / prev.close - 1;
  if (move < 0) {
    const rar = moveRarity(bars as Bar[], n - 1, 'close-vs-prev-close');
    if (!isNa(rar) && rar.priorEligible >= 60 && rar.atLeastAsSevere.hits / rar.priorEligible <= 0.1) {
      out.push({
        id: 'move',
        date: last.date,
        title: `Last session ${fmtPct(move)}`,
        body: <>{fmtInt(rar.atLeastAsSevere.hits)} of {fmtInt(rar.priorEligible)} earlier sessions ({fmtPct(rar.atLeastAsSevere.hits / rar.priorEligible, 1, false)}) closed down at least this much.</>,
        to: { section: 'selloffs', params: { tab: 'declines', dthr: (Math.floor(Math.abs(move) * 200) / 2).toString() }, label: 'Declines this large' },
      });
    }
  } else if (move > 0 && n > 61) {
    let ge = 0;
    for (let i = 1; i < n - 1; i++) if (closes[i]! / closes[i - 1]! - 1 >= move) ge++;
    if (ge / (n - 2) <= 0.1) {
      out.push({ id: 'move', date: last.date, title: `Last session ${fmtPct(move)}`, body: <>{fmtInt(ge)} of {fmtInt(n - 2)} earlier sessions ({fmtPct(ge / (n - 2), 1, false)}) closed up at least this much.</>, to: { section: 'strength', label: 'Strength' } });
    }
  }

  // 3. A 200 session average crossing inside the last ten sessions.
  const L = DEFAULT_ALERT_CONFIG.smaLength;
  const s = sma(closes, L);
  for (let i = n - 1; i >= Math.max(L, n - 10); i--) {
    const a = s[i];
    const b = s[i - 1];
    if (a === null || a === undefined || b === null || b === undefined) break;
    const now = closes[i]! - a;
    const before = closes[i - 1]! - b;
    if ((now < 0 && before >= 0) || (now > 0 && before <= 0)) {
      const below = now < 0;
      let run = 0;
      for (let k = i - 1; k >= L - 1 && s[k] !== null && (below ? closes[k]! >= s[k]! : closes[k]! <= s[k]!); k--) run++;
      out.push({
        id: 'ma200',
        date: bars[i]!.date,
        title: below ? `Closed below the ${L} day average` : `Closed back above the ${L} day average`,
        body: <>First close {below ? 'below' : 'above'} it after {fmtInt(run)} sessions on the other side. {n - 1 - i === 0 ? 'That was the latest session.' : `${n - 1 - i} sessions ago.`}</>,
        to: { section: 'trend', label: 'Run lengths' },
      });
      break;
    }
  }

  // 4. Large down sessions in the last 20.
  const thr = DEFAULT_ALERT_CONFIG.downSessionPct;
  if (n > 21) {
    const recent = findDeclines(bars, { threshold: thr, from: bars[n - 20]!.date }).occurrences;
    if (recent.length > 0) {
      out.push({
        id: 'big',
        date: recent[recent.length - 1]!.date,
        title: `${recent.length} session${recent.length > 1 ? 's' : ''} of ${fmtPct(-thr, 0)} or worse in the last 20`,
        body: <>{recent.slice(-4).map((o) => `${fmtDateShort(o.date)} (${fmtPct(o.measure, 1)})`).join(', ')}. Close against the previous close.</>,
        to: { section: 'selloffs', params: { tab: 'declines' }, label: 'What followed' },
      });
    }
  }

  // 5. Lowest or highest close in a long while.
  let lower = -1;
  let higher = -1;
  for (let i = n - 2; i >= 0 && (lower < 0 || higher < 0); i--) {
    if (lower < 0 && closes[i]! <= last.close) lower = i;
    if (higher < 0 && closes[i]! >= last.close) higher = i;
  }
  const sinceLower = lower < 0 ? n - 1 : n - 1 - lower;
  const sinceHigher = higher < 0 ? n - 1 : n - 1 - higher;
  if (sinceLower >= 20) {
    out.push({ id: 'low', date: last.date, title: `Lowest close in ${fmtInt(sinceLower)} sessions`, body: lower < 0 ? <>Lowest close of the loaded history.</> : <>The last close this low was {fmtDate(bars[lower]!.date)}.</>, to: { section: 'strength', label: 'Ranges' } });
  } else if (sinceHigher >= 20 && !(cur && !isNa(cur) && cur.drawdown === 0)) {
    out.push({ id: 'high', date: last.date, title: `Highest close in ${fmtInt(sinceHigher)} sessions`, body: higher < 0 ? <>Highest close of the loaded history.</> : <>The last close this high was {fmtDate(bars[higher]!.date)}.</>, to: { section: 'strength', label: 'Ranges' } });
  }

  // 6. Run of lower closes.
  let streak = 0;
  for (let i = n - 1; i > 0 && closes[i]! < closes[i - 1]!; i--) streak++;
  if (streak >= 4) {
    out.push({ id: 'streak', date: last.date, title: `${streak} lower closes in a row`, body: <>{fmtPct(last.close / closes[n - 1 - streak]! - 1, 1)} from the {fmtDate(bars[n - 1 - streak]!.date)} close.</>, to: { section: 'selloffs', params: { tab: 'monthly' }, label: 'Monthly Reversal' } });
  }
  return out.slice(0, 6);
};

export function StandOut() {
  const r = useResearch();
  const asof = r.frozen && r.asOf ? r.asOf : undefined;
  const facts = useMemo(() => buildFacts(r.bars), [r.bars]);
  const range = useMemo(() => rangeFacts(r.bars), [r.bars]);
  const rangeOk = !isNa(range) && !isNa(range.closingHigh) && !isNa(range.closingLow) ? { hi: range.closingHigh, lo: range.closingLow, close: range.close } : null;
  const pos = rangeOk && rangeOk.hi.value > rangeOk.lo.value ? (rangeOk.close - rangeOk.lo.value) / (rangeOk.hi.value - rangeOk.lo.value) : null;

  return (
    <Card title="What stands out" info="Observed facts about the latest completed close, each with its date. They describe what happened. They are not forecasts." sub={`Through the ${fmtDate(r.asOf)} close.`}>
      {facts.length === 0 && !rangeOk && <StateNote>Nothing unusual at the latest close, and less than one year of history for a range position.</StateNote>}
      {facts.length === 0 && rangeOk && <p className="muted small" style={{ marginBottom: 8 }}>No drawdown, large move, average crossing or streak stands out at the latest close.</p>}
      <ul className="ov-facts">
        {facts.map((f) => (
          <li key={f.id}>
            <div className="ov-fact-head">
              <strong>{f.title}</strong>
              <span className="faint small">{fmtDate(f.date)}</span>
            </div>
            <div className="muted small">
              {f.body} <Link to={researchPath(r.symbol, f.to.section, { asof, ...f.to.params })}>{f.to.label}</Link>
            </div>
          </li>
        ))}
        <li>
          <div className="ov-fact-head">
            <strong>52 week closing range</strong>
            {pos !== null && <span className="faint small">{fmtPct(pos, 0, false)} of the way from low to high</span>}
          </div>
          {rangeOk ? (
            <RangeGauge
              pos={pos}
              label="Position of the latest close inside the 52 week closing range"
              lowLabel={`${fmtPrice(rangeOk.lo.value)} on ${fmtDate(rangeOk.lo.date)}`}
              highLabel={`${fmtPrice(rangeOk.hi.value)} on ${fmtDate(rangeOk.hi.date)}`}
            />
          ) : (
            <div className="muted small">Needs 252 completed sessions. This history has {fmtInt(r.bars.length)}.</div>
          )}
        </li>
      </ul>
    </Card>
  );
}
