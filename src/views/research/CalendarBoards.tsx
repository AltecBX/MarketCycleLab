/** Calendar. Realized monthly, yearly and weekly price returns for the selected stock. Owner specification sections 6 and 7. */
import { RequireBars } from '../../app/research';
import { Segmented } from '../../ui/components';
import { MonthlyView } from './calendar/MonthlyView';
import { WeeklyView } from './calendar/WeeklyView';
import { useUrlState } from './trend/params';
import './calendar/calendar.css';

export default function CalendarBoards() {
  const [sp, patch] = useUrlState();
  const view = sp.get('view') === 'weekly' ? 'weekly' : 'monthly';
  return (
    <RequireBars min={2}>
      <div className="stack">
        <Segmented
          label="Board"
          value={view}
          options={[
            { value: 'monthly', label: 'Monthly' },
            { value: 'weekly', label: 'Weekly' },
          ]}
          onChange={(v) => patch({ view: v === 'monthly' ? null : v }, true)}
        />
        {view === 'monthly' ? <MonthlyView /> : <WeeklyView />}
      </div>
    </RequireBars>
  );
}
