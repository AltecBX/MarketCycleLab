/** Hypothetical price shock. Never changes an observed figure on the page. */
import { useMemo, useState } from 'react';
import { isNa, type Bar } from '../../../engine/core/types';
import { simulateShock, type RangeBasis } from '../../../engine/relativeStrength';
import { Card, Chip, Disclosure, Missing, Stat } from '../../../ui/components';
import { fmtDate, fmtDollars, fmtNum, fmtPct, fmtPp, fmtPrice, reasonText } from '../../../ui/format';
import { num } from './util';

export function Simulation({ bars, basis, symbol }: { bars: readonly Bar[]; basis: RangeBasis; symbol: string }) {
  const [stock, setStock] = useState('-3');
  const [bench, setBench] = useState('');
  const [shares, setShares] = useState('');
  const i = bars.length - 1;
  const r = useMemo(() => {
    const s = Number(stock);
    if (stock.trim() === '' || !Number.isFinite(s)) return null;
    const b = bench.trim() === '' ? undefined : Number(bench);
    const q = shares.trim() === '' ? undefined : Number(shares);
    return simulateShock(bars, i, { stockShock: s / 100, benchmarkShock: b !== undefined && Number.isFinite(b) ? b / 100 : undefined, shares: q !== undefined && Number.isFinite(q) ? q : undefined, basis });
  }, [bars, i, stock, bench, shares, basis]);

  return (
    <Card>
      <Disclosure summary="What if price moved. Hypothetical">
        <div className="row" style={{ margin: '4px 0 10px' }}>
          <Chip tone="warn">Hypothetical</Chip>
          <span className="muted small">An input you choose. Not an observed price, not a forecast, and it never triggers an alert.</span>
        </div>
        <div className="st-inputs">
          <label className="field">
            {symbol} move, %
            <input className="input" inputMode="decimal" value={stock} onChange={(e) => setStock(e.target.value)} />
          </label>
          <label className="field">
            Benchmark move, % (optional)
            <input className="input" inputMode="decimal" value={bench} onChange={(e) => setBench(e.target.value)} placeholder="None" />
          </label>
          <label className="field">
            Shares held (optional)
            <input className="input" inputMode="decimal" value={shares} onChange={(e) => setShares(e.target.value)} placeholder="None" />
          </label>
        </div>
        {!r && <p className="muted small" style={{ marginTop: 10 }}>Enter a percent move to see the result.</p>}
        {r && isNa(r) && <div style={{ marginTop: 10 }}><Missing why={r} block /></div>}
        {r && !isNa(r) && (
          <>
            <div className="stats" style={{ margin: '12px 0' }}>
              <Stat label="Hypothetical close" value={fmtPrice(r.shockedClose)} sub={`from ${fmtPrice(r.close)} on ${fmtDate(r.anchorDate)}`} />
              <Stat label="Relative wealth factor" info="One plus the stock move, divided by one plus the benchmark move." value={num(r.relativeWealthFactor) === null ? 'n/a' : fmtNum(num(r.relativeWealthFactor), 4)} sub={num(r.relativeEffectPp) === null ? 'Enter a benchmark move' : `${fmtPp(num(r.relativeEffectPp), 2)} versus the benchmark`} />
              <Stat label="Position change" value={num(r.positionDollars) === null ? 'n/a' : fmtDollars(num(r.positionDollars), true)} sub={num(r.positionDollars) === null ? 'Enter shares held' : 'shares times close times move'} />
              <Stat label="ATR14 bands" value={isNa(r.atrBands) ? 'n/a' : `${fmtPrice(r.atrBands.lower1)} to ${fmtPrice(r.atrBands.upper1)}`} sub={isNa(r.atrBands) ? reasonText(r.atrBands) : `one ATR of ${fmtNum(r.atrBands.atr, 2)}. Two: ${fmtPrice(r.atrBands.lower2)} to ${fmtPrice(r.atrBands.upper2)}`} />
            </div>
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Hypothetical effect by window">
              <table className="st-mini">
                <thead>
                  <tr>
                    <th scope="col">Window</th>
                    <th scope="col">Position now</th>
                    <th scope="col">Position after</th>
                    <th scope="col">Move to exceed high</th>
                    <th scope="col">Move to reach low</th>
                    <th scope="col">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {r.windows.map((w) => (
                    <tr key={w.key}>
                      <td>{w.label}</td>
                      {isNa(w.result) ? (
                        <td colSpan={5} className="faint">{reasonText(w.result)}</td>
                      ) : (
                        <>
                          <td>{num(w.result.positionNow) === null ? 'flat' : fmtPct(num(w.result.positionNow), 0, false)}</td>
                          <td>{num(w.result.positionAfter) === null ? 'flat' : fmtPct(num(w.result.positionAfter), 0, false)}</td>
                          <td>{fmtPct(w.result.moveToBreakHigh, 1)}</td>
                          <td>{fmtPct(w.result.moveToTestLow, 1)}</td>
                          <td>{w.result.breaksHigh ? 'Above the high' : w.result.breaksLow ? 'Below the low' : 'Inside the range'}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Disclosure>
    </Card>
  );
}
