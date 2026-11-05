/**
 * The `queues` and `version` CTEs that open every step query: which architecture the step screen
 * shows. step-detail.sql's copy is the owner (#435, #453); version-rule.test.ts holds the others to it.
 */
export function versionRule(sql: string): string {
  if (!sql.startsWith('WITH queues AS ('))
    throw new Error('the query does not open with the queues CTE');
  const end = /^\s*LIMIT 1\s*\r?\n\)/m.exec(sql);
  if (!end) throw new Error('the query has no version CTE ending in LIMIT 1');
  return sql.slice(0, end.index + end[0].length);
}

/**
 * step-detail.sql's rule, then the version's architecture key. Parameters: the factory and the
 * address pin, '' for the current version.
 */
export function currentVersionSql(stepDetailSql: string): string {
  return `${versionRule(stepDetailSql)}\nSELECT archon_sha, factory_sha FROM version`;
}

/** Every query that copies the rule, step-detail first. */
export const STEP_QUERIES_WITH_THE_RULE = [
  'step-detail',
  'step-nesting',
  'step-prompt',
  'step-scripts',
  'step-subagents',
  'step-yaml',
  'step-versions',
];
