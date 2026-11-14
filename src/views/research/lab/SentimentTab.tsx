/**
 * Sentiment study: a 0 to 100 score overlaid on a benchmark, confirmed benchmark swings with the
 * score on the turning session, and outcomes after extreme fear and extreme greed entries.
 * In fixture mode the score is a labeled synthetic proxy.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useResearch } from '../../../app/research';
import { researchPath } from '../../../app/routes';
import { isFixtureMode, useAsync, useBars } from '../../../data/client';
import { syntheticSentiment, type SentimentFixture } from '../../../data/fixtures/sentimentFixture';
import { isNa, type Bar } from '../../../engine/core/types';
import { buildOverlay, clusterStudy, SENTIMENT_DEFAULTS, swingsWithScores, ZONE_LEGEND, zoneLabel, zoneOf, type ClusterEntry, type ClusterStudy, type SwingWithScore, type Zone } from '../../../engine/sentiment';
import { LineChart, type Marker } from '../../../ui/charts';
import { Card, Chip, DataTable, Disclosure, Freq, Pct, Segmented, Skeleton, Stat, StateNote, type Column } from '../../../ui/components';
import { fmtDate, fmtInt, fmtNum, fmtPct, fmtPrice, reasonDetail } from '../../../ui/format';
import { PAGE_SIZE, Pager, useParamPatch } from './shared';

const zoneTone = (z: Zone): 'down' | 'up' | undefined => (z === 'extreme-fear' ? 'down' : z === 'extreme-greed' ? 'up' : undefined);

function ZoneTag({ score }: { score: number }) {
  const z = zoneOf(score);
  return (
    <span className="num">
      {fmtNum(score, 1)} <span className="muted">{zoneLabel(z)}</span>
    </span>
  );
}

function ClusterCard({ study, symbol }: { study: ClusterStudy; symbol: string }) {
  const fear = study.kind === 'fear';
  const [page, setPage] = useState(0);
  const byAnchor = useMemo(() => {
    const m = new Map<string, Record<number, number>>();
    for (const h of study.horizons) for (const o of h.outcomes) m.set(o.anchorDate, { ...(m.get(o.anchorDate) ?? {}), [h.months]: o.ret });
    return m;
  }, [study]);
  const rows = useMemo(() => [...study.clusters].reverse(), [study]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const cols: Column<(typeof rows)[number]>[] = [
    { key: 'd', header: 'First entry', sticky: true, cell: (c) => <Link to={researchPath(symbol, 'lab', { asof: c.anchorDate, tab: 'sentiment' })}>{fmtDate(c.anchorDate)}</Link> },
    { key: 's', header: 'Score', cell: (c) => fmtNum(c.anchorScore, 1) },
    { key: 'n', header: 'Sessions in zone', cell: (c) => `${c.sessions}${c.open ? ', still open' : ''}` },
    { key: 'x', header: 'Most extreme', cell: (c) => `${fmtNum(c.extremeScore, 1)} on ${fmtDate(c.extremeDate)}` },
    ...study.horizons.map((h): Column<(typeof rows)[number]> => ({
      key: `m${h.months}`,
      header: `${h.months} mo`,
      info: 'Blank when the window has not matured or overlaps an earlier counted entry.',
      cell: (c) => {
        const v = byAnchor.get(c.anchorDate)?.[h.months];
        return v === undefined ? <span className="faint">not counted</span> : <Pct v={v} digits={1} />;
      },
    })),
  ];
  return (
    <Card
      title={fear ? 'After the score entered extreme fear' : 'After the score entered extreme greed'}
      info={`Each stretch of consecutive ${fear ? 'extreme fear' : 'extreme greed'} sessions counts once, at its first session after a known non extreme session. ${study.note}`}
      sub={`${study.benchmarkLabel}. ${fmtInt(study.clusters.length)} entries${study.unknownPriorExcluded ? `, ${study.unknownPriorExcluded} skipped with an unknown prior session` : ''}. Entry at ${study.entry === 'next-open' ? 'the next session open' : 'the entry session close'}.`}
    >
      {study.clusters.length === 0 ? (
        <StateNote>No {fear ? 'extreme fear' : 'extreme greed'} entry in this window. A longer history window would include more.</StateNote>
      ) : (
        <>
          <div className="table-wrap lab-wrap" tabIndex={0} role="region" aria-label={`Benchmark outcomes after ${fear ? 'extreme fear' : 'extreme greed'} entries`}>
            <table className="data">
              <thead>
                <tr>
                  <th className="l" scope="col">Months later</th>
                  <th scope="col">Cases</th>
                  <th className="l" scope="col">Higher close</th>
                  <th scope="col">Median</th>
                  <th scope="col">Median drawdown</th>
                  <th scope="col">Median runup</th>
                  <th className="l" scope="col">Left out</th>
                </tr>
              </thead>
              <tbody>
                {study.horizons.map((h) => (
                  <tr key={h.months}>
                    <td className="l">{h.months}</td>
                    <td>{h.n}</td>
                    <td className="l"><Freq p={h.win} /></td>
                    <td><Pct v={h.returns?.median} digits={1} /></td>
                    <td><Pct v={h.drawdowns?.median} digits={1} /></td>
                    <td><Pct v={h.runups?.median} digits={1} /></td>
                    <td className="muted lab-left">{h.overlapDropped} overlap, {h.notMatured} not matured{h.unavailable ? `, ${h.unavailable} no entry` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Disclosure summary={`Entries (${study.clusters.length})`}>
            <DataTable caption="Entries with benchmark return by horizon" rows={rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)} cols={cols} rowKey={(c) => c.anchorDate} />
            <Pager page={Math.min(page, pages - 1)} pages={pages} total={rows.length} noun="entries" onPage={setPage} />
          </Disclosure>
        </>
      )}
    </Card>
  );
}

export function SentimentTab() {
  const r = useResearch();
  const [sp, patch] = useParamPatch();
  const spy = useBars('SPY', r.asOf ?? undefined);
  const spyBars = spy.status === 'ready' && !isNa(spy.data) ? spy.data : null;
  const fixture = isFixtureMode();
  const score = useAsync<SentimentFixture>(fixture && spyBars ? `sentiment-fixture:${r.asOf}` : null, async () => {
    await new Promise((res) => setTimeout(res, 0));
    return syntheticSentiment(spyBars!);
  });
  const revPct = Math.min(30, Math.max(1, Number(sp.get('rev') ?? '') || SENTIMENT_DEFAULTS.minReversal * 100));
  const entry: ClusterEntry = sp.get('ent') === 'close' ? 'signal-close' : 'next-open';
  const [swingPage, setSwingPage] = useState(0);

  const study = useMemo(() => {
    if (!spyBars || score.status !== 'ready') return null;
    const from = r.windowStart ?? '';
    const pts = score.data.points.filter((p) => p.date >= from);
    const overlay = buildOverlay(pts, spyBars, score.data.label, score.data.benchmarkLabel);
    return {
      overlay,
      swings: swingsWithScores(overlay, revPct / 100),
      fear: clusterStudy(overlay, spyBars, 'fear', { entry }),
      greed: clusterStudy(overlay, spyBars, 'greed', { entry }),
    };
  }, [spyBars, score, r.windowStart, revPct, entry]);

  const chart = useMemo(() => {
    if (!study || study.overlay.rows.length < 2) return null;
    const rows = study.overlay.rows;
    const stock = new Map<string, number>(r.symbol === 'SPY' ? [] : r.bars.map((b: Bar) => [b.date, b.close]));
    const b0 = rows[0]!.close;
    let s0: number | null = null;
    const stockPts = rows.map((row, i) => {
      const c = stock.get(row.date);
      if (c === undefined) return { x: i, y: null };
      if (s0 === null) s0 = c;
      return { x: i, y: (c / s0) * 100 };
    });
    const markers: Marker[] = study.swings.swings.map((s) => ({ x: s.turnIndex, y: (s.turnClose / b0) * 100, color: s.kind === 'high' ? 'var(--down)' : 'var(--up)' }));
    return {
      score: rows.map((row, i) => ({ x: i, y: row.score })),
      bench: rows.map((row, i) => ({ x: i, y: (row.close / b0) * 100 })),
      stock: stockPts,
      hasStock: s0 !== null,
      markers,
      label: (x: number) => fmtDate(rows[Math.round(x)]?.date),
      ticks: [0, Math.floor((rows.length - 1) / 2), rows.length - 1],
    };
  }, [study, r.bars, r.symbol]);

  if (!fixture) return <StateNote tone="warn" title="No sentiment source is connected.">A sourced score history is required. Nothing is shown in its place.</StateNote>;
  if (spy.status === 'loading' || (spyBars && score.status === 'loading')) return <Skeleton h={320} />;
  if (spy.status === 'error' || !spyBars) {
    return (
      <StateNote tone="error" title="Benchmark history is unavailable." action={<button type="button" className="btn small" onClick={spy.reload}>Retry</button>}>
        {spy.status === 'error' ? spy.error.message : spy.status === 'ready' && isNa(spy.data) ? reasonDetail(spy.data) : ''} The sentiment study needs SPY closes.
      </StateNote>
    );
  }
  if (score.status === 'error') return <StateNote tone="error" title="The score series could not be built." action={<button type="button" className="btn small" onClick={score.reload}>Retry</button>}>{score.error.message}</StateNote>;
  if (score.status !== 'ready' || !study || !chart) return <StateNote>Fewer than two sessions have both a score and a benchmark close in this window. Choose a longer history window.</StateNote>;

  const last = study.overlay.rows[study.overlay.rows.length - 1]!;
  const sw = study.swings;
  const lastSwing = sw.swings[sw.swings.length - 1];
  const swingRows = [...sw.swings].reverse();
  const swingPages = Math.max(1, Math.ceil(swingRows.length / PAGE_SIZE));
  const swingCols: Column<SwingWithScore>[] = [
    { key: 'k', header: 'Swing', sticky: true, cell: (s) => `${s.kind === 'high' ? 'High' : 'Low'}${s.leading ? ', first in window' : ''}` },
    { key: 't', header: 'Turning date', cell: (s) => <span className="num">{fmtDate(s.turnDate)} at {fmtPrice(s.turnClose)}</span> },
    { key: 'c', header: 'Confirmed', info: 'First later close that completed the reversal. The swing is known only from this date.', cell: (s) => fmtDate(s.confirmDate) },
    { key: 'r', header: 'Reversal', cell: (s) => <Pct v={s.reversal} digits={1} /> },
    { key: 's', header: 'Score that session', cell: (s) => (isNa(s.sameSessionScore) ? <span className="faint">n/a</span> : <ZoneTag score={s.sameSessionScore} />) },
    {
      key: 'a',
      header: 'Nearby alternative',
      info: `The most extreme score within ${SENTIMENT_DEFAULTS.nearbySessions} sessions when it falls on another date. It never replaces the turning session score.`,
      cell: (s) => (s.nearbyAlternative ? <span className="num">{fmtNum(s.nearbyAlternative.score, 1)} on {fmtDate(s.nearbyAlternative.date)}</span> : <span className="faint">none</span>),
    },
  ];

  return (
    <div className="stack">
      <StateNote tone="warn" title={score.data.label}>
        {score.data.method} Generated from the synthetic SPY series for testing. Benchmark: {score.data.benchmarkLabel}.
      </StateNote>
      <Card
        title="Sentiment score and benchmark"
        sub={`${fmtDate(study.overlay.first)} to ${fmtDate(study.overlay.last)}, ${fmtInt(study.overlay.rows.length)} sessions with both a score and a close.`}
        actions={
          <div className="row">
            <label className="field">
              Swing reversal, %
              <input className="input lab-num" type="number" min={1} max={30} step="0.5" value={revPct} onChange={(e) => patch({ rev: Number(e.target.value) === SENTIMENT_DEFAULTS.minReversal * 100 || !e.target.value ? null : e.target.value })} />
            </label>
            <label className="field">
              Outcome entry
              <Segmented label="Outcome entry" value={entry} options={[{ value: 'next-open', label: 'Next open' }, { value: 'signal-close', label: 'Same close' }]} onChange={(v) => patch({ ent: v === 'signal-close' ? 'close' : null })} />
            </label>
          </div>
        }
      >
        <div className="stats" style={{ marginBottom: 12 }}>
          <Stat label="Score" value={<>{fmtNum(last.score, 1)} <Chip tone={zoneTone(last.zone)}>{zoneLabel(last.zone)}</Chip></>} sub={fmtDate(last.date)} />
          <Stat
            label="Last confirmed swing"
            info={`A benchmark close followed by a close to close reversal of at least ${fmtPct(sw.minReversal, 1, false)}.`}
            value={lastSwing ? `${lastSwing.kind === 'high' ? 'High' : 'Low'}, ${fmtDate(lastSwing.turnDate)}` : 'None'}
            sub={lastSwing ? <>Confirmed {fmtDate(lastSwing.confirmDate)}. Score that session {isNa(lastSwing.sameSessionScore) ? 'n/a' : fmtNum(lastSwing.sameSessionScore, 1)}</> : `No reversal of ${fmtPct(sw.minReversal, 1, false)} in this window`}
          />
          <Stat
            label="Unconfirmed extreme"
            info="The latest benchmark extreme that no later close has confirmed. It is not a swing and may be replaced."
            value={sw.pending ? `${sw.pending.kind === 'high' ? 'High' : 'Low'}, ${fmtDate(sw.pending.date)}` : 'None'}
            sub={sw.pending ? `Unconfirmed. Move since ${fmtPct(sw.pending.moveSoFar, 1)}, needs ${fmtPct(sw.minReversal, 1, false)}` : undefined}
          />
          <Stat label="Extreme entries" value={`${study.fear.clusters.length} fear, ${study.greed.clusters.length} greed`} sub="First session of each stretch" />
        </div>
        <LineChart
          ariaLabel={`Sentiment score from ${fmtDate(study.overlay.first)} to ${fmtDate(study.overlay.last)}. Latest ${fmtNum(last.score, 1)}, ${zoneLabel(last.zone)}`}
          series={[{ id: 'score', label: 'Score', points: chart.score, width: 1.4 }]}
          xLabel={chart.label}
          xTicks={chart.ticks}
          yFormat={(y) => fmtNum(y, 0)}
          yDomain={[0, 100]}
          height={190}
          hLines={SENTIMENT_DEFAULTS.thresholds.map((t) => ({ y: t, label: String(t) }))}
        />
        <div className="row" style={{ gap: 6, margin: '6px 0 14px' }}>
          {ZONE_LEGEND.map((z) => (
            <span key={z.zone} className="lab-zone">
              <i className={`lab-z-${z.zone}`} />
              {z.label}. <span className="muted">{z.range}</span>
            </span>
          ))}
          <span className="muted small">A boundary value belongs to the less extreme zone. Proposed convention, the provider convention is not verified.</span>
        </div>
        <LineChart
          ariaLabel={`Benchmark${chart.hasStock ? ` and ${r.symbol}` : ''} price return paths, each starting at 100, with confirmed benchmark swings marked`}
          series={[
            { id: 'bench', label: 'SPY', points: chart.bench },
            ...(chart.hasStock ? [{ id: 'stock', label: r.symbol, points: chart.stock, color: 'var(--gold-line)' }] : []),
          ]}
          markers={chart.markers}
          xLabel={chart.label}
          xTicks={chart.ticks}
          yFormat={(y) => fmtNum(y, 0)}
          height={220}
        />
        <p className="muted small">
          Price return, each line starts at 100 on its first session in view. Dots are confirmed benchmark swing highs and lows at their turning dates.
          {r.symbol !== 'SPY' && !chart.hasStock && ` ${r.symbol} has no closes in this window.`}
        </p>
        <Disclosure summary={`Confirmed swings (${sw.swings.length})`}>
          <DataTable caption="Confirmed benchmark swings with turning and confirmation dates" rows={swingRows.slice(swingPage * PAGE_SIZE, (swingPage + 1) * PAGE_SIZE)} cols={swingCols} rowKey={(s) => `${s.kind}${s.turnDate}`} empty="No confirmed swing in this window." />
          <Pager page={Math.min(swingPage, swingPages - 1)} pages={swingPages} total={swingRows.length} noun="swings" onPage={setSwingPage} />
        </Disclosure>
      </Card>
      <div className="grid">
        <ClusterCard study={study.fear} symbol={r.symbol} />
        <ClusterCard study={study.greed} symbol={r.symbol} />
      </div>
    </div>
  );
}
