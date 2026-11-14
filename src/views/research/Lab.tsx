/** Lab: rule tests, the sentiment study and the capability coverage map. One tab at a time. */
import { useSearchParams } from 'react-router-dom';
import { Segmented } from '../../ui/components';
import { CoverageTab } from './lab/CoverageTab';
import { RulesTab } from './lab/RulesTab';
import { SentimentTab } from './lab/SentimentTab';
import './lab/lab.css';

const TABS = [
  { value: 'rules', label: 'Rule tests' },
  { value: 'sentiment', label: 'Sentiment' },
  { value: 'coverage', label: 'Coverage' },
] as const;
type Tab = (typeof TABS)[number]['value'];

export default function Lab() {
  const [sp, setSp] = useSearchParams();
  const raw = sp.get('tab');
  const tab: Tab = TABS.some((t) => t.value === raw) ? (raw as Tab) : 'rules';
  const setTab = (t: Tab) => {
    // Tab specific settings are dropped. The symbol, as-of cut and history window stay.
    const n = new URLSearchParams();
    for (const k of ['asof', 'hist']) if (sp.get(k)) n.set(k, sp.get(k)!);
    if (t !== 'rules') n.set('tab', t);
    setSp(n);
  };
  return (
    <div className="stack">
      <Segmented label="Lab study" value={tab} options={TABS} onChange={setTab} />
      {tab === 'rules' && <RulesTab />}
      {tab === 'sentiment' && <SentimentTab />}
      {tab === 'coverage' && <CoverageTab />}
    </div>
  );
}
