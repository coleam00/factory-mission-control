import { afterAll, expect, test } from 'bun:test';
import { join } from 'node:path';

interface Failure {
  width: number;
  check: string;
  element: string;
  detail: string;
}

const GEIST = join(
  import.meta.dir,
  '..',
  'node_modules',
  '@fontsource',
  'geist',
  'files',
  'geist-latin-400-normal.woff2',
);

const TOKENS = {
  background: 'oklch(0.14 0.005 260)',
  foreground: 'oklch(0.93 0.005 260)',
  surface: 'oklch(0.18 0.008 260)',
  border: 'oklch(0.28 0.01 260)',
};

const pages: Record<string, string> = {
  '/clean.html': `<!doctype html>
<html lang="en">
  <head>
    <style>
      @font-face { font-family: Geist; src: url(/geist.woff2) format('woff2'); }
      body { margin: 0; font-family: Geist; background: ${TOKENS.background}; color: ${TOKENS.foreground}; }
      button, input {
        font: inherit; color: inherit; background: ${TOKENS.surface};
        border: 1px solid ${TOKENS.border};
      }
    </style>
  </head>
  <body>
    <p>Token text</p>
    <button type="button">Save</button>
    <input aria-label="Name" value="Typed text">
  </body>
</html>`,
  '/broken.html': `<!doctype html>
<html lang="en">
  <body>
    <p style="color: #ff0000">Red text</p>
    <button></button>
    <input aria-label="Name" value="Typed text" style="color: #00ff00; background: ${TOKENS.surface}; border: 1px solid ${TOKENS.border}">
    <div style="width: 2000px; height: 10px"></div>
  </body>
</html>`,
};

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  idleTimeout: 0,
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/geist.woff2') return new Response(Bun.file(GEIST));
    if (pathname === '/wedged.html') return new Promise<Response>(() => {});
    const page = pages[pathname];
    if (!page) return new Response('not found', { status: 404 });
    return new Response(page, { headers: { 'content-type': 'text/html' } });
  },
});
afterAll(() => server.stop(true));

async function runProbe(path: string) {
  const probe = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'design-probe.js'), new URL(path, server.url).href],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(probe.stdout).text(),
    new Response(probe.stderr).text(),
    probe.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test('a token-styled page in Geist with named controls passes the probe', async () => {
  const { stdout, stderr, exitCode } = await runProbe('/clean.html');

  expect(stderr).toBe('');
  expect(JSON.parse(stdout).failures).toEqual([]);
  expect(exitCode).toBe(0);
}, 60_000);

test('a page with off-token colors and fonts, an unnamed raw button and a 2000 px block fails the probe once per defect', async () => {
  const { stdout, stderr, exitCode } = await runProbe('/broken.html');

  expect(stderr).toBe('');
  expect(exitCode).toBe(1);
  const { failures } = JSON.parse(stdout) as { failures: Failure[] };
  const atDesktop = failures.filter((f) => f.width === 1440);
  const has = (check: string, element: string, detail: string) =>
    atDesktop.some(
      (f) => f.check === check && f.element.includes(element) && f.detail.includes(detail),
    );

  expect(has('color', 'p', 'rgb(255, 0, 0)')).toBe(true);
  expect(has('font', 'p', 'is not Geist')).toBe(true);
  expect(has('contrast', 'p', 'below 4.5:1')).toBe(true);
  expect(has('default-control', 'button', "browser's default look")).toBe(true);
  expect(has('accessible-name', 'button', 'role button')).toBe(true);
  expect(has('color', 'input', 'color rgb(0, 255, 0)')).toBe(true);
  expect(has('font', 'input', 'is not Geist')).toBe(true);
  expect(has('overflow', 'div', '1440px viewport')).toBe(true);
  expect(failures.filter((f) => f.width === 390).some((f) => f.check === 'overflow')).toBe(true);
  expect(failures.length).toBeGreaterThanOrEqual(3);
}, 60_000);

test('a page that never answers stops the probe with exit 2 instead of hanging', async () => {
  const { stdout, stderr, exitCode } = await runProbe('/wedged.html');

  expect(stdout).toBe('');
  expect(stderr).toContain('got no answer within');
  expect(exitCode).toBe(2);
}, 60_000);
