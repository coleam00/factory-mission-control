import type { Db } from '../scripts/lib/db';
import { MANAGER_LIMITS, readOnlyQuery } from './manager-sql';

/** These bound the briefing's input: each section lists at most this many and counts the rest. */
export const DAY_MERGED_CAP = 30;
export const DAY_RUNS_CAP = 30;

export type DaySection<T> = { items: T[]; and_more: number };

export type DayDigest = {
  day: string;
  merged: DaySection<{ number: number; title: string }>;
  runs: DaySection<{ workflow: string; status: string; runs: number }>;
};

/*
 * One statement, so the sections describe the same day. A run belongs to the day its completed_at
 * falls (started_at only while it has not ended). The day and zone are bound: this is server SQL,
 * which may know the clock, where a live query under db/queries/ may not.
 */
const DAY_SQL = `WITH day_laps AS (
  SELECT l.run_id, l.workflow_name, l.status, l.completed_at FROM mc.laps l
  WHERE l.factory = $1 AND (coalesce(l.completed_at, l.started_at) AT TIME ZONE $2)::date = $3::date
), merged AS (
  SELECT p.number, left(p.title, 200) AS title, p.merged_at FROM mc.pull_requests p
  WHERE p.factory = $1 AND (p.merged_at AT TIME ZONE $2)::date = $3::date
)
SELECT
  (SELECT coalesce(json_agg(json_build_object('number', m.number, 'title', m.title) ORDER BY m.merged_at DESC, m.number DESC), '[]'::json)
     FROM (SELECT * FROM merged ORDER BY merged_at DESC, number DESC LIMIT $4) m) AS merged,
  (SELECT count(*)::int FROM merged) AS merged_total,
  (SELECT coalesce(json_agg(json_build_object('workflow', w.workflow_name, 'status', w.status, 'runs', w.runs) ORDER BY w.runs DESC, w.workflow_name, w.status), '[]'::json)
     FROM (SELECT workflow_name, status, count(*)::int AS runs FROM day_laps GROUP BY workflow_name, status ORDER BY runs DESC, workflow_name, status LIMIT $5) w) AS runs,
  (SELECT count(*)::int FROM (SELECT DISTINCT workflow_name, status FROM day_laps) x) AS runs_total`;

function section<T>(items: T[], total: number): DaySection<T> {
  return { items, and_more: total - items.length };
}

/** Today's merges and runs by workflow and outcome, each section capped. */
export async function readDayDigest(
  db: Db,
  factory: string,
  day: string,
  zone: string,
): Promise<DayDigest> {
  const { rows } = await readOnlyQuery(
    db,
    DAY_SQL,
    [factory, zone, day, DAY_MERGED_CAP, DAY_RUNS_CAP],
    MANAGER_LIMITS,
  );
  const row = rows[0] as {
    merged: DayDigest['merged']['items'];
    merged_total: number;
    runs: DayDigest['runs']['items'];
    runs_total: number;
  };
  return {
    day,
    merged: section(row.merged, row.merged_total),
    runs: section(row.runs, row.runs_total),
  };
}
