import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { PLACES } from '../lib/places';
import { currentPlace, PlaceLinks, RunsCountBody } from './ScreenNav';

const FACTORY = 'mission-control';

/** The places for `factory` in a router at `path`; the counts are stubbed, they are live panels. */
function navAt(path: string, factory: string | null = FACTORY, layout: 'side' | 'tabs' = 'side') {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <nav>
            <PlaceLinks factory={factory ?? undefined} layout={layout} count={() => null} />
          </nav>
        ),
      },
    ],
    { initialEntries: [path] },
  );
  const html = () => renderToStaticMarkup(<RouterProvider router={router} />);
  return { router, html };
}

/** Each link: its href, its accessible name and whether it is the current page. */
function links(html: string): { href: string; name: string; current: boolean }[] {
  return [...html.matchAll(/<a\b([^>]*)>(.*?)<\/a>/g)].map(([, attrs = '', inner = '']) => ({
    href: attrs.match(/href="([^"]*)"/)?.[1] ?? '',
    name: inner.replace(/<[^>]+>/g, '').trim(),
    current: attrs.includes('aria-current="page"'),
  }));
}

test('the nav is the four fixed places, Attention first, whatever route files exist', () => {
  expect(links(navAt('/').html())).toEqual([
    { href: `/f/${FACTORY}`, name: 'Attention', current: false },
    { href: `/f/${FACTORY}/map`, name: 'Factory', current: false },
    { href: `/f/${FACTORY}/board`, name: 'Board', current: false },
    { href: `/f/${FACTORY}/runs`, name: 'Runs', current: false },
  ]);
  expect(PLACES.map((place) => place.label)).toEqual(['Attention', 'Factory', 'Board', 'Runs']);
});

test('the phone tabs hold the same places', () => {
  expect(links(navAt('/', FACTORY, 'tabs').html()).map((l) => l.href)).toEqual(
    links(navAt('/').html()).map((l) => l.href),
  );
});

test('the factory in the address is encoded', () => {
  expect(links(navAt('/', 'a b/c').html())[1]?.href).toBe('/f/a%20b%2Fc/map');
});

test('a place’s count follows its name and no other', () => {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <PlaceLinks
            factory={FACTORY}
            layout="side"
            count={(place) => (place.path === 'board' ? <b data-badge>3</b> : null)}
          />
        ),
      },
    ],
    { initialEntries: ['/'] },
  );
  const html = renderToStaticMarkup(<RouterProvider router={router} />);
  expect(html.match(/data-badge/g)).toHaveLength(1);
  expect(html).toMatch(/Board<span class="[^"]*"><b data-badge="true">3<\/b>/);
});

test('until the factory is known no place shows', () => {
  expect(links(navAt('/', null).html())).toEqual([]);
});

test('each place marks itself alone, a run’s page marks Runs and a step’s page marks Factory', () => {
  const current = (path: string) =>
    links(navAt(path).html())
      .filter((l) => l.current)
      .map((l) => l.name);
  expect(current(`/f/${FACTORY}`)).toEqual(['Attention']);
  expect(current(`/f/${FACTORY}/map`)).toEqual(['Factory']);
  expect(current(`/f/${FACTORY}/board`)).toEqual(['Board']);
  expect(current(`/f/${FACTORY}/runs`)).toEqual(['Runs']);
  expect(current(`/f/${FACTORY}/runs/5eed0001-0000-4000-8000-000000000003`)).toEqual(['Runs']);
  for (const step of ['archon-loop/build', 'archon-ship-block/intel']) {
    expect(current(`/f/${FACTORY}/steps/${step}`)).toEqual(['Factory']);
  }
  expect(current(`/f/${FACTORY}/work/12`)).toEqual([]);
});

test('a step’s page is current under the factory it names only', () => {
  const map = PLACES.find((place) => place.path === 'map');
  if (map === undefined) throw new Error('no map place');
  expect(currentPlace('/f/a/steps/x/y', 'a', map)).toBe(true);
  expect(currentPlace('/f/a/steps/x/y', 'b', map)).toBe(false);
});

test('following a place’s link moves the router there', async () => {
  const { router, html } = navAt('/');
  const runs = links(html()).find((l) => l.name === 'Runs');
  await router.navigate(runs?.href ?? '');
  expect(router.state.location.pathname).toBe(`/f/${FACTORY}/runs`);
  expect(
    links(html())
      .filter((l) => l.current)
      .map((l) => l.name),
  ).toEqual(['Runs']);
});

test('the Runs count is the status strip’s running count, empty until it is known', () => {
  const html = (rows: Parameters<typeof RunsCountBody>[0]['rows']) =>
    renderToStaticMarkup(<RunsCountBody rows={rows} />);
  expect(html([{ running: 2 }])).toMatch(/data-runs-count[^>]*>2 live<\/span>/);
  expect(html([{ running: 0 }])).toMatch(/data-runs-count[^>]*>0 live<\/span>/);
  expect(html(undefined)).toMatch(/data-runs-count[^>]*><\/span>/);
});
