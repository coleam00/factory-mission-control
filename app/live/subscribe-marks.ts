import type { WebSocketFactory, WebSocketLike } from '@neon/realtime/client';

/**
 * Which panel each sealed capability belongs to, until its first `subscribe` goes out. The
 * capability is a bearer credential: it stays in this map and never enters a mark's name.
 */
const awaiting = new Map<string, string>();

/** Marks `live:<query>:subscribe-sent` when the client sends the subscribe for `capability`. */
export function expectSubscribe(capability: string, query: string): void {
  awaiting.set(capability, query);
}

function subscribedCapability(data: string): string | undefined {
  if (!data.includes('"subscribe"')) return undefined;
  try {
    const message = JSON.parse(data) as { type?: unknown; authorization?: unknown };
    return message.type === 'subscribe' && typeof message.authorization === 'string'
      ? message.authorization
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read by `bun run test:live`: a panel's first snapshot is timed from the moment the Realtime
 * client sends its `subscribe` (once the socket says `ready`) to its rows on screen. Connection
 * setup before that is judged separately, from navigation.
 */
function markSubscribe(data: string): void {
  const capability = subscribedCapability(data);
  if (capability === undefined) return;
  const query = awaiting.get(capability);
  if (query === undefined) return;
  awaiting.delete(capability);
  const name = `live:${query}:subscribe-sent`;
  if (performance.getEntriesByName(name).length === 0) performance.mark(name);
}

/** `factory`'s sockets, with each panel's first `subscribe` marked as it is sent. */
export function markingSubscribes(factory: WebSocketFactory): WebSocketFactory {
  return (url, protocols) => {
    const socket = factory(url, protocols);
    const marked: WebSocketLike = {
      get readyState() {
        return socket.readyState;
      },
      addEventListener: socket.addEventListener.bind(socket),
      send: (data) => {
        socket.send(data);
        markSubscribe(data);
      },
      close: (code, reason) => socket.close(code, reason),
      ...(socket.terminate && { terminate: () => socket.terminate?.() }),
    };
    return marked;
  };
}
