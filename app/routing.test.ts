import { afterAll, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RouteModule, routesFromModules } from './routing';

const scratch = mkdtempSync(join(tmpdir(), 'mc-routes-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** What main.tsx's `import.meta.glob` over `./routes/` yields, read from disk. */
async function globRoutes(routesDir: string): Promise<Record<string, RouteModule>> {
  const modules: Record<string, RouteModule> = {};
  for (const file of new Bun.Glob('*.tsx').scanSync(routesDir)) {
    if (file.endsWith('.test.tsx')) continue;
    modules[`./routes/${file}`] = await import(join(routesDir, file));
  }
  return modules;
}

test('a file added to the routes directory becomes a route at its path', async () => {
  const routesDir = join(scratch, 'routes');
  cpSync(join(import.meta.dir, 'routing.fixture', 'routes'), routesDir, { recursive: true });
  expect(routesFromModules(await globRoutes(routesDir)).map((r) => r.path)).toEqual(['/']);

  writeFileSync(
    join(routesDir, 'versions.tsx'),
    'export default function Versions() { return null; }',
  );
  const routes = routesFromModules(await globRoutes(routesDir));

  expect(routes.map((r) => r.path).sort()).toEqual(['/', '/versions']);
  const versions = routes.find((r) => r.path === '/versions');
  expect(versions?.Component?.name).toBe('Versions');
});
