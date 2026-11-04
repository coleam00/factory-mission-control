import type { WebSocketLike } from '@neon/realtime/client';
import { createRoot } from 'react-dom/client';
import { LivePanel } from '../LivePanel';
import { LiveProvider } from '../LiveProvider';

/** Subscribes made on any socket of the page, which `failAfter` counts. */
let subscribed = 0;

/**
 * A Realtime socket that answers every subscribe with one row. With `failAfterRows`, it then
 * reports a backend protocol error, which ends the client's connection for good: the library never
 * reconnects that client, and rejects every renewal on it. With `failAfter`, a subscription fails
 * for good `failAfter` ms after its rows. A `dead` socket closes as soon as it is made.
 */
class RowSocket implements WebSocketLike {
  readyState = 1;
  private subscribes = 0;
  private listeners = new Map<string, ((event: { data: unknown }) => void)[]>();

  constructor(
    private failAfterRows: boolean,
    private greet: boolean,
    private failAfter: (subscribe: number) => number | undefined = () => undefined,
    dead = false,
  ) {
    if (dead) queueMicrotask(() => this.close());
  }

  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    if (type === 'message' && this.greet) {
      this.greet = false;
      queueMicrotask(() => this.receive({ type: 'ready' }));
    }
  }

  private receive(message: object) {
    for (const listener of this.listeners.get('message') ?? [])
      listener({ data: JSON.stringify(message) });
  }

  send(data: string) {
    const message = JSON.parse(data);
    if (message.type !== 'subscribe') return;
    const liveId = String(++this.subscribes);
    queueMicrotask(() => {
      this.receive({
        type: 'subscribed',
        request_id: message.request_id,
        live_id: liveId,
        epoch: '1',
        first_sequence: '1',
        columns: [{ name: 'value', type_oid: 25, typmod: -1, codec: 'pg_text' }],
      });
      const version = { live_id: liveId, epoch: '1', baseline_sync_attempt: '1' };
      this.receive({
        type: 'baseline_sync_start',
        ...version,
        mvcc: { xmin: '1', xmax: '1', xip: [] },
      });
      this.receive({
        type: 'baseline_sync_batch',
        ...version,
        index: 0,
        rows: [{ row_key: 'a'.repeat(64), values: ['the lap'] }],
      });
      this.receive({ type: 'baseline_sync_end', ...version, batch_count: 1 });
      const failIn = this.failAfter(++subscribed);
      if (failIn !== undefined)
        setTimeout(() => {
          this.receive({
            type: 'subscription_error',
            live_id: liveId,
            code: 'baseline_sync_failed',
            message: 'the subscription failed',
          });
        }, failIn);
      if (this.failAfterRows)
        setTimeout(() => {
          this.receive({
            type: 'connection_error',
            code: 'backend_protocol_error',
            message: 'the backend broke the protocol',
          });
        }, 300);
    });
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const listener of this.listeners.get('close') ?? []) listener({ data: undefined });
  }
}

const panelOf = (query: string) => document.querySelector(`[data-live="${query}"]`);
const panel = () => panelOf('one-lap');

/**
 * The one-lap panel through a connection that ends for good once it has shown its row, while the
 * seal endpoint fails `failures` times and then seals again. Resolves once the panel shows its row
 * again, or after `timeoutMs`, with when each seal was asked for (ms after the first) and the
 * panel's state at every change.
 *
 * With `rewound`, the server is switched to a rewind branch, so the page has two clients: the
 * rewind one for `one-lap`, the home one for `one-lap-home`. The home connection ends for good,
 * and with `'both'` so does the rewind one; the panels on each must show their rows again.
 */
export async function renderRecovery(
  failures: number,
  timeoutMs: number,
  rewound?: 'both' | 'home',
) {
  const originalFetch = window.fetch;
  const OriginalWebSocket = window.WebSocket;
  const header = btoa(JSON.stringify({ alg: 'dir', enc: 'A256GCM', v: 1 })).replace(/=+$/, '');
  const asked: number[] = [];
  window.fetch = Object.assign(
    async (_url: unknown, init?: RequestInit) => {
      const home = String(init?.body).includes('"branch":"home"');
      asked.push(Math.round(performance.now()));
      if (asked.length > 1 && asked.length <= 1 + failures)
        return Response.json({ error: 'sealing is down' }, { status: 503 });
      return Response.json({
        capability: `${header}..nonce.test.tag`,
        queryFingerprint: 'a'.repeat(64),
        expiresAt: Date.now() + 60_000,
        rewind: rewound && !home ? 'branch-x' : null,
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  // Every socket after the boot one: a new client's connection, which stays up.
  let homeSockets = 0;
  window.WebSocket = class extends RowSocket {
    constructor(url: string) {
      // The first connection on the home URL is the home client's; it is the one that ends.
      super(rewound !== undefined && url === 'wss://test/' && homeSockets++ === 0, true);
    }
  } as unknown as typeof WebSocket;
  window.__MC_LIVE__ = {
    url: rewound ? 'wss://test/rewind' : 'wss://test/',
    home: 'wss://test/',
    factories: ['factory-a'],
    rewind: rewound ? 'branch-x' : null,
    protocol: 'neon.realtime.v1',
    early: [JSON.stringify({ type: 'ready' })],
    socket: new RowSocket(rewound !== 'home', false) as unknown as WebSocket,
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const states: string[] = [];
  const observer = new MutationObserver(() => {
    const state = `${panel()?.getAttribute('data-state')} ${panel()?.textContent}`;
    if (states.at(-1) !== state) states.push(state);
  });
  const homePanel = () => panelOf('one-lap-home');
  observer.observe(container, { subtree: true, childList: true, attributes: true });
  try {
    root.render(
      <LiveProvider>
        <LivePanel<{ value: string }> query="one-lap" factory="factory-a" args={['run-1']}>
          {(rows, state) => (
            <p>{state === 'ready' ? rows?.map((row) => row.value).join(', ') : state}</p>
          )}
        </LivePanel>
        {rewound && (
          <LivePanel<{ value: string }> query="one-lap-home" factory="factory-a" home>
            {(rows, state) => (
              <p>{state === 'ready' ? rows?.map((row) => row.value).join(', ') : state}</p>
            )}
          </LivePanel>
        )}
      </LiveProvider>,
    );
    const started = performance.now();
    const failed = new Set<string>();
    const recovered = new Set<string>();
    const queries =
      rewound === 'home' ? ['one-lap-home'] : rewound ? ['one-lap', 'one-lap-home'] : ['one-lap'];
    while (performance.now() - started < timeoutMs && recovered.size < queries.length) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      for (const query of queries) {
        const state = panelOf(query)?.getAttribute('data-state');
        if (state === 'error') failed.add(query);
        if (failed.has(query) && state === 'ready') recovered.add(query);
      }
    }
    return {
      state: panel()?.getAttribute('data-state'),
      text: panel()?.textContent,
      homeState: homePanel()?.getAttribute('data-state'),
      homeText: homePanel()?.textContent,
      asked: asked.map((at) => at - asked[0]),
      states,
    };
  } finally {
    observer.disconnect();
    root.unmount();
    container.remove();
    window.fetch = originalFetch;
    window.WebSocket = OriginalWebSocket;
    delete window.__MC_LIVE__;
  }
}

/**
 * A panel whose subscriptions fail for good `delays` ms after their rows (the last repeats), while
 * sealing answers every request. Resolves after `windowMs` with when each seal was asked for.
 */
export async function renderFlapping(windowMs: number, delays: number[] = [300]) {
  subscribed = 0;
  const failAfter = (subscribe: number) => delays[subscribe - 1] ?? delays.at(-1);
  const originalFetch = window.fetch;
  const OriginalWebSocket = window.WebSocket;
  const header = btoa(JSON.stringify({ alg: 'dir', enc: 'A256GCM', v: 1 })).replace(/=+$/, '');
  const asked: number[] = [];
  const started = performance.now();
  window.fetch = Object.assign(
    async () => {
      asked.push(Math.round(performance.now() - started));
      return Response.json({
        capability: `${header}..nonce.test.tag`,
        queryFingerprint: 'a'.repeat(64),
        expiresAt: Date.now() + 600_000,
        rewind: null,
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  window.WebSocket = class extends RowSocket {
    constructor() {
      super(false, true, failAfter);
    }
  } as unknown as typeof WebSocket;
  window.__MC_LIVE__ = {
    url: 'wss://test/',
    home: 'wss://test/',
    factories: ['factory-a'],
    rewind: null,
    protocol: 'neon.realtime.v1',
    early: [JSON.stringify({ type: 'ready' })],
    socket: new RowSocket(false, false, failAfter) as unknown as WebSocket,
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    root.render(
      <LiveProvider>
        <LivePanel<{ value: string }> query="one-lap" factory="factory-a">
          {(rows, state) => <p>{state === 'ready' ? rows?.map((row) => row.value) : state}</p>}
        </LivePanel>
      </LiveProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    return { asked };
  } finally {
    root.unmount();
    container.remove();
    window.fetch = originalFetch;
    window.WebSocket = OriginalWebSocket;
    delete window.__MC_LIVE__;
  }
}

/**
 * A page whose every connection, the boot one and each new client's, ends for good after its
 * panel's row. Resolves after `windowMs` with when each socket after the boot one was opened (ms
 * after the page rendered), and the panel's state.
 */
export async function renderOutage(windowMs: number) {
  const originalFetch = window.fetch;
  const OriginalWebSocket = window.WebSocket;
  const header = btoa(JSON.stringify({ alg: 'dir', enc: 'A256GCM', v: 1 })).replace(/=+$/, '');
  const started = performance.now();
  const opened: number[] = [];
  window.fetch = Object.assign(
    async () =>
      Response.json({
        capability: `${header}..nonce.test.tag`,
        queryFingerprint: 'a'.repeat(64),
        expiresAt: Date.now() + 600_000,
        rewind: null,
      }),
    { preconnect: originalFetch.preconnect },
  );
  window.WebSocket = class extends RowSocket {
    constructor() {
      opened.push(Math.round(performance.now() - started));
      super(true, true);
    }
  } as unknown as typeof WebSocket;
  window.__MC_LIVE__ = {
    url: 'wss://test/',
    home: 'wss://test/',
    factories: ['factory-a'],
    rewind: null,
    protocol: 'neon.realtime.v1',
    early: [JSON.stringify({ type: 'ready' })],
    socket: new RowSocket(true, false) as unknown as WebSocket,
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    root.render(
      <LiveProvider>
        <LivePanel<{ value: string }> query="one-lap" factory="factory-a">
          {(rows, state) => <p>{state === 'ready' ? rows?.map((row) => row.value) : state}</p>}
        </LivePanel>
      </LiveProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    return { opened, state: panel()?.getAttribute('data-state') };
  } finally {
    root.unmount();
    container.remove();
    window.fetch = originalFetch;
    window.WebSocket = OriginalWebSocket;
    delete window.__MC_LIVE__;
  }
}
