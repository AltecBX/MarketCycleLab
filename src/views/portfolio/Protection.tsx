/** Protection planner. Hypothetical payoff scenarios for one holding. Nothing is sent to a broker. */
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { researchPath } from '../../app/routes';
import { useBundle } from '../../data/client';
import { newId, useWorkspace } from '../../data/workspace';
import { addDays, fridayOf, sessionOnOrBefore, toDayNum } from '../../engine/core/calendar';
import { isNa } from '../../engine/core/types';
import { freezeScenario, maxCoveredContracts, payoffAt, payoffCurve, preExpiryScenario, summarizePlan, upsideSurrenderedAt, validatePlan, type OptionLeg, type ProtectionPlan } from '../../engine/protection';
import { LineChart } from '../../ui/charts';
import { Card, Chip, Disclosure, Segmented, Skeleton, Stat, StateNote } from '../../ui/components';
import { fmtDate, fmtDollars, fmtNum, fmtPct, fmtPrice, reasonDetail } from '../../ui/format';
import { markOf, parseNum, storageScopeText, useResolver } from './shared/data';
import { Field, NumInput, SymbolPicker } from './shared/ui';
import './shared/pf.css';

type Strategy = 'shares' | 'trim' | 'call' | 'put' | 'collar';
const STRATEGIES: { value: Strategy; label: string }[] = [
  { value: 'shares', label: 'Shares only' },
  { value: 'trim', label: 'Trim' },
  { value: 'call', label: 'Covered call' },
  { value: 'put', label: 'Protective put' },
  { value: 'collar', label: 'Collar' },
];
const isStrategy = (s: string | null): s is Strategy => STRATEGIES.some((x) => x.value === s);

export default function Protection() {
  const [ws, update] = useWorkspace();
  const [sp, setSp] = useSearchParams();
  const { instruments, resolve } = useResolver();
  const [saved, setSaved] = useState<{ tone: 'info' | 'warn' | 'error'; text: string } | null>(null);

  const longs = ws.positions.filter((p) => p.shares > 0);
  const symParam = sp.get('sym')?.toUpperCase() ?? null;
  const symbol = symParam ?? longs[0]?.symbol ?? null;
  const held = longs.find((p) => p.symbol === symbol);
  const strategy: Strategy = isStrategy(sp.get('st')) ? (sp.get('st') as Strategy) : 'collar';
  const get = (k: string) => sp.get(k) ?? '';
  const set = (patch: Record<string, string | null>) => {
    const n = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') n.delete(k);
      else n.set(k, v);
    }
    setSp(n, { replace: true });
    setSaved(null);
  };

  const b = useBundle(symbol);
  const bundle = b.status === 'ready' && !isNa(b.data) ? b.data : null;
  const mark = bundle ? markOf(bundle) : null;
  const spot = mark && !isNa(mark) ? mark : null;

  const sharesText = sp.has('sh') ? get('sh') : held ? String(held.shares) : '';
  const shares = parseNum(sharesText);
  const defaultExpiry = spot ? sessionOnOrBefore(fridayOf(addDays(spot.date, 35))) : '';
  const expiry = get('exp') || defaultExpiry;
  const maxC = shares !== null ? maxCoveredContracts(shares - (strategy === 'trim' ? (parseNum(get('ts')) ?? 0) : 0)) : 0;
  const useCall = strategy === 'call' || strategy === 'collar';
  const usePut = strategy === 'put' || strategy === 'collar';
  const ck = parseNum(get('ck'));
  const cp = parseNum(get('cp'));
  const cn = sp.has('cn') ? parseNum(get('cn')) : maxC || null;
  const pk = parseNum(get('pk'));
  const pp = parseNum(get('pp'));
  const pn = sp.has('pn') ? parseNum(get('pn')) : maxC || null;
  const fee = parseNum(get('fee')) ?? 0;

  const missing: string[] = [];
  if (shares === null) missing.push('shares held');
  if (useCall) { if (ck === null) missing.push('call strike'); if (cp === null) missing.push('call premium'); if (cn === null) missing.push('call contracts'); }
  if (usePut) { if (pk === null) missing.push('put strike'); if (pp === null) missing.push('put premium'); if (pn === null) missing.push('put contracts'); }
  if (strategy === 'trim' && parseNum(get('ts')) === null) missing.push('shares to trim');

  const plan = useMemo<ProtectionPlan | null>(() => {
    if (!spot || shares === null || missing.length > 0) return null;
    const p: ProtectionPlan = { shares, spot: spot.close, spotDate: spot.date, feePerContract: fee };
    if (useCall) p.call = { kind: 'call', side: 'short', strike: ck!, premium: cp!, contracts: cn!, expiry } satisfies OptionLeg;
    if (usePut) p.put = { kind: 'put', side: 'long', strike: pk!, premium: pp!, contracts: pn!, expiry } satisfies OptionLeg;
    if (strategy === 'trim') {
      p.trim = { shares: parseNum(get('ts'))!, price: parseNum(get('tp')) ?? spot.close, costs: parseNum(get('tc')) ?? 0 };
    }
    return p;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spot?.close, spot?.date, sp.toString(), held?.shares]);

  const issues = plan && spot ? validatePlan(plan, spot.date) : [];
  const errors = issues.filter((i) => i.severity === 'error');
  const budget = ws.settings.lossBudget ?? undefined;
  const summary = plan && spot && errors.length === 0 ? summarizePlan(plan, spot.date, { lossBudget: budget }) : null;
  const sum = summary && !isNa(summary) ? summary : null;

  const chart = useMemo(() => {
    if (!plan || !sum) return null;
    const ks = [plan.spot, plan.call?.strike, plan.put?.strike].filter((x): x is number => typeof x === 'number');
    const lo = Math.max(0, Math.min(plan.spot * 0.5, ...ks.map((k) => k * 0.8)));
    const hi = Math.max(plan.spot * 1.5, ...ks.map((k) => k * 1.2));
    const curve = payoffCurve(plan, lo, hi, 100);
    for (const k of ks) curve.push(payoffAt(plan, k));
    curve.sort((a, c) => a.price - c.price);
    return { curve, lo, hi };
  }, [plan, sum]);

  const ladder = plan ? [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3].map((m) => ({ m, p: payoffAt(plan, plan.spot * (1 + m)), up: upsideSurrenderedAt(plan, plan.spot * (1 + m)) })) : [];

  // Pre expiry model scenario
  const iv = parseNum(get('iv')) ?? 45;
  const rate = parseNum(get('r')) ?? 4;
  const daysTotal = spot && expiry ? Math.max(0, toDayNum(expiry) - toDayNum(spot.date)) : 0;
  const daysLeft = Math.min(daysTotal, parseNum(get('dl')) ?? Math.round(daysTotal / 2));
  const mpx = parseNum(get('px')) ?? (spot ? Math.round(spot.close * 0.9 * 100) / 100 : 0);
  const model = plan && (plan.call || plan.put) && errors.length === 0 ? preExpiryScenario(plan, { price: mpx, callYears: daysLeft / 365, putYears: daysLeft / 365, iv: iv / 100, rate: rate / 100 }) : null;

  const save = () => {
    if (!plan || !spot || !bundle || !symbol) return;
    const id = newId();
    const now = new Date().toISOString();
    const rec = freezeScenario({ id, createdAt: now, asOf: spot.date, symbol, instrumentId: bundle.instrument.id, plan, premiumBasis: { ...(plan.call ? { call: 'manual' as const } : {}), ...(plan.put ? { put: 'manual' as const } : {}) }, ...(budget !== undefined ? { lossBudget: budget } : {}) });
    if (isNa(rec)) return setSaved({ tone: 'error', text: reasonDetail(rec) });
    const label = STRATEGIES.find((s) => s.value === strategy)!.label;
    const ok = update((w) => ({ ...w, journal: [...w.journal, { id, createdAt: now, symbol, kind: 'note', text: `Protection scenario saved: ${symbol}, ${label}, ${plan.shares} shares at ${fmtPrice(plan.spot)} on ${spot.date}. Hypothetical.`, payload: { type: 'protection-scenario', strategy, ...JSON.parse(JSON.stringify(rec)) } }] }));
    setSaved(ok ? { tone: 'info', text: 'Scenario saved to the journal as a fixed record. Later changes here do not alter it.' } : { tone: 'warn', text: 'Another tab changed your workspace first. The latest copy is loaded. Save again.' });
  };

  const pickSymbol = (s: string) => {
    const r = resolve(s);
    const n = new URLSearchParams();
    n.set('sym', isNa(r) ? s : r.symbol);
    n.set('st', strategy);
    setSp(n, { replace: true });
  };

  return (
    <div className="stack">
      <div className="pf-head">
        <h1>Protection planner</h1>
        <span className="pf-health">Hypothetical scenarios only. Nothing here is a quote, a fill or an order, and nothing is sent to a broker.</span>
      </div>

      <Card title="Holding and structure">
        <div className="pf-stack-sm">
          <div className="pf-form">
            <Field label="Holding">
              {longs.length > 0 ? (
                <select className="select" aria-label="Holding" value={held ? held.symbol : '__manual'} onChange={(e) => (e.target.value === '__manual' ? setSp(new URLSearchParams({ sym: symbol ?? '', st: strategy, sh: sharesText }), { replace: true }) : pickSymbol(e.target.value))}>
                  {longs.map((p) => <option key={p.symbol} value={p.symbol}>{p.symbol}, {fmtNum(p.shares, 0)} shares</option>)}
                  <option value="__manual">{held ? 'Another stock' : `${symbol ?? 'Manual'}, manual entry`}</option>
                </select>
              ) : (
                <SymbolPicker instruments={instruments} label="Stock for the scenario" onPick={pickSymbol} value={symbol ?? ''} clearOnPick={false} key={symbol ?? 'none'} />
              )}
            </Field>
            {longs.length > 0 && !held && <Field label="Stock"><SymbolPicker instruments={instruments} label="Stock for the scenario" onPick={pickSymbol} value={symbol ?? ''} clearOnPick={false} key={symbol ?? 'none'} /></Field>}
            <Field label="Shares held" hint={held ? `From your positions: ${fmtNum(held.shares, 0)}` : 'Manual entry'}><NumInput label="Shares held" value={sharesText} onChange={(v) => set({ sh: v })} min="0" /></Field>
            <Field label="Spot" hint={spot ? `Close on ${fmtDate(spot.date)}` : undefined}>
              <div className="input" style={{ display: 'flex', alignItems: 'center', background: 'var(--surface-2)' }}>{b.status === 'loading' ? 'Loading' : spot ? fmtPrice(spot.close) : 'Unavailable'}</div>
            </Field>
          </div>
          <Segmented label="Structure" value={strategy} options={STRATEGIES} onChange={(v) => set({ st: v })} />
          {strategy === 'trim' && (
            <div className="pf-form">
              <Field label="Shares to trim"><NumInput label="Shares to trim" value={get('ts')} onChange={(v) => set({ ts: v })} min="0" /></Field>
              <Field label="Sale price" hint="Defaults to spot"><NumInput label="Trim sale price" value={get('tp')} onChange={(v) => set({ tp: v })} placeholder={spot ? spot.close.toFixed(2) : ''} /></Field>
              <Field label="Sale costs, dollars"><NumInput label="Trim costs" value={get('tc')} onChange={(v) => set({ tc: v })} placeholder="0" min="0" /></Field>
            </div>
          )}
          {(useCall || usePut) && (
            <>
              <div className="row">
                <Chip tone="warn">Option quotes unavailable</Chip>
                <span className="small muted">No option data source is connected. Premiums below are your own assumptions, per share.</span>
              </div>
              <div className="pf-form">
                {useCall && (
                  <>
                    <Field label="Call strike" hint="Short call"><NumInput label="Call strike" value={get('ck')} onChange={(v) => set({ ck: v })} placeholder={spot ? (spot.close * 1.1).toFixed(0) : ''} /></Field>
                    <Field label="Call premium received" hint="Assumption"><NumInput label="Call premium" value={get('cp')} onChange={(v) => set({ cp: v })} min="0" /></Field>
                    <Field label="Call contracts" hint={`${maxC} fully covered by shares`}><NumInput label="Call contracts" value={sp.has('cn') ? get('cn') : maxC ? String(maxC) : ''} onChange={(v) => set({ cn: v })} step="1" min="0" /></Field>
                  </>
                )}
                {usePut && (
                  <>
                    <Field label="Put strike" hint="Long put"><NumInput label="Put strike" value={get('pk')} onChange={(v) => set({ pk: v })} placeholder={spot ? (spot.close * 0.9).toFixed(0) : ''} /></Field>
                    <Field label="Put premium paid" hint="Assumption"><NumInput label="Put premium" value={get('pp')} onChange={(v) => set({ pp: v })} min="0" /></Field>
                    <Field label="Put contracts" hint={`${maxC} match the shares`}><NumInput label="Put contracts" value={sp.has('pn') ? get('pn') : maxC ? String(maxC) : ''} onChange={(v) => set({ pn: v })} step="1" min="0" /></Field>
                  </>
                )}
                <Field label="Expiry"><input className="input" type="date" aria-label="Expiry" value={expiry} min={spot ? addDays(spot.date, 1) : undefined} onChange={(e) => set({ exp: e.target.value })} /></Field>
                <Field label="Fee per contract"><NumInput label="Fee per contract" value={get('fee')} onChange={(v) => set({ fee: v })} placeholder="0" min="0" /></Field>
              </div>
            </>
          )}
        </div>
      </Card>

      {!symbol && <StateNote>Pick a stock to plan. Holdings come from <Link to="/portfolio">Positions</Link>, or enter shares by hand.</StateNote>}
      {symbol && b.status === 'loading' && <Skeleton h={200} />}
      {symbol && b.status === 'ready' && !spot && (
        <StateNote tone="error" title={`No completed close for ${symbol}.`}>{isNa(b.data) ? reasonDetail(b.data) : mark && isNa(mark) ? reasonDetail(mark) : 'Unavailable.'} <Link to="/data">See source status</Link></StateNote>
      )}
      {spot && missing.length > 0 && <StateNote>Enter {missing.join(', ')} to see the payoff.</StateNote>}
      {errors.length > 0 && (
        <StateNote tone="error" title="The plan cannot be calculated.">
          <ul className="pf-issues" style={{ marginTop: 6 }}>{errors.map((e, i) => <li key={i}>{e.message}</li>)}</ul>
        </StateNote>
      )}

      {plan && sum && chart && spot && (
        <>
          <Card
            title="Payoff at expiry"
            sub={`Signed dollar change from the ${fmtPrice(plan.spot)} close on ${fmtDate(spot.date)}, at each possible price on ${plan.call || plan.put ? fmtDate(expiry) : 'a later date'}. Hypothetical.`}
            actions={<button type="button" className="btn small" onClick={save}>Save scenario to journal</button>}
          >
            <div className="pf-stack-sm">
              {saved && <StateNote tone={saved.tone}>{saved.text} {saved.tone === 'info' && <Link to="/portfolio/journal">Open journal</Link>}</StateNote>}
              <div className="stats">
                <Stat label="Largest loss" value={sum.lossUnbounded ? 'Uncapped' : fmtDollars(sum.maxLoss, true)} tone="down" sub={sum.lossUnbounded ? 'Short calls exceed shares' : `at ${fmtPrice(sum.maxLossPrice)}`} />
                <Stat label="Largest gain" value={sum.gainUnbounded ? 'Uncapped' : fmtDollars(sum.maxGain, true)} tone="up" sub={sum.gainUnbounded ? 'Shares keep upside' : `at ${fmtPrice(sum.maxGainPrice)} and above`} />
                <Stat label="Breakeven" info="Expiry prices where the net change from today's close is zero." value={sum.breakevens.length ? sum.breakevens.map((x) => fmtPrice(x)).join(', ') : 'None'} sub={sum.breakevens.length === 1 ? `${fmtPct(sum.breakevens[0]! / plan.spot - 1, 1)} from spot` : undefined} />
                {(plan.call || plan.put) && <Stat label="Net premium" info="Call premium received minus put premium paid, before fees." value={fmtDollars(sum.netPremium, true)} sub={`Fees ${fmtDollars(sum.fees)}. Net ${fmtDollars(sum.netPremium - sum.fees, true)}`} />}
                {sum.effectiveCallSalePrice !== null && <Stat label="Sale price if called" value={fmtPrice(sum.effectiveCallSalePrice)} sub="Strike plus premium" />}
                {sum.effectivePutFloor !== null && <Stat label="Floor under the put" value={fmtPrice(sum.effectivePutFloor)} sub="Strike minus premium" />}
                <Stat label="Coverage" value={`${sum.coverage.maxCoveredContracts} contracts max`} sub={`${sum.coverage.remainingShares} shares after trim. ${sum.coverage.sharesWithoutPut} without a put, ${sum.coverage.sharesWithoutCall} without a call${sum.coverage.uncoveredCallContracts ? `, ${sum.coverage.uncoveredCallContracts} calls uncovered` : ''}`} />
              </div>
              <LineChart
                ariaLabel={`Payoff at expiry for ${symbol}. ${sum.lossUnbounded ? 'Loss is uncapped' : `Largest loss ${fmtDollars(sum.maxLoss, true)}`}, ${sum.gainUnbounded ? 'gain is uncapped' : `largest gain ${fmtDollars(sum.maxGain, true)}`}`}
                series={[
                  { id: 'plan', label: 'This plan, net', points: chart.curve.map((p) => ({ x: p.price, y: p.net })), width: 2.2 },
                  { id: 'shares', label: 'Shares only', color: 'var(--text-3)', dashed: true, points: chart.curve.map((p) => ({ x: p.price, y: p.sharesOnly })) },
                ]}
                xLabel={(x) => fmtPrice(x)}
                yFormat={(y) => fmtDollars(y, true)}
                xTicks={[chart.lo, plan.spot, chart.hi]}
                zeroLine
                vLines={[{ x: plan.spot, label: 'Spot', color: 'var(--text-3)' }, ...(plan.put ? [{ x: plan.put.strike, label: 'Put' }] : []), ...(plan.call ? [{ x: plan.call.strike, label: 'Call' }] : [])]}
                hLines={budget !== undefined && budget > 0 ? [{ y: -budget, label: 'Loss budget', color: 'var(--down)' }] : []}
                height={280}
              />
              <div className="table-wrap" tabIndex={0} role="region" aria-label="Payoff at selected prices">
                <table className="data">
                  <caption className="sr-only">Payoff at selected expiry prices</caption>
                  <thead>
                    <tr><th className="l sticky" scope="col">Expiry price</th><th scope="col">Move</th><th scope="col">Shares only</th><th scope="col">Plan, gross</th><th scope="col">Plan, net</th><th scope="col">Upside given up</th></tr>
                  </thead>
                  <tbody>
                    {ladder.map((l) => (
                      <tr key={l.m}>
                        <td className="l sticky">{fmtPrice(l.p.price)}</td>
                        <td>{fmtPct(l.m, 0)}</td>
                        <td className={l.p.sharesOnly < 0 ? 'down' : l.p.sharesOnly > 0 ? 'up' : ''}>{fmtDollars(l.p.sharesOnly, true)}</td>
                        <td>{fmtDollars(l.p.gross, true)}</td>
                        <td className={l.p.net < 0 ? 'down' : l.p.net > 0 ? 'up' : ''}><strong>{fmtDollars(l.p.net, true)}</strong></td>
                        <td>{l.up > 0 ? fmtDollars(l.up) : <span className="faint">None</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {issues.length > 0 && (
                <ul className="pf-issues">
                  {issues.map((i, k) => <li key={k}><Chip tone="warn">Note</Chip><span>{i.message}</span></li>)}
                </ul>
              )}
              <Disclosure summary="Assumptions behind these figures">
                <ul className="muted small" style={{ margin: 0, paddingLeft: 18 }}>
                  {sum.notes.map((n, i) => <li key={i}>{n}</li>)}
                  <li>Premiums are manual assumptions. A real order would trade at the market's bid or ask, which this build cannot see.</li>
                  <li>One standard contract covers 100 shares. Adjusted contracts are not supported.</li>
                </ul>
              </Disclosure>
            </div>
          </Card>

          <div className="grid">
            <Card title="Against your loss budget" sub={budget === undefined ? undefined : `Budget ${fmtDollars(budget)}, set on Positions. ${storageScopeText()}`}>
              {!sum.lossBudget ? (
                <p className="muted">No loss budget is set. <Link to="/portfolio">Set one on Positions</Link> to compare this plan with it.</p>
              ) : (
                <dl className="kv">
                  <dt>Shares alone lose the budget at</dt>
                  <dd>{isNa(sum.lossBudget.sharesOnlyBudgetPrice) ? reasonDetail(sum.lossBudget.sharesOnlyBudgetPrice) : `${fmtPrice(sum.lossBudget.sharesOnlyBudgetPrice)} (${fmtPct(sum.lossBudget.sharesOnlyBudgetPrice / plan.spot - 1, 1)})`}</dd>
                  <dt>This plan at that price</dt>
                  <dd>{isNa(sum.lossBudget.planChangeAtThatPrice) ? 'n/a' : fmtDollars(sum.lossBudget.planChangeAtThatPrice, true)}</dd>
                  <dt>This plan loses the budget at</dt>
                  <dd>{isNa(sum.lossBudget.planBudgetPrice) ? 'Never, at or below spot' : `${fmtPrice(sum.lossBudget.planBudgetPrice)} (${fmtPct(sum.lossBudget.planBudgetPrice / plan.spot - 1, 1)})`}</dd>
                  <dt>Worst case</dt>
                  <dd>{sum.lossBudget.worstCaseInsideBudget ? 'Stays inside the budget' : sum.lossUnbounded ? 'Uncapped, exceeds the budget' : `${fmtDollars(sum.maxLoss, true)}, exceeds the budget`}</dd>
                </dl>
              )}
            </Card>

            {(plan.call || plan.put) && (
              <Card title="Before expiry, model scenario" info="Black Scholes, European exercise, zero dividends. The volatility, rate and date are your hypothetical inputs. This is a model value, never a quote." sub="Model scenario, not a quote.">
                <div className="pf-stack-sm">
                  <div className="pf-form">
                    <Field label="Stock price"><NumInput label="Scenario stock price" value={sp.has('px') ? get('px') : String(mpx)} onChange={(v) => set({ px: v })} /></Field>
                    <Field label="Days to expiry" hint={`${daysTotal} from the close`}><NumInput label="Days left to expiry" value={sp.has('dl') ? get('dl') : String(daysLeft)} onChange={(v) => set({ dl: v })} step="1" min="0" /></Field>
                    <Field label="Volatility, %" hint="Hypothetical"><NumInput label="Hypothetical volatility" value={sp.has('iv') ? get('iv') : String(iv)} onChange={(v) => set({ iv: v })} /></Field>
                    <Field label="Rate, %" hint="Hypothetical"><NumInput label="Hypothetical rate" value={sp.has('r') ? get('r') : String(rate)} onChange={(v) => set({ r: v })} /></Field>
                  </div>
                  {model === null ? null : isNa(model) ? (
                    <StateNote tone="warn">{reasonDetail(model)}</StateNote>
                  ) : (
                    <dl className="kv">
                      <dt>Net change</dt><dd><strong className={model.net < 0 ? 'down' : 'up'}>{fmtDollars(model.net, true)}</strong> at {fmtPrice(model.price)} with {daysLeft} days left</dd>
                      <dt>Shares</dt><dd>{fmtDollars(model.shares, true)}</dd>
                      {model.callModelValue !== null && (<><dt>Short call</dt><dd>{fmtDollars(model.call, true)}, model value {fmtPrice(model.callModelValue)} per share</dd></>)}
                      {model.putModelValue !== null && (<><dt>Long put</dt><dd>{fmtDollars(model.put, true)}, model value {fmtPrice(model.putModelValue)} per share</dd></>)}
                      <dt>Shares only</dt><dd>{fmtDollars(plan.shares * (model.price - plan.spot), true)}</dd>
                    </dl>
                  )}
                </div>
              </Card>
            )}
          </div>
          <p className="small muted">Research this holding: <Link to={researchPath(symbol!, 'selloffs')}>selloff history</Link>, <Link to={researchPath(symbol!, 'earnings')}>earnings reactions</Link>.</p>
        </>
      )}
    </div>
  );
}
