/** A row of `db/queries/app-check.sql`: an open pull request and its latest app check. */
export interface AppCheckRow {
  number: number;
  title: string | null;
  url: string | null;
  run_id: string;
  /** PASS or FAIL; null while the check is still running. */
  overall: string | null;
  criteria: number;
  probes: number;
  assertions: number;
}
