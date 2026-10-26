import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { readDevToolsUrl } from './cdp';

test('Chrome port discovery waits for a partial file, then reads its published endpoint', () => {
  expect(readDevToolsUrl('port', () => '12345\n')).toBeUndefined();
  expect(readDevToolsUrl('port', () => '12345\n/devtools/browser/test\n')).toBe(
    'ws://127.0.0.1:12345/devtools/browser/test',
  );
});

test('Chrome port discovery conforms to the design probe retry classification', () => {
  // The harness owns this contract but is human-edit-only and does not export its retry set.
  const harness = readFileSync(new URL('../../harness/design-probe.js', import.meta.url), 'utf8');
  const declaration = harness.match(
    /const PORT_FILE_NOT_WRITTEN_YET\s*=\s*new Set\(\[\s*((?:['"]E[A-Z0-9_]+['"]\s*,?\s*)+)\]\)/,
  );
  if (!declaration) throw new Error('cannot read the design probe port-file retry contract');
  const retryCodes = new Set(declaration[1].match(/E[A-Z0-9_]+/g));
  const liveSource = readFileSync(new URL('./cdp.ts', import.meta.url), 'utf8');
  const codes = new Set([
    ...Object.keys(constants.errno),
    ...retryCodes,
    ...Array.from(liveSource.matchAll(/['"](E[A-Z0-9_]+)['"]/g), (match) => match[1]),
    'UNKNOWN',
    undefined,
  ]);
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
