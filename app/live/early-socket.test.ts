import { afterEach, describe, expect, test } from 'bun:test';
import { discardEarlySocket, earlySocketFactory, type LiveBoot } from './early-socket';

const SOCKET_URL = 'wss://ep-sample.rt.c-14.us-east-1.aws.neon.tech/';
const PROTOCOL = 'neon.realtime.v1';

/** Enough of a browser WebSocket for the factory: listeners, a ready state and close. */
class FakeSocket {
  static opened: FakeSocket[] = [];
  readyState = 0;
  closed = false;
  sent: string[] = [];
  private listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeSocket.opened.push(this);
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
}

const realWebSocket = globalThis.WebSocket;
afterEach(() => {
  globalThis.WebSocket = realWebSocket;
  FakeSocket.opened = [];
});

/** A boot record as the server's inline script leaves it, with its socket already buffering. */
function bootWith(socket: FakeSocket): LiveBoot {
  const boot: LiveBoot = {
    url: SOCKET_URL,
    factories: ['mission-control'],
    protocol: PROTOCOL,
    socket: socket as unknown as WebSocket,
    early: [],
  };
  socket.addEventListener('message', (e) => boot.early?.push(e.data));
  return boot;
}

function useFakeWebSocket() {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
}

describe('earlySocketFactory', () => {
  test('the first socket is the boot socket, and what it buffered reaches the client first, in order', async () => {
    useFakeWebSocket();
    const socket = new FakeSocket(SOCKET_URL, PROTOCOL);
    socket.readyState = 1;
    const boot = bootWith(socket);
    socket.emit('message', 'ready');
    socket.emit('message', 'ping');

    const transport = earlySocketFactory(boot)(SOCKET_URL, PROTOCOL);
    const got: unknown[] = [];
    transport.addEventListener('message', (e) => got.push(e.data));
    expect(got).toEqual([]);
    await Promise.resolve();
    socket.emit('message', 'subscribed');

    expect(got).toEqual(['ready', 'ping', 'subscribed']);
    expect(boot.early).toBeNull();
    expect(boot.socket).toBeUndefined();
    expect(transport.readyState).toBe(1);
    transport.send('subscribe');
    expect(socket.sent).toEqual(['subscribe']);
    expect(FakeSocket.opened).toEqual([socket]);
  });

  test('a later socket, as on a reconnect, is a new one', () => {
    useFakeWebSocket();
    const socket = new FakeSocket(SOCKET_URL, PROTOCOL);
    const factory = earlySocketFactory(bootWith(socket));
    factory(SOCKET_URL, PROTOCOL);
    factory(SOCKET_URL, [PROTOCOL]);
    expect(FakeSocket.opened).toHaveLength(2);
    expect(FakeSocket.opened[1]?.protocols).toEqual([PROTOCOL]);
  });

  test.each([
    ['closed', SOCKET_URL, PROTOCOL, 3],
    ['for another URL', 'wss://elsewhere.example/', PROTOCOL, 1],
    ['for another subprotocol', SOCKET_URL, 'neon.realtime.v2', 1],
  ])('a boot socket %s is closed and a new socket opened', (_, url, protocol, readyState) => {
    useFakeWebSocket();
    const socket = new FakeSocket(SOCKET_URL, PROTOCOL);
    socket.readyState = readyState;
    const boot = bootWith(socket);

    earlySocketFactory(boot)(url, protocol);
    expect(socket.closed).toBe(true);
    expect(FakeSocket.opened).toHaveLength(2);
    expect(FakeSocket.opened[1]?.url).toBe(url);
    expect(boot.early).toBeNull();
  });
});

test('discardEarlySocket closes a boot socket no client took', () => {
  const socket = new FakeSocket(SOCKET_URL, PROTOCOL);
  const boot = bootWith(socket);
  discardEarlySocket(boot);
  expect(socket.closed).toBe(true);
  expect(boot.socket).toBeUndefined();
  expect(boot.early).toBeNull();
});
