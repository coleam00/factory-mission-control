import { expect, test } from 'bun:test';
import type { RealtimeClient } from '@neon/realtime/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { NotFound } from './errors';
import { FactoryProvider } from './live/FactoryProvider';
import { type Live, LiveContext } from './live/LiveProvider';
import Home from './routes/index';
import { routesFromModules } from './routing';
import { ForFactory } from './Shell';

const routes = routesFromModules({
  './routes/index.tsx': { default: Home },
  './routes/f.$factory.tsx': { default: Home },
  './routes/f.$factory.versions.tsx': { default: Home },
  './routes/steps.$workflow.$step.tsx': { default: Home },
});
const SCREENS = [{ path: 'versions', label: 'Versions' }];
const client = {} as RealtimeClient;
const ready: Live = {
  status: 'ready',
  factories: ['mission-control', 'second-factory'],
  client,
  homeClient: client,
  rewind: null,
};

/** The app's tree as `appRoutes` builds it, over a server configuration that is already in. */
function render(path: string, live: Live = ready): string {
  const router = createMemoryRouter(
    [
      {
        element: (
          <LiveContext.Provider value={live}>
            <FactoryProvider>
              <ForFactory screens={SCREENS} />
            </FactoryProvider>
          </LiveContext.Provider>
        ),
        children: [...routes, { path: '*', Component: NotFound }],
      },
    ],
    { initialEntries: [path] },
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
const header = (html: string) => text(html.match(/<header[\s\S]*<\/header>/)?.[0] ?? '');
const main = (html: string) => text(html.match(/<main[\s\S]*<\/main>/)?.[0] ?? '');

/** Nothing above or in the page reads as a real factory's identity or count (#119). */
function expectNoFactoryIdentity(html: string): void {
  expect(header(html)).not.toContain('mission-control');
  expect(html).not.toContain('Running laps');
  expect(html).not.toContain('data-count');
  expect(html).not.toContain('Live data is unavailable.');
  expect(main(html)).not.toContain('Nothing is at this address.');
}

test('an address under an unknown key that no screen serves names the key, not a factory', () => {
  for (const path of [
    '/f/nope/laps/example',
    '/f/nope/steps/archon-loop/check-app',
    '/f/nope/anything',
    '/f/nope',
    '/f/nope/versions',
  ]) {
    const html = render(path);
    expectNoFactoryIdentity(html);
    expect(header(html)).toContain('nope Unknown factory');
    expect(main(html)).toBe('No factory is named "nope". Go to mission-control\'s map');
  }
});

test('a key is named as typed, decoded from the address', () => {
  const html = render('/f/Mission%20Control/laps/1');
  expectNoFactoryIdentity(html);
  expect(main(html)).toContain('No factory is named "Mission Control".');
});

test('the empty key names no factory and links home', () => {
  for (const path of ['/f/', '/f//versions', '/f//laps/example']) {
    const html = render(path);
    expectNoFactoryIdentity(html);
    expect(main(html)).toBe('No factory is named in this address. Go to home');
    expect(html.match(/<main[\s\S]*<\/main>/)?.[0]).toContain('href="/"');
  }
});

test("a factory removed from the server's file reads as unknown on its old addresses", () => {
  const removed: Live = { ...ready, factories: ['mission-control'] };
  for (const path of [
    '/f/second-factory',
    '/f/second-factory/versions',
    '/f/second-factory/laps/7',
  ]) {
    const html = render(path, removed);
    expectNoFactoryIdentity(html);
    expect(main(html)).toContain('No factory is named "second-factory".');
  }
});

test("a real factory's not-found address keeps its identity; one outside /f/ is plain not-found", () => {
  const real = render('/f/mission-control/nothing-here');
  expect(header(real)).toContain('mission-control');
  expect(real).toContain('Running laps');
  expect(real).not.toContain('Unknown factory');
  expect(main(real)).toBe('Nothing is at this address. Go to home');

  const outside = render('/nothing');
  expect(outside).not.toContain('Unknown factory');
  expect(main(outside)).toBe('Nothing is at this address. Go to home');
});

test('a real factory screen renders its strip, not the unknown page', () => {
  const html = render('/f/second-factory/versions');
  expect(header(html)).toContain('second-factory');
  expect(html).toContain('Running laps');
  expect(html).not.toContain('data-unknown-factory');
});
