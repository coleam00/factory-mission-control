/**
 * The Failures view of Runs (v3 README, owner change 2): one card per failure cause, newest first,
 * from the rows of `failure-groups`. Pure, no React. Failures are never counted as things that need
 * the owner, so nothing here is an Attention item.
 */
import type { FailureGroupRow, StopClass } from './failures';
import { lapHref, workflowLabel } from './one-lap';
import { waited } from './owner-queue';
import { since } from './laps';
import { STOP_CLASS_STATE, type State } from './states';

export const FAILURES_QUERY = 'failure-groups';

/** The muted line's query: the transient failures a later run retried. */
export const RETRIED_QUERY = 'retried-runs';

export function retriedLine(n: number): string {
  return `${n === 1 ? '1 run hit' : `${n} runs hit`} a passing database or GitHub error today and ${n === 1 ? 'was' : 'were'} retried.`;
}

export type FailureLabel = StopClass | 'mixed' | 'unclassified';

/** The class a group shows on its card; a group with no class is unclassified. */
export const failureLabel = (g: Pick<FailureGroupRow, 'class'>): FailureLabel =>
  g.class ?? 'unclassified';

export interface FailureCard {
  key: string;
  title: string;
  workflow: string;
  step: string | null;
  pill: { label: FailureLabel; state: State };
  failures: number;
  lastAt: Date | null;
  /** The error, whole; the card cuts it to one line. */
  line: string | null;
  /** The latest run, where the full text is. */
  href: string;
}

const lastTime = (g: FailureGroupRow) => g.last_at?.getTime() ?? 0;

/** One card per failure signature, the most recently failed first. */
export function failureCards(rows: readonly FailureGroupRow[], factory: string): FailureCard[] {
  return [...rows]
    .sort(
      (a, b) =>
        lastTime(b) - lastTime(a) ||
        b.failures - a.failures ||
        a.signature.localeCompare(b.signature),
    )
    .map((g) => {
      const label = workflowLabel(g.workflow_name);
      const pill = failureLabel(g);
      return {
        key: g.signature,
        title: g.step_id === null ? `${label} failed` : `${label} failed at ${g.step_id}`,
        workflow: g.workflow_name,
        step: g.step_id,
        pill: { label: pill, state: STOP_CLASS_STATE[pill] },
        failures: g.failures,
        lastAt: g.last_at,
        line: g.line,
        href: lapHref(factory, g.latest_run_id),
      };
    });
}

/** "3 runs, last 4h 12m ago": the count and the age in words. */
export function failureWhen(card: Pick<FailureCard, 'failures' | 'lastAt'>, now: number): string {
  const runs = card.failures === 1 ? '1 run' : `${card.failures} runs`;
  const seconds = since(card.lastAt, now);
  return seconds === null ? runs : `${runs}, last ${waited(seconds)} ago`;
}
