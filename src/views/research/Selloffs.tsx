/** Selloffs: the current drawdown, large single-session declines, and Monthly Reversal. */
import { RequireBars, useResearch } from '../../app/research';
import { Segmented } from '../../ui/components';
import MonthlyReversalPanel from './MonthlyReversalPanel';
import { BigDeclines } from './selloffs/BigDeclines';
import { CurrentSelloff } from './selloffs/CurrentSelloff';
import './selloffs/selloffs.css';
import { CrossLinks, useUrlState } from './selloffs/shared';

const TABS = [
  { value: 'current', label: 'Current selloff' },
  { value: 'declines', label: 'Big declines' },
  { value: 'monthly', label: 'Monthly Reversal' },
] as const;
type Tab = (typeof TABS)[number]['value'];

function Body() {
  const r = useResearch();
  const [sp, set] = useUrlState();
  const raw = sp.get('tab');
  const tab: Tab = TABS.some((t) => t.value === raw) ? (raw as Tab) : 'current';
  const asof = r.frozen && r.asOf ? r.asOf : undefined;
  return (
    <div className="stack">
      <Segmented label="Selloff study" value={tab} options={TABS} onChange={(v) => set({ tab: v === 'current' ? null : v }, true)} />
      {tab === 'current' && <CurrentSelloff />}
      {tab === 'declines' && <BigDeclines />}
      {tab === 'monthly' && <MonthlyReversalPanel />}
      <CrossLinks
        symbol={r.symbol}
        asof={asof}
        links={[
          ...(tab !== 'current' ? [{ section: 'selloffs' as const, label: 'Current selloff' }] : []),
          ...(tab !== 'declines' ? [{ section: 'selloffs' as const, label: 'Big declines', params: { tab: 'declines' } }] : []),
          ...(tab !== 'monthly' ? [{ section: 'selloffs' as const, label: 'Monthly Reversal', params: { tab: 'monthly' } }] : []),
          { section: 'strength', label: 'Relative strength' },
          { section: 'earnings', label: 'Earnings reactions' },
          { section: 'trend', label: 'Moving average runs' },
        ]}
      />
    </div>
  );
}

export default function Selloffs() {
  return (
    <RequireBars min={30}>
      <Body />
    </RequireBars>
  );
}
