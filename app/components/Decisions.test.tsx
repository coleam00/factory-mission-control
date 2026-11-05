import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { AttentionRow } from '../lib/attention';
import type { HealthRunRow, HealthStepRow } from '../lib/health';
import type { OwnerQueueRow } from '../lib/owner-queue';
import { CAPTION, FOOTER, HealthDrawn, sourceOf, WaitingItems } from './Decisions';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const RUN = '5eed0005-0000-4000-8000-000000000001';
const render = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

const attention: AttentionRow = {
  run_id: RUN,
  workflow_name: 'archon-build-queue',
  node_id: 'ask',
  waiting_since: new Date('2026-10-24T10:20:00Z'),
  form: 'select',
  options: JSON.stringify([
    { id: 'split', label: 'Split the issue in two' },
    { id: 'build', label: 'Build it as written' },
  ]),
  labels: '{"build":"scope"}',
  message: [
    '**Build queue, issue 15: scope decision**',
    '**What it is.** Issue 15 asks for two screens in one change.',
    '**Recommendation: `split`** (high confidence). Two small changes land sooner.',
  ].join('\n\n'),
  console: 'http://localhost:3090/',
};

const needsOwner: OwnerQueueRow = {
  kind: 'issue',
  issue_number: 13,
  question_number: null,
  title: 'The architecture diff',
  url: 'https://github.com/coleam00/factory-mission-control/issues/13',
  options: null,
  recommendation: null,
  default_option: null,
  default_at: null,
  waiting_since: new Date('2026-10-10T21:00:00Z'),
  approximate: false,
};

const waiting = render(<WaitingItems attention={[attention]} owner={[needsOwner]} now={NOW} />);

test('an attention item shows where it came from, its wait, its question and its choices', () => {
  expect(waiting).toContain('build: scope · Build queue, issue 15: scope decision · waiting');
  expect(waiting).toMatch(/data-waited="true"[^>]*>1h 40m</);
  expect(waiting).toContain('Issue 15 asks for two screens in one change.');
  expect(waiting).toContain('Split the issue in two');
});

test('only the recommended choice carries the violet recommended chip', () => {
  const split = waiting.match(/<li data-choice="split"[^>]*>(.*?)<\/li>/)?.[1] ?? '';
  const build = waiting.match(/<li data-choice="build"[^>]*>(.*?)<\/li>/)?.[1] ?? '';
  expect(split).toContain('data-recommended');
  expect(split).toContain('var(--role-person)');
  expect(build).not.toContain('data-recommended');
});

test('each attention panel links to its run in the console, and says where to answer', () => {
  expect(waiting).toContain(`href="http://localhost:3090/console/r/${RUN}"`);
  expect(waiting).toContain(FOOTER);
  expect(CAPTION).toBe(
    'Decisions the manager brought you, each with its recommended answer. You answer in the Archon console or Slack; this page only shows them.',
  );
});

test('an old-loop issue shows its number, title, wait and thread link, and no options', () => {
  const item = waiting.match(/<li data-owner-item="issue-13".*?<\/li>/s)?.[0] ?? '';
  expect(item).toContain('Needs owner · #13');
  expect(item).toContain('The architecture diff');
  expect(item).toMatch(/data-waited="true"[^>]*>13d /);
  expect(item).toContain('href="https://github.com/coleam00/factory-mission-control/issues/13"');
  expect(item).not.toContain('data-option');
  expect(item).not.toContain('px-4 py-3.5"></div>');
  expect(item).not.toContain('grid gap-3');
  expect(item).not.toContain('border-b border-border');
});

test('a card with options keeps its body under the header row', () => {
  const card = waiting.match(/<li data-attention-item=.*?<\/li><\/ul>.*?<\/li>/s)?.[0] ?? '';
  expect(card).toContain('data-choice');
  expect(card).toContain('grid gap-3');
  expect(card).toContain('border-b border-border');
});

test('nothing here is amber, and nothing here can answer', () => {
  expect(waiting).not.toContain('warning');
  expect(waiting).not.toMatch(/<(button|form|input|select|textarea)\b/);
});

test('with nothing waiting, one sentence says so', () => {
  expect(render(<WaitingItems attention={[]} owner={[]} now={NOW} />)).toContain(
    'Nothing is waiting on you.',
  );
});

const run = (overrides: Partial<HealthRunRow>): HealthRunRow => ({
  run_id: 'a',
  workflow_name: 'archon-loop',
  status: 'completed',
  started_at: null,
  completed_at: null,
  failed_step: null,
  error: null,
  failed_at: null,
  ...overrides,
});

test('when nothing is pending, paused, overdue or failed, the factory is healthy', () => {
  const html = render(
    <HealthDrawn
      runs={[run({})]}
      steps={[] as HealthStepRow[]}
      factory="mission-control"
      now={NOW}
    />,
  );
  expect(html).toContain('The factory is healthy.');
});

test('a paused run is drawn in the person color, not amber', () => {
  const html = render(
    <HealthDrawn
      runs={[run({ status: 'paused', started_at: new Date(NOW - 60_000) })]}
      steps={[]}
      factory="mission-control"
      now={NOW}
    />,
  );
  expect(html).not.toContain('The factory is healthy.');
  expect(html).toContain('var(--role-person)');
  expect(html).not.toContain('warning');
});

test('attention items in error leave the owner queue on screen with an unavailable notice', () => {
  const html = render(
    <WaitingItems
      attention={sourceOf([attention], 'error')}
      owner={sourceOf([needsOwner], 'ready')}
      now={NOW}
    />,
  );
  expect(html).toContain('Live data for what is waiting on you is unavailable.');
  expect(html).toContain('data-owner-item');
  expect(html).not.toContain('Nothing is waiting on you.');
});

test('an unavailable list never lets the screen claim nothing waits', () => {
  const html = render(<WaitingItems attention={[]} owner="unavailable" now={NOW} />);
  expect(html).toContain('Live data for the owner queue is unavailable.');
  expect(html).not.toContain('Nothing is waiting on you.');
});

test('a panel in error is unavailable even when it kept rows; no rows means loading', () => {
  expect(sourceOf([attention], 'error')).toBe('unavailable');
  expect(sourceOf(undefined, 'loading')).toBe('loading');
  const kept = [attention];
  expect(sourceOf(kept, 'ready')).toBe(kept);
});
