import type { WebSocketLike } from '@neon/realtime/client';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { Attention } from '../../components/Attention';
import { PanelBody } from '../../components/panel';
import { LivePanel } from '../LivePanel';
import { LiveProvider } from '../LiveProvider';

/** While `server.accept` is false every socket fails the way a refused upgrade does; after, it greets and answers every query with no rows. */
const server = { accept: false };

class RefusableSocket implements WebSocketLike {
  readyState = 0;
  private subscribes = 0;
  private listeners = new Map<string, ((event: { data: unknown }) => void)[]>();

  constructor() {
    const refused = !server.accept;
    setTimeout(() => {
      if (refused) {
        this.readyState = 3;
        this.emit('error');
        this.emit('close');
      } else {
        this.readyState = 1;
        this.emit('open');
        this.emit('message', JSON.stringify({ type: 'ready' }));
      }
    }, 5);
  }

  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  private emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }

  send(data: string) {
    const message = JSON.parse(data);
    if (message.type !== 'subscribe') return;
    const liveId = String(++this.subscribes);
    const receive = (body: object) => this.emit('message', JSON.stringify(body));
    queueMicrotask(() => {
      receive({
        type: 'subscribed',
        request_id: message.request_id,
        live_id: liveId,
        epoch: '1',
        first_sequence: '1',
        columns: [{ name: 'value', type_oid: 25, typmod: -1, codec: 'pg_text' }],
      });
      const version = { live_id: liveId, epoch: '1', baseline_sync_attempt: '1' };
      receive({ type: 'baseline_sync_start', ...version, mvcc: { xmin: '1', xmax: '1', xip: [] } });
      receive({ type: 'baseline_sync_end', ...version, batch_count: 0 });
    });
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
}

/**
 * Attention and a `one-lap` panel on one client whose every socket is refused until the page has
 * shown that it cannot connect (`[data-live-offline]`); then sockets are accepted. Samples the page
 * every 100 ms, and resolves once the same mounted page reads "Nothing needs you" with the panel
 * `ready`, or after `timeoutMs`.
 */
export async function renderRefused(timeoutMs: number) {
  server.accept = false;
  const originalFetch = window.fetch;
  const OriginalWebSocket = window.WebSocket;
  const header = btoa(JSON.stringify({ alg: 'dir', enc: 'A256GCM', v: 1 })).replace(/=+$/, '');
  const sealed = new Map<string, number>();
  window.fetch = Object.assign(
    async (url: unknown) => {
      const path = String(url);
      if (path.includes('/api/actions')) return Response.json({ factories: [] });
      const query = path.split('/').at(-1) ?? '';
      if (!sealed.has(query)) sealed.set(query, sealed.size + 1);
      return Response.json({
        capability: `${header}..nonce.${query}.tag`,
        queryFingerprint: String(sealed.get(query)).padStart(64, '0'),
        expiresAt: Date.now() + 600_000,
        rewind: null,
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  window.WebSocket = RefusableSocket as unknown as typeof WebSocket;
  window.__MC_LIVE__ = {
    url: 'wss://test/',
    home: 'wss://test/',
    factories: ['factory-a'],
    rewind: null,
    protocol: 'neon.realtime.v1',
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const lap = () => document.querySelector('[data-live="one-lap"]');
  const sample = (started: number) => ({
    at: Math.round(performance.now() - started),
    title: document.querySelector('h1')?.textContent ?? '',
    offline: document.querySelector('[data-live-offline]') !== null,
    panel: lap()?.getAttribute('data-state') ?? null,
    panelText: lap()?.textContent ?? '',
  });
  try {
    root.render(
      <MemoryRouter>
        <LiveProvider>
          <Attention factory="factory-a" />
          <LivePanel<{ value: string }> query="one-lap" factory="factory-a" args={['run-1']}>
            {(rows, state) => (
              <PanelBody rows={rows} state={state} factory="factory-a" what="the lap">
                {() => <p>No laps.</p>}
              </PanelBody>
            )}
          </LivePanel>
        </LiveProvider>
      </MemoryRouter>,
    );
    const started = performance.now();
    const samples: ReturnType<typeof sample>[] = [];
    let atOffline: ReturnType<typeof sample> | undefined;
    while (performance.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const now = sample(started);
      samples.push(now);
      if (!atOffline && now.offline) {
        atOffline = now;
        server.accept = true;
      }
      if (atOffline && !now.offline && now.title === 'Nothing needs you' && now.panel === 'ready')
        break;
    }
    return { samples, atOffline, last: sample(started) };
  } finally {
    root.unmount();
    container.remove();
    window.fetch = originalFetch;
    window.WebSocket = OriginalWebSocket;
    delete window.__MC_LIVE__;
  }
}
