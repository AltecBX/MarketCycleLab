/** Overview: what changed, how unusual it is, and where to look next. */
import { RequireBars, useResearch } from '../../app/research';
import { BenchmarkTable } from './overview/BenchmarkTable';
import './overview/overview.css';
import { PriceCard } from './overview/PriceCard';
import { StandOut } from './overview/StandOut';
import { CrossLinks } from './selloffs/shared';

function Body() {
  const r = useResearch();
  const asof = r.frozen && r.asOf ? r.asOf : undefined;
  return (
    <div className="stack">
      <div className="ov-grid">
        <PriceCard />
        <div className="ov-side">
          <StandOut />
          <BenchmarkTable />
        </div>
      </div>
      <CrossLinks
        symbol={r.symbol}
        asof={asof}
        links={[
          { section: 'selloffs', label: 'Selloffs' },
          { section: 'trend', label: 'Moving average runs' },
          { section: 'calendar', label: 'Monthly and weekly returns' },
          { section: 'strength', label: 'Relative strength' },
          { section: 'earnings', label: 'Earnings reactions' },
        ]}
      />
    </div>
  );
}

export default function Overview() {
  return (
    <RequireBars min={2}>
      <Body />
    </RequireBars>
  );
}
