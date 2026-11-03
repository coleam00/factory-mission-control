import type { WebSocketLike } from '@neon/realtime/client';
import { createRoot } from 'react-dom/client';
import { LivePanel } from '../LivePanel';
import { LiveProvider } from '../LiveProvider';

/**
 * A Realtime socket that answers every subscribe with one row. With `failAfterRows`, it then
 * reports a backend protocol error, which ends the client's connection for good: the library never
 * reconnects that client, and rejects every renewal on it.
 */
class RowSocket implements WebSocketLike {
  readyState = 1;
  private listeners = new Map<string, ((event: { data: unknown }) => void)[]>();

  constructor(
    private failAfterRows: boolean,
    private greet: boolean,
  ) {}

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
    queueMicrotask(() => {
      this.receive({
        type: 'subscribed',
        request_id: message.request_id,
        live_id: '1',
        epoch: '1',
        first_sequence: '1',
        columns: [{ name: 'value', type_oid: 25, typmod: -1, codec: 'pg_text' }],
      });
      const version = { live_id: '1', epoch: '1', baseline_sync_attempt: '1' };
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

const panel = () => document.querySelector('[data-live="one-lap"]');

/**
 * The one-lap panel through a connection that ends for good once it has shown its row, while the
 * seal endpoint fails `failures` times and then seals again. Resolves once the panel shows its row
 * again, or after `timeoutMs`, with when each seal was asked for (ms after the first) and the
 * panel's state at every change.
 */
export async function renderRecovery(failures: number, timeoutMs: number) {
  const originalFetch = window.fetch;
  const OriginalWebSocket = window.WebSocket;
  const header = btoa(JSON.stringify({ alg: 'dir', enc: 'A256GCM', v: 1 })).replace(/=+$/, '');
  const asked: number[] = [];
  window.fetch = Object.assign(
    async () => {
      asked.push(Math.round(performance.now()));
      if (asked.length > 1 && asked.length <= 1 + failures)
        return Response.json({ error: 'sealing is down' }, { status: 503 });
      return Response.json({
        capability: `${header}..nonce.test.tag`,
        queryFingerprint: 'a'.repeat(64),
        expiresAt: Date.now() + 60_000,
        rewind: null,
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  // Every socket after the boot one: a new client's connection, which stays up.
  window.WebSocket = class extends RowSocket {
    constructor() {
      super(false, true);
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
  const states: string[] = [];
  const observer = new MutationObserver(() => {
    const state = `${panel()?.getAttribute('data-state')} ${panel()?.textContent}`;
    if (states.at(-1) !== state) states.push(state);
  });
  observer.observe(container, { subtree: true, childList: true, attributes: true });
  try {
    root.render(
      <LiveProvider>
        <LivePanel<{ value: string }> query="one-lap" factory="factory-a" args={['run-1']}>
          {(rows, state) => (
            <p>{state === 'ready' ? rows?.map((row) => row.value).join(', ') : state}</p>
          )}
        </LivePanel>
      </LiveProvider>,
    );
    const started = performance.now();
    let failed = false;
    while (performance.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const state = panel()?.getAttribute('data-state');
      if (state === 'error') failed = true;
      if (failed && state === 'ready') break;
    }
    return {
      state: panel()?.getAttribute('data-state'),
      text: panel()?.textContent,
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
