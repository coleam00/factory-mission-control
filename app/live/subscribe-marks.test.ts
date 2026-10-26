import { afterEach, expect, test } from 'bun:test';
import { createRealtimeClient, defineParsers, type WebSocketLike } from '@neon/realtime/client';
import { earlySocketFactory, type LiveBoot } from './early-socket';
import { panelState } from './LivePanel';
import {
  discardObservation,
  expectSubscribe,
  markingSubscribes,
  markRendered,
  observeQuery,
  type QueryObservation,
} from './subscribe-marks';

class FakeSocket implements WebSocketLike {
  readyState = 1;
  sent: string[] = [];
  private listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
  receive(message: object) {
    this.emit('message', JSON.stringify(message));
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
}

function sealed(identity: string) {
  const header = Buffer.from(JSON.stringify({ alg: 'dir', enc: 'A256GCM', v: 1 })).toString(
    'base64url',
  );
  return {
    capability: `${header}..nonce.${identity}.tag`,
    queryFingerprint: identity.repeat(64),
    expiresAt: Date.now() + 60_000,
  };
}

const observations: QueryObservation[] = [];
function observation(
  query = 'home-map',
  context: Partial<Omit<QueryObservation, 'id' | 'query'>> = {},
) {
  const result = observeQuery({
    query,
    factory: 'factory-a',
    args: [],
    home: false,
    branch: null,
    queryFingerprint: `fingerprint-${query}`,
    ...context,
  });
  observations.push(result);
  return result;
}
const marks = (query: string, kind: string) =>
  performance.getEntriesByName(`live:${query}:${kind}`) as PerformanceMark[];
const send = (socket: WebSocketLike, capability: string, id = '1') =>
  socket.send(JSON.stringify({ type: 'subscribe', request_id: id, authorization: capability }));
function admit(socket: FakeSocket, request = '1', live = '11') {
  socket.receive({
    type: 'subscribed',
    request_id: request,
    live_id: live,
    epoch: '1',
    first_sequence: '1',
    columns: [{ name: 'value', type_oid: 23, typmod: -1, codec: 'pg_text' }],
  });
}
function start(socket: FakeSocket, live = '11', attempt = '1', epoch = '1') {
  socket.receive({
    type: 'baseline_sync_start',
    live_id: live,
    epoch,
    baseline_sync_attempt: attempt,
    mvcc: { xmin: '1', xmax: '1', xip: [] },
  });
}
function end(socket: FakeSocket, live = '11', attempt = '1', batches = 0, epoch = '1') {
  socket.receive({
    type: 'baseline_sync_end',
    live_id: live,
    epoch,
    baseline_sync_attempt: attempt,
    batch_count: batches,
  });
}
function transport(socket = new FakeSocket()) {
  const marked = markingSubscribes(() => socket)('wss://test/', 'neon.realtime.v1');
  marked.addEventListener('message', () => undefined);
  return { socket, marked };
}

afterEach(() => {
  for (const item of observations.splice(0)) discardObservation(item);
  performance.clearMarks();
});

test('the actual SDK sees a complete empty or multi-batch baseline only after its arrival mark, before decoding', async () => {
  const socket = new FakeSocket();
  const firstSeal = sealed('a');
  const emptySeal = sealed('b');
  const populated = observation('home-map', { queryFingerprint: firstSeal.queryFingerprint });
  const empty = observation('step-detail', {
    args: ['workflow', 'step'],
    queryFingerprint: emptySeal.queryFingerprint,
  });
  const order: string[] = [];
  const client = createRealtimeClient({
    url: 'wss://test/',
    webSocketFactory: markingSubscribes(() => socket),
    parsers: defineParsers({
      23: (value: string) => {
        expect(marks('home-map', 'first-result')).toHaveLength(1);
        order.push('decode');
        return Number(value);
      },
    }),
  });
  try {
    for (const [seal, item] of [
      [firstSeal, populated],
      [emptySeal, empty],
    ] as const) {
      expectSubscribe(seal.capability, item);
      const subscription = client.subscribe(seal);
      subscription.onChange((snapshot) => {
        if (panelState(snapshot) !== 'ready') return;
        expect(marks(item.query, 'first-result')).toHaveLength(1);
        order.push(`published:${item.query}`);
        markRendered(item);
      });
    }
    socket.receive({ type: 'ready' });
    admit(socket);
    admit(socket, '2', '22');
    start(socket);
    start(socket, '22');
    for (const index of [0, 1]) {
      socket.receive({
        type: 'baseline_sync_batch',
        live_id: '11',
        epoch: '1',
        baseline_sync_attempt: '1',
        index,
        rows: [{ row_key: String(index).repeat(64), values: [String(index)] }],
      });
    }
    expect(order).toEqual([]);
    expect(marks('home-map', 'first-result')).toHaveLength(0);
    end(socket, '22');
    end(socket, '11', '1', 2);
    expect(order).toEqual(['published:step-detail', 'decode', 'decode', 'published:home-map']);
    for (const item of [populated, empty]) {
      expect(marks(item.query, 'ready')[0].detail.id).toBe(item.id);
      expect(marks(item.query, 'rendered')[0].startTime).toBeGreaterThanOrEqual(
        marks(item.query, 'first-result')[0].startTime,
      );
    }
    for (const seal of [firstSeal, emptySeal]) {
      expect(JSON.stringify(performance.getEntriesByType('mark'))).not.toContain(seal.capability);
    }
  } finally {
    client.close();
  }
});

test.each(['before start', 'during baseline', 'stale completion', 'after completion'])(
  'the actual SDK and observer agree on a committed reset %s',
  (phase) => {
    const socket = new FakeSocket();
    const seal = sealed('a');
    const item = observation();
    expectSubscribe(seal.capability, item);
    const client = createRealtimeClient({
      url: 'wss://test/',
      webSocketFactory: markingSubscribes(() => socket),
    });
    try {
      const subscription = client.subscribe(seal);
      subscription.onChange((snapshot) => {
        if (snapshot.data !== undefined && snapshot.status === 'live') markRendered(item);
      });
      socket.receive({ type: 'ready' });
      admit(socket);
      if (phase !== 'before start') start(socket, '11', '5');
      if (phase === 'after completion') end(socket, '11', '5');
      const original = marks(item.query, 'first-result')[0]?.startTime;
      socket.receive({ type: 'open', publication_id: 'reset' });
      socket.receive({
        type: 'reset_required',
        publication_id: 'reset',
        index: 0,
        targets: [{ live_id: '11', epoch: '2', first_sequence: '1' }],
      });
      socket.receive({
        type: 'commit',
        publication_id: 'reset',
        body_count: 1,
        frontier: { lsn: '0/1' },
      });
      if (phase === 'stale completion') {
        end(socket, '11', '5');
        expect(subscription.getSnapshot().data).toBeUndefined();
        expect(marks(item.query, 'first-result')).toHaveLength(0);
        expect(marks(item.query, 'rendered')).toHaveLength(0);
      }
      start(socket, '11', '1', '2');
      end(socket, '11', '1', 0, '2');
      expect(subscription.getSnapshot()).toMatchObject({ status: 'live', data: [] });
      expect(marks(item.query, 'first-result')).toHaveLength(1);
      expect(marks(item.query, 'rendered')).toHaveLength(1);
      if (original !== undefined)
        expect(marks(item.query, 'first-result')[0].startTime).toBe(original);
    } finally {
      client.close();
    }
  },
);

test('two sockets with colliding IDs and the same query retain their own factory, arguments and branch', () => {
  const first = transport();
  const second = transport();
  const args = ['workflow', 'step-a'];
  const a = observation('step-detail', { args, home: true });
  const b = observation('step-detail', {
    args: ['workflow', 'step-b'],
    factory: 'factory-b',
    branch: 'rewind-owned',
  });
  args[1] = 'mutated';
  expectSubscribe('a', a);
  expectSubscribe('b', b);
  send(first.marked, 'a');
  send(second.marked, 'b');
  admit(first.socket);
  admit(second.socket);
  start(first.socket);
  start(second.socket);
  end(second.socket);
  markRendered(b);
  end(first.socket);
  markRendered(a);
  const arrivals = marks('step-detail', 'first-result');
  expect(arrivals.map((m) => m.detail.id)).toEqual([b.id, a.id]);
  expect(arrivals[1].detail.args).toEqual(['workflow', 'step-a']);
  expect(arrivals[0].detail).toMatchObject({
    factory: 'factory-b',
    branch: 'rewind-owned',
    home: false,
  });
  expect(marks('step-detail', 'ready')).toHaveLength(1);
  expect(marks('step-detail', 'ready')[0].detail.id).toBe(b.id);
  expect(marks('step-detail', 'rendered')).toHaveLength(2);
});

test('retry, replacement capability, reconnect and older attempts cannot overwrite or misattribute the first result', () => {
  const first = transport();
  const item = observation();
  expectSubscribe('old', item);
  send(first.marked, 'old');
  first.socket.receive({ type: 'subscribe_rejected', request_id: '1' });
  send(first.marked, 'old', '2');
  admit(first.socket, '2');
  start(first.socket);
  first.socket.close();
  expectSubscribe('renewed', item);
  const second = transport();
  send(second.marked, 'old');
  admit(second.socket);
  start(second.socket);
  end(second.socket);
  expect(marks('home-map', 'first-result')).toHaveLength(0);
  send(second.marked, 'renewed', '2');
  admit(second.socket, '2', '22');
  start(second.socket, '22', '2');
  start(second.socket, '22', '1');
  end(second.socket, '22', '1');
  end(first.socket);
  expect(marks('home-map', 'first-result')).toHaveLength(0);
  end(second.socket, '22', '2');
  markRendered(item);
  expectSubscribe('later-renewal', item);
  send(second.marked, 'later-renewal', '3');
  admit(second.socket, '3', '33');
  start(second.socket, '33');
  end(second.socket, '33');
  markRendered(item);
  expect(marks('home-map', 'first-result')).toHaveLength(1);
  expect(marks('home-map', 'rendered')).toHaveLength(1);
  expect(marks('home-map', 'subscribe-sent')).toHaveLength(1);
});

test.each(['cancel', 'unsubscribe', 'error', 'close'] as const)(
  '%s discards obsolete admission',
  (operation) => {
    const { marked, socket } = transport();
    const item = observation();
    expectSubscribe('capability', item);
    send(marked, 'capability');
    admit(socket);
    start(socket);
    if (operation === 'cancel') discardObservation(item);
    if (operation === 'unsubscribe')
      marked.send(JSON.stringify({ type: 'unsubscribe', live_id: '11' }));
    if (operation === 'error') socket.receive({ type: 'subscription_error', live_id: '11' });
    if (operation === 'close') marked.close();
    end(socket);
    expect(marks('home-map', 'first-result')).toHaveLength(0);
  },
);

test('successful sends alone mark subscribe; unknown and malformed frames are forwarded unchanged', () => {
  const socket = new FakeSocket();
  const marked = markingSubscribes(() => socket)('wss://test/', 'p');
  const got: unknown[] = [];
  marked.addEventListener('message', (event) => got.push(event.data));
  const item = observation();
  expectSubscribe('secret', item);
  for (const data of ['{', '{"type":"pong","token":"t"}', '{}']) {
    marked.send(data);
    socket.emit('message', data);
  }
  expect(got).toEqual(socket.sent);
  expect(marks('home-map', 'subscribe-sent')).toHaveLength(0);
  send(marked, 'unknown');
  expect(marks('home-map', 'subscribe-sent')).toHaveLength(0);
  socket.send = () => {
    throw new Error('closed');
  };
  expect(() => send(marked, 'secret')).toThrow('closed');
  expect(marks('home-map', 'subscribe-sent')).toHaveLength(0);
});

test('early socket buffered ready and ping reach the actual client in order', async () => {
  const socket = new FakeSocket();
  const boot: LiveBoot = {
    url: 'wss://test/',
    home: 'wss://test/',
    factories: ['factory-a'],
    rewind: null,
    protocol: 'neon.realtime.v1',
    socket: socket as unknown as WebSocket,
    early: [JSON.stringify({ type: 'ready' }), JSON.stringify({ type: 'ping', token: 'early' })],
  };
  const seal = sealed('a');
  const item = observation('home-map', { queryFingerprint: seal.queryFingerprint });
  expectSubscribe(seal.capability, item);
  const client = createRealtimeClient({
    url: boot.url,
    webSocketFactory: markingSubscribes(earlySocketFactory(boot)),
  });
  try {
    const subscription = client.subscribe(seal);
    await Promise.resolve();
    expect(socket.sent.map((data) => JSON.parse(data).type)).toEqual(['subscribe', 'pong']);
    admit(socket);
    start(socket);
    end(socket);
    expect(subscription.getSnapshot().data).toEqual([]);
    expect(marks('home-map', 'first-result')).toHaveLength(1);
  } finally {
    client.close();
  }
});
