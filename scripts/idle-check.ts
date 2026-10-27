import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { sign } from '../function/signature';
import { type Deps, failing, guardedDatabaseUrl, type Main, runCli } from './lib/cli';
import { endpointIdOf } from './lib/target';
import { freePort } from './test-live';

const USAGE = [
  'usage: bun run function:idle-check [--max-minutes <n>]',
  '  Proves the local webhook handler survives its database connection idling out, against the',
  '  check branch in .mc-check.env (run `bun run fixture:branch` first). Starts `function:dev` on a',
  '  free port in 8850-8864, records two signed `issues` deliveries, then leaves it idle, asking',
  "  the Neon API each minute for the branch endpoint's state, until the compute suspends or",
  '  --max-minutes (default 15) pass. It then sends three more and counts the rows of their issue.',
  '  It prints the runtime, the connection mode, each answer with its time, and every line the',
  '  handler printed: a connection that closed under a delivery names its error. Exits 1 when any',
  '  delivery after the idle is not recorded exactly once.',
].join('\n');

const FIXTURE = '01-issues-opened.json';
const ISSUE = 10;

type Handler = { lines: string[]; exited: Promise<number>; stop: () => Promise<void> };

function startHandler(deps: Deps, port: number, secret: string): Handler {
  const child = Bun.spawn(
    [process.execPath, join(deps.repoRoot, 'function', 'dev.ts'), '--port', String(port)],
    {
      cwd: deps.repoRoot,
      env: { ...deps.env, GITHUB_WEBHOOK_SECRET: secret },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const lines: string[] = [];
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let rest = '';
    for await (const bytes of stream) {
      const parts = (rest + decoder.decode(bytes, { stream: true })).split(/\r?\n/);
      rest = parts.pop() ?? '';
      for (const line of parts) {
        lines.push(line);
        deps.out(`${deps.now().toISOString()} handler: ${line}`);
      }
    }
  };
  const reading = Promise.all([read(child.stdout), read(child.stderr)]);
  return {
    lines,
    exited: child.exited,
    async stop() {
      child.kill();
      await child.exited;
      await reading;
    },
  };
}

async function check(deps: Deps, maxMinutes: number): Promise<void> {
  const url = await guardedDatabaseUrl(deps, 'check');
  const endpointId = endpointIdOf(url);
  if (!endpointId) throw new Error('MC_DATABASE_URL is not a Neon endpoint');
  const neon = deps.neon();
  const state = async () => (await neon.getEndpoint(endpointId)).current_state;

  const body = new Uint8Array(readFileSync(join(deps.repoRoot, 'fixtures', 'webhooks', FIXTURE)));
  const secret = crypto.randomUUID();
  const signature = await sign(secret, body);
  const port = await freePort();
  const handler = startHandler(deps, port, secret);
  const answers: { label: string; status: number }[] = [];
  const send = async (label: string) => {
    const started = deps.now().getTime();
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': `idle-check-${label}`,
        'x-hub-signature-256': signature,
      },
    });
    const text = await response.text();
    const ms = deps.now().getTime() - started;
    deps.out(`${deps.now().toISOString()} ${label} ${response.status} ${text} ${ms} ms`);
    answers.push({ label, status: response.status });
  };

  try {
    await Promise.race([
      handler.exited.then((code) => {
        throw new Error(`function:dev exited ${code} before serving`);
      }),
      (async () => {
        while (!handler.lines.some((line) => line.startsWith('receiving webhooks'))) {
          await deps.sleep(100);
        }
      })(),
    ]);
    const mode = new URL(url).hostname.split('.')[0].endsWith('-pooler') ? 'pooled' : 'direct';
    deps.out(
      `runtime: bun ${Bun.version} (${process.platform}); connection: ${mode} ${endpointId}`,
    );

    await send('warm-1');
    await send('warm-2');
    deps.out(`endpoint ${await state()}`);
    let suspended = false;
    for (let minute = 1; minute <= maxMinutes && !suspended; minute++) {
      await deps.sleep(60_000);
      const now = await state();
      deps.out(`${deps.now().toISOString()} idle ${minute} min: endpoint ${now}`);
      suspended = now === 'idle';
    }
    if (!suspended) deps.out(`compute never suspended within ${maxMinutes} min`);
    for (const label of ['after-idle-1', 'after-idle-2', 'after-idle-3']) await send(label);
  } finally {
    await handler.stop();
  }

  const db = deps.openDb(url);
  let issues: number;
  try {
    const [row] = await db.query(
      `SELECT count(*)::int AS n FROM mc.issues WHERE factory = 'mission-control' AND number = $1`,
      [ISSUE],
    );
    issues = Number(row?.n);
  } finally {
    await db.close();
  }
  deps.out(`rows for issue #${ISSUE}: ${issues}`);
  const failed = answers.filter((answer) => answer.status !== 200);
  if (failed.length > 0 || issues !== 1) {
    throw new Error(
      `not recorded once: ${failed.map((f) => `${f.label} ${f.status}`).join(', ') || `${issues} rows`}`,
    );
  }
  deps.out('every delivery after the idle was recorded once');
}

export const main: Main = async (argv, deps) => {
  let maxMinutes: number;
  try {
    const { values } = parseArgs({ args: argv, options: { 'max-minutes': { type: 'string' } } });
    maxMinutes = Number(values['max-minutes'] ?? 15);
    if (!Number.isInteger(maxMinutes) || maxMinutes < 1) throw new Error('--max-minutes');
  } catch {
    deps.err(USAGE);
    return 2;
  }
  return failing(deps, () => check(deps, maxMinutes));
};

if (import.meta.main) await runCli(main);
