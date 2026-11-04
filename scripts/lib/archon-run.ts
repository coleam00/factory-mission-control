import type { Env } from '../../server/check-env';

export type RunStatus =
  | { state: 'active' }
  | { state: 'ended' }
  | { state: 'unknown'; reason: string };

/** The same split as `factory/consumer.py`'s `ACTIVE` and `ENDED`; an unrecognized status reads as `unknown`, which `drop` keeps. */
const ACTIVE = new Set(['pending', 'running', 'paused']);
const ENDED = new Set(['completed', 'failed', 'cancelled']);

const ASK_TIMEOUT_MS = 30_000;

/**
 * What `archon workflow get <run> --json` said. A run Archon has no record of (`not_found`) has
 * ended; anything not recognized is unknown, never guessed.
 */
export function runStatusFrom(code: number, stdout: string): RunStatus {
  let reply: { status?: unknown; error?: unknown };
  try {
    reply = JSON.parse(stdout);
  } catch {
    return { state: 'unknown', reason: `exit ${code}, not JSON` };
  }
  if (code !== 0) {
    if (reply?.error === 'not_found') return { state: 'ended' };
    return { state: 'unknown', reason: String(reply?.error ?? `exit ${code}`) };
  }
  const status = reply?.status;
  if (typeof status === 'string' && ACTIVE.has(status)) return { state: 'active' };
  if (typeof status === 'string' && ENDED.has(status)) return { state: 'ended' };
  return { state: 'unknown', reason: `status ${String(status)}` };
}

function archonCommand(env: Env): string[] | undefined {
  try {
    const command: unknown = JSON.parse(env.ARCHON_CLI_COMMAND ?? '');
    const argv = Array.isArray(command) ? command : [];
    return argv.length > 0 && argv.every((part) => typeof part === 'string') ? argv : undefined;
  } catch {
    return undefined;
  }
}

/** Asks Archon, read-only, whether `run` is still active, through the argv in `ARCHON_CLI_COMMAND`. */
export async function askArchon(env: Env, repoRoot: string, run: string): Promise<RunStatus> {
  const command = archonCommand(env);
  if (!command) return { state: 'unknown', reason: 'ARCHON_CLI_COMMAND is not set' };
  try {
    const child = Bun.spawn([...command, 'workflow', 'get', run, '--json'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: ASK_TIMEOUT_MS,
    });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return runStatusFrom(code, stdout);
  } catch (error) {
    return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }
}
