import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { parsePack, type Step } from '../../parsers/pack';
import { FACTORY_MAP } from '../map/factory-map';
import type { HomeMapRow, MapSources } from '../map/live';
import { HomeMapBody } from './index';

const REPO = join(import.meta.dir, '..', '..');

const render = (
  map: HomeMapRow[] | undefined,
  state: 'loading' | 'ready' | 'error',
  {
    at = null,
    configured,
    ...more
  }: { at?: string | null; configured?: boolean } & Omit<MapSources, 'map'> = {},
) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <HomeMapBody
        sources={{ map, ...more }}
        state={state}
        factory="here"
        at={at}
        configured={configured}
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
  // No deeper view exists yet, so no card offers to open one.
  expect(html).not.toContain('⤢');
  expect(html).not.toContain('data-chip');
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
