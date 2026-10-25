import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const scratch = mkdtempSync(join(tmpdir(), 'design-probe-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Failure {
  width: number;
  check: string;
  element: string;
  detail: string;
}

test('a page with an off-token color, an unnamed raw button and a 2000 px block fails the probe once per defect', async () => {
  const page = join(scratch, 'broken.html');
  writeFileSync(
    page,
    `<!doctype html>
<html lang="en">
  <body>
    <p style="color: #ff0000">Red text</p>
    <button></button>
    <div style="width: 2000px; height: 10px"></div>
  </body>
</html>`,
  );

  const probe = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'design-probe.js'), pathToFileURL(page).href],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(probe.stdout).text(),
    new Response(probe.stderr).text(),
    probe.exited,
  ]);

  expect(stderr).toBe('');
  expect(exitCode).toBe(1);
  const { failures } = JSON.parse(stdout) as { failures: Failure[] };
  const atDesktop = failures.filter((f) => f.width === 1440);
  const has = (check: string, element: string, detail: string) =>
    atDesktop.some(
      (f) => f.check === check && f.element.includes(element) && f.detail.includes(detail),
    );

  expect(has('color', 'p', 'rgb(255, 0, 0)')).toBe(true);
  expect(has('accessible-name', 'button', 'role button')).toBe(true);
  expect(has('overflow', 'div', '1440px viewport')).toBe(true);
  expect(failures.filter((f) => f.width === 390).some((f) => f.check === 'overflow')).toBe(true);
  expect(failures.length).toBeGreaterThanOrEqual(3);
}, 60_000);
