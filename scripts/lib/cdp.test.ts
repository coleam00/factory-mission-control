import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PORT_FILE_NOT_WRITTEN_YET as retryCodes } from '../../harness/design-probe.js';
import { readDevToolsUrl, startBrowser } from './cdp';

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

function fakeLaunches(opens: boolean[], exits = false) {
  const log: string[] = [];
  const launch = () => {
    const n = log.filter((entry) => entry.startsWith('launch')).length;
    log.push(`launch ${n}`);
    const profile = mkdtempSync(join(tmpdir(), 'mc-cdp-test-'));
    if (opens[n]) {
      writeFileSync(join(profile, 'DevToolsActivePort'), '12345\n/devtools/browser/x\n');
    }
    return {
      profile,
      exited: () => exits,
      stop: async () => {
        log.push(`stop ${n}`);
      },
    };
  };
  return { launch, log };
}

test('a browser that misses the port wait is replaced by a fresh launch', async () => {
  const { launch, log } = fakeLaunches([false, true]);
  const { url } = await startBrowser(launch, 300);
  expect(url).toBe('ws://127.0.0.1:12345/devtools/browser/x');
  expect(log).toEqual(['launch 0', 'stop 0', 'launch 1']);
});

test('a browser that never opens its port fails with the same error after both launches', async () => {
  const { launch, log } = fakeLaunches([false, false]);
  const started = Date.now();
  await expect(startBrowser(launch, 300)).rejects.toThrow(
    'the browser did not open its DevTools port within 0.3s',
  );
  expect(log).toEqual(['launch 0', 'stop 0', 'launch 1', 'stop 1']);
  expect(Date.now() - started).toBeLessThan(1500);
});

test('a browser that exits is not relaunched', async () => {
  const { launch, log } = fakeLaunches([false, true], true);
  await expect(startBrowser(launch, 300)).rejects.toThrow(
    'the browser exited before opening its DevTools port',
  );
  expect(log).toEqual(['launch 0', 'stop 0']);
});
