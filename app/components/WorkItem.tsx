import { type ReactElement, useState } from 'react';
import { Link } from 'react-router';
import { clock, localDay, weekdayClock } from '../lib/format';
import type { DecideRow, UnstickRow } from '../lib/attention';
import { type BoardRow, type ItemOnBoard, itemOnBoard } from '../lib/board';
import type { HealthWorkableRow } from '../lib/health';
import type { OwnerQueueRow } from '../lib/owner-queue';
import { stateInk } from '../lib/states';
import {
  type TimelineEvent,
  type WorkItemHeader,
  type WorkItemRow,
  workItemHeader,
  workItemTimeline,
} from '../lib/work-item';
import { type WorkItemNote, workItemNote } from '../lib/work-item-note';
import { AWAITED, Feed, overall, type Source } from '../live/Feed';
import { useUnavailable } from '../live/LiveProvider';
import type { HomeMapRow } from '../map/live';
import { EmptyState } from './EmptyState';
import { useActionPending, useActionsEnabled, useStartAction } from './ActionToast';
import { Button, buttonClass } from './ui/Button';
import { Card } from './ui/Card';
import { ManagerNote } from './ui/ManagerNote';
import { Pill } from './ui/StateDot';
import { Timeline, TimelineRow } from './ui/Timeline';
import { Column } from './Column';

/** The weekday and time on the first row and wherever the local day changes, else the time alone. */
function whenOf(at: Date, before: Date | null): string {
  return before === null || localDay(before) !== localDay(at) ? weekdayClock(at) : clock(at);
}

export function NoWorkItem({ number }: { number: string }): ReactElement {
  return (
    <p data-no-work-item className="text-sm text-[color:var(--v3-fg-2)] [overflow-wrap:anywhere]">
      No work item #{number} in this factory.
    </p>
  );
}

const RUN_LINK = 'text-[color:var(--v3-you-2)] hover:underline';

function Row({ event, before }: { event: TimelineEvent; before: Date | null }): ReactElement {
  const { run, stop } = event;
  return (
    <TimelineRow
      prose
      state={event.tone}
      name={event.text}
      time={whenOf(event.at, before)}
      dateTime={event.at.toISOString()}
      data-event={event.kind}
      data-tone={event.tone}
      data-run={run?.id}
      data-stage={event.stage ?? undefined}
    >
      {run === null ? null : (
        <Link to={run.link.to} className={`text-[length:var(--v3-t-meta)] ${RUN_LINK}`}>
          Open the run
        </Link>
      )}
      {event.detail === null || event.detail === '' ? null : (
        <div className="text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-2)]">
          {event.detail}
        </div>
      )}
      {stop === null ? null : (
        <div
          data-stop-line
          className="text-[length:var(--v3-t-meta)] [overflow-wrap:anywhere]"
          style={{ color: stateInk(event.tone) }}
        >
          {stop.step === null ? null : (
            <>
              <span className="font-mono">{stop.step}</span>
              {' · '}
            </>
          )}
          {stop.line}
        </div>
      )}
    </TimelineRow>
  );
}

/** The primary action: answers or resumes in place when the server holds an operator for the factory, else a console link. */
function PrimaryAction({ action }: { action: NonNullable<WorkItemNote['action']> }): ReactElement {
  const enabled = useActionsEnabled(action.request?.factory ?? '');
  const start = useStartAction();
  const pending = useActionPending();
  const marks = {
    'data-primary-action': action.kind,
    'data-action-run': action.runId,
    'data-action-step': action.step ?? undefined,
  };
  if (enabled && action.request !== null) {
    const { request, toast } = action;
    return (
      <Button variant="primary" disabled={pending} {...marks} onClick={() => start(request, toast)}>
        {action.label}
      </Button>
    );
  }
  return (
    <a
      href={action.href}
      data-primary-action={action.kind}
      data-action-run={action.runId}
      data-action-step={action.step ?? undefined}
      className={buttonClass('primary')}
    >
      {action.label}
    </a>
  );
}

/** The work item once its rows have arrived: the head, the Manager's note and the timeline. */
export function WorkItemBody({
  header,
  events,
  board,
  note,
}: {
  header: WorkItemHeader;
  events: readonly TimelineEvent[];
  board: ItemOnBoard | null;
  note: WorkItemNote | null;
}): ReactElement {
  const column = board?.column ?? null;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <div className="font-mono text-[length:var(--v3-t-micro)] font-semibold uppercase tracking-[0.05em] text-[color:var(--v3-fg-2)]">
            work item #{header.number}
          </div>
          <h1 className="m-0 text-[length:var(--v3-t-title)] font-bold text-[color:var(--v3-fg)] [overflow-wrap:anywhere]">
            {header.title}
          </h1>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {note === null ? null : (
              <Pill state={note.state} data-item-state={note.state}>
                {note.pill}
              </Pill>
            )}
            {column === null ? null : <Pill data-column={column.id}>{column.title}</Pill>}
            {(board?.workOrders ?? []).map((name) => (
              <Pill key={name} data-chip="order">
                {name}
              </Pill>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {note?.action == null ? null : <PrimaryAction action={note.action} />}
          <a href={header.issueUrl} className={buttonClass('secondary')}>
            Issue
          </a>
          {board?.prUrl == null ? null : (
            <a href={board.prUrl} className={buttonClass('secondary')}>
              PR #{board.pr}
            </a>
          )}
          {header.latestRunHref === null ? null : (
            <a href={header.latestRunHref} className={buttonClass('secondary')}>
              Runs in console
            </a>
          )}
        </div>
      </div>
      {note === null ? null : (
        <Card data-manager-note data-note-state={note.state} className="px-4 py-3">
          <ManagerNote>
            {note.parts.map((part, i) =>
              part.bold ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: a note is a fixed sequence of parts
                <b key={i} className={part.mono ? 'font-mono' : undefined}>
                  {part.text}
                </b>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: a note is a fixed sequence of parts
                <span key={i}>{part.text}</span>
              ),
            )}
          </ManagerNote>
        </Card>
      )}
      <Card>
        <div data-timeline className="px-4 py-2">
          <Timeline>
            {events.map((event, i) => (
              <Row key={event.key} event={event} before={events[i - 1]?.at ?? null} />
            ))}
          </Timeline>
        </div>
        <p
          data-timeline-gap
          className="m-0 border-t border-[color:var(--v3-line)] px-4 py-2 text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-2)]"
        >
          This timeline does not hold app check lines for build-queue rounds, review verdicts past
          each round's review and re-review, or owner answers on old-loop runs yet. A gap here does
          not mean nothing happened.
        </p>
      </Card>
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
  const unavailable = useUnavailable();
  const [item, setItem] = useState<Source<WorkItemRow>>(AWAITED);
  const [board, setBoard] = useState<Source<BoardRow>>(AWAITED);
  const [map, setMap] = useState<Source<HomeMapRow>>(AWAITED);
  const [workable, setWorkable] = useState<Source<HealthWorkableRow>>(AWAITED);
  const [owner, setOwner] = useState<Source<OwnerQueueRow>>(AWAITED);
  const [stuck, setStuck] = useState<Source<UnstickRow>>(AWAITED);
  const [decide, setDecide] = useState<Source<DecideRow>>(AWAITED);
  const state = overall([
    item.state,
    board.state,
    map.state,
    workable.state,
    owner.state,
    stuck.state,
    decide.state,
  ]);
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
    <Column
      data-work-item={number}
      data-state={state}
      width="max-w-4xl"
      className="grid gap-4 px-6 py-6"
    >
      <Feed<WorkItemRow> query="work-item" factory={factory} args={[number]} into={setItem} />
      <Feed<BoardRow> query="board" factory={factory} into={setBoard} />
      <Feed<HomeMapRow> query="home-map" factory={factory} args={['']} into={setMap} />
      <Feed<HealthWorkableRow> query="health-workable" factory={factory} into={setWorkable} />
      <Feed<OwnerQueueRow> query="owner-queue" factory={factory} into={setOwner} />
      <Feed<UnstickRow> query="unstick" factory={factory} into={setStuck} />
      <Feed<DecideRow> query="decide" factory={factory} into={setDecide} />
      {state === 'error' ? (
        <EmptyState title={unavailable} />
      ) : !ready || item.rows === undefined ? (
        <EmptyState title="Loading the work item." />
      ) : header === null ? (
        <NoWorkItem number={number} />
      ) : (
        <WorkItemBody
          header={header}
          events={workItemTimeline(item.rows, factory ?? '')}
          board={onBoard}
          note={workItemNote(item.rows, onBoard, stuck.rows ?? [], {
            decide: decide.rows ?? [],
            factory: factory ?? '',
          })}
        />
      )}
    </Column>
  );
}
