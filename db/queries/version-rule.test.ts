import { expect, test } from 'bun:test';
import { onTheSeed, queries } from './test-seed';
import { currentVersionSql, versionRule } from './version-rule';

const sql = (name: string) => queries.find(([n]) => n === name)?.[1] as string;
const normalized = (text: string) =>
  text
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** The two CTEs apart: the version's FROM clause onward is the choice of version. */
function parts(name: string, address: string) {
  const rule = normalized(versionRule(sql(name))).replaceAll(address, '$V');
  return {
    queues: rule.slice(0, rule.indexOf('), version AS (')),
    version: rule.slice(rule.indexOf('FROM mc.arch_versions a')),
  };
}

// status-strip names the engine of the same current version, so it is held to the rule too.
const stepQueries = queries
  .map(([n]) => n)
  .filter((n) => n.startsWith('step-') || n === 'status-strip');
const addressOf = (name: string) => (name === 'step-detail' ? '$2' : '$4');
const owner = parts('step-detail', '$2');

// step-versions and status-strip take no address: the '' case, written out.
const WITH_ADDRESS =
  "CASE WHEN $V = '' THEN q.on_queues OR p.sha IS NOT NULL ELSE (p.sha = $V OR a.archon_sha = $V) END";
const WITH_ADDRESS_ORDER = "CASE WHEN $V = '' AND q.on_queues THEN";

test("every step query's queues test is step-detail's", () => {
  const differ = stepQueries.filter((name) => parts(name, addressOf(name)).queues !== owner.queues);
  expect(differ).toEqual([]);
});

test('every step query chooses its version as step-detail does', () => {
  expect(owner.version).toContain(WITH_ADDRESS);
  expect(owner.version).toContain(WITH_ADDRESS_ORDER);
  const withoutAddress = owner.version
    .replace(WITH_ADDRESS, 'q.on_queues OR p.sha IS NOT NULL')
    .replace(WITH_ADDRESS_ORDER, 'CASE WHEN q.on_queues THEN');

  const differ = stepQueries.flatMap((name) => {
    const expected =
      name === 'step-versions' || name === 'status-strip' ? withoutAddress : owner.version;
    const got = parts(name, addressOf(name)).version;
    return got === expected ? [] : [[name, got]];
  });
  expect(differ).toEqual([]);
});

test("the live check's current version is the one step-versions marks current", async () => {
  const db = await onTheSeed();
  try {
    const rows = await db.query(currentVersionSql(sql('step-detail')), ['mission-control', '']);
    expect(rows).toHaveLength(1);
    const [current] = (await db.query(sql('step-versions'), ['mission-control'])).filter(
      (v) => v.is_current,
    );
    const [pin] = await db.query('SELECT archon_sha FROM mc.pins WHERE sha = $1', [current?.sha]);
    expect(rows[0]?.archon_sha).toBe(pin?.archon_sha);
  } finally {
    await db.close();
  }
});

// The two one-lap queries draw one lap's version apart: one-lap-steps lists the steps of the version
// one-lap-map draws the map from, so the choice (the gate, the holder test, the order) must not drift.
const lapQueue = (name: string) => {
  const text = normalized(sql(name));
  const start = text.indexOf('queues AS (');
  return {
    queues: text.slice(start, text.indexOf('), version AS (')),
    holds: text.slice(
      text.indexOf('EXISTS (SELECT 1 FROM mc.arch_steps'),
      text.indexOf(' ORDER BY'),
    ),
    order: text
      .slice(text.indexOf(' ORDER BY'), text.indexOf(' LIMIT 1'))
      .replaceAll('l.started_at', 'lap.started_at'),
  };
};

test("the one-lap queries' queues test is step-detail's, and both choose a lap's version alike", () => {
  const map = lapQueue('one-lap-map');
  const steps = lapQueue('one-lap-steps');
  expect(`WITH ${map.queues}`).toBe(owner.queues);
  expect(`WITH ${steps.queues}`).toBe(owner.queues);
  expect(map.order).toContain('(q.on_queues AND p.sha IS NULL) DESC');
  expect(steps.order).toBe(map.order);
  expect(steps.holds.replaceAll('l.workflow_name', 'lap.workflow_name')).toBe(map.holds);
});
