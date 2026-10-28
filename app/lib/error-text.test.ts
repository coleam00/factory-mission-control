import { expect, test } from 'bun:test';
import { errorHeadline } from './error-text';

const THROWN =
  'gh pr view failed: no pull requests found for branch "https://github.com/coleam00/factory-mission-control/issues/197"';

/** A script node's failure as Archon recorded it on a real lap (#197's subject step). */
const SCRIPT_FAILURE = [
  "Script node 'subject' failed [exit 1]: 16 | const chosen = trimmed(input.pr);",
  '17 | const reports = trimmed(input.builder);',
  '18 |',
  '19 | function gh(args: string[]): unknown {',
  "20 |   const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });",
  '21 |   if (result.exitCode !== 0) throw new Error(String(result.stderr));',
  '                                       ^',
  `error: ${THROWN}`,
  '      at gh (C:\\Users\\colem\\.archon\\workspaces\\loop\\scripts\\subject.ts:21:40)',
  '      at C:\\Users\\colem\\.archon\\workspaces\\loop\\scripts\\subject.ts:30:3',
].join('\n');

test('a script failure leads with its thrown message, and says there is more', () => {
  expect(errorHeadline(SCRIPT_FAILURE)).toEqual({ headline: THROWN, more: true });
});

test('the same failure flattened onto one line still finds the thrown message', () => {
  expect(errorHeadline(SCRIPT_FAILURE.replaceAll('\n', ' ')).headline).toBe(THROWN);
});

test('with no thrown message, the first line that is not source or a stack frame', () => {
  expect(errorHeadline('12 | x()\n   ^\nbuild exited 1\n    at main (a.ts:1:1)')).toEqual({
    headline: 'build exited 1',
    more: true,
  });
});

test('a one-line error is shown whole, with nothing more to show', () => {
  expect(errorHeadline('429 usage limit reached')).toEqual({
    headline: '429 usage limit reached',
    more: false,
  });
});
