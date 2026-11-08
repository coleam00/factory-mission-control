import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { snapshot } from '../db/test-db';
import { FACTORY, FAILED_RUN, type ManagerDb, startManagerDb } from './manager-fixture';
import { adHocSelect, MANAGER_LIMITS, RefusedQuery, readOnlyQuery } from './manager-sql';

let fixture: ManagerDb;
beforeAll(async () => {
  fixture = await startManagerDb();
}, 60_000);
afterAll(() => fixture.stop());

const select = (text: string) => adHocSelect(fixture.db, text, MANAGER_LIMITS);

describe('the ad hoc SELECT', () => {
  test('reads mc, accepts a trailing semicolon or comment, and caps its rows', async () => {
    expect((await select('SELECT run_id::text AS id FROM mc.laps ORDER BY 1;')).rows).toHaveLength(
      3,
    );
    expect((await select('-- all\nSELECT 1 AS n FROM mc.laps -- done')).rows).toHaveLength(3);
    const capped = await adHocSelect(fixture.db, 'SELECT * FROM mc.laps', {
      ...MANAGER_LIMITS,
      rowCap: 1,
    });
    expect(capped.rows).toHaveLength(1);
    expect(capped.truncated).toBe(true);
  });

  test('runs under the statement timeout', async () => {
    const { rows } = await select("SELECT current_setting('statement_timeout') AS t");
    expect(rows[0]?.t).toBe('5s');
  });

  test.each([
    ['a DELETE', `DELETE FROM mc.laps WHERE run_id::text = '${FAILED_RUN}'`],
    ['a data-modifying CTE', 'WITH d AS (DELETE FROM mc.laps RETURNING 1) SELECT * FROM d'],
    ['a COMMIT injection', `SELECT 1) q; COMMIT; DELETE FROM mc.laps; SELECT * FROM (SELECT 1`],
    ['Archon’s tables', 'SELECT * FROM public.remote_agent_workflow_runs'],
    ['the catalog', 'SELECT * FROM pg_class'],
    [
      'query_to_xml',
      "SELECT query_to_xml('select * from public.remote_agent_workflow_runs', true, false, '')",
    ],
    [
      'ts_stat',
      "SELECT word FROM ts_stat('SELECT to_tsvector(''simple'', user_message) FROM public.remote_agent_workflow_runs')",
    ],
    ['ts_rewrite', "SELECT ts_rewrite('a'::tsquery, 'SELECT ''a''::tsquery, ''b''::tsquery')"],
    [
      'ts_stat in the select list',
      "SELECT (ts_stat('SELECT to_tsvector(''simple'', user_message) FROM public.remote_agent_workflow_runs')).word",
    ],
    ['pg_show_all_settings in the select list', 'SELECT pg_show_all_settings()'],
    ['pg_hba_file_rules in the select list', 'SELECT pg_hba_file_rules()'],
    ['pg_prepared_statement in the select list', 'SELECT pg_prepared_statement()'],
    ['pg_settings', 'SELECT * FROM pg_settings'],
    ['pg_show_all_settings', 'SELECT * FROM pg_show_all_settings()'],
    ['pg_stat_get_activity', 'SELECT * FROM pg_stat_get_activity(NULL)'],
    ['a quoted query_to_xml', `SELECT "query_to_xml"('select 1', true, false, '')`],
    [
      'a write hidden in a function',
      "SELECT mc.project_attention_item(gen_random_uuid(), NULL, 'w', 'running', '{}'::jsonb)",
    ],
  ])('refuses %s and leaves mc unchanged', async (_name, text) => {
    const before = await snapshot(fixture.direct);
    await expect(select(text)).rejects.toThrow();
    expect(await snapshot(fixture.direct)).toEqual(before);
  });

  test('says why a statement that is not a SELECT is refused', async () => {
    await expect(select('DELETE FROM mc.laps')).rejects.toBeInstanceOf(RefusedQuery);
  });
});

test('a named query takes its parameters and the same read-only transaction', async () => {
  const { rows } = await readOnlyQuery(
    fixture.db,
    'SELECT count(*)::int AS n FROM mc.laps WHERE factory = $1',
    [FACTORY],
    MANAGER_LIMITS,
  );
  expect(rows[0]?.n).toBe(2);
  await expect(
    readOnlyQuery(
      fixture.db,
      'SELECT 1 FROM mc.laps WHERE factory = $1; DELETE FROM mc.laps',
      [FACTORY],
      MANAGER_LIMITS,
    ),
  ).rejects.toThrow();
  expect((await snapshot(fixture.direct)).laps).toHaveLength(3);
});
