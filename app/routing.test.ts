import { afterAll, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import {
  appRoutes,
  factoryPath,
  homeAddressTarget,
  PLACES,
  REMOVED_SCREENS,
  type RouteModule,
  routePath,
  routesFromModules,
} from './routing';

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
  expect(routePath('f.$factory.runs.$run')).toBe('/f/:factory/runs/:run');
  expect(routePath('f.$factory.steps.$workflow.$step')).toBe('/f/:factory/steps/:workflow/:step');
  expect(() => routePath('f..versions')).toThrow('empty path segment');
  expect(() => routePath('f.$')).toThrow('empty path segment');
});

test('a parameter route renders at its path and receives the parameter', () => {
  const routes = appRoutes({
    './routes/f.$factory.probe.tsx': { default: Probe },
  });
  const paths = routes[0]?.children?.map((r) => r.path) ?? [];
  expect(paths[0]).toBe('/f/:factory/probe');
  expect(paths.at(-1)).toBe('*');

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

test('choosing a factory keeps the place, else goes to its Attention', () => {
  for (const { path } of PLACES.filter((place) => place.path !== '')) {
    expect(factoryPath(`/f/mission-control/${path}`, 'second-factory')).toBe(
      `/f/second-factory/${path}`,
    );
  }
  for (const from of ['/', '/f/mission-control', '/f/a/nope', '/steps/archon-loop']) {
    expect(factoryPath(from, 'second-factory')).toBe('/f/second-factory');
  }
  expect(factoryPath('/f/a/runs/5eed0001', 'second-factory')).toBe('/f/second-factory/runs');
  expect(factoryPath('/f/a/board', 'a b/c')).toBe('/f/a%20b%2Fc/board');
});

test("choosing a factory from a step's page stays on that step's page, at the same version", () => {
  expect(factoryPath('/f/mission-control/steps/archon-loop/check-app', 'second-factory')).toBe(
    '/f/second-factory/steps/archon-loop/check-app',
  );
  expect(
    factoryPath('/f/mission-control/steps/archon-loop/review', 'second-factory', '?at=8e3e1cef'),
  ).toBe('/f/second-factory/steps/archon-loop/review?at=8e3e1cef');
});

test("choosing a factory drops the old factory's search", () => {
  expect(factoryPath('/f/mission-control/board', 'second-factory', '?order=demo')).toBe(
    '/f/second-factory/board',
  );
});

/** Where an address lands once the redirects have run, in a router holding only `routes`. */
async function landing(from: string): Promise<string> {
  const router = createMemoryRouter(appRoutes({}), { initialEntries: ['/'] });
  await router.navigate(from);
  return router.state.location.pathname;
}

test('every old address lands where the v3 README says', async () => {
  const landings: Record<string, string> = {
    '/f/mc/decisions': '/f/mc',
    '/f/mc/laps': '/f/mc/runs',
    '/f/mc/laps/5eed0001-0000-4000-8000-000000000003':
      '/f/mc/runs/5eed0001-0000-4000-8000-000000000003',
    '/f/mc/health': '/f/mc',
    '/f/mc/ledger': '/f/mc',
    '/f/mc/owner': '/f/mc',
    '/f/mc/issues': '/f/mc/board',
    '/f/mc/testing': '/f/mc/board',
    '/f/mc/changes': '/f/mc/map',
    '/f/mc/diff': '/f/mc/map',
    '/f/mc/rewind': '/f/mc/map',
    '/f/mc/scorecard': '/f/mc/map',
    '/f/mc/versions': '/f/mc/map',
    '/f/a%20b/laps': '/f/a%20b/runs',
  };
  for (const [from, to] of Object.entries(landings)) expect(await landing(from)).toBe(to);
});

test('every removed screen is a route that lands on a place', () => {
  const routes = appRoutes({})[0]?.children ?? [];
  for (const [from, to] of Object.entries(REMOVED_SCREENS)) {
    expect(routes.some((r) => r.path === `/f/:factory/${from}`)).toBe(true);
    expect(PLACES.map((place): string => place.path)).toContain(to);
  }
  expect(routes.some((r) => r.path === '/steps/:workflow/:step')).toBe(true);
});

test('/ keeps an old map link on the map, with its pin and view, and otherwise opens Attention', () => {
  const target = (search: string) => homeAddressTarget('mc', new URLSearchParams(search));
  expect(target('view=build&at=8e3e1cef&from=review')).toBe(
    '/f/mc/map?view=build&at=8e3e1cef&from=review',
  );
  expect(target('view=build')).toBe('/f/mc/map?view=build');
  expect(target('at=8e3e1cef')).toBe('/f/mc/map?at=8e3e1cef');
  expect(target('')).toBe('/f/mc');
  expect(target('order=demo')).toBe('/f/mc');
});
