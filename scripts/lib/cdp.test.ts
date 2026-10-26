import { expect, test } from 'bun:test';
import { readDevToolsUrl } from './cdp';

test('Chrome port discovery waits for an absent, busy or partial file, then reads its published endpoint', () => {
  for (const code of ['ENOENT', 'EBUSY']) {
    expect(
      readDevToolsUrl('port', () => {
        throw Object.assign(new Error('opening port'), { code });
      }),
    ).toBeUndefined();
  }
  expect(readDevToolsUrl('port', () => '12345\n')).toBeUndefined();
  expect(readDevToolsUrl('port', () => '12345\n/devtools/browser/test\n')).toBe(
    'ws://127.0.0.1:12345/devtools/browser/test',
  );
});

test('Chrome port discovery does not suppress other filesystem failures', () => {
  for (const code of ['EACCES', 'EIO']) {
    const error = Object.assign(new Error('cannot read port'), { code });
    expect(() =>
      readDevToolsUrl('port', () => {
        throw error;
      }),
    ).toThrow(error);
  }
});
