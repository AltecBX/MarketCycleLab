/** Business: valuation and cash on dated, sourced figures, plus what the owner is tracking. */
import { useMemo } from 'react';
import { useResearch } from '../../app/research';
import { invalidate } from '../../data/client';
import { isNa, na } from '../../engine/core/types';
import { ownHistoryPercentile, trailingPe, trailingYearFcf, valuationFacts } from '../../engine/valuation';
import { BarChart } from '../../ui/charts';
import { Card, Chip, DataTable, Disclosure, Missing, Stat, StateNote, type Column } from '../../ui/components';
import { fmtDate, fmtDateShort, fmtMoney, fmtMultiple, fmtNum, fmtPrice, reasonDetail } from '../../ui/format';
import type { CashFlowPeriod } from '../../data/contracts';
import './business/business.css';
import { Checkpoints } from './business/Checkpoints';
import { Peers } from './business/Peers';

/** Engine reasons carry ISO dates. Show them in the display date format. */
export const humanDates = (t: string | undefined): string | undefined => t?.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (d) => fmtDate(d));

const SCOPE_LABEL: Record<string, string> = { quarter: 'Quarter', 'fiscal-year': 'Fiscal year', ttm: 'Trailing year', ytd: 'Year to date' };

export default function Business() {
  const r = useResearch();
  const last = r.bars[r.bars.length - 1];
  const isFund = r.instrument.type === 'etf' || r.instrument.type === 'index';
  const facts = useMemo(
    () => valuationFacts(last ? { close: last.close, date: last.date, currency: r.instrument.currency } : na('source-failed', 'No completed close'), r.fundamentals),
    [last, r.fundamentals, r.instrument.currency],
  );
  const fund = r.fundamentals;
  const pe = facts.forwardPe;
  const trailing = useMemo(() => (last ? trailingPe({ price: last.close, priceDate: last.date, priceCurrency: r.instrument.currency, quarters: [] }) : na('source-failed', 'No completed close')), [last, r.instrument.currency]);
  const own = useMemo(() => (isNa(pe) ? pe : ownHistoryPercentile([], { date: pe.priceDate, value: pe.value, basis: pe.basis, currency: pe.currency })), [pe]);
  const periods = useMemo<CashFlowPeriod[]>(() => {
    if (isNa(fund) || isNa(fund.cashFlow)) return [];
    const cut = r.frozen ? r.asOf : null;
    return fund.cashFlow.filter((p) => !cut || p.filedAt <= cut).slice().sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1));
  }, [fund, r.frozen, r.asOf]);
  const ttm = useMemo(() => trailingYearFcf(periods.length ? periods : isNa(fund) ? fund : fund.cashFlow), [periods, fund]);
  const fundFailed = isNa(fund) && fund.code !== 'not-applicable';

  const cfCols: Column<CashFlowPeriod>[] = [
    { key: 'end', header: 'Period end', sticky: true, cell: (p) => fmtDate(p.periodEnd) },
    { key: 'scope', header: 'Scope', align: 'l', cell: (p) => SCOPE_LABEL[p.scope] ?? p.scope },
    { key: 'filed', header: 'Filed', cell: (p) => <span className="muted">{p.filedAt === p.periodEnd ? 'Not provided' : fmtDate(p.filedAt)}</span> },
    { key: 'ocf', header: 'Operating cash flow', cell: (p) => fmtMoney(p.operatingCashFlow, true) },
    { key: 'capex', header: 'Capital expenditure', info: 'Shown as a positive outflow.', cell: (p) => fmtMoney(Math.abs(p.capex)) },
    { key: 'fcf', header: 'Free cash flow', info: 'Operating cash flow minus capital expenditure for the same period.', cell: (p) => (p.freeCashFlow === null ? <Missing why="Not derivable from this report" /> : <strong>{fmtMoney(p.freeCashFlow, true)}</strong>) },
  ];

  return (
    <div className="stack">
      {r.frozen && (
        <StateNote tone="warn">Fundamentals come from the current capture, not a capture made on {fmtDate(r.asOf)}. Reports filed after that date are left out, and an estimate dated later than the frozen close gives no multiple.</StateNote>
      )}
      {isFund ? (
        <Card title="Valuation and cash">
          <StateNote title="Not applicable.">{r.symbol} is a fund. Issuer valuation and cash flow do not apply. Checkpoints and notes below still work.</StateNote>
        </Card>
      ) : fundFailed ? (
        <Card title="Valuation and cash">
          <StateNote tone="error" title="Fundamentals are unavailable." action={<button type="button" className="btn small" onClick={() => invalidate()}>Retry</button>}>
            {reasonDetail(fund)} Price studies stay usable.
          </StateNote>
        </Card>
      ) : (
        <>
          <div className="grid-2">
            <Card title="Valuation" info="One canonical forward multiple. The quote strip and the screener read this same record.">
              <div className="stats">
                <Stat
                  label="Forward P/E, FY1"
                  value={isNa(pe) ? <Missing why={pe} /> : fmtMultiple(pe.value)}
                  sub={isNa(pe) ? humanDates(pe.detail) : `${fmtPrice(pe.price)} close on ${fmtDate(pe.priceDate)} over EPS ${fmtNum(pe.eps)}`}
                />
                <Stat
                  label="Trailing P/E"
                  info="Needs four consecutive actual quarters on one declared accounting basis, published by the price date."
                  value={isNa(trailing) ? <Missing why={trailing} /> : fmtMultiple(trailing.value)}
                  sub={isNa(trailing) ? 'This capture has no quarterly actual EPS with a declared basis' : trailing.basisLabel}
                />
                <Stat
                  label="Versus own history"
                  info="Percentile of today's multiple inside earlier captured multiples. Needs ten compatible captures. Closing prices never backfill a past estimate."
                  value={isNa(own) ? <Chip>{own.code === 'sample-too-small' ? 'Collecting' : 'n/a'}</Chip> : `${Math.round(own.percentile * 100)}th percentile`}
                  sub={isNa(own) ? (own.code === 'sample-too-small' ? `${humanDates(own.detail)} No capture archive is stored in this build.` : undefined) : `${own.n} captures, ${fmtDate(own.from)} to ${fmtDate(own.to)}`}
                />
              </div>
              {!isNa(pe) && (
                <Disclosure summary="Basis and source">
                  <dl className="kv">
                    <dt>Basis</dt><dd>{pe.basisLabel}, {pe.currency}</dd>
                    <dt>Price</dt><dd>{fmtPrice(pe.price)}, completed close on {fmtDate(pe.priceDate)}</dd>
                    <dt>Estimate</dt><dd>EPS {fmtNum(pe.eps)}, captured {fmtDate(pe.estimateDate)}</dd>
                    <dt>Fiscal year end</dt><dd>{fmtDate(pe.fiscalYearEnd)}</dd>
                    <dt>Source</dt><dd>{pe.source.note ?? pe.source.provider}</dd>
                  </dl>
                </Disclosure>
              )}
            </Card>
            <Card title="Cash" info="Cash on hand is a balance sheet figure. It does not show current cash generation.">
              <div className="stats">
                <Stat label="Cash and equivalents" value={isNa(facts.cash) ? <Missing why={facts.cash} /> : fmtMoney(facts.cash.value)} sub={isNa(facts.cash) ? undefined : `Balance sheet ${fmtDate(facts.cash.asOf)}`} />
                <Stat
                  label="Latest free cash flow"
                  value={isNa(facts.fcf) ? <Missing why={facts.fcf} /> : fmtMoney(facts.fcf.value, true)}
                  sub={isNa(facts.fcf) ? undefined : `${SCOPE_LABEL[facts.fcf.scope]} to ${fmtDate(facts.fcf.periodEnd)}`}
                />
                <Stat label="Trailing year free cash flow" info="Sum of the four newest consecutive standalone quarters, all with a derivable figure." value={isNa(ttm) ? <Missing why={ttm} /> : fmtMoney(ttm.value, true)} sub={isNa(ttm) ? humanDates(ttm.detail) : `Four quarters to ${fmtDate(ttm.periodEnd)}`} />
              </div>
              {!isNa(facts.fcf) && !facts.fcf.isLatestPeriod && (
                <div style={{ marginTop: 10 }}>
                  <StateNote tone="warn" title="Prior period shown.">
                    The newest report, to {fmtDate(facts.fcf.newestPeriodEnd)}, has no derivable free cash flow. The figure above is from the period to {fmtDate(facts.fcf.periodEnd)} and is not treated as current in filters.
                  </StateNote>
                </div>
              )}
            </Card>
          </div>
          <Card title="Cash flow by fiscal period" sub="Standalone periods as reported. Scopes are never mixed.">
            {periods.length === 0 ? (
              <StateNote>{isNa(fund) ? reasonDetail(fund) : isNa(fund.cashFlow) ? reasonDetail(fund.cashFlow) : 'No report was filed by the frozen date.'}</StateNote>
            ) : (
              <div className="bz-cf">
                <BarChart
                  bars={[...periods].reverse().map((p) => ({ key: p.periodEnd, label: fmtDateShort(p.periodEnd), value: p.freeCashFlow, detail: `${SCOPE_LABEL[p.scope]} to ${fmtDate(p.periodEnd)}` }))}
                  yFormat={(y) => fmtMoney(y, true)}
                  ariaLabel={`Free cash flow for the last ${periods.length} fiscal periods, oldest to newest`}
                  height={190}
                  tickEvery={1}
                />
                <DataTable rows={periods} cols={cfCols} rowKey={(p) => `${p.scope}:${p.periodEnd}`} caption="Cash flow by fiscal period, newest first" />
              </div>
            )}
          </Card>
          <Card title="Peers on the same basis">
            <Peers subject={pe} />
          </Card>
        </>
      )}
      <Card title="Checkpoints and notes" info="Your own milestones and notes for this stock. Nothing here is supplied by a data source.">
        <Checkpoints symbol={r.symbol} />
      </Card>
    </div>
  );
}
