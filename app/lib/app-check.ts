/**
 * The kinds `mc.app_check_lines` stores (0024's `app_check_lines_kind_check`, held by
 * `db/schema.test.ts`).
 */
export const APP_CHECK_KINDS = ['criterion', 'holdout', 'probe', 'assertion', 'defect'] as const;

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
