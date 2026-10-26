import { expect, test } from 'bun:test';
import { constants } from 'node:os';
import { PORT_FILE_NOT_WRITTEN_YET as retryCodes } from '../../harness/design-probe.js';
import { readDevToolsUrl } from './cdp';

test('Chrome port discovery waits for a partial file, then reads its published endpoint', () => {
  expect(readDevToolsUrl('port', () => '12345\n')).toBeUndefined();
  expect(readDevToolsUrl('port', () => '12345\n/devtools/browser/test\n')).toBe(
    'ws://127.0.0.1:12345/devtools/browser/test',
  );
});

test('Chrome port discovery conforms to the design probe retry classification', () => {
  const codes = new Set([...Object.keys(constants.errno), ...retryCodes, 'UNKNOWN', undefined]);
  for (const code of codes) {
    const error = Object.assign(new Error('cannot read port'), { code });
    const read = () =>
      readDevToolsUrl('port', () => {
        throw error;
      });
    if (code !== undefined && retryCodes.has(code)) {
      expect(read(), code).toBeUndefined();
    } else {
      expect(read, String(code)).toThrow(error);
    }
  }
});
