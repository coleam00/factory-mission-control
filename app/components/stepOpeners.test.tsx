import { expect, mock, test } from 'bun:test';
import type { ComponentProps, ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as router from 'react-router';
import { lapGraph } from '../lib/lap-graph';
import { type StepRow, stepOriginOf } from '../lib/step-detail';
import { allCards, FACTORY_MAP, selectOnArrival, selectState } from '../map/factory-map';

const RealLink = router.Link;

function RecordingLink(props: ComponentProps<typeof router.Link>) {
  links.push({ to: props.to, state: props.state });
  return <RealLink {...props} />;
}

// Server rendering cannot click, so each Link reports the state it would navigate with.
const links: { to: unknown; state: unknown }[] = [];
mock.module('react-router', () => ({
  ...router,
  Link: RecordingLink,
}));
const { Behind } = await import('./MapDetails');
const { StepPanel } = await import('./LapGraph');
const { LaneList } = await import('./Lanes');

const at = (element: ReactElement, url: string) =>
  renderToStaticMarkup(
    <router.RouterProvider
      router={router.createMemoryRouter([{ path: '*', element }], { initialEntries: [url] })}
    />,
  );

test("a card's Behind link opens the step with an origin that names the card it came from", () => {
  const card = allCards(FACTORY_MAP).find((c) => c.id === 'app');
  if (card === undefined) throw new Error('no app card');
  const steps = [
    { workflow: 'factory-app-check', path: 'check', kind: 'agent', include: null, model: null },
  ] as unknown as StepRow[];
  links.length = 0;
  at(<Behind card={card} factory="x" at={null} steps={steps} failed={false} />, '/f/x?view=app');
  const opened = links.find((l) => l.to === '/f/x/steps/factory-app-check/check');
  expect(stepOriginOf(opened?.state)).toEqual({
    href: '/f/x?view=app',
    label: `Factory / ${card.title}`,
    card: card.id,
  });
});

test("a lap's step definition link opens the step with the lap as its origin", () => {
  const lap = lapGraph(
    [
      {
        pin: 'v1',
        path: 'review',
        parent_path: null,
        position: 1,
        step_id: 'review',
        kind: 'prompt',
        depends_on: [],
      },
    ],
    [
      {
        step_id: 'review',
        status: 'completed',
        started_at: new Date('2026-10-25T12:00:00Z'),
        duration_ms: 1,
        model: null,
        tokens_input: null,
        tokens_output: null,
        tokens_cache_read: null,
        tokens_cache_write: null,
        cost_usd: null,
        outcome: null,
        error: null,
        position: null,
      },
    ],
    'x',
  );
  links.length = 0;
  at(<StepPanel lap={lap} path="review" now={0} onClose={() => {}} />, '/f/x/laps/abc');
  const opened = links.find((l) => String(l.to).includes('/steps/'));
  expect(stepOriginOf(opened?.state)).toEqual({ href: '/f/x/laps/abc', label: 'Laps / This lap' });
});

test("a Laps lane's step link opens the step with Laps as its origin", () => {
  const lane = {
    run_id: '5eed0003-0000-4000-8000-00000000000a',
    workflow_name: 'archon-loop',
    console: null,
    started_at: null,
    issue_number: 11,
    issue_title: null,
    route: 'simple',
    depth: 'normal',
    step_id: 'ship__intel',
    step_started_at: null,
    cost_usd: null,
    steps: ['ship__intel running'],
  };
  links.length = 0;
  at(<LaneList rows={[lane]} factory="x" now={0} />, '/f/x/laps');
  const opened = links.find((l) => l.to === '/f/x/steps/archon-loop/ship%2Fintel');
  expect(stepOriginOf(opened?.state)).toEqual({ href: '/f/x/laps', label: 'Laps' });
});

test('the map reads back the card a breadcrumb selects', () => {
  expect(selectOnArrival(selectState('app'))).toBe('app');
});
