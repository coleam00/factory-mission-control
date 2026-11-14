import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { pinZone } from '../lib/pin-zone';
import type { TimelineEvent } from '../lib/work-item';
import Work from '../routes/f.$factory.work.$n';
import { WorkItemBody } from './WorkItem';

pinZone('America/Chicago');

function render(element: React.ReactElement): string {
  const router = createMemoryRouter([{ path: '/', element }]);
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const event = (over: Partial<TimelineEvent>): TimelineEvent => ({
  key: 'k',
  kind: 'round',
  at: new Date('2026-10-13T09:00:00Z'),
  tone: 'done',
  text: 'Round 1',
  detail: null,
  run: null,
  stage: null,
  stop: null,
  ...over,
});

const header = {
  number: 407,
  title: 'Queue issue 407',
  issueUrl: 'https://github.com/o/r/issues/407',
  latestRunHref: 'http://localhost:3090/console/r/abc',
};

test('the header links the issue, the pull request and the newest run, under the work item label', () => {
  const html = render(
    <WorkItemBody
      header={header}
      events={[]}
      note={null}
      board={{
        blocked: false,
        column: { id: 'merged', title: 'Merged', role: 'test', holder: 'done' },
        pr: 410,
        prUrl: 'https://github.com/o/r/pull/410',
        workOrders: ['screens'],
      }}
    />,
  );
  expect(html).toContain('work item #407');
  expect(html).toContain('href="https://github.com/o/r/issues/407"');
  expect(html).toContain('href="https://github.com/o/r/pull/410"');
  expect(html).toContain('PR #410');
  expect(html).toContain('Runs in console');
  expect(html).toContain('data-column="merged"');
  expect(html).toContain('screens');
});

test('rows come in the order given, with their reason, and a lap row links its lap page', () => {
  const html = render(
    <WorkItemBody
      header={header}
      board={null}
      note={null}
      events={[
        event({
          key: 'a',
          kind: 'decision',
          tone: 'failed',
          text: 'Merge gate refused: it changes .claude/settings.json',
          run: { id: 'r1', link: { kind: 'lap', to: '/f/f/runs/r1' } },
        }),
        event({ key: 'b', text: 'Round 2', detail: 'The reason.' }),
      ]}
    />,
  );
  expect(html.indexOf('Merge gate refused: it changes .claude/settings.json')).toBeLessThan(
    html.indexOf('Round 2'),
  );
  expect(html).toContain('data-tone="failed"');
  expect(html).toContain('href="/f/f/runs/r1"');
  expect(html).toContain('The reason.');
});

test('an address that is not a work item number names none, and asks no query', () => {
  const router = createMemoryRouter([{ path: '/f/:factory/work/:n', element: <Work /> }], {
    initialEntries: ['/f/f/work/4x'],
  });
  const html = renderToStaticMarkup(<RouterProvider router={router} />);
  expect(html).toContain('No work item #4x in this factory.');
});

test('the timeline says what it does not hold yet, even with no events', () => {
  const html = render(<WorkItemBody header={header} events={[]} board={null} note={null} />);
  expect(html).toContain('data-timeline-gap');
  expect(html).toContain('A gap here does not mean nothing happened');
});

test('the Manager note leads, a failed row shows its stop line, and the primary action opens the console', () => {
  const action = {
    kind: 'resume' as const,
    label: 'Resume from pr__prepare',
    href: 'http://localhost:3090/console/r/abc',
    runId: 'abc',
    step: 'pr__prepare',
    request: null,
    toast: { item: null, label: '' },
  };
  const html = render(
    <WorkItemBody
      header={header}
      board={null}
      note={{
        state: 'failed',
        pill: 'Failed',
        parts: [{ text: 'Round 1 failed', bold: true }, { text: ' at ' }],
        action,
      }}
      events={[
        event({
          tone: 'failed',
          text: 'Round 1 failed in Review',
          stop: { step: 'pr__prepare', line: '401 unauthorized' },
        }),
      ]}
    />,
  );
  expect(html.indexOf('data-manager-note')).toBeLessThan(html.indexOf('data-timeline'));
  expect(html).toContain('data-note-state="failed"');
  expect(html).toMatch(/data-stop-line[^>]*>.*pr__prepare.*401 unauthorized/);
  expect(html).toContain('data-primary-action="resume"');
  expect(html).toContain('href="http://localhost:3090/console/r/abc"');
  expect(html).toContain('Resume from pr__prepare');
});

test('the #630 timeline shows local times and splits days on the local date', () => {
  const html = render(
    <WorkItemBody
      header={header}
      board={null}
      note={null}
      events={[
        event({ key: 'a', kind: 'intake', at: new Date('2026-11-11T12:23:00Z') }),
        event({ key: 'b', kind: 'round', at: new Date('2026-11-12T04:40:00Z') }),
        event({ key: 'c', kind: 'decision', at: new Date('2026-11-12T13:29:00Z'), text: 'Merged' }),
      ]}
    />,
  );
  const times = [...html.matchAll(/<time[^>]*>([^<]*)<\/time>/g)].map((m) => m[1]);
  expect(times).toEqual(['Wed 06:23', '22:40', 'Thu 07:29']);
});
