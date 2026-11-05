import { type ReactElement, useState } from 'react';
import { Link } from 'react-router';
import { type BoardRow, type ItemOnBoard, itemOnBoard } from '../lib/board';
import type { HealthWorkableRow } from '../lib/health';
import type { OwnerQueueRow } from '../lib/owner-queue';
import {
  type TimelineEvent,
  type Tone,
  type WorkItemHeader,
  type WorkItemRow,
  workItemHeader,
  workItemTimeline,
} from '../lib/work-item';
import { AWAITED, Feed, overall, type Source } from '../live/Feed';
import type { HomeMapRow } from '../map/live';
import { EmptyState } from './EmptyState';

const TONE_COLOR: Record<Tone, string> = {
  done: 'var(--success)',
  failed: 'var(--error)',
  owner: 'var(--role-person)',
  running: 'var(--running)',
  plain: 'var(--border-bright)',
};

const GHOST =
  'rounded-[6px] border border-border bg-surface px-2.5 py-1 text-[12px] text-text-primary hover:border-border-bright';
const LINK = 'underline decoration-border-bright underline-offset-2 hover:decoration-text-primary';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const clock = (at: Date) => at.toISOString().slice(11, 16);

/** The weekday and time on the first row and wherever the UTC day changes, else the time alone. */
function whenOf(at: Date, before: Date | null): string {
  const newDay =
    before === null || before.toISOString().slice(0, 10) !== at.toISOString().slice(0, 10);
  return newDay ? `${WEEKDAYS[at.getUTCDay()]} ${clock(at)}` : clock(at);
}

export function NoWorkItem({ number }: { number: string }): ReactElement {
  return (
    <p data-no-work-item className="text-sm text-text-secondary [overflow-wrap:anywhere]">
      No work item #{number} in this factory.
    </p>
  );
}

function Row({ event, before }: { event: TimelineEvent; before: Date | null }): ReactElement {
  const { run } = event;
  return (
    <li
      data-event={event.kind}
      data-tone={event.tone}
      data-run={run?.id}
      data-stage={event.stage ?? undefined}
      className="grid grid-cols-[86px_14px_1fr] items-baseline gap-x-3 py-1.5"
    >
      <time
        dateTime={event.at.toISOString()}
        className="text-right font-mono text-[12px] text-text-secondary"
      >
        {whenOf(event.at, before)}
      </time>
      <span
        aria-hidden="true"
        className={`h-[9px] w-[9px] self-center rounded-full ${
          event.tone === 'running' ? 'motion-safe:animate-pulse' : ''
        }`}
        style={{ background: TONE_COLOR[event.tone] }}
      />
      <span className="min-w-0 text-[13px] text-text-primary [overflow-wrap:anywhere]">
        {event.text}
        {run === null ? null : run.link.kind === 'lap' ? (
          <Link to={run.link.to} className={`ml-2 text-[12px] text-text-secondary ${LINK}`}>
            Open the lap
          </Link>
        ) : (
          <a href={run.link.href} className={`ml-2 text-[12px] text-text-secondary ${LINK}`}>
            Open the run
          </a>
        )}
        {event.detail === null || event.detail === '' ? null : (
          <span className="block text-[12px] text-text-secondary">{event.detail}</span>
        )}
      </span>
    </li>
  );
}

/** The work item once its rows have arrived: the header panel and the timeline under it. */
export function WorkItemBody({
  header,
  events,
  board,
}: {
  header: WorkItemHeader;
  events: readonly TimelineEvent[];
  board: ItemOnBoard | null;
}): ReactElement {
  const column = board?.column ?? null;
  return (
    <div className="rounded-[10px] border border-border bg-surface">
      <div className="flex flex-wrap items-start gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.05em] text-text-secondary">
            work item #{header.number}
          </div>
          <h1 className="text-[15px] font-semibold text-text-primary">{header.title}</h1>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {column === null ? null : (
              <span
                data-column={column.id}
                className="rounded-[5px] bg-surface-hover px-1.5 py-0.5 font-mono text-[11px]"
                style={{
                  color: column.role ? `var(--role-${column.role})` : 'var(--text-primary)',
                }}
              >
                {column.title}
              </span>
            )}
            {(board?.workOrders ?? []).map((name) => (
              <span
                key={name}
                data-chip="order"
                className="rounded-[5px] bg-surface-hover px-1.5 py-0.5 font-mono text-[11px] text-text-secondary"
              >
                {name}
              </span>
            ))}
          </div>
        </div>
        <a href={header.issueUrl} className={GHOST}>
          Issue
        </a>
        {board?.prUrl == null ? null : (
          <a href={board.prUrl} className={GHOST}>
            PR #{board.pr}
          </a>
        )}
        {header.latestRunHref === null ? null : (
          <a href={header.latestRunHref} className={GHOST}>
            Runs in console
          </a>
        )}
      </div>
      <ol data-timeline className="px-4 py-2">
        {events.map((event, i) => (
          <Row key={event.key} event={event} before={events[i - 1]?.at ?? null} />
        ))}
      </ol>
      <p
        data-timeline-gap
        className="border-t border-border px-4 py-2 text-[12px] text-text-secondary"
      >
        This timeline does not hold app check lines for build-queue rounds, review verdicts past
        each round's review and re-review, or owner answers on old-loop runs yet. A gap here does
        not mean nothing happened.
      </p>
    </div>
  );
}

/** One work item's page: its rows, and the board's own feeds for its column and pull request. */
export function WorkItem({
  factory,
  number,
}: {
  factory: string | undefined;
  number: string;
}): ReactElement {
  const [item, setItem] = useState<Source<WorkItemRow>>(AWAITED);
  const [board, setBoard] = useState<Source<BoardRow>>(AWAITED);
  const [map, setMap] = useState<Source<HomeMapRow>>(AWAITED);
  const [workable, setWorkable] = useState<Source<HealthWorkableRow>>(AWAITED);
  const [owner, setOwner] = useState<Source<OwnerQueueRow>>(AWAITED);
  const state = overall([item.state, board.state, map.state, workable.state, owner.state]);
  const header = item.rows ? workItemHeader(item.rows) : null;
  const ready = state === 'ready' && item.rows !== undefined;
  const onBoard =
    board.rows && map.rows && workable.rows && owner.rows
      ? itemOnBoard(
          { board: board.rows, map: map.rows, workable: workable.rows, owner: owner.rows },
          Number(number),
        )
      : null;
  return (
    <main
      data-work-item={number}
      data-state={state}
      className="mx-auto grid max-w-4xl gap-4 px-6 py-6"
    >
      <Feed<WorkItemRow> query="work-item" factory={factory} args={[number]} into={setItem} />
      <Feed<BoardRow> query="board" factory={factory} into={setBoard} />
      <Feed<HomeMapRow> query="home-map" factory={factory} args={['']} into={setMap} />
      <Feed<HealthWorkableRow> query="health-workable" factory={factory} into={setWorkable} />
      <Feed<OwnerQueueRow> query="owner-queue" factory={factory} into={setOwner} />
      {state === 'error' ? (
        <EmptyState title="Live data is unavailable." />
      ) : !ready || item.rows === undefined ? (
        <EmptyState title="Loading the work item." />
      ) : header === null ? (
        <NoWorkItem number={number} />
      ) : (
        <WorkItemBody
          header={header}
          events={workItemTimeline(item.rows, factory ?? '')}
          board={onBoard}
        />
      )}
    </main>
  );
}
