import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { BoardView } from '../lib/board';
import { BoardBody } from './Board';

const longTitle = '.archon/workflows/factory-build-queue-with-an-unbroken-path-token.yaml';

const view: BoardView = {
  orders: [],
  columns: [
    {
      id: 'merged',
      title: 'Merged',
      role: 'test',
      items: [{ number: 441, title: longTitle, chips: [], to: '/f/x/work/441' }],
    },
  ],
  notInOrder: 0,
  older: 0,
  olderHref: null,
};

test('a card title with a long unbroken token wraps inside its card', () => {
  const router = createMemoryRouter([
    { path: '/', element: <BoardBody view={view} order={null} onOrder={() => {}} /> },
  ]);
  const html = renderToStaticMarkup(<RouterProvider router={router} />);
  const title = html.match(/<span class="([^"]*)">\.archon\/workflows/);
  expect(title?.[1]).toContain('[overflow-wrap:anywhere]');
});
