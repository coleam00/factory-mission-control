import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { factoryScreens, type RouteModule, routesFromModules } from '../routing';
import { ScreenNavBody } from './ScreenNav';

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
function navAt(modules: Record<string, RouteModule>, path: string) {
  const routes = routesFromModules(modules);
  const screens = factoryScreens(routes);
  const router = createMemoryRouter(
    [
      {
        element: (
          <>
            <ScreenNavBody screens={screens} factory={FACTORY} />
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
  expect(found[0]).toEqual({ href: '/', name: 'Map', current: true });
  expect(found.map((l) => l.href)).toContain(`/f/${FACTORY}/versions`);
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
  expect(found).toHaveLength(screens.length + 2);
  expect(found.at(-1)).toBe('/rewind');
  expect(found.some((href) => href.startsWith('/steps'))).toBe(false);
});

test('the rewind link shows on every screen and is current on /rewind', () => {
  for (const path of ['/', `/f/${FACTORY}/issues`, '/rewind']) {
    const rewind = links(navAt(registeredRoutes(), path).html()).find((l) => l.href === '/rewind');
    expect(rewind).toEqual({ href: '/rewind', name: 'Rewind', current: path === '/rewind' });
  }
});

test('adding a factory route file adds its link with no edit to the shell', () => {
  const before = links(navAt(registeredRoutes(), '/').html());
  const after = links(
    navAt(registeredRoutes(['f.$factory.probe.tsx', 'f.$factory.laps.$run.tsx']), '/').html(),
  );
  expect(after).toHaveLength(before.length + 1);
  expect(after).toContainEqual({ href: `/f/${FACTORY}/probe`, name: 'Probe', current: false });
  expect(after.some((l) => l.href.includes(':run') || l.href.includes('/laps/'))).toBe(false);
});

test('from / the versions link reaches the strip and the Map link returns to that factory’s map', async () => {
  const { router, html } = navAt(registeredRoutes(), '/');
  const versions = links(html()).find((l) => l.name === 'Versions');
  expect(versions?.href).toBe(`/f/${FACTORY}/versions`);

  await router.navigate(versions?.href ?? '');
  expect(router.state.location.pathname).toBe(`/f/${FACTORY}/versions`);
  expect(router.state.matches.at(-1)?.route.path).toBe('/f/:factory/versions');
  const there = links(html());
  expect(there.find((l) => l.current)?.name).toBe('Versions');

  const home = there.find((l) => l.name === 'Map');
  await router.navigate(home?.href ?? '');
  expect(router.state.location.pathname).toBe(`/f/${FACTORY}`);
  expect(router.state.matches.at(-1)?.route.path).toBe('/f/:factory');
  expect(links(html()).find((l) => l.current)?.name).toBe('Map');
});

test('until the factory is known only the home link shows', () => {
  const html = renderToStaticMarkup(
    <RouterProvider
      router={createMemoryRouter([
        {
          path: '/',
          element: (
            <ScreenNavBody
              screens={[{ path: 'versions', label: 'Versions' }]}
              factory={undefined}
            />
          ),
        },
      ])}
    />,
  );
  expect(links(html)).toEqual([{ href: '/', name: 'Map', current: true }]);
});
