import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { BoardView } from '../lib/board';
import { COLUMNS } from '../lib/board';
import { BoardBody } from './Board';

const longTitle = '.archon/workflows/factory-build-queue-with-an-unbroken-path-token.yaml';

const longChip = 'factory-build-queue-with-an-unbroken-order-name-token';

const view: BoardView = {
  orders: [],
  columns: [
    {
      id: 'merged',
      title: 'Merged',
      role: 'test',
      holder: 'test',
      items: [
        {
          number: 441,
          title: longTitle,
          chips: [{ kind: 'order', text: longChip }],
          to: '/f/x/work/441',
        },
      ],
    },
  ],
  notInOrder: 0,
  older: 0,
  olderHref: null,
};

test('a card title and an order chip with long unbroken tokens wrap inside their card', () => {
  const router = createMemoryRouter([
    { path: '/', element: <BoardBody view={view} order={null} onOrder={() => {}} /> },
  ]);
  const html = renderToStaticMarkup(<RouterProvider router={router} />);
  const title = html.match(/<span class="([^"]*)">\.archon\/workflows/);
  expect(title?.[1]).toContain('[overflow-wrap:anywhere]');
  const chip = html.match(/<span data-chip="order" class="([^"]*)"/);
  expect(chip?.[1]).toContain('[overflow-wrap:anywhere]');
});

function render(element: React.ReactElement): string {
  const router = createMemoryRouter([{ path: '/', element }]);
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

test('every column renders its caption under the header', () => {
  const html = render(
    <BoardBody
      view={{
        orders: [],
        columns: COLUMNS.map((c) => ({ ...c, items: [] })),
        notInOrder: 0,
        older: 0,
        olderHref: null,
      }}
      order={null}
      onOrder={() => {}}
    />,
  );
  const sections = html.split('data-board-column=').slice(1);
  expect(sections).toHaveLength(COLUMNS.length);
  COLUMNS.forEach((c, i) => {
    expect(sections[i]).toContain(`"${c.id}"`);
    expect(sections[i]).toMatch(new RegExp(`data-holder[^>]*>${c.holder}</p>`));
  });
});
