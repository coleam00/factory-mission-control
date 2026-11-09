/**
 * Plays the factory's Archon CLI for tests and the app check: appends its argv to the file named by
 * MC_STUB_CLI_LOG, fails when MC_STUB_CLI_FAIL is set, and writes nothing else.
 */
import { appendFileSync } from 'node:fs';

const argv = Bun.argv.slice(2);
if (Bun.env.MC_STUB_CLI_LOG) appendFileSync(Bun.env.MC_STUB_CLI_LOG, `${JSON.stringify(argv)}\n`);

const [group, verb, runId] = argv;
if (Bun.env.MC_STUB_CLI_FAIL) {
  console.log(JSON.stringify({ ok: false, error: `stub refuses: ${Bun.env.MC_STUB_CLI_FAIL}` }));
  process.exit(1);
}
if (group === 'workflow' && verb === 'answer') {
  console.log(JSON.stringify({ ok: true, action: 'answer', runId }));
} else if (group === 'workflow' && verb === 'resume') {
  console.log(JSON.stringify({ ok: true, action: 'resume', runId, detached: true }));
} else {
  console.log(JSON.stringify({ ok: false, error: 'unknown' }));
  process.exit(2);
}
