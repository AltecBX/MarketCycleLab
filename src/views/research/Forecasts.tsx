/** Forecasts: the only modeled probabilities in the product. The gate status leads, not the number. */
import { useSearchParams } from 'react-router-dom';
import { Segmented } from '../../ui/components';
import { RangeTab } from './forecasts/RangeTab';
import { SignalTab } from './forecasts/SignalTab';
import './forecasts/forecasts.css';

type Tab = 'signal' | 'range';

export default function Forecasts() {
  const [sp, setSp] = useSearchParams();
  const tab: Tab = sp.get('tab') === 'range' ? 'range' : 'signal';
  const setTab = (t: Tab) => {
    const n = new URLSearchParams(sp);
    if (t === 'signal') n.delete('tab');
    else n.set('tab', t);
    setSp(n);
  };
  return (
    <div className="stack">
      <Segmented<Tab>
        label="Forecast"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'signal', label: 'Signal Score' },
          { value: 'range', label: 'Weekly range' },
        ]}
      />
      {tab === 'signal' ? <SignalTab /> : <RangeTab />}
    </div>
  );
}
