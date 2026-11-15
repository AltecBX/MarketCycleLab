/**
 * Strength: where price sits in its ranges, whether the stock leads or lags the market and its
 * sector, and what followed earlier breakouts. Owner specification section 11.
 */
import { RequireBars, useResearch } from '../../app/research';
import { useBars } from '../../data/client';
import { BREAK_HORIZONS, BREAK_WINDOWS, type BreakWindowKey } from '../../engine/breakouts';
import { ALL_WINDOWS, type RangeBasis, type WindowKey } from '../../engine/relativeStrength';
import { Segmented } from '../../ui/components';
import { BreakoutsTab } from './strength/BreakoutsTab';
import { Lead } from './strength/Lead';
import { RangesTab } from './strength/RangesTab';
import { RelativeTab } from './strength/RelativeTab';
import { PRESET_IDS, ScannerTab } from './strength/ScannerTab';
import { Simulation } from './strength/Simulation';
import './strength/strength.css';
import { oneOf, TABS, useParams2, type StrengthTab } from './strength/util';

function Inner() {
  const r = useResearch();
  const { get, set } = useParams2();
  const asOf = r.asOf!;
  const tab = oneOf<StrengthTab>(get('tab', 'ranges'), TABS.map((t) => t.value), 'ranges');
  const basis = oneOf<RangeBasis>(get('basis', 'close'), ['close', 'traded'], 'close');
  const spy = useBars(r.symbol === 'SPY' ? null : 'SPY', asOf);
  const spyData = spy.status === 'ready' ? spy.data : null;
  const key = `${r.symbol}:${asOf}:${r.bars.length}`;
  const h = Number(get('h', '20'));

  return (
    <div className="stack st-root">
      <Lead bars={r.bars} basis={basis} spy={spyData} />
      <div className="st-controls">
        <Segmented label="Strength view" value={tab} options={TABS} onChange={(v) => set({ tab: v === 'ranges' ? null : v }, false)} />
        {tab !== 'relative' && (
          <Segmented
            label="High and low basis"
            value={basis}
            options={[
              { value: 'close', label: 'Closing', title: 'Highs and lows are daily closes' },
              { value: 'traded', label: 'Traded', title: 'Highs and lows are intraday quote extremes' },
            ]}
            onChange={(v) => set({ basis: v === 'close' ? null : v })}
          />
        )}
      </div>
      {tab === 'ranges' && <RangesTab bars={r.bars} basis={basis} win={oneOf<WindowKey>(get('win', '3M'), ALL_WINDOWS, '3M')} onWin={(k) => set({ win: k === '3M' ? null : k })} cacheKey={key} spy={spyData} />}
      {tab === 'relative' && (
        <RelativeTab
          bars={r.bars}
          symbol={r.symbol}
          sectorEtf={r.instrument.sectorEtf ?? null}
          asOf={asOf}
          bm={get('bm', r.symbol === 'SPY' ? 'QQQ' : 'SPY').toUpperCase()}
          onBm={(s) => set({ bm: s === 'SPY' ? null : s })}
          lw={oneOf<WindowKey>(get('lw', '1Y'), ['3M', '6M', '1Y', '3Y'], '1Y')}
          onLw={(k) => set({ lw: k === '1Y' ? null : k })}
          spy={spyData}
        />
      )}
      {tab === 'breakouts' && (
        <BreakoutsTab
          bars={r.bars}
          basis={basis}
          cacheKey={key}
          spy={spyData}
          set={set}
          p={{
            bw: oneOf<BreakWindowKey>(get('bw', '3M'), BREAK_WINDOWS, '3M'),
            side: oneOf(get('side', 'up'), ['up', 'down'] as const, 'up'),
            mode: oneOf(get('mode', 'close'), ['close', 'intraday'] as const, 'close'),
            h: BREAK_HORIZONS.includes(h) ? h : 20,
            fy: oneOf(get('fy', ''), ['', '5', '10', '15', '25'] as const, ''),
            rv: oneOf(get('rv', ''), ['', '1', '1.3', '2'] as const, ''),
            cmp: oneOf(get('cmp', ''), ['', 'yes', 'no'] as const, ''),
            mat: get('mat', '') === '1',
            st: oneOf(get('st', '5'), ['2', '5', '10'] as const, '5'),
          }}
        />
      )}
      {tab === 'scanner' && (
        <ScannerTab date={asOf} basis={basis} preset={oneOf(get('preset', 'all'), PRESET_IDS, 'all')} prox={oneOf(get('prox', '2'), ['1', '2', '5'] as const, '2')} funds={get('funds', '') === '1'} set={set} current={r.symbol} />
      )}
      <Simulation bars={r.bars} basis={basis} symbol={r.symbol} />
    </div>
  );
}

export default function Strength() {
  return (
    <RequireBars min={6}>
      <Inner />
    </RequireBars>
  );
}
