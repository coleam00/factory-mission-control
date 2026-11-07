import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { COLUMNS } from '../lib/board';
import { BoardBody } from './Board';

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
