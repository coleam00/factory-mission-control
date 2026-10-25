import { afterEach, describe, expect, test } from 'bun:test';
import type { WebSocketLike } from '@neon/realtime/client';
import { expectSubscribe, markingSubscribes } from './subscribe-marks';

function fakeSocket(sent: string[]): WebSocketLike {
  return {
    readyState: 1,
    addEventListener: () => undefined,
    send: (data) => sent.push(data),
    close: () => undefined,
  };
}

const subscribe = (capability: string, id = '1') =>
  JSON.stringify({ type: 'subscribe', request_id: id, authorization: capability });

const marks = (query: string) => performance.getEntriesByName(`live:${query}:subscribe-sent`);

afterEach(() => performance.clearMarks());

describe('markingSubscribes', () => {
  test("marks a panel's subscribe when it is sent, and passes every frame through unchanged", () => {
    const sent: string[] = [];
    const socket = markingSubscribes(() => fakeSocket(sent))('wss://x/', 'p');
    expectSubscribe('cap-map', 'home-map');
    expectSubscribe('cap-strip', 'factory-strip');

    socket.send('{"type":"pong","token":"t"}');
    expect(marks('home-map')).toHaveLength(0);
    socket.send(subscribe('cap-map'));
    expect(marks('home-map')).toHaveLength(1);
    expect(marks('factory-strip')).toHaveLength(0);
    socket.send(subscribe('cap-strip', '2'));
    expect(marks('factory-strip')).toHaveLength(1);
    expect(sent).toEqual([
      '{"type":"pong","token":"t"}',
      subscribe('cap-map'),
      subscribe('cap-strip', '2'),
    ]);
  });

  test('a later subscribe for the same panel (a resubscribe or an unknown capability) adds no mark', () => {
    const socket = markingSubscribes(() => fakeSocket([]))('wss://x/', 'p');
    expectSubscribe('cap-a', 'version-strip');
    socket.send(subscribe('cap-a'));
    socket.send(subscribe('cap-a', '2'));
    socket.send(subscribe('cap-unknown', '3'));
    expect(marks('version-strip')).toHaveLength(1);
  });

  test('no mark name carries the capability', () => {
    const socket = markingSubscribes(() => fakeSocket([]))('wss://x/', 'p');
    expectSubscribe('secret-capability', 'home-map');
    socket.send(subscribe('secret-capability'));
    expect(performance.getEntriesByType('mark').map((m) => m.name)).toEqual([
      'live:home-map:subscribe-sent',
    ]);
  });
});
