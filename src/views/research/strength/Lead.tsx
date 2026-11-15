/** Lead block: observed trend state, the rule that produced it, and a few dated facts. */
import { useMemo } from 'react';
import { isNa, type Bar, type Maybe } from '../../../engine/core/types';
import { rangeStats, relativeMatrix, strengthProfile, type RangeBasis } from '../../../engine/relativeStrength';
import { Card, Chip, Missing, Pct, Stat } from '../../../ui/components';
import { fmtDate, fmtPct, fmtPp, fmtPrice } from '../../../ui/format';
import { num } from './util';

export function Lead({ bars, basis, spy }: { bars: readonly Bar[]; basis: RangeBasis; spy: Maybe<Bar[]> | null }) {
  const i = bars.length - 1;
  const p = useMemo(() => strengthProfile(bars, i, { basis }), [bars, i, basis]);
  const r3 = useMemo(() => rangeStats(bars, i, '3M', { basis: 'close', withPercentile: false }), [bars, i]);
  const rel = useMemo(() => (spy && !isNa(spy) ? relativeMatrix(bars, { symbol: 'SPY', bars: spy, role: 'market' }, { windows: ['3M'] }) : null), [bars, spy]);

  if (isNa(p)) return <Card title="Trend state"><Missing why={p} block /></Card>;

  const facts: React.ReactNode[] = [];
  const el = isNa(p.earlyLeadership) ? null : p.earlyLeadership;
  if (!isNa(r3)) {
    const h = r3.closing.high;
    if (p.newHigh['3M'] === true) {
      facts.push(<>New 3 month closing high on {fmtDate(p.date)}{el ? `, while ${fmtPct(Math.abs(el.distanceToYearHigh), 1, false)} below the 1 year high of ${fmtPrice(el.yearHigh)} set ${fmtDate(el.yearHighDate)}` : ''}.</>);
    } else {
      facts.push(<>3 month closing high {fmtPrice(h.value)} on {fmtDate(h.date)}, {h.sessionsSince} sessions ago. The close is {fmtPct(Math.abs(h.gap), 1, false)} below it.</>);
    }
  }
  if (!isNa(p.trend)) {
    const hs = p.trend.lastSwingHighs;
    const ls = p.trend.lastSwingLows;
    const a = hs[hs.length - 2];
    const b = hs[hs.length - 1];
    const c = ls[ls.length - 2];
    const d = ls[ls.length - 1];
    if (a && b) facts.push(<>Last confirmed swing high {fmtPrice(b.value)} on {fmtDate(b.eventDate)} is {b.value > a.value ? 'higher' : 'lower'} than the prior one, {fmtPrice(a.value)} on {fmtDate(a.eventDate)}.</>);
    if (c && d) facts.push(<>Last confirmed swing low {fmtPrice(d.value)} on {fmtDate(d.eventDate)} is {d.value > c.value ? 'higher' : 'lower'} than the prior one, {fmtPrice(c.value)} on {fmtDate(c.eventDate)}.</>);
  }
  const row = rel && !isNa(rel) ? rel.rows[0]?.row : null;
  if (row && !isNa(row)) {
    facts.push(<>3 month price return {fmtPct(row.own, 1)} versus SPY {fmtPct(row.benchmark, 1)}, a difference of {fmtPp(row.excessPp, 1)} from {fmtDate(row.baseDate)} to {fmtDate(row.endDate)}.</>);
  }
  const d3 = isNa(p.highDistance3M) ? null : p.highDistance3M;

  return (
    <Card
      title="Trend state"
      info="A threshold classification of 1 month and 1 year range positions, the 200 session average and the five session change in distance to the 3 month high. The first matching rule wins. It is not a validated signal."
    >
      <div className="row" style={{ marginBottom: 4 }}>
        <span className="st-state">{p.state}</span>
        <Chip>Classification</Chip>
        {el?.active && <Chip tone="gold" title="A new 1, 3 or 6 month closing high while at least 15% below the 1 year high.">Early leadership</Chip>}
      </div>
      <p className="muted small" style={{ marginBottom: 12 }}>Rule matched. {p.rule} As of {fmtDate(p.date)}.</p>
      <div className="stats" style={{ marginBottom: 12 }}>
        <Stat label="1 month position" value={num(p.pos1M) === null ? 'n/a' : fmtPct(num(p.pos1M), 0, false)} sub="of low to high range" />
        <Stat label="1 year position" value={num(p.pos1Y) === null ? <Missing why={isNa(p.pos1Y) ? p.pos1Y : 'n/a'} /> : fmtPct(num(p.pos1Y), 0, false)} sub="of low to high range" />
        <Stat label="200 session average" value={p.aboveSma200 === null ? 'n/a' : p.aboveSma200 ? 'Above' : 'Below'} sub={p.aboveSma200 === null ? 'Needs 200 sessions' : 'latest close'} />
        <Stat label="Gap to 3 month high" value={d3 ? <Pct v={d3.nowDistance} digits={1} /> : 'n/a'} sub={d3 ? `${fmtPp(d3.change, 1)} in 5 sessions` : undefined} />
      </div>
      {facts.length > 0 && (
        <ul className="st-facts">
          {facts.slice(0, 4).map((f, k) => (
            <li key={k}>{f}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}
