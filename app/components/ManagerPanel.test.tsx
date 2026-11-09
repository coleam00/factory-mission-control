import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { managerPlace, type ManagerMessage, type ManagerReply, reply } from '../lib/manager';
import { ManagerPanelBody } from './ManagerPanel';

const RUN = '5eed0001-0000-4000-8000-0000000000a1';
const place = managerPlace('/f/x', new URLSearchParams(), '7 items');

const render = (messages: ManagerMessage[], enabled = true, factory: string | null = 'x') =>
  renderToStaticMarkup(
    <ManagerPanelBody
      phone={false}
      onClose={() => {}}
      chat={{ messages, busy: false }}
      place={place}
      factory={factory ?? undefined}
      enabled={enabled}
    />,
  );

test('the panel has the head, the chip, the suggestions, the box and Send the design binds', () => {
  const html = render([]);
  expect(html).toContain('Watches every run and queue for you');
  expect(html).toContain('aria-label="Close the Manager"');
  expect(html).toContain('Looking at');
  expect(html).toContain('Attention · 7 items');
  expect(html.match(/data-suggestion/g)).toHaveLength(3);
  expect(html).toContain('placeholder="Ask about any run, or tell me what to do"');
  expect(html).toContain('>Send</button>');
});

test('the panel is never blank: a briefing being written, a notice and an unknown factory all say something', () => {
  expect(render([reply('briefing')])).toContain('Writing today&#x27;s briefing.');
  const capped: ManagerReply = {
    ...reply('answer', '', 'done'),
    notices: ['The Manager has reached today’s cost cap.'],
  };
  expect(render([capped])).toContain('reached today’s cost cap');
  const nothing = render([], true, null);
  expect(nothing).toContain('names no factory');
  expect(nothing).not.toContain('data-suggestion');
});

const answer: ManagerReply = {
  ...reply('answer', `Run ${RUN.slice(0, 8)} failed at implement.`, 'done'),
  links: [{ type: 'link', kind: 'run', id: RUN, label: 'run', href: `/f/x/runs/${RUN}` }],
  runs: [
    {
      run_id: RUN,
      workflow_name: 'archon-loop',
      status: 'failed',
      started_at: '2026-11-09T08:00:00Z',
      completed_at: null,
      href: `/f/x/runs/${RUN}`,
    },
  ],
  proposals: [
    {
      type: 'proposal',
      label: 'Resume',
      factory: 'x',
      action: 'resume',
      run_id: RUN,
      from_step: null,
    },
  ],
};

test('a run list draws one row per run, and a proposal is a button only when the server holds an operator', () => {
  const html = render([answer]);
  expect(html.match(/data-run-row=/g)).toHaveLength(1);
  expect(html).toContain(`data-run-link="${RUN}"`);
  expect(html).toMatch(/<button[^>]*data-proposal="resume"[^>]*>Resume<\/button>/);
  const without = render([answer], false);
  expect(without).not.toContain('data-proposal');
  expect(without).toContain('Open run 5eed0001');
});
