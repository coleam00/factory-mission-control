import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { parsePack, type Step } from '../../parsers/pack';
import { Behind, MapDetails, RightNow } from '../components/MapDetails';
import type { StepRow } from '../lib/step-detail';
import { FACTORY_MAP, workflowFile } from '../map/factory-map';
import type { HomeMapRow, MapSources } from '../map/live';
import { HomeMapBody, msToLocalMidnight } from './index';

const REPO = join(import.meta.dir, '..', '..');

const render = (
  map: HomeMapRow[] | undefined,
  state: 'loading' | 'ready' | 'error',
  {
    at = null,
    configured,
    path,
    ...more
  }: { at?: string | null; configured?: boolean; path?: string[] } & Omit<MapSources, 'map'> = {},
) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <HomeMapBody
        sources={{ map, ...more }}
        state={state}
        factory="here"
        at={at}
        configured={configured}
        path={path}
        flow
      />
    </MemoryRouter>,
  );

const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').trim();

test('loading, error, no factory and an unrecorded version are each one sentence and no button', () => {
  for (const [html, text] of [
    [render(undefined, 'loading'), 'Loading the factory map.'],
    [render(undefined, 'error'), 'Live data is unavailable.'],
    [render(undefined, 'ready', { configured: false }), 'No factory is configured.'],
    [
      render([], 'ready', { at: 'not-a-pin' }),
      'No version not-a-pin is recorded for this factory.',
    ],
  ] as const) {
    expect(textOf(html)).toBe(text);
    expect(html).not.toMatch(/<button\b/);
  }
});

const lap = (run: string, step: string): HomeMapRow => ({
  kind: 'lap',
  run_id: run,
  workflow: 'archon-loop',
  steps: [step],
  number: null,
  title: null,
  url: null,
  at: null,
  prs: null,
});

const cardTag = (html: string, id: string) =>
  html.match(new RegExp(`<div [^>]*data-card="${id}"[^>]*>`))?.[0] ?? '';

test("the map draws every card's wording, the caption, the group and the legend, whatever the data", () => {
  const html = render([], 'ready');
  expect(html).toContain(FACTORY_MAP.caption.replaceAll("'", '&#x27;'));
  for (const card of FACTORY_MAP.cards) {
    const tag = cardTag(html, card.id);
    expect(tag).toContain('role="button"');
    expect(tag).toContain('tabindex="0"');
    expect(tag).toContain('data-live-count="0"');
    expect(html).toContain(`>${card.kind}<`);
    expect(html).toContain(`>${card.title}<`);
  }
  expect(html).toContain('the manager watches everything on this line');
  for (const entry of FACTORY_MAP.legend) expect(html).toContain(entry.label);
  // Only Build, Review, Split, Intake, Merge and Staging have a deeper view, so only they offer to open one.
  const opens = ['build', 'review', 'split', 'intake', 'merge', 'deploy'];
  for (const id of opens) expect(cardTag(html, id)).toContain(`data-opens="${id}"`);
  expect(html).toContain('opens a deeper view');
  for (const card of FACTORY_MAP.cards.filter((c) => !opens.includes(c.id))) {
    expect(cardTag(html, card.id)).not.toContain('data-opens');
  }
  expect(html).not.toContain('data-chip');
});

test("with path ['build'] the map draws the Build view's cards, caption and crumbs", () => {
  const view = FACTORY_MAP.views?.build;
  if (view === undefined) throw new Error('the map has no build view');
  const html = render([lap('a', 'build')], 'ready', { path: ['build'] });
  for (const card of view.cards) expect(cardTag(html, card.id)).toContain('data-card');
  expect(html).toContain(view.caption.replaceAll("'", '&#x27;'));
  expect(html).toContain('data-view="build"');
  expect(textOf(html).replace(/\s+/g, ' ')).toContain('here › Build');
  expect(cardTag(html, 'b-del')).toContain('data-live-count="1"');
  expect(cardTag(html, 'build')).toBe('');
});

test.each([
  ['merge', 6, 'm-sweep', 'archon-merge-queue', 'sweep'],
  ['deploy', 3, 'y-ver', 'factory-deploy', 'verify'],
])(
  "with path ['%s'] the map draws that view's cards and a running step counts on its card",
  (id, cards, here, workflow, step) => {
    const view = FACTORY_MAP.views?.[id];
    if (view === undefined) throw new Error(`the map has no ${id} view`);
    const html = render([{ ...lap('a', step), workflow }], 'ready', { path: [id] });
    expect(view.cards).toHaveLength(cards);
    for (const card of view.cards) expect(cardTag(html, card.id)).toContain('data-card');
    expect(html).toContain(view.caption.replaceAll("'", '&#x27;'));
    expect(html).toContain(`data-view="${id}"`);
    expect(cardTag(html, here)).toContain('data-live-count="1"');
  },
);

test('Right now lists the gate outcomes, the latest deploy or that there is none, and where each work order lands', () => {
  const rightNow = (live: Parameters<typeof RightNow>[0]['live']) =>
    textOf(
      renderToStaticMarkup(
        <MemoryRouter>
          <RightNow live={live} factory="here" />
        </MemoryRouter>,
      ),
    ).replace(/\s+/g, ' ');
  const gate = rightNow({
    here: [],
    gate: [
      {
        run: 'r',
        number: 9,
        outcome: 'sweep: sent back',
        reason: 'conflicts with main',
        url: 'https://github.com/o/r/pull/9',
        at: null,
      },
    ],
  });
  expect(gate).toContain('#9 sweep: sent back conflicts with main');
  expect(rightNow({ here: [], gate: [] })).toContain(
    'No gate decision is recorded for this factory yet.',
  );
  const order = (lands_on: string | null) => ({
    name: 'combat',
    total_count: 1,
    open_count: 1,
    merged_count: 0,
    lands_on,
    last_closed_at: null,
  });
  const staged = rightNow({ here: [], deploy: null, lands: [order('staging'), order(null)] });
  expect(staged).toContain('This factory has never deployed.');
  expect(staged).toContain('combat lands on staging');
  expect(staged).toContain('combat names no target yet');
  const deployed = rightNow({
    here: [],
    deploy: {
      run: 'd',
      revision: 'abcdef0123',
      health: 'healthy',
      verified: true,
      readBack: true,
      at: null,
    },
  });
  expect(deployed).toContain('abcdef0 is deployed, healthy, and its revision read back');
  const unread = rightNow({
    here: [],
    deploy: {
      run: 'd',
      revision: 'abcdef0123',
      health: 'healthy',
      verified: true,
      readBack: false,
      at: null,
    },
  });
  expect(unread).toContain('abcdef0 is deployed, healthy, and its revision not read back');
  const failed = rightNow({
    here: [],
    deploy: { run: 'd', revision: null, health: null, verified: false, readBack: false, at: null },
  });
  expect(failed).toContain('no revision : the last deploy failed, health not reported');
  expect(rightNow({ here: [], listsUnavailable: ['outcomes', 'deploys', 'lands'] })).toContain(
    'The latest deploy is unavailable.',
  );
});

test('a card that opens a view offers ⤢ Open Build · 8 steps', () => {
  const build = FACTORY_MAP.cards.find((c) => c.id === 'build');
  if (build === undefined) throw new Error('no build card');
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <MapDetails
        card={build}
        live={undefined}
        factory="here"
        at={null}
        steps={undefined}
        onClose={() => {}}
        open={{ title: 'Build', steps: 8, onOpen: () => {} }}
      />
    </MemoryRouter>,
  );
  expect(textOf(html)).toContain('⤢ Open Build · 8 steps');
});

test('a card with laps on it carries their count and a pulsing chip; a chip of 0 is not drawn', () => {
  const html = render([lap('a', 'check-app'), lap('b', 'evidence'), lap('c', 'build')], 'ready', {
    workable: [],
  });
  expect(cardTag(html, 'app')).toContain('data-live-count="2"');
  expect(cardTag(html, 'app')).toContain(
    'aria-label="App check. Tries the change in the running app. 2 here"',
  );
  expect(cardTag(html, 'build')).toContain('data-live-count="1"');
  expect(cardTag(html, 'review')).toContain('data-live-count="0"');
  expect(html.match(/data-chip="here"/g)).toHaveLength(2);
  expect(html).not.toContain('data-chip="queued"');
});

test('queued, failing, waiting and merged chips sit on Build, App check, the Manager and Shipped', () => {
  const now = new Date(2026, 10, 3, 12);
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <HomeMapBody
        sources={{
          map: [
            {
              kind: 'failing',
              run_id: null,
              workflow: null,
              steps: null,
              number: 4,
              title: 't',
              url: null,
              at: null,
              prs: null,
            },
            {
              kind: 'merged',
              run_id: 'm',
              workflow: 'archon-loop',
              steps: null,
              number: 1,
              title: null,
              url: null,
              at: new Date(2026, 10, 3, 9),
              prs: null,
            },
          ],
          workable: [{ kind: 'issue', issue_number: 2, title: 'w', url: null, run_id: null }],
          owner: [
            {
              kind: 'issue',
              issue_number: 8,
              question_number: null,
              title: 'o',
              url: null,
              options: null,
              recommendation: null,
              default_option: null,
              default_at: null,
              waiting_since: null,
              approximate: true,
            },
          ],
        }}
        state="ready"
        factory="here"
        at={null}
        flow
        now={now}
      />
    </MemoryRouter>,
  );
  const chipOn = (id: string) => {
    const start = html.indexOf(`data-card="${id}"`);
    const end = html.indexOf('data-card=', start + 1);
    return [...html.slice(start, end).matchAll(/data-chip="(\w+)"[^>]*>([^<]*)</g)].map(
      (m) => `${m[1]} ${m[2]}`,
    );
  };
  expect(chipOn('build')).toEqual(['queued 1 queued']);
  expect(chipOn('app')).toEqual(['failing 1 failing']);
  expect(chipOn('mgr')).toEqual(['waiting 1 waiting']);
  expect(chipOn('out')).toEqual(['merged 1 merged']);
  expect(html).not.toMatch(/warning|amber/);
});

test('with the flow off there is no travelling dot and no flowing dashes', () => {
  const on = render([], 'ready');
  expect(on).toContain('data-tour');
  expect(on).toContain('<path data-flow="true"');
  const off = renderToStaticMarkup(
    <MemoryRouter>
      <HomeMapBody sources={{ map: [] }} state="ready" factory="here" at={null} flow={false} />
    </MemoryRouter>,
  );
  expect(off).not.toContain('data-tour');
  expect(off).not.toContain('<path data-flow="true"');
  expect(off).toContain('data-flow="off"');
});

/** Every step id in the pinned pack, at every depth. */
function stepIds(): Set<string> {
  const pack = parsePack(
    join(REPO, 'fixtures', 'pack', 'sdlc'),
    join(REPO, 'fixtures', 'factory-template'),
  );
  const ids = new Set<string>();
  const walk = (steps: Step[]) => {
    for (const s of steps) {
      ids.add(s.id);
      walk(s.steps);
    }
  };
  for (const workflow of pack.workflows) walk(workflow.steps);
  return ids;
}

test('the map code names no step: what each card covers lives in factory-map.json alone', () => {
  const ids = stepIds();
  expect(ids.has('check-app')).toBe(true);
  for (const file of [
    'app/routes/index.tsx',
    'app/components/FactoryMap.tsx',
    'app/components/MapDetails.tsx',
    'app/map/factory-map.ts',
    'app/map/live.ts',
  ]) {
    const source = readFileSync(join(REPO, file), 'utf8');
    const literals = [
      ...source.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`([^`]*)`|>([^<>{}]+)</g),
    ].map((m) => (m[1] ?? m[2] ?? m[3] ?? m[4]).trim());
    expect(literals.length).toBeGreaterThan(0);
    const named = literals.filter((literal) => ids.has(literal));
    expect({ file, named }).toEqual({ file, named: [] });
  }
});

test('a failed workable or owner source draws its chip as unavailable, never as zero', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <HomeMapBody
        sources={{ map: [] }}
        states={{ workable: 'error', owner: 'error', steps: 'error' }}
        state="ready"
        factory="here"
        at={null}
        flow={false}
      />
    </MemoryRouter>,
  );
  expect(html).toContain('? queued');
  expect(html).toContain('? waiting');
  expect(html).not.toContain('0 queued');
});

test.each([
  [
    'workable',
    'queued',
    { workable: [{ kind: 'issue', issue_number: 2, title: 'w', url: null, run_id: null }] },
  ],
  [
    'owner',
    'waiting',
    {
      owner: [
        {
          kind: 'issue',
          issue_number: 2,
          question_number: null,
          title: 'o',
          url: null,
          options: null,
          recommendation: null,
          default_option: null,
          default_at: null,
        },
      ],
    },
  ],
] as const)(
  'a %s source in error that still holds rows draws "?" and no count',
  (source, chip, rows) => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <HomeMapBody
          sources={{ map: [], ...(rows as object) }}
          states={{ [source]: 'error' }}
          state="ready"
          factory="here"
          at={null}
          flow={false}
        />
      </MemoryRouter>,
    );
    expect(html).toContain(`? ${chip}`);
    expect(html).not.toContain(`1 ${chip}`);
    expect(html).not.toContain(`2 ${chip}`);
  },
);

test('Behind the scenes says the steps are unavailable, not loading, once their query failed', () => {
  const card = FACTORY_MAP.cards.find((c) => c.covers.length > 0) as (typeof FACTORY_MAP.cards)[0];
  const html = (failed: boolean) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <Behind card={card} at={null} steps={undefined} failed={failed} />
      </MemoryRouter>,
    );
  expect(html(true)).toContain('The pinned steps are unavailable.');
  expect(html(true)).not.toContain('Loading');
  expect(html(false)).toContain('Loading the pinned steps.');
});

test('Right now links a lap entry to its page and to its GitHub issue, and only its page without one', () => {
  const lap = (
    run: string,
    issue: { number: number; title: string | null; url: string | null } | null,
  ) => ({
    run,
    step: 'plan',
    issue,
  });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <RightNow
        live={{
          here: [
            lap('aaaaaaaa-1', { number: 7, title: 'T', url: 'https://github.com/o/r/issues/7' }),
            lap('bbbbbbbb-2', null),
          ],
        }}
        factory="here"
      />
    </MemoryRouter>,
  );
  expect(html).toContain('href="https://github.com/o/r/issues/7"');
  expect(html).toContain('/f/here/laps/bbbbbbbb-2');
  expect(html.match(/data-lap-issue/g)).toHaveLength(1);
});

test('Right now says a skipped reviewer was not earned, naming the lap by issue or by run', () => {
  const skipped = [
    { run: 'aaaaaaaa-1', step: 'review/tests', issue: { number: 7, title: 'T', url: null } },
    { run: 'bbbbbbbb-2', step: 'review/tests', issue: null },
  ];
  const render = (live: Parameters<typeof RightNow>[0]['live']) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <RightNow live={live} factory="here" />
      </MemoryRouter>,
    );
  const html = render({ here: [], skipped });
  expect(html).toContain('data-skipped="aaaaaaaa-1"');
  expect(html).toContain('#7');
  expect(html).toContain('lap bbbbbbbb');
  expect(html.match(/did not earn this reviewer/g)).toHaveLength(2);
  expect(render({ here: [] })).not.toContain('data-skipped');
});

test('Right now says a chip count is unavailable', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <RightNow live={{ here: [], unavailable: ['queued'] }} factory="here" />
    </MemoryRouter>,
  );
  expect(html).toContain('The queued count is unavailable.');
});

test('Behind the scenes shows each workflow its own YAML path, and none for a workflow the version lacks', () => {
  const row = (workflow: string, path: string, file: string) =>
    ({ workflow, path, file, model: null }) as unknown as StepRow;
  const steps = [row('wf-a', 'one', 'workflows/a.yaml'), row('wf-b', 'two', 'workflows/b.yaml')];
  const card = {
    ...FACTORY_MAP.cards[0],
    covers: [
      { workflow: 'wf-a', steps: ['one'] },
      { workflow: 'wf-b', steps: ['two'] },
    ],
  } as (typeof FACTORY_MAP.cards)[0];
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <Behind card={card} at={null} steps={steps} failed={false} />
    </MemoryRouter>,
  );
  const block = (workflow: string) =>
    html.split('data-behind-workflow="').find((part) => part.startsWith(`${workflow}"`)) ?? '';
  expect(block('wf-a')).toContain('workflows/a.yaml');
  expect(block('wf-a')).not.toContain('workflows/b.yaml');
  expect(block('wf-b')).toContain('workflows/b.yaml');
  expect(workflowFile(steps, 'missing')).toBeUndefined();
  expect(html).not.toContain('data-steps-missing');
  const lacking = renderToStaticMarkup(
    <MemoryRouter>
      <Behind
        card={{
          ...card,
          covers: [{ pack: 'loop' as const, workflow: 'wf-a', steps: ['one', 'gone'] }],
        }}
        at={null}
        steps={steps}
        failed={false}
      />
    </MemoryRouter>,
  );
  expect(lacking).toContain('are not in this version');
});

test('the home clock turns over at the next local midnight', () => {
  const lateEvening = new Date(2026, 10, 3, 23, 59, 30);
  expect(msToLocalMidnight(lateEvening)).toBe(30_000);
  expect(msToLocalMidnight(new Date(2026, 10, 4, 0, 0, 0))).toBeGreaterThan(23 * 3_600_000);
});

test('the Work order card counts its open work orders and says nothing with none; Right now lists each', () => {
  const orders = [
    {
      name: 'combat',
      total_count: 3,
      open_count: 2,
      merged_count: 1,
      lands_on: 'staging',
      last_closed_at: null,
    },
  ];
  const chips = (html: string) => {
    const start = html.indexOf('data-card="order"');
    const end = html.indexOf('data-card=', start + 1);
    return [...html.slice(start, end).matchAll(/data-chip="(\w+)"[^>]*>([^<]*)</g)].map(
      (m) => `${m[1]} ${m[2]}`,
    );
  };
  expect(chips(render([], 'ready', { orders }))).toEqual(['orders 1 open']);
  expect(render([], 'ready', { orders: [] })).not.toContain('data-chip="orders"');

  const right = textOf(
    renderToStaticMarkup(
      <MemoryRouter>
        <RightNow live={{ here: [], orders }} factory="here" />
      </MemoryRouter>,
    ),
  );
  expect(right).toContain('combat');
  expect(right).toContain('2 open, 1 merged, lands on staging');
});

test.each(['split', 'intake'])(
  "with path ['%s'] the map draws that view's cards and caption",
  (id) => {
    const view = FACTORY_MAP.views?.[id];
    if (view === undefined) throw new Error(`the map has no ${id} view`);
    const html = render([], 'ready', { path: [id] });
    for (const card of view.cards) expect(cardTag(html, card.id)).toContain('data-card');
    expect(html).toContain(view.caption.replaceAll("'", '&#x27;'));
    expect(html).toContain(`data-view="${id}"`);
  },
);

test('Right now draws each product document as a bar with its link and counts, and says when none is open or the query failed', () => {
  const right = (live: Parameters<typeof RightNow>[0]['live']) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <RightNow live={live} factory="here" />
      </MemoryRouter>,
    );
  const html = right({
    here: [],
    documents: [
      {
        number: 410,
        title: 'Queue',
        url: 'https://github.com/o/r/issues/410',
        total_count: 4,
        merged_count: 2,
      },
      {
        number: 420,
        title: 'Empty',
        url: 'https://github.com/o/r/issues/420',
        total_count: 0,
        merged_count: 0,
      },
    ],
  });
  expect(html).toContain('href="https://github.com/o/r/issues/410"');
  expect(html).toContain('role="progressbar"');
  expect(html).toContain('aria-valuenow="2"');
  expect(html).toContain('aria-valuemax="4"');
  expect(textOf(html)).toContain('2/4 merged');
  expect(textOf(html)).toContain('no work items recorded');
  expect(textOf(right({ here: [], documents: [] }))).toContain('No product document is open.');
  expect(textOf(right({ here: [], listsUnavailable: ['documents'] }))).toContain(
    'The product documents are unavailable.',
  );
});
