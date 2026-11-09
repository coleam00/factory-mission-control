/**
 * What the run page works out from a run's rows: costs without a loop's roll-up, loop rounds, the
 * title, why a skipped step was skipped, and the manager's read of a stopped run. One module, so
 * the head, the read and the timeline compute from the same rows. Pure, no React.
 */
import type { StopClass } from './failures';
import { formatCost } from './format';
import { type LapMapRow, mapPathOf } from './lap-graph';
import { costOf, OUTCOME_LABEL } from './laps';
import { questionOf } from './work-item';
import {
  APP_CHECK_WORKFLOW,
  attemptsInRunOrder,
  BUILD_QUEUE_WORKFLOW,
  isOldLoop,
  lapOutcome,
  MERGE_QUEUE_WORKFLOW,
  type OneLapRow,
  type StepAttemptRow,
  workflowLabel,
} from './one-lap';

/** A loop's body step is named `<group>.<body>` on every iteration (lap-graph.ts `mapPathOf`). */
export function bodyOf(stepId: string): { group: string; body: string } | null {
  const at = stepId.indexOf('.');
  return at < 0 ? null : { group: stepId.slice(0, at), body: stepId.slice(at + 1) };
}

/**
 * A loop group's row holds the roll-up of its rounds (0030): it is the row whose id is the prefix
 * of another row's `<group>.<body>` id.
 */
export const isAggregate = (row: StepAttemptRow, rows: readonly StepAttemptRow[]): boolean =>
  rows.some((other) => other.step_id.startsWith(`${row.step_id}.`));

/** What a step cost; null for a loop's roll-up, whose rounds already carry it. */
export const stepCost = (row: StepAttemptRow, rows: readonly StepAttemptRow[]): number | null =>
  isAggregate(row, rows) ? null : costOf(row.cost_usd);

const sumOf = (values: readonly (number | null)[]): number | null => {
  const known = values.filter((value) => value !== null);
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
};

/** The run's cost: the sum of its step costs. Null when no step has one. */
export const runCost = (rows: readonly StepAttemptRow[]): number | null =>
  sumOf(rows.map((row) => stepCost(row, rows)));

/** Tokens in, summed the same way. */
export const runTokens = (rows: readonly StepAttemptRow[]): number | null =>
  sumOf(rows.map((row) => (isAggregate(row, rows) ? null : costOf(row.tokens_input))));

/** One round of a loop: the body steps from its first to its last. */
export interface Round {
  n: number;
  rows: StepAttemptRow[];
  failed: boolean;
  running: boolean;
  durationMs: number | null;
  cost: number | null;
}

export type TimelineEntry =
  | { kind: 'step'; row: StepAttemptRow }
  | {
      kind: 'loop';
      group: string;
      /** The group's own row, which holds the roll-up. */
      row: StepAttemptRow | null;
      rounds: Round[];
    };

/**
 * A new round starts when a body step already ran in the current one. A step that runs again
 * straight after failing is a retry and stays in its round.
 */
function roundsOf(bodies: readonly StepAttemptRow[], all: readonly StepAttemptRow[]): Round[] {
  const groups: StepAttemptRow[][] = [];
  let seen = new Set<string>();
  let previous: StepAttemptRow | undefined;
  for (const row of bodies) {
    const retry = previous?.step_id === row.step_id && previous.status === 'failed';
    if (seen.has(row.step_id) && !retry) {
      groups.push([]);
      seen = new Set();
    }
    if (groups.length === 0) groups.push([]);
    groups[groups.length - 1]?.push(row);
    seen.add(row.step_id);
    previous = row;
  }
  return groups.map((rows, i) => {
    const ms = rows.map((row) => (row.duration_ms === null ? null : Number(row.duration_ms)));
    return {
      n: i + 1,
      rows,
      failed: rows.some((row) => row.status === 'failed'),
      running: rows.some((row) => row.status === 'running'),
      durationMs: sumOf(
        ms.map((value) => (value !== null && Number.isFinite(value) ? value : null)),
      ),
      cost: sumOf(rows.map((row) => stepCost(row, all))),
    };
  });
}

/** The run's steps in the order they started, a loop's body steps gathered under it as rounds. */
export function runTimeline(rows: readonly StepAttemptRow[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const bodies = new Map<string, StepAttemptRow[]>();
  const loops = new Map<string, Extract<TimelineEntry, { kind: 'loop' }>>();
  const loopOf = (group: string) => {
    let loop = loops.get(group);
    if (loop === undefined) {
      loop = { kind: 'loop', group, row: null, rounds: [] };
      loops.set(group, loop);
      bodies.set(group, []);
      entries.push(loop);
    }
    return loop;
  };
  for (const row of attemptsInRunOrder(rows)) {
    const body = bodyOf(row.step_id);
    if (body !== null) bodies.get(loopOf(body.group).group)?.push(row);
    else if (isAggregate(row, rows)) loopOf(row.step_id).row = row;
    else entries.push({ kind: 'step', row });
  }
  for (const [group, loop] of loops) loop.rounds = roundsOf(bodies.get(group) ?? [], rows);
  return entries;
}

/** The loop's body name for a step in a loop, else its id. */
export const displayStep = (stepId: string): string => bodyOf(stepId)?.body ?? stepId;

/** The latest round of the run's longest loop; null when no step ran in a loop. */
const latestRound = (timeline: readonly TimelineEntry[]): number | null => {
  let rounds = 0;
  for (const entry of timeline)
    if (entry.kind === 'loop') rounds = Math.max(rounds, entry.rounds.length);
  return rounds === 0 ? null : rounds;
};

/** The run as a title: what it is, not its id. */
export function runTitle(lap: OneLapRow, timeline: readonly TimelineEntry[]): string {
  const issue = lap.issue_number === null ? '' : ` #${lap.issue_number}`;
  const pr = lap.pr_number;
  switch (lap.workflow_name) {
    case BUILD_QUEUE_WORKFLOW: {
      const round = latestRound(timeline);
      return `Build${issue}${round === null ? '' : `, round ${round}`}`;
    }
    case APP_CHECK_WORKFLOW:
      return pr === null ? 'App check' : `App check, PR #${pr}`;
    case MERGE_QUEUE_WORKFLOW:
      return 'Merge sweep';
    default:
      return `${workflowLabel(lap.workflow_name)}${issue || (pr === null ? '' : `, PR #${pr}`)}`;
  }
}

/** Why a skipped step did not run, from the steps around it and the stored map; null when none is recorded. */
export function skipReason(
  row: StepAttemptRow,
  scope: readonly StepAttemptRow[],
  map: readonly LapMapRow[],
): string | null {
  const ordered = attemptsInRunOrder(scope);
  const at = ordered.indexOf(row);
  if (ordered.slice(0, Math.max(at, 0)).some((other) => other.status === 'failed')) {
    return 'upstream failed';
  }
  const known = new Set(map.map((r) => r.path));
  const node = map.find((r) => r.path === mapPathOf(row.step_id, known));
  if (node?.when_condition) return `when: ${node.when_condition}`;
  if (node?.trigger_rule) return `trigger rule ${node.trigger_rule}`;
  return null;
}

/** Consecutive items that satisfy `skipped`, gathered into one `{ skipped }` group; the rest pass through. */
export function collapseSkipped<T>(
  items: readonly T[],
  skipped: (item: T) => boolean,
): (T | { skipped: T[] })[] {
  const out: (T | { skipped: T[] })[] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (!skipped(item)) out.push(item);
    else if (last !== undefined && typeof last === 'object' && last !== null && 'skipped' in last) {
      (last as { skipped: T[] }).skipped.push(item);
    } else out.push({ skipped: [item] });
  }
  return out;
}

/** The run's latest failed attempt of `stepId`, else of any step. */
export function failedAttempt(rows: readonly StepAttemptRow[], stepId: string | null) {
  const failed = attemptsInRunOrder(rows).filter((row) => row.status === 'failed');
  return failed.filter((row) => row.step_id === stepId).at(-1) ?? failed.at(-1) ?? null;
}

/**
 * What resuming a failed step runs again, and its rough cost from this run's earlier rounds: in a
 * loop that has run the step before, the earlier round from the step onward. With no earlier round
 * there is nothing to estimate from, so the cost is null.
 */
export function resumeEstimate(
  failed: StepAttemptRow,
  rows: readonly StepAttemptRow[],
  timeline: readonly TimelineEntry[],
): { step: string; cost: number | null } {
  const step = displayStep(failed.step_id);
  const group = bodyOf(failed.step_id)?.group;
  const loop = timeline.find((entry) => entry.kind === 'loop' && entry.group === group);
  if (loop?.kind === 'loop') {
    const own = loop.rounds.find((round) => round.rows.includes(failed));
    const earlier = loop.rounds.filter((round) => own !== undefined && round.n < own.n).at(-1);
    const from = earlier?.rows.findIndex((row) => row.step_id === failed.step_id) ?? -1;
    if (earlier !== undefined && from >= 0) {
      return { step, cost: sumOf(earlier.rows.slice(from).map((row) => stepCost(row, rows))) };
    }
  }
  return { step, cost: null };
}

const NOT_CODE: Record<Exclude<StopClass, 'code'>, string> = {
  transient: 'it looks transient',
  environment: 'the environment refused it',
  config: "the factory's configuration needs a fix",
  input: 'the run was given the wrong input',
};

/** A piece of the read's text; the page draws a bold one with `<b>`. */
export interface ReadPart {
  text: string;
  bold?: boolean;
}

export interface ManagerRead {
  parts: ReadPart[];
  stopClass: StopClass | null;
  /** Whether the stop is a code failure; unknown when its error matches no known cause. */
  codeFailure: 'yes' | 'no' | 'unknown';
  resumeStep: string | null;
  resumeCost: number | null;
}

const firstLine = (text: string | null) =>
  text
    ?.split(/\r?\n/)
    .find((line) => line.trim() !== '')
    ?.trim() ?? null;

const NO_STOP = {
  stopClass: null,
  codeFailure: 'unknown',
  resumeStep: null,
  resumeCost: null,
} as const;

/** A paused run holding an answer that is queued for a free slot; the pill, the read and the primary action all key off this. */
export function waitsForSlot(lap: OneLapRow): boolean {
  return lap.status === 'paused' && lap.capacity_since !== null;
}

/** The manager's read of a run, written from its stop record and rows by fixed templates. */
export function managerRead(
  lap: OneLapRow,
  rows: readonly StepAttemptRow[],
  timeline: readonly TimelineEntry[],
): ManagerRead {
  const plain = (...parts: ReadPart[]): ManagerRead => ({ ...NO_STOP, parts });
  switch (lap.status) {
    case 'failed': {
      const failed = failedAttempt(rows, lap.stop_step);
      const stepId = lap.stop_step ?? failed?.step_id ?? null;
      const line = lap.stop_line ?? firstLine(failed?.error ?? null);
      const stopClass = lap.stop_class;
      const codeFailure = stopClass === null ? 'unknown' : stopClass === 'code' ? 'yes' : 'no';
      const loop = timeline.find(
        (entry) =>
          entry.kind === 'loop' && entry.rounds.some((r) => failed && r.rows.includes(failed)),
      );
      const round =
        loop?.kind === 'loop'
          ? loop.rounds.find((r) => failed && r.rows.includes(failed))
          : undefined;
      const parts: ReadPart[] = [
        {
          text: stepId === null ? 'The run' : displayStep(stepId),
          bold: true,
        },
        {
          text: ` failed${round === undefined ? '' : ` on round ${round.n}`}${line === null ? '.' : `: ${line}.`}`,
        },
      ];
      const ordered = attemptsInRunOrder(rows);
      const before = failed === null ? [] : ordered.slice(0, ordered.indexOf(failed));
      if (stepId !== null && !before.some((row) => row.status === 'failed')) {
        parts.push({ text: ' Everything before it succeeded.' });
      }
      let resumeStep: string | null = null;
      let resumeCost: number | null = null;
      if (failed !== null) {
        const estimate = resumeEstimate(failed, rows, timeline);
        resumeStep = estimate.step;
        resumeCost = estimate.cost;
        parts.push(
          { text: ' ' },
          { text: 'Resume', bold: true },
          { text: ` re-runs ${estimate.step} and what follows` },
          {
            text: estimate.cost === null ? '.' : `, for about ${formatCost(estimate.cost)}.`,
          },
        );
      }
      parts.push({
        text:
          stopClass === null
            ? ' Whether it is a code failure is not known: its error matches no known cause.'
            : stopClass === 'code'
              ? ' This is a code failure.'
              : ` This is not a code failure: ${NOT_CODE[stopClass]}.`,
      });
      return { parts, stopClass, codeFailure, resumeStep, resumeCost };
    }
    case 'paused': {
      if (waitsForSlot(lap)) {
        return plain({ text: 'It has your answer and is waiting for a free slot to continue.' });
      }
      const step = lap.stop_step === null ? 'The run' : displayStep(lap.stop_step);
      return plain(
        { text: step, bold: true },
        {
          text: ` is waiting on you${lap.stop_line === null ? '.' : `: ${questionOf(lap.stop_line)}.`}`,
        },
      );
    }
    case 'completed': {
      const outcome = isOldLoop(lap.workflow_name) ? lapOutcome(lap) : null;
      return plain({
        text: `It finished${outcome === null ? '' : `: ${OUTCOME_LABEL[outcome]}`}.`,
      });
    }
    case 'cancelled':
      return plain({ text: 'It was cancelled.' });
    case 'pending':
      return plain({ text: 'It has not started yet.' });
    case 'running': {
      const current = rows.filter((row) => row.status === 'running').at(-1);
      return current === undefined
        ? plain({ text: 'It is running.' })
        : plain(
            { text: 'It is running ' },
            { text: displayStep(current.step_id), bold: true },
            { text: ' now.' },
          );
    }
    default: {
      const unreachable: never = lap.status;
      return plain({ text: `Its state is ${String(unreachable)}.` });
    }
  }
}
