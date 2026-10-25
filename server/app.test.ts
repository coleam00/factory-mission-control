import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from './app';
import { resolveBuildId } from './build-id';

const repoRoot = resolve(import.meta.dir, '..');
let distDir: string;

beforeAll(() => {
  const scratch = mkdtempSync(join(tmpdir(), 'mc-app-'));
  distDir = join(scratch, 'dist');
  mkdirSync(join(distDir, 'assets'), { recursive: true });
  copyFileSync(join(repoRoot, 'app', 'index.html'), join(distDir, 'index.html'));
  writeFileSync(join(distDir, 'assets', 'main.js'), 'console.log("app");');
  writeFileSync(join(scratch, 'outside.txt'), 'not part of the build');
});

afterAll(() => rmSync(resolve(distDir, '..'), { recursive: true, force: true }));

function appWith(env: Record<string, string | undefined>) {
  return createApp({ buildId: resolveBuildId(env, repoRoot), distDir });
}

function app() {
  return createApp({ buildId: 'test', distDir });
}

// `git` can take several seconds to start on Windows.
const GIT_TIMEOUT_MS = 30_000;

describe('GET /api/health', () => {
  test('is 200 with no database or Realtime configuration', async () => {
    const res = await app().request('/api/health');
    expect(res.status).toBe(200);
  });
});

describe('GET /api/build-id', () => {
  test('is exactly FACTORY_RUNTIME_CANDIDATE when it is set', async () => {
    const res = await appWith({ FACTORY_RUNTIME_CANDIDATE: 'cand-123' }).request('/api/build-id');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('cand-123');
  });

  test(
    'is exactly the checked-out commit otherwise',
    async () => {
      const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repoRoot }).stdout.toString();
      const res = await appWith({}).request('/api/build-id');
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toMatch(/^[0-9a-f]{40}$/);
      expect(body).toBe(head.trim());
    },
    GIT_TIMEOUT_MS,
  );
});

describe('the browser app', () => {
  test('GET / is the HTML that mounts the app', async () => {
    const res = await app().request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('<script type="module"');
  });

  test('a client-side route is answered with the same HTML', async () => {
    const res = await app().request('/runs');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root"></div>');
  });

  test('a built asset is served as itself', async () => {
    const res = await app().request('/assets/main.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log("app");');
  });

  test('nothing outside the build is served', async () => {
    const res = await app().request('/..%5coutside.txt');
    expect(await res.text()).not.toContain('not part of the build');
  });

  test('an unknown API path is a 404, not the app', async () => {
    expect((await app().request('/api/nope')).status).toBe(404);
  });
});
