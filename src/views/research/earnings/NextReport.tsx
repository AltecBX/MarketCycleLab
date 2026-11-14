/** Next report: the date, how firm it is, and the first session that can react. */
import { invalidate } from '../../../data/client';
import { isNa, type Maybe } from '../../../engine/core/types';
import { TIME_LABEL, type NextEarnings } from '../../../engine/earnings';
import { Chip, Missing, Stat, StateNote } from '../../../ui/components';
import { fmtTimeET, plural, reasonDetail } from '../../../ui/format';
import { fmtDay } from './util';

export function NextReport({ next, frozen }: { next: Maybe<NextEarnings>; frozen: boolean }) {
  if (isNa(next)) {
    return (
      <StateNote
        tone="warn"
        title="No upcoming report date."
        action={
          <button type="button" className="btn small" onClick={() => invalidate()}>
            Retry
          </button>
        }
      >
        {reasonDetail(next)}
      </StateNote>
    );
  }
  const confirmed = next.status === 'confirmed';
  return (
    <>
      <div className="er-next">
        <Stat
          label="Report date"
          value={fmtDay(next.date)}
          sub={next.fiscalPeriod ?? 'Fiscal period not stated'}
        />
        <Stat
          label="Date quality"
          info="Confirmed means the source marks the date as set by the issuer. Estimated dates are projected and can move."
          value={<Chip tone={confirmed ? 'accent' : 'warn'}>{confirmed ? 'Confirmed' : 'Estimated'}</Chip>}
          sub={confirmed ? 'Marked as issuer set' : 'Projected. It can move'}
        />
        <Stat
          label="Time of day"
          info="Before open reacts in the same session. After close reacts in the next session. An unknown time on a trading day leaves the reacting session open."
          value={next.time === 'unknown' ? <Chip tone="warn">Time unknown</Chip> : TIME_LABEL[next.time]}
          sub={next.time === 'unknown' ? 'The source gave no time' : 'As stated by the source'}
        />
        <Stat
          label="Time until"
          value={next.daysUntil === 0 ? 'Today' : plural(next.daysUntil, 'day')}
          sub={`${plural(next.sessionsUntil, 'session')} from the ${frozen ? 'frozen' : 'latest'} close`}
        />
        <Stat
          label="First session that can react"
          info="The first regular session whose close can reflect the release. Reaction studies anchor on this session."
          value={isNa(next.reactionDate) ? <Missing why={next.reactionDate} /> : fmtDay(next.reactionDate)}
          sub={isNa(next.reactionDate) ? 'Withheld until the time of day is known' : undefined}
        />
      </div>
      <p className="faint small" style={{ marginTop: 10 }}>
        Source {next.source.provider}, captured {fmtTimeET(next.source.capturedAt)}.{next.source.kind === 'synthetic-fixture' ? ' Synthetic fixture date.' : ''}
      </p>
    </>
  );
}
