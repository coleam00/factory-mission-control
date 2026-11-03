import type { ReactElement } from 'react';
import { LivePanel } from '../live/LivePanel';

/** One row of decisions-count.sql: an open item the Decisions screen shows. */
interface DecisionsCountRow {
  kind: 'attention' | 'issue' | 'question';
}

/** The Decisions tab's violet count of open items; nothing while loading or at zero. */
export function DecisionsCount({ factory }: { factory: string }): ReactElement {
  return (
    <LivePanel<DecisionsCountRow> query="decisions-count" factory={factory} className="inline">
      {(rows) =>
        rows === undefined || rows.length === 0 ? null : (
          <span
            data-count={rows.length}
            role="img"
            aria-label={`${rows.length} waiting`}
            className="ml-1.5 rounded-full px-1.5 font-mono text-[11px] tabular-nums"
            style={{ color: 'var(--role-person)', backgroundColor: 'var(--role-person-soft)' }}
          >
            {rows.length}
          </span>
        )
      }
    </LivePanel>
  );
}
