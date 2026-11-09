/**
 * The Manager's note at the top of a work item page: where the item is and why, in words fixed by
 * its state, and the one action that moves it (README rules 2 and 6). Deterministic: the same rows
 * give the same note. Pure, no React.
 */
import type { UnstickRow } from './attention';
import type { ColumnId, ItemOnBoard } from './board';
import { shortRunId } from './format';
import { CLASS_NOTE, UNSTICK_NOTE } from './manager-notes';
import { consoleUrl, workflowLabel } from './one-lap';
import type { State } from './states';
import { questionOf, roundNumbers, stageOf, type WorkItemRow, workItemTimeline } from './work-item';

export interface NotePart {
  text: string;
  bold?: true;
  mono?: true;
}

/** Opens the Archon console at the run until #521's endpoint can answer or resume in place. */
export interface PrimaryAction {
  kind: 'answer' | 'resume';
  label: string;
  href: string;
  runId: string;
  step: string | null;
}

export interface WorkItemNote {
  state: State;
  pill: string;
  parts: NotePart[];
  action: PrimaryAction | null;
}

const bold = (text: string): NotePart => ({ text, bold: true });
const plain = (text: string): NotePart => ({ text });
const step = (text: string): NotePart => ({ text, bold: true, mono: true });

const COLUMN_NOTE: Record<
  ColumnId,
  (column: NonNullable<ItemOnBoard['column']>) => Omit<WorkItemNote, 'action'>
> = {
  queued: () => ({
    state: 'idle',
    pill: 'Queued',
    parts: [bold('Queued.'), plain(' The build queue takes it when a slot frees.')],
  }),
  intake: (c) => inStage(c),
  build: (c) => inStage(c),
  review: (c) => inStage(c),
  app: (c) => inStage(c),
  merge: (c) => inStage(c),
  decision: () => ({
    state: 'needs-you',
    pill: 'Needs you',
    parts: [bold('Waiting on you.'), plain(' Its question is on Attention.')],
  }),
  parked: () => ({
    state: 'idle',
    pill: 'Parked',
    parts: [bold('Parked.'), plain(' A parked item waits until it is re-triaged.')],
  }),
  merged: () => ({ state: 'done', pill: 'Merged', parts: [bold('Merged.')] }),
};

function inStage(column: NonNullable<ItemOnBoard['column']>): Omit<WorkItemNote, 'action'> {
  return {
    state: 'idle',
    pill: 'Waiting',
    parts: [bold(`In ${column.title}`), plain(`, with the ${column.holder}.`)],
  };
}

/** Newest first by start, a run with none last, ties by run id. */
const newestFirst = (a: WorkItemRow, b: WorkItemRow) =>
  (b.started_at?.getTime() ?? -1) - (a.started_at?.getTime() ?? -1) ||
  (a.run_id ?? '').localeCompare(b.run_id ?? '');

const oldestFirst = (a: UnstickRow, b: UnstickRow) =>
  (a.since?.getTime() ?? Number.POSITIVE_INFINITY) -
  (b.since?.getTime() ?? Number.POSITIVE_INFINITY);

function runLabel(run: WorkItemRow, rows: readonly WorkItemRow[]): string {
  if (run.workflow === 'archon-intake') return 'Intake';
  const n = roundNumbers(rows).get(run.run_id ?? '');
  return n === undefined ? workflowLabel(run.workflow ?? 'The run') : `Round ${n}`;
}

const endSentence = (text: string) => (/[.?!]$/.test(text) ? text : `${text}.`);

/** The note for the item's rows, the board's view of it and the Unstick rows that name it. */
export function workItemNote(
  rows: readonly WorkItemRow[],
  board: ItemOnBoard | null,
  unstick: readonly UnstickRow[],
): WorkItemNote | null {
  const item = rows.find((r) => r.kind === 'item');
  if (item === undefined) return null;
  const consoleOf = (
    runId: string | null,
    kind: PrimaryAction['kind'],
    label: string,
    at: string | null,
  ) =>
    runId === null || item.console === null
      ? null
      : { kind, label, href: consoleUrl(item.console, runId), runId, step: at };
  const done = (pill: string, parts: NotePart[]): WorkItemNote => ({
    state: 'done',
    pill,
    parts,
    action: null,
  });

  if (item.status === 'closed')
    return workItemTimeline(rows, '').some((e) => e.kind === 'decision' && e.text === 'Merged')
      ? done('Merged', [bold('Merged.'), plain(' Nothing is left to do on it.')])
      : done('Done', [bold('Closed.'), plain(' Nothing is left to do on it.')]);

  const latest = rows.filter((r) => r.kind === 'run').sort(newestFirst)[0];

  if (latest?.waiting === true) {
    const at = latest.stop_step;
    const question = latest.stop_line === null ? null : questionOf(latest.stop_line);
    return {
      state: 'needs-you',
      pill: 'Needs you',
      parts:
        question === null
          ? [bold('Waiting for your answer.'), plain(' Its question is in the console.')]
          : [
              bold('Waiting for your answer'),
              ...(at === null ? [] : [plain(' at '), step(at)]),
              plain(`: ${endSentence(question)}`),
            ],
      action: consoleOf(latest.run_id, 'answer', 'Answer the question', at),
    };
  }

  const stuck = unstick.filter((u) => u.number === item.number).sort(oldestFirst)[0];
  if (stuck !== undefined) {
    const { lead, rest } = UNSTICK_NOTE[stuck.kind];
    const waits =
      stuck.kind === 'blocked' || stuck.kind === 'parked'
        ? [plain(` It was ${stuck.kind} on `), bold(stuck.waits_on), plain('.')]
        : [];
    return {
      state: 'needs-you',
      pill: 'Needs you',
      parts: [bold(lead), plain(` ${rest}`), ...waits],
      action:
        stuck.kind === 'capacity'
          ? consoleOf(stuck.run_id, 'resume', `Resume ${shortRunId(stuck.run_id ?? '')}`, null)
          : null,
    };
  }

  if (latest?.status === 'failed') {
    const at = latest.stop_step ?? latest.failed_step;
    const classNote =
      latest.stop_class === null ? 'It is not classified.' : CLASS_NOTE[latest.stop_class];
    return {
      state: 'failed',
      pill: 'Failed',
      parts: [
        bold(`${runLabel(latest, rows)} failed`),
        ...(at === null ? [] : [plain(' at '), step(at)]),
        plain(`. ${classNote}`),
      ],
      action: consoleOf(
        latest.run_id,
        'resume',
        at === null ? `Resume ${shortRunId(latest.run_id ?? '')}` : `Resume from ${at}`,
        at,
      ),
    };
  }

  if (latest !== undefined && latest.status !== 'cancelled' && latest.completed_at === null) {
    const label = runLabel(latest, rows);
    const stage = stageOf(latest);
    return {
      state: 'running',
      pill: 'Running',
      parts:
        stage === null
          ? [bold(`${label} is running.`)]
          : [bold(`${label} is running`), plain(', now in '), bold(stage.title), plain('.')],
      action: null,
    };
  }

  if (board?.column != null) return { ...COLUMN_NOTE[board.column.id](board.column), action: null };

  return {
    state: 'idle',
    pill: 'Waiting',
    parts: [bold('Not on the board.'), plain(' No queue holds it right now.')],
    action: null,
  };
}
