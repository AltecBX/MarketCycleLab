/** Capability coverage map: where each study lives, what data it needs, and whether this build has it. */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useResearch } from '../../../app/research';
import { researchPath, type SectionId } from '../../../app/routes';
import { isFixtureMode } from '../../../data/client';
import { Card, Chip, Segmented } from '../../../ui/components';

type Status = 'available' | 'gated' | 'none';

interface Row {
  name: string;
  where: string;
  section?: SectionId;
  tab?: string;
  path?: string;
  needs: string;
  status: Status;
  note?: string;
}

const ROWS: Row[] = [
  { name: 'Earnings center', where: 'Earnings', section: 'earnings', needs: 'Report dates with time of day, daily closes', status: 'available' },
  { name: 'Run up into earnings', where: 'Earnings', section: 'earnings', needs: 'Report dates, daily closes', status: 'available' },
  { name: 'Drift after earnings', where: 'Earnings', section: 'earnings', needs: 'Report dates, daily closes', status: 'available' },
  { name: 'Expected versus realized expiry move', where: 'Earnings', section: 'earnings', needs: 'Dated option quote for an actual expiry', status: 'none', note: 'No option quote source' },
  { name: 'Earnings calendar', where: 'Discover, Earnings calendar', path: '/discover/earnings', needs: 'Cross stock report dates', status: 'available' },
  { name: 'Selling exhaustion and deceleration', where: 'Selloffs, Big declines', section: 'selloffs', tab: 'declines', needs: 'Daily OHLC and volume', status: 'available' },
  { name: 'Staged bottoms', where: 'Selloffs, Big declines', section: 'selloffs', tab: 'declines', needs: 'Daily OHLC', status: 'available', note: 'Confirmed only at a later date' },
  { name: 'Oversold versus downtrend', where: 'Selloffs, Big declines', section: 'selloffs', tab: 'declines', needs: 'RSI14, moving averages', status: 'available' },
  { name: 'Drawdown recovery and time', where: 'Selloffs', section: 'selloffs', needs: 'Daily closes', status: 'available' },
  { name: 'Drawdown thresholds, 5% to 40%', where: 'Selloffs', section: 'selloffs', needs: 'Daily closes', status: 'available' },
  { name: 'Historical analogs', where: 'Selloffs, Big declines', section: 'selloffs', tab: 'declines', needs: 'Daily OHLC, optional market and sector series', status: 'available' },
  { name: 'Forward tests of a rule', where: 'Lab, Rule tests', section: 'lab', needs: 'Daily OHLC', status: 'available' },
  { name: 'What happens next frequencies', where: 'Lab, Rule tests', section: 'lab', needs: '30 non overlapping matured cases', status: 'gated', note: 'Withheld below 30 cases' },
  { name: 'Rolling reliability', where: 'Lab, Rule tests', section: 'lab', needs: 'Selection and holdout split', status: 'gated', note: 'Verdict from the holdout only' },
  { name: 'Monthly selling and reversal', where: 'Selloffs, Monthly Reversal', section: 'selloffs', tab: 'monthly', needs: 'Daily OHLC, 10 months and 3 years of matches', status: 'gated' },
  { name: 'Moving average runs', where: 'Trend', section: 'trend', needs: 'Daily closes', status: 'available' },
  { name: 'Relative strength and breakouts', where: 'Strength', section: 'strength', needs: 'Stock and benchmark closes on the same dates', status: 'available' },
  { name: 'Sector and reference divergence', where: 'Strength', section: 'strength', needs: 'Sector ETF and benchmark closes', status: 'available' },
  { name: 'Market regime', where: 'Overview', section: 'overview', needs: 'SPY closes and its 200 session average', status: 'available' },
  { name: 'Sector participation, 11 sector ETFs', where: 'Overview', section: 'overview', needs: 'Sector ETF closes', status: 'available', note: 'A named proxy, not constituent breadth' },
  { name: 'Full market breadth', where: 'No home yet', needs: 'Point in time index constituents', status: 'none' },
  { name: 'Sector rotation', where: 'Discover, Groups', path: '/discover/groups', needs: 'Group and sector closes', status: 'available' },
  { name: 'International relationships, Korean memory names', where: 'No home yet', needs: 'Foreign closes with exchange timing', status: 'none' },
  { name: 'Fear and greed', where: 'Lab, Sentiment', section: 'lab', tab: 'sentiment', needs: 'Sourced score history', status: 'available', note: 'Synthetic proxy only' },
  { name: 'Signal Score', where: 'Forecasts', section: 'forecasts', needs: 'Fresh data check, out of sample validation', status: 'gated' },
  { name: 'Weekly range forecast', where: 'Forecasts', section: 'forecasts', needs: 'Daily OHLC, dated implied move or IV30', status: 'gated', note: 'No option source, so no option based engine' },
  { name: 'Portfolio scenarios', where: 'Portfolio', path: '/portfolio', needs: 'Owner positions, daily closes', status: 'available' },
  { name: 'Calls, puts and collars', where: 'Portfolio, Protection', path: '/portfolio/protection', needs: 'Owner positions, manual or dated premiums', status: 'available', note: 'Manual premiums only' },
  { name: 'Dated options positioning', where: 'No home yet', needs: 'Put and call flow, open interest, IV term and skew', status: 'none' },
  { name: 'Dealer gamma', where: 'No home yet', needs: 'Provider gamma estimate with its model', status: 'none' },
  { name: 'Policy rates history', where: 'No home yet', needs: 'Dated policy rate series', status: 'none' },
  { name: 'Estimate revisions, point in time', where: 'No home yet', needs: 'Timestamped estimate archive', status: 'none' },
  { name: 'Alerts and briefing', where: 'Today', path: '/', needs: 'Completed closes, report dates', status: 'available' },
  { name: 'Evidence and accuracy audit', where: 'Data and methods', path: '/data', needs: 'Frozen forecasts with settled outcomes', status: 'gated', note: 'No frozen forecasts yet' },
];

const LABEL: Record<Status, string> = { available: 'Available on fixture data', gated: 'Gated', none: 'No source in this build' };
const TONE: Record<Status, 'up' | 'warn' | undefined> = { available: 'up', gated: 'warn', none: undefined };

export function CoverageTab() {
  const r = useResearch();
  const [filter, setFilter] = useState<Status | 'all'>('all');
  const rows = ROWS.filter((x) => filter === 'all' || x.status === filter);
  const count = (s: Status) => ROWS.filter((x) => x.status === s).length;
  const asof = r.frozen && r.asOf ? r.asOf : undefined;
  return (
    <Card
      title="Capability coverage"
      info="Available means the study runs on the data in this build. Gated means a number shows only when its sample or validation rule passes. No source means the data it needs is not connected."
      sub={`${ROWS.length} capabilities. ${count('available')} available${isFixtureMode() ? ' on synthetic fixture data' : ''}, ${count('gated')} gated, ${count('none')} without a source.`}
      actions={
        <Segmented
          label="Filter by status"
          value={filter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'available', label: 'Available' },
            { value: 'gated', label: 'Gated' },
            { value: 'none', label: 'No source' },
          ]}
          onChange={setFilter}
        />
      }
    >
      <div className="table-wrap lab-wrap" tabIndex={0} role="region" aria-label="Capability coverage">
        <table className="data">
          <thead>
            <tr>
              <th className="l" scope="col">Capability</th>
              <th className="l" scope="col">Where</th>
              <th className="l" scope="col">Data it needs</th>
              <th className="l" scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.name}>
                <td className="l" style={{ whiteSpace: 'normal', minWidth: 130 }}>{x.name}</td>
                <td className="l" style={{ whiteSpace: 'normal' }}>
                  {x.section ? <Link to={researchPath(r.symbol, x.section, { asof, tab: x.tab })}>{x.where}</Link> : x.path ? <Link to={x.path}>{x.where}</Link> : <span className="muted">{x.where}</span>}
                </td>
                <td className="l muted" style={{ whiteSpace: 'normal', minWidth: 150 }}>{x.needs}</td>
                <td className="l lab-cov-status">
                  <Chip tone={TONE[x.status]}>{LABEL[x.status]}</Chip>
                  {x.note && <div className="muted small">{x.note}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
