import { afterEach, beforeAll, expect, test } from 'bun:test';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { ARCHON_TABLES, testDb } from '../db/test-db';
import type { GetFetch } from '../function/github';
import { HOOKS_DIR, parsePack, type Step } from '../parsers/pack';
import {
  ARCH_TABLES,
  ARCHON_REPOSITORY,
  archRows,
  FACTORY_HOOKS_DIR,
  FACTORY_REPOSITORY,
  main,
  PACK_DIR,
} from './arch-parse';
import { REPO_ROOT } from './lib/cli';
import type { Db } from './lib/db';
import { DATABASE_URL, recordingDeps, scratchRepo } from './lib/test-deps';
import { migrationsDir, readMigrationFiles, runMigrations } from './migrate';

const PACK = join(REPO_ROOT, 'fixtures/pack');
const TEMPLATE = join(REPO_ROOT, 'fixtures/factory-template');
const TEMPLATE_HOOKS = join(TEMPLATE, HOOKS_DIR);
const ARCHON_SHA = readFileSync(join(PACK, 'ARCHON_COMMIT'), 'utf8').trim();
const FACTORY_SHA = readFileSync(join(TEMPLATE, 'FACTORY_COMMIT'), 'utf8').trim();
const LOCAL = ['--archon-path', PACK, '--factory-path', TEMPLATE];
const TABLES = ['arch_versions', ...ARCH_TABLES];

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = scratchRepo({ MC_DATABASE_URL: DATABASE_URL });
  scratch.push(dir);
  return dir;
}

const pg = testDb();
/** The same in-memory database for every run, so a second run sees the first one's rows. */
const db: Db = { ...pg, async close() {} };

beforeAll(async () => {
  await pg.query(ARCHON_TABLES);
  await runMigrations({ files: readMigrationFiles(migrationsDir(REPO_ROOT)), db: pg });
});

afterEach(async () => {
  for (const table of TABLES) await pg.query(`DELETE FROM mc.${table}`);
});

/** Runs the job against the shared database on branch `check-abc` unless `options` says otherwise. */
async function run(
  argv: string[],
  options: Partial<Parameters<typeof recordingDeps>[0]> = {},
  now?: Date,
) {
  const recorder = recordingDeps({ repoRoot: repo(), branchName: 'check-abc', ...options });
  recorder.deps.openDb = (url) => {
    recorder.opened.push(url);
    return db;
  };
  if (now) recorder.deps.now = () => now;
  return { ...recorder, exit: await main(argv, recorder.deps) };
}

/** Each table's row count, as the job prints it. */
const counts = (out: string[]) => out.filter((line) => line.startsWith('mc.'));

const everyRow = () =>
  Promise.all(
    TABLES.map((table) => pg.query(`SELECT * FROM mc.${table} AS row ORDER BY row::text`)),
  );

test('stores the archon-loop steps in parser order, keyed by the full shas', async () => {
  const job = await run([ARCHON_SHA.slice(0, 8), FACTORY_SHA, ...LOCAL]);
  expect(job.exit).toBe(0);
  expect(job.out[0]).toBe(`archon ${ARCHON_SHA} factory ${FACTORY_SHA}`);
  expect(counts(job.out)).toContain('mc.arch_versions 1');

  const stored = await pg.query(
    `SELECT path FROM mc.arch_steps WHERE archon_sha = $1 AND factory_sha = $2 AND workflow = 'archon-loop' ORDER BY position`,
    [ARCHON_SHA, FACTORY_SHA],
  );
  const loop = parsePack(join(PACK, 'sdlc'), TEMPLATE).workflows.find(
    (w) => w.name === 'archon-loop',
  );
  const inOrder = (step: Step): string[] => [step.path, ...step.steps.flatMap(inOrder)];
  expect(loop).toBeDefined();
  expect(stored.map((row) => row.path)).toEqual(loop?.steps.flatMap(inOrder) ?? []);
  expect(job.requests).toEqual([]);
});

test('a second run for the same shas leaves every row as it was', async () => {
  const first = await run([ARCHON_SHA, FACTORY_SHA, ...LOCAL]);
  expect(first.exit).toBe(0);
  const before = await everyRow();

  const second = await run([ARCHON_SHA, FACTORY_SHA, ...LOCAL], {}, new Date('2026-10-25T00:00Z'));
  expect(second.exit).toBe(0);
  expect(counts(second.out)).toEqual(counts(first.out));
  expect(await everyRow()).toEqual(before);
});

test('a CRLF checkout stores the same rows as an LF one', async () => {
  const lf = await run([ARCHON_SHA, FACTORY_SHA, ...LOCAL]);
  expect(lf.exit).toBe(0);
  const lfRows = await everyRow();
  for (const table of TABLES) await pg.query(`DELETE FROM mc.${table}`);

  const checkout = mkdtempSync(join(tmpdir(), 'arch-parse-crlf-'));
  scratch.push(checkout);
  for (const [from, to] of [
    [PACK, 'pack'],
    [TEMPLATE, 'template'],
  ] as const) {
    const dir = join(checkout, to);
    cpSync(from, dir, { recursive: true });
    for (const file of filesOf(dir)) {
      const path = join(dir, file);
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll('\n', '\r\n'));
    }
  }
  expect(readFileSync(join(checkout, 'pack/sdlc/loop/archon-loop.yaml'), 'utf8')).toContain('\r\n');

  const crlf = await run([
    ARCHON_SHA,
    FACTORY_SHA,
    '--archon-path',
    join(checkout, 'pack'),
    '--factory-path',
    join(checkout, 'template'),
  ]);
  expect(crlf.err).toEqual([]);
  expect(crlf.exit).toBe(0);
  expect(crlf.out).toEqual(lf.out);
  expect(await everyRow()).toEqual(lfRows);
});

test.each(['main', 'fixture'])(
  'refuses target branch %s before reading or writing anything',
  async (branchName) => {
    const job = await run([ARCHON_SHA, FACTORY_SHA], { branchName });
    expect(job.exit).toBe(1);
    expect(job.err.join('\n')).toContain(`refusing branch '${branchName}'`);
    expect(job.opened).toEqual([]);
    expect(job.requests).toEqual([]);
    expect(await pg.query('SELECT 1 FROM mc.arch_versions')).toEqual([]);
  },
);

test('arch:parse:main refuses main unless the owner confirms at a terminal', async () => {
  const job = await run(['--main', ARCHON_SHA, FACTORY_SHA, ...LOCAL], {
    branchName: 'main',
    owner: false,
  });
  expect(job.exit).toBe(1);
  expect(job.opened).toEqual([]);
});

test('refuses a local snapshot at another commit than the sha given', async () => {
  const job = await run(['0123abcd', FACTORY_SHA, ...LOCAL]);
  expect(job.exit).toBe(1);
  expect(job.err.join('\n')).toContain(`is at ${ARCHON_SHA}, not 0123abcd`);
  expect(job.opened).toEqual([]);
});

test.each([
  ['a missing directory', 'fixtures/no-such-template'],
  ['a directory without hooks', 'fixtures'],
])('refuses %s as the factory path and keeps the stored rows', async (_, factoryPath) => {
  expect((await run([ARCHON_SHA, FACTORY_SHA, ...LOCAL])).exit).toBe(0);
  const before = await everyRow();

  const job = await run([
    ARCHON_SHA,
    FACTORY_SHA,
    '--archon-path',
    PACK,
    '--factory-path',
    factoryPath,
  ]);
  expect(job.exit).toBe(1);
  expect(job.err.join('\n')).toContain(`no ${HOOKS_DIR} under`);
  expect(job.opened).toEqual([]);
  expect(await everyRow()).toEqual(before);
});

test('refuses a missing archon path', async () => {
  const job = await run([
    ARCHON_SHA,
    FACTORY_SHA,
    '--archon-path',
    'fixtures/no-such-pack',
    '--factory-path',
    TEMPLATE,
  ]);
  expect(job.exit).toBe(1);
  expect(job.err.join('\n')).toContain('no pack at');
  expect(job.opened).toEqual([]);
});

test('every row the job builds names exactly its table columns', async () => {
  const rows = archRows(parsePack(join(PACK, 'sdlc'), TEMPLATE));
  for (const table of ARCH_TABLES) {
    const columns = await pg.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'mc' AND table_name = $1 AND column_name NOT IN ('archon_sha', 'factory_sha')`,
      [table],
    );
    const names = columns.map((c) => String(c.column_name)).sort();
    expect(rows[table].length).toBeGreaterThan(0);
    for (const row of rows[table]) expect(Object.keys(row).sort()).toEqual(names);
  }
});

test.each([[[]], [[ARCHON_SHA]], [['not-a-sha', FACTORY_SHA]]])(
  'exits 2 with usage for %j before touching Neon',
  async (argv) => {
    const job = await run(argv);
    expect(job.exit).toBe(2);
    expect(job.err.join('\n')).toContain('usage: bun run arch:parse');
    expect(job.neonCalls).toEqual([]);
  },
);

/** Every file under `dir`, `/`-separated and relative to it. */
function filesOf(dir: string, at = dir): string[] {
  return readdirSync(at).flatMap((entry) => {
    const path = join(at, entry);
    return statSync(path).isDirectory()
      ? filesOf(dir, path)
      : [relative(dir, path).replaceAll('\\', '/')];
  });
}

/** A holdout scenario beside the template's hooks, which the job must never request. */
const HOLDOUT = 'template/.factory/holdouts/H-01.md';

/**
 * GitHub's API and raw files over the two repositories, each holding its fixture where the real
 * repository keeps it.
 */
function fakeGitHub(): GetFetch {
  const repos = new Map<string, { sha: string; files: Map<string, string> }>();
  const mount = (repository: string, sha: string, at: string, dir: string) =>
    repos.set(repository, {
      sha,
      files: new Map(filesOf(dir).map((file) => [`${at}/${file}`, join(dir, file)])),
    });
  mount(ARCHON_REPOSITORY, ARCHON_SHA, PACK_DIR, join(PACK, 'sdlc'));
  mount(FACTORY_REPOSITORY, FACTORY_SHA, FACTORY_HOOKS_DIR, TEMPLATE_HOOKS);
  repos.get(FACTORY_REPOSITORY)?.files.set(HOLDOUT, join(TEMPLATE, 'FACTORY_COMMIT'));

  const trees: { repository: string; dir: string }[] = [];
  const treeSha = (repository: string, dir: string) => {
    const known = trees.findIndex((t) => t.repository === repository && t.dir === dir);
    return String(known >= 0 ? known : trees.push({ repository, dir }) - 1);
  };
  const below = (dir: string, path: string) => (dir === '' ? path : path.slice(dir.length + 1));

  return async (url) => {
    const { host, pathname, searchParams } = new URL(url);
    const parts = pathname.slice(1).split('/').map(decodeURIComponent);
    if (host === 'raw.githubusercontent.com') {
      const [owner, name, sha, ...path] = parts;
      const repo = repos.get(`${owner}/${name}`);
      const file = repo?.sha === sha ? repo.files.get(path.join('/')) : undefined;
      return file ? new Response(readFileSync(file)) : new Response('', { status: 404 });
    }
    const [, owner, name, kind, ...rest] = parts;
    const repository = `${owner}/${name}`;
    const repo = repos.get(repository);
    if (kind === 'commits' && repo?.sha.startsWith(rest[0] ?? '-')) {
      return Response.json({ sha: repo.sha, commit: { tree: { sha: treeSha(repository, '') } } });
    }
    const tree = kind === 'git' && rest[0] === 'trees' ? trees[Number(rest[1])] : undefined;
    if (!repo || !tree) return new Response('', { status: 404 });
    const paths = [...repo.files.keys()]
      .filter((path) => tree.dir === '' || path.startsWith(`${tree.dir}/`))
      .map((path) => below(tree.dir, path));
    if (searchParams.get('recursive')) {
      return Response.json({
        truncated: false,
        tree: paths.map((path) => ({ path, type: 'blob', sha: 'blob' })),
      });
    }
    const children = new Map(
      paths.map((path) => {
        const [child = '', ...deeper] = path.split('/');
        return [child, deeper.length > 0 ? 'tree' : 'blob'];
      }),
    );
    return Response.json({
      tree: [...children].map(([path, type]) => ({
        path,
        type,
        sha: treeSha(repository, tree.dir === '' ? path : `${tree.dir}/${path}`),
      })),
    });
  };
}

test('reads a version from GitHub with GETs only, and nothing of the template but its hooks', async () => {
  const local = await run([ARCHON_SHA, FACTORY_SHA, ...LOCAL]);
  expect(local.exit).toBe(0);
  const localRows = await everyRow();
  for (const table of TABLES) await pg.query(`DELETE FROM mc.${table}`);

  const remote = await run([ARCHON_SHA.slice(0, 8), FACTORY_SHA.slice(0, 8)], {
    fetch: fakeGitHub(),
  });
  expect(remote.err).toEqual([]);
  expect(remote.exit).toBe(0);
  expect(remote.out).toEqual(local.out);
  expect(await everyRow()).toEqual(localRows);

  expect(remote.requests.length).toBeGreaterThan(0);
  for (const request of remote.requests) expect(request).toStartWith('GET https://');
  const raw = remote.requests.filter((r) => r.startsWith('GET https://raw.githubusercontent.com/'));
  expect(raw).toHaveLength(filesOf(join(PACK, 'sdlc')).length + filesOf(TEMPLATE_HOOKS).length);
  expect(remote.requests.filter((r) => r.includes('/.factory/holdouts/'))).toEqual([]);
});
