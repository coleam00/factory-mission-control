import type { WebSocketLike } from '@neon/realtime/client';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { Shell } from '../../Shell';
import type { HomeMapRow } from '../../map/live';
import Home from '../../routes/f.$factory.map';

const VERSION_ROW: HomeMapRow = {
  kind: 'version',
  run_id: null,
  workflow: null,
  steps: null,
  number: null,
  title: null,
  url: null,
  at: null,
  prs: null,
};

/** A socket that answers every subscribe with `home-map`'s one version row, and no rows otherwise. */
export class Socket implements WebSocketLike {
  readyState = 1;
  private listeners: ((event: { data: unknown }) => void)[] = [];

  constructor(private queryOf: (capability: string) => string) {}

  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    if (type === 'message') this.listeners.push(listener);
  }

  private receive(message: object) {
    for (const listener of this.listeners) listener({ data: JSON.stringify(message) });
  }

  send(data: string) {
    const message = JSON.parse(data);
    if (message.type !== 'subscribe') return;
    const rows = this.queryOf(message.authorization) === 'home-map' ? 1 : 0;
    const live_id = message.request_id;
    queueMicrotask(() => {
      this.receive({
        type: 'subscribed',
        request_id: message.request_id,
        live_id,
        epoch: '1',
        first_sequence: '1',
        columns: (rows ? Object.keys(VERSION_ROW) : ['value']).map((name) => ({
          name,
          type_oid: 25,
          typmod: -1,
          codec: 'pg_text',
        })),
      });
      const version = { live_id, epoch: '1', baseline_sync_attempt: '1' };
      this.receive({
        type: 'baseline_sync_start',
        ...version,
        mvcc: { xmin: '1', xmax: '1', xip: [] },
      });
      if (rows)
        this.receive({
          type: 'baseline_sync_batch',
          ...version,
          index: 0,
          rows: [
            {
              row_key: 'a'.repeat(64),
              values: Object.values(VERSION_ROW),
            },
          ],
        });
      this.receive({ type: 'baseline_sync_end', ...version, batch_count: rows });
    });
  }

  close() {
    this.readyState = 3;
  }
}

let current: { unmount: () => void } | undefined;

/** Mounts the real shell and home over a fake server at `url`. */
export function mount(url: string) {
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
        children: [
          { path: '/f/:factory/map', element: <Home /> },
          { path: '/f/:factory/board', element: <p>Board</p> },
        ],
      },
    ],
    { initialEntries: [url] },
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

const TOGGLE = 'main button[aria-label="Flow animation"]';

export const shown = () => ({
  toggle: document.querySelector(TOGGLE) !== null,
  flow: document.querySelector<HTMLElement>('[data-map-stage]')?.dataset.flow ?? null,
});

export const clickToggle = () => document.querySelector<HTMLButtonElement>(TOGGLE)?.click();

export const goBoard = () => {
  document.querySelector<HTMLAnchorElement>('nav a[href$="/board"]')?.click();
};
