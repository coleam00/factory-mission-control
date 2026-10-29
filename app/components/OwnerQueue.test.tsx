import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OwnerQueueRow } from '../lib/owner-queue';
import { OwnerList } from './OwnerQueue';

const ISSUES = 'https://github.com/coleam00/factory-mission-control/issues';

const issue: OwnerQueueRow = {
  kind: 'issue',
  issue_number: 13,
  question_number: null,
  title: 'The architecture diff',
  url: `${ISSUES}/13`,
  options: null,
  recommendation: null,
  default_option: null,
  default_at: null,
  waiting_since: new Date('2026-10-10T21:00:00Z'),
  approximate: false,
};

const question: OwnerQueueRow = {
  kind: 'question',
  issue_number: 17,
  question_number: 2,
  title: 'Should the lanes panel show finished laps for an hour?',
  url: `${ISSUES}/17`,
  options: '[{"key": "A", "text": "yes, faded"}, {"key": "B", "text": "no, only running laps"}]',
  recommendation: 'A, so a merge that just happened is still visible.',
  default_option: 'A',
  default_at: new Date('2026-10-27T14:00:00Z'),
  waiting_since: new Date('2026-10-23T09:00:00Z'),
  approximate: false,
};

const NOW = Date.parse('2026-10-27T10:30:00Z');
const html = renderToStaticMarkup(<OwnerList rows={[question, issue]} now={NOW} />);

test('lists each item longest-waiting first, each linking to its GitHub thread', () => {
  expect(html.indexOf('data-owner-item="issue-13"')).toBeLessThan(
    html.indexOf('data-owner-item="question-17-2"'),
  );
  const links = [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1]);
  expect(links).toEqual([`${ISSUES}/13`, `${ISSUES}/17`]);
});

test('a question shows its options, recommendation, default, the date it applies and its wait', () => {
  expect(html).toContain('data-option="A"');
  expect(html).toContain('yes, faded');
  expect(html).toContain('no, only running laps');
  expect(html).toContain('A, so a merge that just happened is still visible.');
  expect(html).toContain('data-default-option="true">A<');
  expect(html).toContain('2026-10-27 14:00 UTC');
  expect(html).toContain('in 3h 30m');
  // Raised 2026-10-23 09:00, now 2026-10-27 10:30: the browser's clock gives the wait.
  expect(html).toContain('data-waited="true">4d 1h<');
});

test('a needs-owner issue shows how long it has waited since it was labelled', () => {
  expect(html).toContain('data-waited="true">16d 13h<');
  expect(html).toContain('title="Since the issue was labelled needs-owner"');
  expect(html).not.toContain('Approximate');
});

test('only an issue whose label time is not recorded says its wait is approximate', () => {
  const approximate = renderToStaticMarkup(
    <OwnerList rows={[question, { ...issue, approximate: true }]} now={NOW} />,
  );
  expect(approximate).toContain('data-approximate="true"');
  expect(approximate.match(/title="Approximate: since the issue was last updated/g)).toHaveLength(
    1,
  );
  expect(approximate).toContain('title="Since the question was raised"');
});

test('a default whose date has passed says how long ago it applied', () => {
  const passed = renderToStaticMarkup(
    <OwnerList rows={[question]} now={Date.parse('2026-10-28T15:00:00Z')} />,
  );
  expect(passed).toContain('1d 1h ago');
});

test('a question without a mirrored issue shows its number and no link', () => {
  const unlinked = renderToStaticMarkup(
    <OwnerList rows={[{ ...question, url: null }]} now={NOW} />,
  );
  expect(unlinked).not.toContain('<a ');
  expect(unlinked).toContain('#17');
});

test('the screen has no form and no button: it answers nothing, links open GitHub', () => {
  expect(html).not.toMatch(/<(form|button|input|select|textarea)\b/i);
  const sources = ['components/OwnerQueue.tsx', 'routes/f.$factory.owner.tsx'].map((file) =>
    readFileSync(join(import.meta.dir, '..', file), 'utf8'),
  );
  for (const source of sources) {
    expect(source).not.toMatch(/<(form|button|input|select|textarea)\b|fetch\(|onClick|onSubmit/);
  }
});

test('a question with no default says so in one plain sentence, with no countdown', () => {
  const open = renderToStaticMarkup(
    <OwnerList rows={[{ ...question, default_option: null, default_at: null }]} now={NOW} />,
  );
  expect(open).toContain('No default: this waits for the owner.');
  expect(open).not.toContain('applies');
  expect(open).not.toContain('data-default-option="true">');
  expect(open).not.toContain('bg-warning"');
});
