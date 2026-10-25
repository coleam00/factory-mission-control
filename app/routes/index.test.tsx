import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { parsePack, type Step } from '../../parsers/pack';
import type { HomeMapRow } from '../lib/home-map';
import { HomeMapBody } from './index';

const REPO = join(import.meta.dir, '..', '..');

const render = (rows: HomeMapRow[] | undefined, state: 'loading' | 'ready' | 'error') =>
  renderToStaticMarkup(
    <MemoryRouter>
      <HomeMapBody rows={rows} state={state} />
    </MemoryRouter>,
  );

const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').trim();

test('loading, error and an empty architecture are each one sentence and no button', () => {
  for (const html of [
    render(undefined, 'loading'),
    render(undefined, 'error'),
    render([], 'ready'),
  ]) {
    const text = textOf(html);
    expect(text.match(/[.!?](\s|$)/g)?.length).toBe(1);
    expect(text.endsWith('.')).toBe(true);
    expect(html).not.toMatch(/<button\b/);
  }
});

test('a step with laps on it carries its count and the running style; the rest show 0', () => {
  const step = (path: string, position: number, live_count: number): HomeMapRow => ({
    role: 'step',
    workflow: 'wf',
    path,
    parent_path: null,
    position,
    step_id: path,
    kind: 'command',
    depends_on: [],
    detail_workflow: 'wf',
    live_count,
  });
  const html = render([step('first', 0, 2), step('second', 1, 0)], 'ready');
  const link = (href: string) => html.match(new RegExp(`<a [^>]*href="${href}"[^>]*>`))?.[0] ?? '';
  expect(link('/steps/wf/first')).toContain('data-live-count="2"');
  expect(link('/steps/wf/first')).toContain('var(--running)');
  expect(link('/steps/wf/second')).toContain('data-live-count="0"');
  expect(link('/steps/wf/second')).not.toContain('var(--running)');
});

/** Every step id in the pinned pack's archon-loop, at every depth. */
function loopStepIds(): Set<string> {
  const pack = parsePack(
    join(REPO, 'fixtures', 'pack', 'sdlc'),
    join(REPO, 'fixtures', 'factory-template'),
  );
  const loop = pack.workflows.find((w) => w.name === 'archon-loop');
  if (loop === undefined) throw new Error('the pack has no archon-loop');
  const ids = new Set<string>();
  const walk = (steps: Step[]) => {
    for (const s of steps) {
      ids.add(s.id);
      walk(s.steps);
    }
  };
  walk(loop.steps);
  return ids;
}

test('the map names no step: every node comes from the architecture rows', () => {
  const ids = loopStepIds();
  expect(ids.has('check-app')).toBe(true);
  for (const file of [
    'app/routes/index.tsx',
    'app/components/HomeMap.tsx',
    'app/lib/home-map.ts',
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
