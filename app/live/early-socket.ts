import type { WebSocketFactory, WebSocketLike } from '@neon/realtime/client';

/**
 * What the server's inline script leaves on `window.__MC_LIVE__` (server/live.ts
 * `liveBootScript`): the answer of `GET /api/live`, plus the Realtime socket it opened while the
 * page parsed and the messages that socket received before the app took it.
 */
export interface LiveBoot {
  url: string;
  factories: string[];
  protocol: string;
  socket?: WebSocket;
  early?: unknown[] | null;
}

declare global {
  interface Window {
    __MC_LIVE__?: LiveBoot;
  }
}

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;

type Listener = (event?: { readonly data: unknown }) => void;

/**
 * The boot socket as the Realtime client's transport. The client adds its `message` listener
 * right after the factory returns; the messages buffered before then are delivered to it first,
 * in a microtask, so they arrive in order and after all of its listeners are in place.
 */
function takeOver(boot: LiveBoot, socket: WebSocket): WebSocketLike {
  const add = (type: string, listener: Listener) => {
    socket.addEventListener(type, listener as unknown as EventListener);
    if (type !== 'message' || !boot.early) return;
    const early = boot.early;
    boot.early = null;
    queueMicrotask(() => {
      for (const data of early) listener({ data });
    });
  };
  return {
    get readyState() {
      return socket.readyState;
    },
    addEventListener: add as WebSocketLike['addEventListener'],
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
  };
}

/**
 * A Realtime transport factory whose first call takes over the boot socket when it is for the
 * same URL and subprotocol and is still connecting or open; every other call opens a new socket,
 * as the client's own factory does.
 */
export function earlySocketFactory(boot: LiveBoot): WebSocketFactory {
  return (url, protocols) => {
    const socket = boot.socket;
    boot.socket = undefined;
    const usable =
      socket !== undefined &&
      url === boot.url &&
      [protocols].flat().includes(boot.protocol) &&
      (socket.readyState === SOCKET_CONNECTING || socket.readyState === SOCKET_OPEN);
    if (socket !== undefined && usable) return takeOver(boot, socket);
    socket?.close();
    boot.early = null;
    return new WebSocket(url, protocols);
  };
}

/** Closes the boot socket if no client took it over. */
export function discardEarlySocket(boot: LiveBoot): void {
  boot.socket?.close();
  boot.socket = undefined;
  boot.early = null;
}
