import type { FactoryEntry } from '../../server/factories';
import type { Db } from './db';

/**
 * Upserts `entries` into mc.factories by name, deleting none, and gives each lap projected
 * before its factory existed (factory '' or its codebase's name) the factory the projection would
 * now choose, then projects the versions (mc.project_version) of every digest those laps moved to
 * and from, so a factory registered after its runs lists them on the version strip. Returns how
 * many factory and lap rows changed. `entries` is bound as the array itself: Bun
 * encodes a string bound to `::jsonb` as a jsonb string, which jsonb_to_recordset rejects.
 */
export async function loadFactories({
  entries,
  db,
}: {
  entries: FactoryEntry[];
  db: Db;
}): Promise<{ factories: number; laps: number }> {
  const changed = { factories: 0, laps: 0 };
  await db.transaction(async (tx) => {
    changed.factories = (
      await tx.query(
        `INSERT INTO mc.factories AS f (name, repository, codebase, console)
         SELECT name, repository, codebase, console
           FROM jsonb_to_recordset($1::jsonb)
             AS e(name text, repository text, codebase text, console text)
         ON CONFLICT (name) DO UPDATE SET
           repository = EXCLUDED.repository,
           codebase = EXCLUDED.codebase,
           console = EXCLUDED.console
         WHERE (f.repository, f.codebase, f.console)
           IS DISTINCT FROM (EXCLUDED.repository, EXCLUDED.codebase, EXCLUDED.console)
         RETURNING f.name`,
        [entries],
      )
    ).length;
    const moved = await tx.query(
      `UPDATE mc.laps l SET factory = m.factory
           FROM (SELECT r.id, c.name AS codebase,
                   (SELECT f.name FROM mc.factories f WHERE f.codebase = c.name
                     ORDER BY f.name LIMIT 1) AS factory
                   FROM public.remote_agent_workflow_runs r
                   JOIN public.remote_agent_codebases c ON c.id = r.codebase_id) m
          WHERE l.run_id = m.id AND l.factory IN ('', m.codebase) AND l.factory <> m.factory
         RETURNING l.factory, m.codebase AS was, l.digest`,
      [],
    );
    changed.laps = moved.length;
    await tx.query(
      `SELECT mc.project_version(p.factory, p.digest)
         FROM (SELECT DISTINCT factory, digest FROM jsonb_to_recordset($1::jsonb)
                 AS e(factory text, digest text)
                WHERE digest IS NOT NULL) p`,
      [moved.flatMap((r) => [r, { factory: r.was, digest: r.digest }])],
    );
  });
  return changed;
}
