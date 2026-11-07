import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { factoryScreens, type RouteModule, routesFromModules } from '../routing';
import { currentLink, ScreenNavBody } from './ScreenNav';

const FACTORY = 'mission-control';
const page: RouteModule = { default: () => null };

/** Every route file in `app/routes/`, as main.tsx registers them, with empty screens. */
function registeredRoutes(extra: string[] = []): Record<string, RouteModule> {
  const modules: Record<string, RouteModule> = {};
  for (const file of new Bun.Glob('*.tsx').scanSync(join(import.meta.dir, '..', 'routes'))) {
    if (!file.endsWith('.test.tsx')) modules[`./routes/${file}`] = page;
  }
  for (const file of extra) modules[`./routes/${file}`] = page;
  return modules;
}

/** The nav over the given route files, in a router at `path`. */
function navAt(
  modules: Record<string, RouteModule>,
  path: string,
  badge?: (path: string) => React.ReactNode,
) {
  const routes = routesFromModules(modules);
  const screens = factoryScreens(routes);
  const router = createMemoryRouter(
    [
      {
        element: (
          <>
            <ScreenNavBody screens={screens} factory={FACTORY} badge={badge} />
            <Outlet />
          </>
        ),
        children: routes,
      },
    ],
    { initialEntries: [path] },
  );
  const html = () => renderToStaticMarkup(<RouterProvider router={router} />);
  return { router, html };
}

/** Each link in the nav: its href, its accessible name and whether it is the current page. */
function links(html: string): { href: string; name: string; current: boolean }[] {
  return [...html.matchAll(/<a\b([^>]*)>(.*?)<\/a>/g)].map(([, attrs = '', inner = '']) => ({
    href: attrs.match(/href="([^"]*)"/)?.[1] ?? '',
    name: inner.replace(/<[^>]+>/g, '').trim(),
    current: attrs.includes('aria-current="page"'),
  }));
}

test('the nav links the home map and every factory screen, and marks the current one', () => {
  const { html } = navAt(registeredRoutes(), '/');
  const found = links(html());
  expect(found[0]).toEqual({ href: '/', name: 'Factory', current: true });
  expect(found.map((l) => l.href)).toContain(`/f/${FACTORY}/laps`);
  for (const link of found) expect(link.name).not.toBe('');
  expect(found.filter((l) => l.current)).toHaveLength(1);
  expect(html()).toContain('<nav aria-label="Screens"');
});

test('every factory route file has a link; screens needing another parameter have none', () => {
  const found = links(navAt(registeredRoutes(), '/').html()).map((l) => l.href);
  const files = Object.keys(registeredRoutes()).map((f) => f.replace(/^.*\//, ''));
  const screens = files.filter((f) => /^f\.\$factory\.[^$]+\.tsx$/.test(f));
  expect(screens.length).toBeGreaterThan(0);
  for (const file of screens) {
    const rest = file
      .replace(/^f\.\$factory\./, '')
      .replace(/\.tsx$/, '')
      .replaceAll('.', '/');
    expect(found).toContain(`/f/${FACTORY}/${rest}`);
  }
  expect(found).toHaveLength(screens.length + 1);
  expect(found.some((href) => href.startsWith('/steps'))).toBe(false);
});

test('a badge follows its screen’s label and no other', () => {
  const html = navAt(registeredRoutes(), '/', (path) =>
    path === 'decisions' ? <b data-badge>3</b> : null,
  ).html();
  expect(html.match(/data-badge/g)).toHaveLength(1);
  expect(html).toMatch(/Decisions<b data-badge="true">3<\/b>/);
});

test('the tabs are Factory, Board, Decisions and Laps, in that order', () => {
  expect(links(navAt(registeredRoutes(), '/').html()).map((l) => l.name)).toEqual([
    'Factory',
    'Board',
    'Decisions',
    'Laps',
  ]);
});

test('adding a factory route file adds its link with no edit to the shell', () => {
  const before = links(navAt(registeredRoutes(), '/').html());
  const after = links(
    navAt(registeredRoutes(['f.$factory.probe.tsx', 'f.$factory.probe.$item.tsx']), '/').html(),
  );
  expect(after).toHaveLength(before.length + 1);
  expect(after).toContainEqual({ href: `/f/${FACTORY}/probe`, name: 'Probe', current: false });
  expect(after.some((l) => l.href.includes(':item') || l.href.includes('/probe/'))).toBe(false);
});

test('from / the laps link reaches the strip and the Factory link returns to that factory’s map', async () => {
  const { router, html } = navAt(registeredRoutes(), '/');
  const laps = links(html()).find((l) => l.name === 'Laps');
  expect(laps?.href).toBe(`/f/${FACTORY}/laps`);

  await router.navigate(laps?.href ?? '');
  expect(router.state.location.pathname).toBe(`/f/${FACTORY}/laps`);
  expect(router.state.matches.at(-1)?.route.path).toBe('/f/:factory/laps');
  const there = links(html());
  expect(there.find((l) => l.current)?.name).toBe('Laps');

  const home = there.find((l) => l.name === 'Factory');
  await router.navigate(home?.href ?? '');
  expect(router.state.location.pathname).toBe(`/f/${FACTORY}`);
  expect(router.state.matches.at(-1)?.route.path).toBe('/f/:factory');
  expect(links(html()).find((l) => l.current)?.name).toBe('Factory');
});

test('until the factory is known only the home link shows', () => {
  const html = renderToStaticMarkup(
    <RouterProvider
      router={createMemoryRouter([
        {
          path: '/',
          element: (
            <ScreenNavBody screens={[{ path: 'laps', label: 'Laps' }]} factory={undefined} />
          ),
        },
      ])}
    />,
  );
  expect(links(html)).toEqual([{ href: '/', name: 'Factory', current: true }]);
});

test("a lap's page marks Laps as current, and a step's page marks Factory, one link only", () => {
  const lap = links(
    navAt(registeredRoutes(), `/f/${FACTORY}/laps/5eed0001-0000-4000-8000-000000000003`).html(),
  );
  expect(lap.filter((l) => l.current).map((l) => l.href)).toEqual([`/f/${FACTORY}/laps`]);
  for (const step of ['archon-loop/build', 'archon-ship-block/intel']) {
    const found = links(navAt(registeredRoutes(), `/f/${FACTORY}/steps/${step}`).html());
    expect(found.filter((l) => l.current)).toEqual([
      { href: `/f/${FACTORY}`, name: 'Factory', current: true },
    ]);
  }
  // Every screen still marks itself alone.
  for (const screen of ['laps', 'board', 'decisions']) {
    const found = links(navAt(registeredRoutes(), `/f/${FACTORY}/${screen}`).html());
    expect(found.filter((l) => l.current).map((l) => l.href)).toEqual([`/f/${FACTORY}/${screen}`]);
  }
  expect(links(navAt(registeredRoutes(), `/f/${FACTORY}`).html()).filter((l) => l.current)).toEqual(
    [{ href: `/f/${FACTORY}`, name: 'Factory', current: true }],
  );
});

test("a step's page is current under the factory it names only", () => {
  expect(currentLink('/f/a/steps/x/y', '/f/a', 'map')).toBe(true);
  expect(currentLink('/f/a/steps/x/y', '/f/b', 'map')).toBe(false);
});
