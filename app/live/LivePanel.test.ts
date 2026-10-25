import { expect, test } from 'bun:test';
import { panelState } from './LivePanel';

test('a panel is loading until rows arrive', () => {
  expect(panelState({ status: 'connecting', data: undefined, error: undefined })).toBe('loading');
});

test('a panel with rows is ready, including retained rows while a renewal reconnects', () => {
  expect(panelState({ status: 'live', data: [], error: undefined })).toBe('ready');
  expect(panelState({ status: 'live', data: [{ running: 2 }], error: undefined })).toBe('ready');
  expect(panelState({ status: 'connecting', data: [{ running: 2 }], error: undefined })).toBe(
    'ready',
  );
});

test('a panel whose seal expired with no replacement is in error, not ready with old rows', () => {
  expect(panelState({ status: 'stale', data: [{ running: 4 }], error: undefined })).toBe('error');
  expect(panelState({ status: 'stale', data: undefined, error: undefined })).toBe('error');
});

test('a panel whose query reports an error is in error, rows or not', () => {
  const error = { code: 'upstream_rejected', message: 'unsupported query' };
  expect(panelState({ status: 'error', data: undefined, error })).toBe('error');
  expect(panelState({ status: 'error', data: [{ running: 2 }], error })).toBe('error');
});
