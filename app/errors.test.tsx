import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createMemoryRouter,
  createStaticHandler,
  createStaticRouter,
  RouterProvider,
  StaticRouterProvider,
} from 'react-router';
import Home from './routes/index';
import { appRoutes, type RouteModule } from './routing';

const modules: Record<string, RouteModule> = { './routes/index.tsx': { default: Home } };

function render(path: string): string {
  const router = createMemoryRouter(appRoutes(modules), { initialEntries: [path] });
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The route's own content, without the shell's factory strip. */
const mainText = (html: string) => text(html.match(/<main[\s\S]*<\/main>/)?.[0] ?? '');

test('an unknown path renders the not-found empty state, not the developer error page', () => {
  const html = render('/no-such-screen');
  expect(mainText(html)).toBe('Nothing is at this address. Go to home');
  expect(html).not.toContain('Unexpected Application Error');
  expect(html).not.toContain('style=');
  expect(html).toContain('href="/"');
});

test('a route that fails renders the error empty state', async () => {
  // React's server renderer has no error boundaries, so the failure comes from a loader.
  const routes = appRoutes(modules);
  routes[0]?.children?.unshift({
    path: '/broken',
    Component: Home,
    loader: () => {
      throw new Error('load failed');
    },
  });
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request('http://localhost/broken'));
  if (context instanceof Response) throw new Error('unexpected redirect');
  const html = renderToStaticMarkup(
    <StaticRouterProvider
      router={createStaticRouter(handler.dataRoutes, context)}
      context={context}
      hydrate={false}
    />,
  );
  expect(text(html)).toBe('This page failed to load. Go to home');
  expect(html).not.toContain('style=');
});

test('registered routes still render through the error boundary', () => {
  expect(mainText(render('/'))).toBe('Factory map Version - Loading the factory map.');
});
