/**
 * The work item page's rows, as `db/queries/work-item.sql` returns them, and the timeline the
 * browser makes of them: one event per fact, oldest first. Pure, no React.
 */
import { cardForStep, FACTORY_MAP } from '../map/factory-map';
import { deepestStep } from '../map/live';
import { formatCost, formatElapsed } from './format';
import { stepPath } from './lap-graph';
import { costOf, durationOf, stepLabel } from './laps';
import { consoleUrl, hasLapPage, isOldLoop, lapHref } from './one-lap';
import { LAP_WORKFLOWS } from './scorecard';
import {
  CHECK_OVERALL_STATE,
  GATE_STATE,
  QUEUE_ENDING_STATE,
  QUEUE_REVIEW_STATE,
  REVIEW_OUTCOME_STATE,
  RUN_STATE,
  type State,
  stateOf,
  SWEEP_ACTION_STATE,
} from './states';

/**
 * One row of `db/queries/work-item.sql`. `kind` says which columns are filled: `item` (the issue:
 * status is its state, started_at its creation and completed_at its closing), `run` (one run on
 * the item), `line` (one app check line of a `run`, by kind and verdict, never its text) and
 * `sweep` (a merge-queue run that ran while one of the item's pull requests was open).
 */
export interface WorkItemRow {
  kind: 'item' | 'run' | 'line' | 'sweep';
  run_id: string | null;
  workflow: string | null;
  status: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  /** A build-queue run whose facts step names the item (PRD 4.2's lap rule). */
  lap: boolean | null;
  /** The run waits on a person. */
  waiting: boolean | null;
  cost: number | string | null;
  /** Running step ids, newest first. */
  steps: string[] | null;
  failed_step: string | null;
  error: string | null;
  /** An old-loop lap's pick. */
  route: string | null;
  depth: string | null;
  /** An intake run's labels. */
  labels: string[] | null;
  /** A build-queue run's latest delivery round, as text. */
  deliveries: string | null;
  /** The old loop's review outcome, or the build queue's latest review action. */
  review: string | null;
  review_at: Date | null;
  /** A build-queue round's re-review action: the stored review result is its first verdict. */
  rereview: string | null;
  rereview_at: Date | null;
  check_overall: string | null;
  check_at: Date | null;
  /** The old loop's land outcome, or the build queue's apply decision. */
  decision: string | null;
  reason: string | null;
  decision_at: Date | null;
  /** The owner's ruling on a run that asked, and its summary. */
  answer: string | null;
  answer_summary: string | null;
  answer_at: Date | null;
  line_kind: string | null;
  line_verdict: string | null;
  /** A sweep row: the pull request it is matched through, what its sweep decided and read back. */
  pr: number | null;
  decisions: SweepDecision[] | null;
  landed: number[] | null;
  asked_pr: string | null;
  /** The sweep's record step (the read-back of merges): null until it starts. */
  record_status: string | null;
  /** The item row. */
  number: number | null;
  title: string | null;
  url: string | null;
  console: string | null;
}

export interface SweepDecision {
  number: number;
  action: string;
  reason?: string | null;
  brief?: string | null;
}

/** The shape of `mc.run_issue_number`'s numbers: an address that is not one names no work item. */
export const WORK_ITEM_NUMBER = /^[1-9][0-9]{0,8}$/;

/** The address of a factory's work item page: the one writer of what `WORK_ITEM_NUMBER` reads. */
export function workItemHref(factory: string, number: number): string {
  return `/f/${encodeURIComponent(factory)}/work/${number}`;
}

export const NO_REASON = 'No reason was recorded.';

export type RunLink = { kind: 'lap'; to: string } | { kind: 'console'; href: string };

export interface TimelineEvent {
  key: string;
  kind: 'filed' | 'intake' | 'review' | 'check' | 'decision' | 'answer' | 'round';
  at: Date;
  tone: State;
  text: string;
  detail: string | null;
  run: { id: string; link: RunLink } | null;
  /** The map card a running round is on now. */
  stage: string | null;
}

export interface WorkItemHeader {
  number: number;
  title: string;
  issueUrl: string;
  latestRunHref: string | null;
}

const RANK: Record<TimelineEvent['kind'], number> = {
  filed: 0,
  intake: 1,
  review: 2,
  check: 3,
  decision: 4,
  answer: 5,
  round: 6,
};

export const ROUTE_OF_LABEL: Record<string, string> = {
  'archon-ready': 'deliver',
  'archon-plan': 'plan',
  'archon-investigate': 'investigate',
  'archon-split': 'split',
};

/** A table's text for a key, undefined for a key it does not hold. */
const textOf = (table: Readonly<Record<string, string>>, key: string): string | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

const QUEUE_ENDING_TEXT = {
  ready: 'Ready',
  continue: 'another round',
  asked: 'asked you',
  parked: 'parked',
} as const satisfies Record<keyof typeof QUEUE_ENDING_STATE, string>;

const LOOP_REVIEW_TEXT = {
  merge: 'ready to merge',
  approved: 'approved',
  nothing: 'nothing to do',
  'sent-back': 'sent back',
  'needs-owner': 'needs you',
} as const satisfies Record<keyof typeof REVIEW_OUTCOME_STATE, string>;

const QUEUE_REVIEW_TEXT = {
  none: 'Ready',
  correct: 'fixes requested',
  replan: 'plan again',
  ask: 'asks you',
} as const satisfies Record<keyof typeof QUEUE_REVIEW_STATE, string>;

const runLink = (row: WorkItemRow, factory: string, console: string | null): RunLink | null => {
  if (row.run_id === null) return null;
  if (hasLapPage(row.workflow)) return { kind: 'lap', to: lapHref(factory, row.run_id) };
  return console === null ? null : { kind: 'console', href: consoleUrl(console, row.run_id) };
};

const deliveries = (n: number) => `${n} ${n === 1 ? 'delivery' : 'deliveries'}`;

function header(rows: readonly WorkItemRow[]): WorkItemRow | undefined {
  return rows.find((r) => r.kind === 'item');
}

/** The run the header's "Runs in console" opens: the newest run, or merge-queue sweep that shows on the timeline. */
function newestRun(rows: readonly WorkItemRow[]): WorkItemRow | undefined {
  return rows
    .filter(
      (r) =>
        r.run_id !== null &&
        (r.kind === 'run' || (r.kind === 'sweep' && sweepEvents(r, NO_BASE).length > 0)),
    )
    .sort((a, b) => (b.started_at?.getTime() ?? 0) - (a.started_at?.getTime() ?? 0))[0];
}

export function workItemHeader(rows: readonly WorkItemRow[]): WorkItemHeader | null {
  const item = header(rows);
  if (item === undefined || item.number === null) return null;
  const latest = newestRun(rows);
  return {
    number: item.number,
    title: item.title ?? '',
    issueUrl: item.url ?? '',
    latestRunHref:
      latest?.run_id != null && item.console !== null
        ? consoleUrl(item.console, latest.run_id)
        : null,
  };
}

/** "Round k: " numbered per workflow, oldest run first. */
function roundNumbers(rows: readonly WorkItemRow[]): Map<string, number> {
  const numbers = new Map<string, number>();
  const seen = new Map<string, number>();
  const rounds = rows
    .filter((r) => r.kind === 'run' && r.workflow !== null && LAP_WORKFLOWS.includes(r.workflow))
    .sort((a, b) => (a.started_at?.getTime() ?? 0) - (b.started_at?.getTime() ?? 0));
  for (const r of rounds) {
    const n = (seen.get(r.workflow ?? '') ?? 0) + 1;
    seen.set(r.workflow ?? '', n);
    numbers.set(r.run_id ?? '', n);
  }
  return numbers;
}

function stageOf(row: WorkItemRow): { id: string; title: string } | null {
  const step = deepestStep(row.steps);
  if (step === undefined || row.workflow === null) return null;
  const card = cardForStep(FACTORY_MAP, row.workflow, stepPath(step));
  return card === undefined ? null : { id: card.id, title: card.title };
}

function intakeEvent(row: WorkItemRow, at: Date, base: Base): TimelineEvent {
  if (row.status === 'failed')
    return {
      ...base,
      at,
      tone: RUN_STATE.failed,
      text: `Intake failed: ${row.error ?? NO_REASON}`,
    };
  if (row.status === 'cancelled')
    return { ...base, at, tone: RUN_STATE.cancelled, text: 'Intake cancelled' };
  if (row.completed_at === null)
    return {
      ...base,
      at,
      tone: 'running',
      text: 'Intake running',
      stage: stageOf(row)?.id ?? null,
    };
  const labels = row.labels ?? [];
  // The Board shows the first route name alphabetically (db/queries/board.sql `min`).
  const route = labels
    .map((l) => ROUTE_OF_LABEL[l])
    .filter((r): r is string => r !== undefined)
    .sort()[0];
  const size = labels.find((l) => /^archon-size-[sml]$/.test(l))?.slice(-1);
  const parts = [route && `route ${route}`, size && `size ${size}`].filter(Boolean);
  return {
    ...base,
    at,
    tone: 'done',
    text: parts.length === 0 ? 'Intake finished' : `Intake: ${parts.join(', ')}`,
  };
}

type Base = Pick<TimelineEvent, 'key' | 'kind' | 'detail' | 'run' | 'stage'>;

const NO_BASE = (kind: TimelineEvent['kind']): Base => ({
  key: '',
  kind,
  detail: null,
  run: null,
  stage: null,
});

function roundEvent(row: WorkItemRow, n: number, at: Date, base: Base): TimelineEvent {
  const label = `Round ${n}`;
  const stage = stageOf(row);
  const failedCard =
    row.failed_step === null || row.workflow === null
      ? undefined
      : cardForStep(FACTORY_MAP, row.workflow, stepPath(row.failed_step));
  if (row.status === 'failed')
    return {
      ...base,
      at,
      tone: RUN_STATE.failed,
      text: `${label} failed${
        row.failed_step === null ? '' : ` in ${failedCard?.title ?? stepLabel(row.failed_step)}`
      }: ${row.error ?? NO_REASON}`,
    };
  if (row.status === 'cancelled')
    return { ...base, at, tone: RUN_STATE.cancelled, text: `${label}: cancelled` };
  if (row.waiting === true)
    return { ...base, at, tone: 'needs-you', text: `${label}: waiting for your answer` };
  if (row.completed_at === null)
    return {
      ...base,
      at,
      tone: 'running',
      text: stage === null ? `${label}: running` : `${label}: running, now in ${stage.title}`,
      stage: stage?.id ?? null,
    };
  const seconds = durationOf(row);
  const cost = costOf(row.cost);
  const facts = [
    isOldLoop(row.workflow)
      ? [row.route && `route ${row.route}`, row.depth && `depth ${row.depth}`]
      : [row.deliveries && deliveries(Number(row.deliveries))],
    seconds === null ? null : formatElapsed(seconds),
    cost === null ? null : formatCost(cost),
  ]
    .flat()
    .filter(Boolean);
  if (isOldLoop(row.workflow)) {
    const nothing = row.review === 'nothing' || row.route === 'none';
    return {
      ...base,
      at,
      tone: nothing ? 'idle' : 'done',
      text: `${label}: ${nothing ? 'nothing to do' : facts.join(', ')}`,
    };
  }
  const decision = row.decision ?? '';
  const endingText = textOf(QUEUE_ENDING_TEXT, decision);
  return {
    ...base,
    at,
    tone: stateOf(QUEUE_ENDING_STATE, decision) ?? 'done',
    detail: row.reason,
    text: `${label}: ${[...facts, ...(endingText ? [`then ${endingText}`] : [])].join(', ')}`,
  };
}

function checkEvent(row: WorkItemRow, lines: readonly WorkItemRow[], base: Base): TimelineEvent[] {
  if (row.check_overall === null || row.check_at === null) return [];
  const counts = new Map<string, number>();
  for (const l of lines.filter((l) => l.run_id === row.run_id))
    counts.set(
      `${l.line_kind} ${l.line_verdict}`,
      (counts.get(`${l.line_kind} ${l.line_verdict}`) ?? 0) + 1,
    );
  const tally = [...counts].map(([what, n]) => `${n} ${what}`).join(', ');
  return [
    {
      ...base,
      at: row.check_at,
      tone: stateOf(CHECK_OVERALL_STATE, row.check_overall) ?? 'idle',
      text: `App check ${row.check_overall}${tally === '' ? '' : `: ${tally}`}`,
    },
  ];
}

function loopDecision(row: WorkItemRow, base: Base): TimelineEvent[] {
  if (row.decision_at === null) return [];
  if (row.decision === 'merged')
    return [
      { ...base, at: row.decision_at, tone: GATE_STATE.merged, text: 'Merged', detail: row.reason },
    ];
  if (row.decision === 'refused') {
    const reason = row.reason?.trim() ? row.reason : null;
    return [
      {
        ...base,
        at: row.decision_at,
        tone: GATE_STATE.refused,
        text:
          reason === null ? `Merge gate refused. ${NO_REASON}` : `Merge gate refused: ${reason}`,
      },
    ];
  }
  return [];
}

function sweepDecision(row: WorkItemRow, base: Base): TimelineEvent[] {
  const entry = (row.decisions ?? []).find((d) => d.number === row.pr);
  if (entry === undefined || row.decision_at === null || row.pr === null) return [];
  const at = row.decision_at;
  const reason = entry.reason?.trim() ? entry.reason : null;
  // The record step records a pull request it read back as merged whatever the sweep declared.
  if ((row.landed ?? []).includes(row.pr))
    return [{ ...base, at, tone: 'done', text: 'Merged', detail: reason }];
  switch (entry.action) {
    case 'merged':
      // Only a finished read-back can say the merge did not land: the sweep decides
      // `merged` after the gate merged, so an unfinished read-back proves nothing.
      if (row.record_status === 'completed')
        return [{ ...base, at, tone: 'failed', text: `The merge did not land. ${NO_REASON}` }];
      if (
        row.completed_at === null &&
        row.status !== 'failed' &&
        row.status !== 'cancelled' &&
        row.record_status !== 'failed'
      )
        return [{ ...base, at, tone: 'running', text: 'Merging', detail: reason }];
      return [
        {
          ...base,
          at,
          tone: 'idle',
          text: 'Merged, not read back: the run ended before checking it.',
          detail: reason,
        },
      ];
    case 'return':
      return [
        {
          ...base,
          at,
          tone: SWEEP_ACTION_STATE.return,
          text: `Returned to Build: ${reason ?? NO_REASON}`,
          detail: entry.brief?.trim() ? `Brief: ${entry.brief}` : 'No brief was recorded.',
        },
      ];
    case 'ask':
      if (row.asked_pr !== String(row.pr)) return [];
      return [
        { ...base, at, tone: SWEEP_ACTION_STATE.ask, text: `Asked you: ${reason ?? NO_REASON}` },
      ];
    case 'wait':
      return [
        { ...base, at, tone: SWEEP_ACTION_STATE.wait, text: `Waiting: ${reason ?? NO_REASON}` },
      ];
    default:
      return [];
  }
}

/** What a sweep row shows on this work item: its decision on this pull request, and the answer to an ask raised on it. */
function sweepEvents(
  row: WorkItemRow,
  base: (kind: TimelineEvent['kind']) => Base,
): TimelineEvent[] {
  return [...sweepDecision(row, base('decision')), ...answerEvent(row, base('answer'))];
}

function answerEvent(row: WorkItemRow, base: Base): TimelineEvent[] {
  if (row.answer === null || row.answer_at === null) return [];
  if (row.kind === 'sweep' && row.asked_pr !== String(row.pr)) return [];
  return [
    {
      ...base,
      at: row.answer_at,
      tone: 'done',
      text: `You answered: ${row.answer}`,
      detail: row.answer_summary,
    },
  ];
}

export function workItemTimeline(rows: readonly WorkItemRow[], factory: string): TimelineEvent[] {
  const item = header(rows);
  if (item === undefined) return [];
  const lines = rows.filter((r) => r.kind === 'line');
  const numbers = roundNumbers(rows);
  const events: TimelineEvent[] = [];
  if (item.started_at !== null)
    events.push({
      key: 'filed',
      kind: 'filed',
      at: item.started_at,
      tone: 'done',
      text: 'Filed',
      detail: null,
      run: null,
      stage: null,
    });
  for (const row of rows) {
    if ((row.kind !== 'run' && row.kind !== 'sweep') || row.run_id === null) continue;
    const link = runLink(row, factory, item.console);
    const base = (kind: TimelineEvent['kind']): Base => ({
      key: `${kind}-${row.kind}-${row.run_id}-${row.pr ?? ''}`,
      kind,
      detail: null,
      run: link === null ? null : { id: row.run_id as string, link },
      stage: null,
    });
    if (row.kind === 'sweep') {
      events.push(...sweepEvents(row, base));
      continue;
    }
    if (row.workflow === 'archon-intake') {
      const at = row.completed_at ?? row.started_at;
      if (at !== null) events.push(intakeEvent(row, at, base('intake')));
      continue;
    }
    // A round sits at its start, so the review, check and merge decision it led to follow it.
    const at = row.started_at ?? row.completed_at;
    if (at === null) continue;
    events.push(roundEvent(row, numbers.get(row.run_id) ?? 1, at, base('round')));
    if (isOldLoop(row.workflow)) {
      events.push(...checkEvent(row, lines, base('check')), ...loopDecision(row, base('decision')));
    }
    const [reviewText, reviewState] = isOldLoop(row.workflow)
      ? [LOOP_REVIEW_TEXT, REVIEW_OUTCOME_STATE]
      : [QUEUE_REVIEW_TEXT, QUEUE_REVIEW_STATE];
    for (const [name, outcome, reviewedAt] of [
      ['Review', row.review, row.review_at],
      ['Re-review', row.rereview, row.rereview_at],
    ] as const) {
      const text = outcome === null ? undefined : textOf(reviewText, outcome);
      const tone = stateOf(reviewState, outcome);
      if (text !== undefined && tone !== undefined && reviewedAt !== null)
        events.push({
          ...base('review'),
          key: `${base('review').key}-${name}`,
          at: reviewedAt,
          tone,
          text: `${name}: ${text}`,
        });
    }
    events.push(...answerEvent(row, base('answer')));
  }
  return events.sort(
    (a, b) =>
      a.at.getTime() - b.at.getTime() || RANK[a.kind] - RANK[b.kind] || a.key.localeCompare(b.key),
  );
}
