/** Weekly Range Engine. Fixture mode has no option or IV source, so both engines are honestly unavailable. */
import { useMemo, useState } from 'react';
import { RequireBars, useResearch } from '../../../app/research';
import { addDays, holidayName, isSession, weekdayName } from '../../../engine/core/calendar';
import { isNa } from '../../../engine/core/types';
import {
  BROWNIAN_MODEL_EXCLUSIONS, BROWNIAN_MODEL_NAME, WEEKLY_RANGE_SPEC, checkImpliedMove, checkIv30, engineAForecast, forecastContext, inspectStrike, realizedScale,
  type ImpliedMoveInput,
} from '../../../engine/weeklyRange';
import { Card, Chip, Info, Pct, Stat, StateNote } from '../../../ui/components';
import { fmtDate, fmtDateShort, fmtPct, fmtPrice, reasonDetail } from '../../../ui/format';

function Body() {
  const r = useResearch();
  const [moveText, setMoveText] = useState('');
  const [strikeText, setStrikeText] = useState('');

  const base = useMemo(() => {
    const ctx = forecastContext(r.bars);
    if (isNa(ctx)) return { ctx, sReal: ctx } as const;
    return { ctx, sReal: realizedScale(r.bars, ctx.anchorIndex, ctx.sessionCount) } as const;
  }, [r.bars]);

  const { ctx, sReal } = base;
  if (isNa(ctx)) return <StateNote tone="warn" title="No forecast week can be set up.">{reasonDetail(ctx)}</StateNote>;

  const days = [0, 1, 2, 3, 4].map((k) => addDays(ctx.weekStart, k));
  const windowFrom = r.bars[ctx.anchorIndex - WEEKLY_RANGE_SPEC.lookbackSessions + 1]?.date ?? null;
  const aReason = checkImpliedMove(ctx, null);
  const bReason = checkIv30(ctx, null);

  const move = Number(moveText);
  const moveOk = moveText.trim() !== '' && Number.isFinite(move) && move > 0 && move < 100;
  const hypo = (() => {
    if (!moveOk || isNa(sReal)) return null;
    const input: ImpliedMoveInput = {
      impliedMoveFraction: move / 100,
      expiry: ctx.weekEnd,
      quoteDate: ctx.anchorDate,
      verified: false,
      source: { provider: 'what-if', kind: 'owner-input', capturedAt: r.clock.now, version: 'what-if', note: 'Hypothetical input, not a forecast' },
    };
    return engineAForecast(ctx, sReal, { sOpt: input.impliedMoveFraction / WEEKLY_RANGE_SPEC.absNormalMean, dte: 0, expiry: ctx.weekEnd }, input);
  })();
  const strike = Number(strikeText);
  const insp = hypo && strikeText.trim() !== '' ? inspectStrike(hypo, strike) : null;

  return (
    <div className="stack">
      <div className="grid-2">
        <Card title="Forecast week" sub={`Week of ${fmtDate(ctx.weekStart)}, anchored on the prior week's last completed close.`}>
          <div className="stack" style={{ gap: 12 }}>
            <div className="stats">
              <Stat label="Anchor close C" value={fmtPrice(ctx.close)} sub={fmtDate(ctx.anchorDate)} />
              <Stat label="Sessions T" value={ctx.sessionCount} sub={`${fmtDateShort(ctx.sessions[0])} to ${fmtDateShort(ctx.weekEnd)}`} />
              <Stat
                label="Realized scale S real"
                info="Square root of T times the mean of the last 20 sessions of a range based daily variance: overnight move squared, plus half the high to low log range squared, minus (2 ln 2 minus 1) times the open to close move squared."
                value={isNa(sReal) ? 'n/a' : fmtPct(sReal, 2, false)}
                sub={isNa(sReal) ? reasonDetail(sReal) : `Log scale for the week. Window ${fmtDateShort(windowFrom)} to ${fmtDateShort(ctx.anchorDate)}`}
              />
            </div>
            <div className="fc-days" role="list" aria-label="Sessions of the forecast week">
              {days.map((d) => {
                const open = isSession(d);
                const early = ctx.earlyCloses.includes(d);
                return (
                  <div key={d} className="fc-day" data-open={open} role="listitem">
                    <strong>{weekdayName(d)}</strong>
                    {fmtDateShort(d)}
                    <div>{open ? (early ? 'Closes 1:00pm ET' : 'Session') : `Closed. ${holidayName(d) ?? 'Holiday'}`}</div>
                  </div>
                );
              })}
            </div>
            {ctx.weekInProgress && <StateNote>This week has already started in the loaded history. A live forecast is frozen after the prior week's close and is not redrawn mid week.</StateNote>}
          </div>
        </Card>
        <Card title="Before this can go live">
          <ol className="fc-check">
            <li>Approved provider key held on the server, never in the browser.</li>
            <li>The supplied backtest reproduced, including the strict forecast date embargo.</li>
            <li>Frozen forecast capture on schedule, Friday 4:30pm ET, or the prior actual close in a holiday week. One immutable record per stock and forecast date.</li>
            <li>Settlement against the full verified high, low and close of the stored sessions.</li>
          </ol>
        </Card>
      </div>
      <div className="grid">
        <Card title="Engine A" actions={<Chip>Unavailable</Chip>} sub="Blend of realized scale and the option implied weekly move.">
          <StateNote title="Missing input.">
            A verified implied move from the same week expiry ({fmtDate(ctx.weekEnd)}), with a quote dated {fmtDate(ctx.anchorDate)} and {WEEKLY_RANGE_SPEC.dteMin} to {WEEKLY_RANGE_SPEC.dteMax} days to expiry. {isNa(aReason) ? reasonDetail(aReason) : ''}. No option source is connected in this build, and an implied move is never synthesized.
          </StateNote>
        </Card>
        <Card title="Engine B" actions={<Chip>Unavailable</Chip>} sub="Fallback ridge model on realized scale, IV30 and the earnings week flag.">
          <StateNote title="Missing inputs.">
            A dated IV30 for {fmtDate(ctx.anchorDate)} ({isNa(bReason) ? reasonDetail(bReason) : 'present'}), a known earnings status for the week, and a training pool of at least {WEEKLY_RANGE_SPEC.minTrainingWeeks} mature stock weeks across at least {WEEKLY_RANGE_SPEC.minTrainingTickers} tickers. None has a source in this build.
          </StateNote>
        </Card>
      </div>
      <Card
        title="What if calculator"
        info="Type a weekly implied move to inspect the Engine A arithmetic. The result is a hypothetical scenario. It is not a forecast, is not stored and does not settle."
        actions={<Chip tone="gold">Hypothetical input, not a forecast</Chip>}
      >
        <div className="stack" style={{ gap: 12 }}>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label className="field">
              Hypothetical weekly implied move, percent
              <input className="input" inputMode="decimal" value={moveText} onChange={(e) => setMoveText(e.target.value)} placeholder="for example 6.5" style={{ width: 170 }} />
            </label>
            <label className="field">
              Strike to inspect, dollars
              <input className="input" inputMode="decimal" value={strikeText} onChange={(e) => setStrikeText(e.target.value)} placeholder={fmtPrice(ctx.close * 1.05).slice(1)} style={{ width: 170 }} disabled={!hypo} />
            </label>
          </div>
          {moveText.trim() !== '' && !moveOk && <StateNote tone="warn">Enter a positive percent below 100.</StateNote>}
          {isNa(sReal) && <StateNote tone="warn">{reasonDetail(sReal)}</StateNote>}
          {!hypo && moveText.trim() === '' && <div className="muted small">Enter an implied move to see the levels. Nothing is computed from an assumed value until you type one.</div>}
          {hypo && (
            <div className="fc-hypo stack" style={{ gap: 12 }}>
              <div className="small"><strong>Hypothetical input, not a forecast.</strong> Assumes a {fmtPct(move / 100, 2, false)} implied move for the week ending {fmtDate(ctx.weekEnd)}.</div>
              <div className="stats">
                <Stat label="Blended scale S" value={fmtPct(hypo.scale, 2, false)} sub={`S real ${fmtPct(hypo.sReal, 2, false)}, S option ${fmtPct(hypo.sOpt ?? null, 2, false)}`} />
                <Stat label="Expected high" value={fmtPrice(hypo.expectedHigh)} sub={<Pct v={hypo.expectedMoveUp} />} />
                <Stat label="Expected low" value={fmtPrice(hypo.expectedLow)} sub={<Pct v={hypo.expectedMoveDown} />} />
                <Stat
                  label="Stays inside both 10% levels all week"
                  info={`Joint range probability. ${hypo.inside10.model}. ${hypo.inside10.exclusions} This is different from a one sided touch and from a finish probability.`}
                  value={fmtPct(hypo.inside10.probability, 0, false)}
                  sub="Joint, both sides"
                />
              </div>
              <div className="table-wrap">
                <table className="data">
                  <caption className="sr-only">Hypothetical touch levels</caption>
                  <thead>
                    <tr>
                      <th className="l">Touch odds, per side <Info text="Chance that price trades through this one level at any time in the week, each side taken alone. Not the chance of finishing beyond it, and not a joint range probability." /></th>
                      <th>Lower level</th>
                      <th>From C</th>
                      <th>Upper level</th>
                      <th>From C</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hypo.levels.map((l) => (
                      <tr key={l.odds}>
                        <td className="l">{fmtPct(l.odds, 0, false)}</td>
                        <td>{fmtPrice(l.lower)}</td>
                        <td><Pct v={l.lowerPct} /></td>
                        <td>{fmtPrice(l.upper)}</td>
                        <td><Pct v={l.upperPct} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {insp && isNa(insp) && <div className="small">{reasonDetail(insp)}</div>}
              {insp && !isNa(insp) && (
                <div className="stats">
                  <Stat label={`Strike ${fmtPrice(insp.strike)}`} value={<Pct v={insp.pctFromClose} />} sub={`${insp.distance >= 0 ? '+' : '−'}$${Math.abs(insp.distance).toFixed(2)} from C`} />
                  <Stat label="One sided touch during the week" value={fmtPct(insp.touch, 0, false)} />
                  <Stat label="Finish above at the week close" value={fmtPct(insp.finishAbove, 0, false)} />
                  <Stat label="Finish at or below at the week close" value={fmtPct(insp.finishBelow, 0, false)} />
                </div>
              )}
              <div className="small">Model. {BROWNIAN_MODEL_NAME}, normal tails in log price. {BROWNIAN_MODEL_EXCLUSIONS}</div>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

export function RangeTab() {
  return (
    <RequireBars min={WEEKLY_RANGE_SPEC.requiredRows}>
      <Body />
    </RequireBars>
  );
}
