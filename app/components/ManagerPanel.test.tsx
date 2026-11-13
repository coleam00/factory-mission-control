import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { managerPlace, type ManagerMessage, type ManagerReply, reply } from '../lib/manager';
import { ManagerPanelBody } from './ManagerPanel';

const RUN = '5eed0001-0000-4000-8000-0000000000a1';
const place = managerPlace('/f/x', new URLSearchParams(), '7 items');

const render = (
  messages: ManagerMessage[],
  enabled = true,
  factory: string | null = 'x',
  loginMissing = false,
) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <ManagerPanelBody
        phone={false}
        onClose={() => {}}
        chat={{ messages, busy: false }}
        place={place}
        factory={factory ?? undefined}
        enabled={enabled}
        loginMissing={loginMissing}
      />
    </MemoryRouter>,
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
  links: [{ type: 'link', kind: 'run', id: RUN, href: `/f/x/runs/${RUN}` }],
  runs: [
    {
      run_id: RUN,
      workflow_name: 'factory-manager',
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
  expect(html).toMatch(/<button[^>]*data-proposal="resume"[^>]*>Resume 5eed0001<\/button>/);
  const OTHER = '5eed0002-0000-4000-8000-0000000000b2';
  const answers: ManagerReply = {
    ...answer,
    proposals: [
      {
        type: 'proposal',
        factory: 'x',
        action: 'answer',
        run_id: RUN,
        occurrence: 'o1',
        option: 'yes',
        text: null,
        label: 'Answer "Yes"',
        detail: 'Yes',
      },
      {
        type: 'proposal',
        factory: 'x',
        action: 'answer',
        run_id: OTHER,
        occurrence: 'o2',
        option: 'yes',
        text: null,
        label: 'Answer "Yes"',
        detail: 'Yes',
      },
      {
        type: 'proposal',
        factory: 'x',
        action: 'answer',
        run_id: RUN,
        occurrence: 'o1',
        option: null,
        text: 'ship it',
        label: 'Answer with your text',
      },
    ],
  };
  const buttons = render([answers]).match(/<button[^>]*data-proposal[^>]*>[^<]*<\/button>/g) ?? [];
  expect(buttons.map((b) => b.replace(/<[^>]*>/g, ''))).toEqual([
    'Answer &quot;Yes&quot; 5eed0001',
    'Answer &quot;Yes&quot; 5eed0002',
    'Answer “ship it” 5eed0001',
  ]);
  const without = render([answer], false);
  expect(without).not.toContain('data-proposal');
  expect(without).toContain('Open run 5eed0001');
});

test('an item-keyed proposal is a button with no run suffix, and an Open #N link without an operator', () => {
  const items: ManagerReply = {
    ...answer,
    proposals: [
      { type: 'proposal', factory: 'x', action: 'retriage', number: 42, label: 'Re-triage #42' },
    ],
  };
  const html = render([items]);
  expect(html).toMatch(/<button[^>]*data-proposal="retriage"[^>]*>Re-triage #42<\/button>/);
  const without = render([items], false);
  expect(without).not.toContain('data-proposal');
  expect(without).toMatch(/<a [^>]*href="[^"]*42[^"]*"[^>]*>Open #42<\/a>/);
});

test('a comment proposal shows its quoted text, and re-triage and comment become links without a login', () => {
  const text = 'Both blockers shipped, so this can go back through triage today';
  const items: ManagerReply = {
    ...answer,
    proposals: [
      { type: 'proposal', factory: 'x', action: 'retriage', number: 42, label: 'Re-triage #42' },
      { type: 'proposal', factory: 'x', action: 'close', number: 42, label: 'Close #42' },
      {
        type: 'proposal',
        factory: 'x',
        action: 'comment',
        number: 42,
        text,
        label: 'Comment on #42, then re-triage',
      },
    ],
  };
  const buttons = (html: string) =>
    (html.match(/<button[^>]*data-proposal[^>]*>[^<]*<\/button>/g) ?? []).map((b) =>
      b.replace(/<[^>]*>/g, ''),
    );
  expect(buttons(render([items]))).toEqual([
    'Re-triage #42',
    'Close #42',
    `Comment on #42, then re-triage: “${text.slice(0, 40)}…”`,
  ]);
  const noLogin = render([items], true, 'x', true);
  expect(buttons(noLogin)).toEqual(['Close #42']);
  const links = (noLogin.match(/<a [^>]*>[^<]*<\/a>/g) ?? []).map((a) => a.replace(/<[^>]*>/g, ''));
  expect(links.filter((l) => l.startsWith('Open #'))).toEqual([
    'Open #42: Re-triage #42, which needs the operator’s `login`',
    `Open #42: Comment on #42, then re-triage: “${text.slice(0, 40)}…”, which needs the operator’s \`login\``,
  ]);
});

test('bold that opens in one list item and closes in the next shows no ** and stays out of both', () => {
  const text = '1. **Build-queue failures on issue #522\n2. keep recurring.** Fix the gate.';
  const html = render([
    {
      ...reply('briefing', text, 'done'),
      links: [{ type: 'link', kind: 'item', id: 522, href: '/f/x/work/522' }],
    },
  ]);
  expect(html).not.toContain('**');
  expect(html).toContain('<ol');
  expect(html.match(/<li/g)).toHaveLength(2);
  expect(html).not.toContain('<b>');
});

test('an issue link reads #N and not the title', () => {
  const html = render([
    {
      ...reply('answer', 'See #514.', 'done'),
      links: [
        {
          type: 'link',
          kind: 'item',
          id: 514,
          href: '/f/x/work/514',
        },
      ],
    },
  ]);
  expect(html).toContain('href="/f/x/work/514"');
  expect(html).toContain('>#514</a>');
  expect(html).not.toContain('Manager backend');
});

test('the briefing link to Runs > Failures renders as an anchor to that view', () => {
  const html = render([
    reply('briefing', 'See [Runs > Failures](/f/x/runs?view=failures).', 'done'),
  ]);
  expect(html).toContain('href="/f/x/runs?view=failures"');
  expect(html).toMatch(/<a [^>]*><span>Runs &gt; Failures<\/span><\/a>/);
});
