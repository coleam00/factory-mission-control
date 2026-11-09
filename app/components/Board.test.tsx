import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { type BoardView, COLUMNS, MINI_CARDS, PIPELINE } from '../lib/board';
import { BoardBody } from './Board';

const longTitle = '.archon/workflows/factory-build-queue-with-an-unbroken-path-token.yaml';

const longChip = 'factory-build-queue-with-an-unbroken-order-name-token';

const empty: BoardView = {
  orders: [],
  columns: COLUMNS.map((c) => ({ ...c, items: [] })),
  pipeline: PIPELINE.map(({ columns: _, ...spec }) => ({ ...spec, items: [], pills: [] })),
  found: { filed: 0, tracked: 0, dropped: 0 },
  notInOrder: 0,
  older: 0,
  olderHref: null,
};

function render(view: BoardView, mode: 'pipeline' | 'table'): string {
  const router = createMemoryRouter([
    {
      path: '/',
      element: (
        <BoardBody
          view={view}
          mode={mode}
          order={null}
          onOrder={() => {}}
          tableHref="?view=table"
        />
      ),
    },
  ]);
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

test('a card title and an order chip with long unbroken tokens wrap inside their card', () => {
  const html = render(
    {
      ...empty,
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
    },
    'table',
  );
  const title = html.match(/<span class="([^"]*)">\.archon\/workflows/);
  expect(title?.[1]).toContain('[overflow-wrap:anywhere]');
  const chip = html.match(/<span data-chip="order" class="([^"]*)"/);
  expect(chip?.[1]).toContain('[overflow-wrap:anywhere]');
});

test('the Table renders every column with its caption under the header', () => {
  const sections = render(empty, 'table').split('data-board-column=').slice(1);
  expect(sections).toHaveLength(COLUMNS.length);
  COLUMNS.forEach((c, i) => {
    expect(sections[i]).toContain(`"${c.id}"`);
    expect(sections[i]).toMatch(new RegExp(`data-holder[^>]*>${c.holder}</p>`));
  });
});

test('a failed chip renders the v3 failed color and a running chip pulses', () => {
  const html = render(
    {
      ...empty,
      columns: [
        {
          id: 'merged',
          title: 'Merged',
          role: 'test',
          holder: 'test',
          items: [
            {
              number: 1,
              title: 'x',
              chips: [
                { kind: 'route', text: 'broke', state: 'failed' },
                { kind: 'route', text: 'going', state: 'running', pulse: true },
              ],
              to: '/f/x/work/1',
            },
          ],
        },
      ],
    },
    'table',
  );
  const failed = html.match(/<span[^>]*color:var\(--v3-failed\)[^>]*>broke<\/span>/);
  expect(failed).not.toBeNull();
  const running = html.match(/<span[^>]*>(<span[^>]*animate-pulse[^>]*><\/span>)going<\/span>/);
  expect(running).not.toBeNull();
});

const stage = (id: string, numbers: number[]) => ({
  ...(PIPELINE.find((h) => h.id === id) as (typeof PIPELINE)[number]),
  columns: undefined,
  items: numbers.map((number) => ({
    number,
    title: `Item ${number}`,
    chips: [],
    to: `/f/x/work/${number}`,
    status: 'waiting' as const,
  })),
  pills:
    numbers.length > 0
      ? [{ label: 'waiting' as const, state: 'idle' as const, count: numbers.length }]
      : [],
});

test('the Pipeline renders the five stages in order, then Blocked and parked, each with its count and a link to the work item', () => {
  const view: BoardView = {
    ...empty,
    pipeline: PIPELINE.map((h) => stage(h.id, h.id === 'build' ? [7] : [])),
  };
  const html = render(view, 'pipeline');
  const ids = [...html.matchAll(/data-board-stage="(\w+)"/g)].map((m) => m[1]);
  expect(ids).toEqual(['intake', 'planned', 'build', 'merge', 'merged', 'blocked']);
  expect(html).toContain('data-count="1"');
  expect(html).toMatch(
    /<a[^>]*href="\/f\/x\/work\/7"[^>]*data-work-item="7"|data-work-item="7"[^>]*href="\/f\/x\/work\/7"/,
  );
  expect(html).toContain('data-found');
});

test('the Pipeline shows at most three mini cards and a more-in-Table link', () => {
  const numbers = Array.from({ length: MINI_CARDS + 2 }, (_, i) => i + 1);
  const view: BoardView = {
    ...empty,
    pipeline: PIPELINE.map((h) => stage(h.id, h.id === 'build' ? numbers : [])),
  };
  const html = render(view, 'pipeline');
  expect(html.match(/data-work-item=/g)).toHaveLength(MINI_CARDS);
  expect(html).toContain('data-count="5"');
  expect(html).toMatch(/href="\/\?view=table"[^>]*>2 more in Table/);
});

test('a mini card moves its state pill under the number instead of breaking it', () => {
  const html = render(
    {
      ...empty,
      pipeline: PIPELINE.map(({ columns: _, ...spec }, i) => ({
        ...spec,
        items:
          i === 0
            ? [
                {
                  number: 7,
                  title: 't',
                  status: 'check failed' as const,
                  chips: [],
                  to: '/f/x/work/7',
                },
              ]
            : [],
        pills: [],
      })),
    },
    'pipeline',
  );
  expect(html).toMatch(/class="[^"]*flex-wrap[^"]*whitespace-nowrap/);
  expect(html).toMatch(/class="[^"]*min-w-0[^"]*" title="check failed"/);
  expect(html).toMatch(/<span class="min-w-0 truncate">check failed<\/span>/);
});

test('a stage summary pill truncates on one line and carries its full text in a title', () => {
  const html = render(
    {
      ...empty,
      pipeline: PIPELINE.map((h) => ({
        ...stage(h.id, [7]),
        pills: [{ label: 'check failed' as const, state: 'failed' as const, count: 1 }],
      })),
    },
    'pipeline',
  );
  expect(html).toMatch(/title="check failed 1"[^>]*><span class="truncate">check failed/);
});
