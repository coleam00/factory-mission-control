import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { matchRoutes } from 'react-router';
import { boardHref } from './lib/board';
import { homeHref } from './lib/home-map';
import { lapHref } from './lib/one-lap';
import { placeAddress } from './lib/places';
import { stepHref } from './lib/step-detail';
import { workItemHref } from './lib/work-item';
import { globRoutes } from './route-files';
import { routesFromModules } from './routing';

test('every page-address writer points at the route file meant to serve it', async () => {
  const modules = await globRoutes(join(import.meta.dir, 'routes'));
  const routes = routesFromModules(modules);
  // Route files can re-export one component, so a match is traced by its path, in the routes' order.
  const files = Object.keys(modules);
  const served = (href: string): string | undefined => {
    const matches = matchRoutes(routes, new URL(href, 'http://x').pathname);
    const index = routes.indexOf(matches?.at(-1)?.route as (typeof routes)[number]);
    return files[index];
  };

  expect(served(placeAddress('acme', ''))).toBe('./routes/f.$factory.tsx');
  expect(served(homeHref('acme'))).toBe('./routes/f.$factory.map.tsx');
  expect(served(placeAddress('acme', 'runs'))).toBe('./routes/f.$factory.runs.tsx');
  expect(served(lapHref('acme', 'run-1'))).toBe('./routes/f.$factory.runs.$runId.tsx');
  expect(served(workItemHref('acme', 7))).toBe('./routes/f.$factory.work.$n.tsx');
  expect(served(boardHref('acme', 'order'))).toBe('./routes/f.$factory.board.tsx');
  expect(served(stepHref('acme', 'wf', 'a/b'))).toBe(
    './routes/f.$factory.steps.$workflow.$step.tsx',
  );
});
