import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { TimelineEvent } from '../lib/work-item';
import Work from '../routes/f.$factory.work.$n';
import { WorkItemBody } from './WorkItem';

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
      board={{
        column: { id: 'merged', title: 'Merged', role: 'test' },
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
      events={[
        event({
          key: 'a',
          kind: 'decision',
          tone: 'failed',
          text: 'Merge gate refused: it changes .claude/settings.json',
          run: { id: 'r1', link: { kind: 'lap', to: '/f/f/laps/r1' } },
        }),
        event({ key: 'b', text: 'Round 2', detail: 'The reason.' }),
      ]}
    />,
  );
  expect(html.indexOf('Merge gate refused: it changes .claude/settings.json')).toBeLessThan(
    html.indexOf('Round 2'),
  );
  expect(html).toContain('data-tone="failed"');
  expect(html).toContain('href="/f/f/laps/r1"');
  expect(html).toContain('The reason.');
});

test('an address that is not a work item number names none, and asks no query', () => {
  const router = createMemoryRouter([{ path: '/f/:factory/work/:n', element: <Work /> }], {
    initialEntries: ['/f/f/work/4x'],
  });
  const html = renderToStaticMarkup(<RouterProvider router={router} />);
  expect(html).toContain('No work item #4x in this factory.');
});
