/**
 * The mission-control laps `fixtures/seed.sql` holds, read from the comment the generator writes above each run
 * (`-- V1 k4: needs-owner on #4`, `-- V3 run A: running on #11`) and the id its run insert gives,
 * so a check compares a screen with the seed's own account of each lap, not with the query that
 * drew it.
 */
export interface SeedLap {
  label: string;
  runId: string;
  /** A finished lap's outcome, or an unfinished run's status (`running`, `paused`, `pending`). */
  what: string;
  issue: number | null;
}

const LAP =
  /^-- (V\d+ (?:k\d+|run [A-Z])): ([a-z-]+)(?: on #(\d+))?\r?\nINSERT INTO remote_agent_workflow_runs \([^)]*\) VALUES \('([0-9a-f-]{36})'/gm;

export function seedLaps(seed: string): SeedLap[] {
  return [...seed.matchAll(LAP)].map(([, label, what, issue, runId]) => ({
    label,
    runId,
    what,
    issue: issue === undefined ? null : Number(issue),
  }));
}
