import { afterAll, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { appRoutes, factoryPath, type RouteModule, routePath, routesFromModules } from './routing';

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

/** The throwaway `f.$factory.probe.tsx` route: it shows the parameter it receives. */
function Probe() {
  return createElement('p', null, `probe of ${useParams().factory}`);
}

test('index serves /, a dotted name serves nested segments and $name is a parameter', () => {
  expect(routePath('index')).toBe('/');
  expect(routePath('versions')).toBe('/versions');
  expect(routePath('f.$factory.versions')).toBe('/f/:factory/versions');
  expect(routePath('f.$factory.laps.$run')).toBe('/f/:factory/laps/:run');
  expect(routePath('steps.$workflow.$step')).toBe('/steps/:workflow/:step');
  expect(() => routePath('f..versions')).toThrow('empty path segment');
  expect(() => routePath('f.$')).toThrow('empty path segment');
});

test('a parameter route renders at its path and receives the parameter', () => {
  const routes = appRoutes({
    './routes/index.tsx': { default: () => null },
    './routes/f.$factory.probe.tsx': { default: Probe },
  });
  expect(routes[0]?.children?.map((r) => r.path)).toEqual(['/', '/f/:factory/probe', '*']);

  const router = createMemoryRouter(routes, { initialEntries: ['/f/mission-control/probe'] });
  const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
  expect(html).toContain('<p>probe of mission-control</p>');
});

test('two route files that map to the same path are refused', () => {
  const page: RouteModule = { default: () => null };
  expect(() =>
    routesFromModules({ './routes/f.$factory.tsx': page, './routes/f.$name.tsx': page }),
  ).toThrow('route files ./routes/f.$factory.tsx and ./routes/f.$name.tsx both serve /f/:name');
  expect(() =>
    routesFromModules({ './routes/index.tsx': page, './routes/f.$factory.tsx': page }),
  ).not.toThrow();
});

test('choosing a factory keeps the screen, else goes to its home map', () => {
  const screens = [
    { path: 'laps', label: 'Laps' },
    { path: 'versions', label: 'Versions' },
  ];
  for (const { path } of screens) {
    expect(factoryPath(`/f/mission-control/${path}`, 'second-factory', screens)).toBe(
      `/f/second-factory/${path}`,
    );
  }
  for (const from of ['/', '/f/mission-control', '/f/a/nope', '/steps/archon-loop']) {
    expect(factoryPath(from, 'second-factory', screens)).toBe('/f/second-factory');
  }
  expect(factoryPath('/f/a/versions', 'a b/c', screens)).toBe('/f/a%20b%2Fc/versions');
});

test("choosing a factory from a step's page stays on that step's page, at the same version", () => {
  const screens = [{ path: 'laps', label: 'Laps' }];
  expect(factoryPath('/steps/archon-loop/check-app', 'second-factory', screens)).toBe(
    '/steps/archon-loop/check-app',
  );
  expect(factoryPath('/steps/archon-loop/review', 'second-factory', screens, '?at=8e3e1cef')).toBe(
    '/steps/archon-loop/review?at=8e3e1cef',
  );
});

test("choosing a factory from a scorecard keeps its versions; other screens drop the old factory's search", () => {
  const screens = [
    { path: 'diff', label: 'Diff' },
    { path: 'scorecard', label: 'Scorecard' },
    { path: 'versions', label: 'Versions' },
  ];
  const A = `sha256:${'a1'.repeat(32)}`;
  const B = `sha256:${'b2'.repeat(32)}`;
  const search = `?a=${encodeURIComponent(A)}&b=${encodeURIComponent(B)}`;
  expect(factoryPath('/f/mission-control/scorecard', 'second-factory', screens, search)).toBe(
    `/f/second-factory/scorecard${search}`,
  );
  expect(
    factoryPath('/f/mission-control/scorecard', 'second-factory', screens, `?a=${A}&x=1&b=`),
  ).toBe(`/f/second-factory/scorecard?a=${encodeURIComponent(A)}`);
  expect(factoryPath('/f/mission-control/scorecard', 'second-factory', screens)).toBe(
    '/f/second-factory/scorecard',
  );
  for (const screen of ['diff', 'versions']) {
    expect(factoryPath(`/f/mission-control/${screen}`, 'second-factory', screens, search)).toBe(
      `/f/second-factory/${screen}`,
    );
  }
});
