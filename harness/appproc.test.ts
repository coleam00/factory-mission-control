import { expect, test } from 'bun:test';
import { SERVE_PORTS } from '../server/ports';

const python = process.platform === 'win32' ? 'python' : 'python3';

/** Runs `script` with harness/appproc.py importable and returns what it printed as JSON. */
function runPython(script: string): unknown {
  const run = Bun.spawnSync([python, '-c', script], {
    cwd: import.meta.dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(run.stderr.toString()).toBe('');
  expect(run.exitCode).toBe(0);
  return JSON.parse(run.stdout.toString());
}

test("the http driver's port range is the one the server accepts", () => {
  const range = runPython(
    'import json, appproc; print(json.dumps([appproc.APP_PORTS.start, appproc.APP_PORTS.stop - 1]))',
  );
  expect(range).toEqual([SERVE_PORTS.min, SERVE_PORTS.max]);
});

test('the http driver takes the one free port in its range and refuses to start when none is', () => {
  const outcome = runPython(`
import json, random, socket, appproc
for _ in range(50):
    base = random.randrange(20000, 60000)
    held = []
    try:
        for port in range(base, base + 3):
            s = socket.socket()
            s.bind(("127.0.0.1", port))
            held.append(s)
        break
    except OSError:
        for s in held:
            s.close()
appproc.APP_PORTS = range(base, base + 3)
held[1].close()
free = appproc._free_port()
s = socket.socket()
s.bind(("127.0.0.1", base + 1))
held[1] = s
try:
    appproc._free_port()
    refused = None
except appproc.AppDidNotStart as error:
    refused = str(error)
print(json.dumps({"free": free - base, "refused": refused}))
`);
  expect(outcome).toEqual({ free: 1, refused: expect.stringContaining('is taken') });
});
