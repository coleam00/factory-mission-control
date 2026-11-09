import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { matchRoutes } from 'react-router';
import { boardHref } from './lib/board';
import { lapHref, lapsHref } from './lib/one-lap';
import { stepHref } from './lib/step-detail';
import { workItemHref } from './lib/work-item';
import { type RouteModule, routesFromModules } from './routing';

/** The route files served at `app/routes/`, keyed by the module paths `import.meta.glob` yields. */
async function realRoutes() {
  const dir = join(import.meta.dir, 'routes');
  const modules: Record<string, RouteModule> = {};
  for (const file of new Bun.Glob('*.tsx').scanSync(dir)) {
    if (file.endsWith('.test.tsx')) continue;
    modules[`./routes/${file}`] = await import(join(dir, file));
  }
  return { routes: routesFromModules(modules), modules };
}

test('every page-address writer points at the route file meant to serve it', async () => {
  const { routes, modules } = await realRoutes();
  const served = (href: string): string | undefined => {
    const matches = matchRoutes(routes, new URL(href, 'http://x').pathname);
    const component = matches?.at(-1)?.route.Component;
    return Object.entries(modules).find(([, m]) => m.default === component)?.[0];
  };

  expect(served(lapsHref('acme'))).toBe('./routes/f.$factory.laps.tsx');
  expect(served(lapHref('acme', 'run-1'))).toBe('./routes/f.$factory.laps.$runId.tsx');
  expect(served(workItemHref('acme', 7))).toBe('./routes/f.$factory.work.$n.tsx');
  expect(served(boardHref('acme', 'order'))).toBe('./routes/f.$factory.board.tsx');
  expect(served(stepHref('acme', 'wf', 'a/b'))).toBe(
    './routes/f.$factory.steps.$workflow.$step.tsx',
  );
});
