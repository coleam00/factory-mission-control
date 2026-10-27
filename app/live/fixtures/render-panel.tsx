import type { WebSocketLike } from '@neon/realtime/client';
import { createRoot } from 'react-dom/client';
import { LivePanel } from '../LivePanel';
import { LiveProvider } from '../LiveProvider';

class BaselineSocket implements WebSocketLike {
  readyState = 1;
  private listeners = new Map<string, ((event: { data: unknown }) => void)[]>();

  constructor(private empty: boolean) {}

  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
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
      if (!this.empty)
        this.receive({
          type: 'baseline_sync_batch',
          ...version,
          index: 0,
          rows: [{ row_key: 'a'.repeat(64), values: ['delivered row'] }],
        });
      this.receive({ type: 'baseline_sync_end', ...version, batch_count: this.empty ? 0 : 1 });
    });
  }

  close() {
    this.readyState = 3;
  }
}

export async function renderPanel(empty: boolean) {
  const originalFetch = window.fetch;
  const header = btoa(JSON.stringify({ alg: 'dir', enc: 'A256GCM', v: 1 })).replace(/=+$/, '');
  window.fetch = Object.assign(
    async () =>
      Response.json({
        capability: `${header}..nonce.test.tag`,
        queryFingerprint: 'a'.repeat(64),
        expiresAt: Date.now() + 60_000,
        rewind: null,
      }),
    { preconnect: originalFetch.preconnect },
  );
  window.__MC_LIVE__ = {
    url: 'wss://test/',
    home: 'wss://test/',
    factories: ['factory-a'],
    rewind: null,
    protocol: 'neon.realtime.v1',
    early: [JSON.stringify({ type: 'ready' })],
    socket: new BaselineSocket(empty) as unknown as WebSocket,
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    const committed = new Promise<void>((resolve, reject) => {
      const observer = new PerformanceObserver(() => {
        if (performance.getEntriesByName('live:home-map:rendered').length) {
          clearTimeout(timer);
          observer.disconnect();
          resolve();
        }
      });
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error('LivePanel did not record committed rows'));
      }, 5000);
      observer.observe({ entryTypes: ['mark'] });
    });
    root.render(
      <LiveProvider>
        <LivePanel<{ value: string }> query="home-map" factory="factory-a">
          {(rows, state) => {
            if (state !== 'ready') return <p>{state}</p>;
            const until = performance.now() + 650;
            while (performance.now() < until) {
              /* Deliberate render cost, including before DOM commit. */
            }
            return <p data-delivered>{rows?.map((row) => row.value).join(', ') || 'No rows.'}</p>;
          }}
        </LivePanel>
      </LiveProvider>,
    );
    await committed;
    const rows = container.querySelector('[data-delivered]');
    return {
      text: rows?.textContent,
      visible: !!rows && rows.getBoundingClientRect().height > 0,
      state: container.querySelector('[data-live]')?.getAttribute('data-state'),
    };
  } finally {
    root.unmount();
    container.remove();
    window.fetch = originalFetch;
    delete window.__MC_LIVE__;
  }
}
