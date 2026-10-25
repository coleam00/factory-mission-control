import { expect, test } from 'bun:test';
import { panelState } from './LivePanel';

test('a panel is loading until rows arrive', () => {
  expect(panelState({ data: undefined, error: undefined })).toBe('loading');
});

test('a panel with rows is ready, including retained rows while a renewal reconnects', () => {
  expect(panelState({ data: [], error: undefined })).toBe('ready');
  expect(panelState({ data: [{ running: 2 }], error: undefined })).toBe('ready');
});

test('a panel whose query reports an error is in error, rows or not', () => {
  const error = { code: 'upstream_rejected', message: 'unsupported query' };
  expect(panelState({ data: undefined, error })).toBe('error');
  expect(panelState({ data: [{ running: 2 }], error })).toBe('error');
});
