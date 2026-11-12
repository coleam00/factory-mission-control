/**
 * Plays the factory's Archon CLI for tests and the app check: appends its argv to the file named by
 * MC_STUB_CLI_LOG, fails when MC_STUB_CLI_FAIL is set, writes the names of its environment to the
 * file named by MC_STUB_ENV_FILE, and writes nothing else.
 *
 * It answers `workflow answer`, `workflow resume`, `workflow run <name>` and `forge <operation>`,
 * which prints pretty JSON as the real forge does. MC_STUB_CLI_FAIL_ON=<verb> fails only the calls
 * whose second argument is that verb (`resume`, `run`, or a forge operation such as
 * `workitem.label.add`), with the forge's own error shape.
 */
import { appendFileSync, writeFileSync } from 'node:fs';

const argv = Bun.argv.slice(2);
if (Bun.env.MC_STUB_CLI_LOG) appendFileSync(Bun.env.MC_STUB_CLI_LOG, `${JSON.stringify(argv)}\n`);
if (Bun.env.MC_STUB_ENV_FILE) writeFileSync(Bun.env.MC_STUB_ENV_FILE, JSON.stringify(Object.keys(process.env)));

const [group, verb, runId] = argv;
if (Bun.env.MC_STUB_CLI_FAIL) {
  console.log(JSON.stringify({ ok: false, error: `stub refuses: ${Bun.env.MC_STUB_CLI_FAIL}` }));
  process.exit(1);
}
if (Bun.env.MC_STUB_CLI_FAIL_ON && verb === Bun.env.MC_STUB_CLI_FAIL_ON) {
  const error = { kind: 'refused', message: `stub refuses ${verb}` };
  console.log(JSON.stringify({ ok: false, error }, null, 2));
  process.exit(1);
}
if (group === 'workflow' && verb === 'answer') {
  console.log(JSON.stringify({ ok: true, action: 'answer', runId }));
} else if (group === 'workflow' && verb === 'resume') {
  console.log(JSON.stringify({ ok: true, action: 'resume', runId, detached: true }));
} else if (group === 'workflow' && verb === 'run') {
  console.log(JSON.stringify({ ok: true, action: 'run', workflow: runId, detached: true }));
} else if (group === 'forge') {
  console.log(JSON.stringify({ operationId: 'stub', ok: true, result: { op: verb } }, null, 2));
} else {
  console.log(JSON.stringify({ ok: false, error: 'unknown' }));
  process.exit(2);
}
