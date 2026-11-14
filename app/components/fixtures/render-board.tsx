import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { Shell } from '../../Shell';
import { type BoardView, COLUMNS, PIPELINE } from '../../lib/board';
import { BoardBody } from '../Board';
import { Column } from '../Column';
import { Segmented } from '../ui/Segmented';
import { Socket } from './render-flow';

export { setManager } from './render-layout';

let current: { unmount: () => void } | undefined;

const BUILD_ITEMS = Array.from({ length: 15 }, (_, i) => i + 1);

function view(orders: number): BoardView {
  return {
    orders: Array.from({ length: orders }, (_, i) => ({
      name: `order-${i}`,
      merged: 1,
      total: 4,
      landsOn: 'main',
      building: 1,
      needsYou: 0,
    })),
    columns: COLUMNS.map((c) => ({ ...c, items: [] })),
    pipeline: PIPELINE.map((stage) => {
      const numbers = stage.id === 'build' ? BUILD_ITEMS : [];
      return {
        ...stage,
        items: numbers.map((number) => ({
          number,
          title: `Item ${number}`,
          chips: [],
          round: 0,
          dots: [],
          run: null,
          returned: 0,
          mergedAt: null,
          stop: null,
          to: `/f/x/work/${number}`,
          status: 'waiting' as const,
        })),
        pills:
          numbers.length > 0
            ? [{ label: 'waiting' as const, state: 'idle' as const, count: numbers.length }]
            : [],
      };
    }),
    found: { filed: 0, tracked: 0, dropped: 0 },
    notInOrder: 0,
    older: 0,
    olderHref: null,
  };
}

/** The Board route's frame around the real BoardBody. */
function Page({ orders }: { orders: number }) {
  return (
    <Column data-board width="max-w-none" className="px-4 py-6 min-[760px]:px-6">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-xl">
          <h1 className="text-[length:var(--v3-t-title)] leading-tight font-bold">Board</h1>
          <p className="mt-1 text-[length:var(--v3-t-body)]">
            Every work item by stage. Work flows left to right; a work order groups the items that
            ship together.
          </p>
        </div>
        <Segmented
          label="Board view"
          options={[
            { value: 'pipeline', label: 'Pipeline' },
            { value: 'table', label: 'Table' },
          ]}
          value="pipeline"
          onChange={() => {}}
        />
      </header>
      <BoardBody view={view(orders)} mode="pipeline" order={null} onOrder={() => {}} />
    </Column>
  );
}

/** Mounts the real shell with the Board's frame around the real BoardBody: 15 Build items and `orders` work orders. */
export function mount(orders: number) {
  current?.unmount();
  const originalFetch = window.fetch;
  const header = btoa(JSON.stringify({ alg: 'dir', enc: 'A256GCM', v: 1 })).replace(/=+$/, '');
  const asked: string[] = [];
  window.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const n = asked.push(String(input).replace('/api/live/', '')) - 1;
      return Response.json({
        capability: `${header}..${n}.test.tag`,
        queryFingerprint: n.toString(16).padStart(64, '0'),
        expiresAt: Date.now() + 60_000,
        rewind: null,
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  window.__MC_LIVE__ = {
    url: 'wss://test/',
    home: 'wss://test/',
    factories: ['x'],
    rewind: null,
    protocol: 'neon.realtime.v1',
    early: [JSON.stringify({ type: 'ready' })],
    socket: new Socket(
      (capability) => asked[Number(capability.split('.')[2])],
    ) as unknown as WebSocket,
  };
  const router = createMemoryRouter(
    [
      {
        element: <Shell />,
        children: [{ path: '/f/:factory/board', element: <Page orders={orders} /> }],
      },
    ],
    { initialEntries: ['/f/x/board'] },
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  root.render(<RouterProvider router={router} />);
  current = {
    unmount() {
      root.unmount();
      container.remove();
      window.fetch = originalFetch;
      delete window.__MC_LIVE__;
    },
  };
}

/** Where the Build column sits in the window, whether its list scrolls, and what scrolls sideways. */
export function measure() {
  const column = document.querySelector<HTMLElement>('[data-board-stage="build"]');
  const list = column?.querySelector<HTMLElement>('[data-stage-items]');
  const pane = document.querySelector('main')?.parentElement;
  const found = document.querySelector('[data-found]');
  if (!column || !list || !pane || !found) return null;
  const c = column.getBoundingClientRect();
  return {
    innerHeight: window.innerHeight,
    paneScrollTop: pane.scrollTop,
    top: Math.round(c.top),
    bottom: Math.round(c.bottom),
    listScrolls: list.scrollHeight > list.clientHeight,
    sideways: pane.scrollWidth > pane.clientWidth,
    foundTop: Math.round(found.getBoundingClientRect().top),
  };
}
