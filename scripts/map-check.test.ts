import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Card, FACTORY_MAP, type FactoryMap, type MapView } from '../app/map/factory-map';
import { parsePack } from '../parsers/pack';
import { REPO_ROOT } from './lib/cli';
import { mapCheck, parseQueuePack } from './map-check';

const PACK = join(REPO_ROOT, 'fixtures', 'pack', 'sdlc');
const QUEUE_ROOT = join(REPO_ROOT, 'fixtures', 'pack', 'queue');
const TEMPLATE = join(REPO_ROOT, 'fixtures', 'factory-template');
const LOOP = join('loop', 'archon-loop.yaml');

const copies: string[] = [];
afterEach(() => {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The pack parsed from a copy whose loop `edit` rewrote. */
function editedPack(edit: (yaml: string) => string) {
  const dir = mkdtempSync(join(tmpdir(), 'map-check-'));
  copies.push(dir);
  cpSync(PACK, dir, { recursive: true });
  const file = join(dir, LOOP);
  const yaml = readFileSync(file, 'utf8');
  const edited = edit(yaml);
  expect(edited).not.toBe(yaml);
  writeFileSync(file, edited);
  return parsePack(dir, TEMPLATE);
}

const queue = () => parseQueuePack(QUEUE_ROOT, TEMPLATE);
const loop = () => parsePack(PACK, TEMPLATE);
const check = (map: FactoryMap, pack = loop()) => mapCheck(map, { loop: pack, queue: queue() });

/** The map with only the Build view, so a test that edits root covers is not also held to the Split and Intake views. */
const onlyBuild = (cards: FactoryMap['cards']): FactoryMap => ({
  ...FACTORY_MAP,
  cards: cards.map((c) => (c.opens === 'build' ? c : { ...c, opens: undefined })),
  views: { build: FACTORY_MAP.views?.build as MapView },
});

const withCards = (cards: FactoryMap['cards']): FactoryMap => onlyBuild(cards);

/** The map with the Build view's cards rewritten by `edit`. */
const withBuildView = (edit: (cards: FactoryMap['cards']) => FactoryMap['cards']): FactoryMap => ({
  ...onlyBuild(FACTORY_MAP.cards),
  views: {
    build: {
      ...(FACTORY_MAP.views?.build as MapView),
      cards: edit(FACTORY_MAP.views?.build?.cards ?? []),
    },
  },
});
const buildCard = (cards: FactoryMap['cards'], id: string, edit: (c: Card) => Card) =>
  cards.map((c) => (c.id === id ? edit(c) : c));

describe('map:check', () => {
  test('fixtures/pack and fixtures/pack/queue: every step of every covered workflow is covered by exactly one card', () => {
    expect(check(FACTORY_MAP)).toEqual([]);
  });

  test('a question card asking for a label no queue wait declares fails', () => {
    const view = FACTORY_MAP.views?.manager as MapView;
    const map: FactoryMap = {
      ...FACTORY_MAP,
      views: {
        ...FACTORY_MAP.views,
        manager: {
          ...view,
          cards: view.cards.map((c) => (c.id === 'u-b' ? { ...c, asks: { label: 'bild' } } : c)),
        },
      },
    };
    expect(check(map)).toEqual([
      'Build is stuck on a choice asks label "bild", which no wait of the queue pack declares',
    ]);
  });

  test('a question card asking for a value its label never takes fails', () => {
    const view = FACTORY_MAP.views?.manager as MapView;
    const map: FactoryMap = {
      ...FACTORY_MAP,
      views: {
        ...FACTORY_MAP.views,
        manager: {
          ...view,
          cards: view.cards.map((c) =>
            c.id === 'u-c' ? { ...c, asks: { label: 'stage', value: 'archon-triag' } } : c,
          ),
        },
      },
    };
    expect(check(map)).toEqual([
      expect.stringContaining(
        'asks label stage with value "archon-triag", which the queue pack never sets',
      ),
    ]);
  });

  test('a question card asking with a misspelled key fails instead of widening to every question', () => {
    const view = FACTORY_MAP.views?.manager as MapView;
    const map: FactoryMap = {
      ...FACTORY_MAP,
      views: {
        ...FACTORY_MAP.views,
        manager: {
          ...view,
          cards: view.cards.map((c) =>
            c.id === 'u-b' ? { ...c, asks: { label: 'build', valu: 'x' } as never } : c,
          ),
        },
      },
    };
    expect(check(map)).toEqual([
      'Build is stuck on a choice asks {"label":"build","valu":"x"}, with unknown key valu',
    ]);
  });

  test('a covered step removed from a copy of the pack fails naming the step', () => {
    const pack = editedPack((yaml) =>
      yaml
        .replace(/ {2}- id: briefs\n[\s\S]*?(?= {2}- id: check-app\n)/, '')
        .replace('depends_on: [subject, briefs]', 'depends_on: [subject]'),
    );
    expect(check(FACTORY_MAP, pack)).toEqual([
      'loop pack: App check names archon-loop briefs, which the pack lacks',
    ]);
  });

  test('a step a lap marks that the pack lacks passes only while a card covers it', () => {
    const without = FACTORY_MAP.cards.map((card) =>
      card.id === 'app'
        ? {
            ...card,
            covers: [
              {
                pack: 'loop' as const,
                workflow: 'archon-loop',
                steps: ['briefs', 'check-app', 'evidence'],
              },
            ],
          }
        : card,
    );
    expect(check(withCards(without))).toEqual([
      "loop pack: archon-loop handoff is marked on a lap's row but covered by no card",
    ]);
  });

  test('a step a lap marks that the pack lacks fails when two cards cover it', () => {
    const twice = FACTORY_MAP.cards.map((card) =>
      card.id === 'review'
        ? {
            ...card,
            covers: [
              ...card.covers,
              { pack: 'loop' as const, workflow: 'archon-loop', steps: ['handoff'] },
            ],
          }
        : card,
    );
    expect(check(withCards(twice))).toEqual([
      'loop pack: archon-loop handoff is covered by Review and App check',
    ]);
  });

  test('a step added to a copy of the pack fails naming the step', () => {
    const pack = editedPack((yaml) =>
      yaml.replace(
        '  - id: release\n',
        '  - id: tally\n    script: release\n    runtime: bun\n    depends_on: [land]\n  - id: release\n',
      ),
    );
    expect(check(FACTORY_MAP, pack)).toEqual([
      'loop pack: archon-loop tally is covered by no card',
    ]);
  });

  test('a step two cards cover, a workflow the pack lacks and a wrong screen each fail', () => {
    const cards = FACTORY_MAP.cards.map((card) => {
      if (card.id === 'merge') {
        return {
          ...card,
          covers: [
            {
              pack: 'loop' as const,
              workflow: 'archon-loop',
              steps: ['review', 'land', 'release', 'deploy'],
            },
          ],
        };
      }
      if (card.id === 'split')
        return {
          ...card,
          covers: [{ pack: 'loop' as const, workflow: 'archon-nothing', steps: ['slice'] }],
        };
      if (card.id === 'review') {
        return { ...card, covers: card.covers.map(({ screens: _, ...cover }) => cover) };
      }
      return card;
    });
    expect(check(withCards(cards))).toEqual([
      'loop pack: Split names workflow archon-nothing, which the pack lacks',
      'loop pack: Review opens archon-loop ship/deliver/rounds/review at archon-loop ship/deliver/rounds/review, not its own screen archon-deliver-block rounds/review',
      'loop pack: Review opens archon-loop ship/deliver/rounds/rereview at archon-loop ship/deliver/rounds/rereview, not its own screen archon-deliver-block rounds/rereview',
      'queue pack: Review opens archon-build-queue ship/deliver/rounds/review at archon-build-queue ship/deliver/rounds/review, not its own screen archon-deliver-block rounds/review',
      'queue pack: Review opens archon-build-queue ship/deliver/rounds/rereview at archon-build-queue ship/deliver/rounds/rereview, not its own screen archon-deliver-block rounds/rereview',
      'loop pack: archon-loop deploy is covered by Merge and Staging',
      'loop pack: archon-loop deploy/resolve is covered by Merge and Staging',
      'loop pack: archon-loop deploy/deploy is covered by Merge and Staging',
      'loop pack: archon-loop deploy/health is covered by Merge and Staging',
      'loop pack: archon-loop deploy/verify is covered by Merge and Staging',
    ]);
  });

  test('a value outside the closed sets fails naming it', () => {
    const map: FactoryMap = {
      ...FACTORY_MAP,
      cards: FACTORY_MAP.cards.map((card, i) =>
        i === 0
          ? { ...card, role: 'robot' as never, chips: ['lost' as never], lists: ['nope' as never] }
          : card,
      ),
      lines: FACTORY_MAP.lines.map((line, i) =>
        i === 0 ? { ...line, style: 'flwo' as never } : line,
      ),
      legend: FACTORY_MAP.legend.map((e, i) => (i === 0 ? { ...e, role: 'ghost' as never } : e)),
    };
    const first = FACTORY_MAP.cards[0] as FactoryMap['cards'][number];
    const line = FACTORY_MAP.lines[0] as FactoryMap['lines'][number];
    const entry = FACTORY_MAP.legend[0] as FactoryMap['legend'][number];
    expect(check(map)).toEqual([
      `${first.title} role "robot" is not one of source, agent, test, person`,
      `${first.title} chip "lost" is not one of queued, failing, waiting, merged, orders`,
      `${first.title} list "nope" is not one of documents`,
      `line ${line.from} to ${line.to} style "flwo" is not one of flow, ask, loop`,
      `legend ${entry.label} role "ghost" is not one of source, agent, test, person`,
    ]);
  });

  test('a step id with a dot in the pack fails, because the home map would split it', () => {
    const pack = editedPack((yaml) =>
      yaml.replace(
        '  - id: release\n',
        '  - id: t.ally\n    script: release\n    runtime: bun\n    depends_on: [land]\n  - id: release\n',
      ),
    );
    expect(check(FACTORY_MAP, pack)).toContain(
      'loop pack: archon-loop t.ally holds a dot, which the home map reads as a loop group',
    );
  });

  test('a queue step removed from a copy of the snapshot fails naming the step', () => {
    const dir = mkdtempSync(join(tmpdir(), 'map-check-queue-'));
    copies.push(dir);
    cpSync(QUEUE_ROOT, dir, { recursive: true });
    const file = join(dir, 'factory', 'deploy', 'factory-deploy.yaml');
    const lines = readFileSync(file, 'utf8').split('\n');
    const at = lines.findIndex((l) => l.trimEnd() === '  - id: verify');
    expect(at).toBeGreaterThan(0);
    writeFileSync(file, `${lines.slice(0, at).join('\n')}\n`);
    expect(mapCheck(FACTORY_MAP, { loop: loop(), queue: parseQueuePack(dir, TEMPLATE) })).toEqual([
      'queue pack: Staging names factory-deploy verify, which the pack lacks',
    ]);
  });

  test('a queue entry that reaches into a step of the loop pack fails: a live row cannot tell the packs apart', () => {
    const cards = FACTORY_MAP.cards.map((card) =>
      card.id === 'merge'
        ? {
            ...card,
            covers: [
              ...card.covers,
              { pack: 'queue' as const, workflow: 'archon-merge-queue', steps: ['merge'] },
            ],
          }
        : card,
    );
    const failures = check(withCards(cards));
    expect(failures).toContain(
      'queue pack: Merge names archon-merge-queue merge, which the pack lacks',
    );
    expect(failures).toContain(
      'loop pack: archon-merge-queue merge, which no loop card covers, counts on Merge',
    );
  });

  test('a cover for a pack outside the closed set fails naming it', () => {
    const cards = FACTORY_MAP.cards.map((card) =>
      card.id === 'deploy'
        ? { ...card, covers: card.covers.map((c) => ({ ...c, pack: 'both' as never })) }
        : card,
    );
    expect(check(withCards(cards))).toContain(
      'Staging cover archon-loop pack "both" is not one of loop, queue',
    );
  });

  test('a Build-view card dropping a child step fails naming it', () => {
    const map = withBuildView((cards) =>
      buildCard(cards, 'b-push', (c) => ({
        ...c,
        covers: c.covers.map((cover) =>
          cover.workflow === 'archon-build-queue' ? { ...cover, steps: [] } : cover,
        ),
      })),
    );
    expect(check(map)).toEqual([
      'queue pack: Build view: archon-build-queue apply is covered by no card',
    ]);
  });

  test('the Split and Intake views each cover the steps of their card once', () => {
    const split = FACTORY_MAP.views?.split as MapView;
    const map: FactoryMap = {
      ...FACTORY_MAP,
      views: {
        ...FACTORY_MAP.views,
        split: {
          ...split,
          cards: split.cards.map((c) =>
            c.id === 's-slice'
              ? {
                  ...c,
                  covers: c.covers.map((cover) =>
                    cover.workflow === 'archon-split' ? { ...cover, steps: [] } : cover,
                  ),
                }
              : c,
          ),
        },
      },
    };
    expect(check(map)).toEqual([
      'queue pack: Split view: archon-split slice is covered by no card',
    ]);
  });

  test('a view card covering a step its parent does not fails', () => {
    const map = withBuildView((cards) =>
      buildCard(cards, 'b-del', (c) => ({
        ...c,
        covers: c.covers.map((cover) =>
          cover.workflow === 'archon-build-queue'
            ? {
                ...cover,
                steps: [...cover.steps, 'ship/deliver/rounds/review'],
                screens: {
                  ...cover.screens,
                  'ship/deliver/rounds/review': {
                    workflow: 'archon-deliver-block',
                    path: 'rounds/review',
                  },
                },
              }
            : cover,
        ),
      })),
    );
    expect(check(map)).toEqual([
      'queue pack: Build view: Deliver covers archon-build-queue ship/deliver/rounds/review, which Build does not',
    ]);
  });

  test('a view card covering the step the pack lacks, which its opener does not name, fails', () => {
    const map = withBuildView((cards) =>
      buildCard(cards, 'b-del', (c) => ({
        ...c,
        covers: c.covers.map((cover) =>
          cover.workflow === 'archon-loop'
            ? { ...cover, steps: [...cover.steps, 'handoff'] }
            : cover,
        ),
      })),
    );
    expect(check(map)).toEqual([
      'loop pack: Build view: Deliver covers archon-loop handoff, which Build does not',
    ]);
  });

  test('an opens naming no view, and a view no card opens, fail', () => {
    const dead = {
      ...FACTORY_MAP,
      cards: FACTORY_MAP.cards.map((c) => (c.id === 'review' ? { ...c, opens: 'nowhere' } : c)),
    };
    expect(check(dead)).toEqual(['Review opens view nowhere, which the map lacks']);
    const orphan = {
      ...FACTORY_MAP,
      cards: FACTORY_MAP.cards.map(({ opens: _, ...c }) => c),
    };
    expect(check(orphan)).toContain('view build is opened by no card');
  });

  test('a card id used twice fails naming it', () => {
    const map = withBuildView((cards) =>
      buildCard(cards, 'b-brief', (c) => ({ ...c, id: 'build' })),
    );
    expect(check(map)).toContain('card id build is used twice');
  });

  test('a card going up to a card its parent level lacks fails', () => {
    const map = withBuildView((cards) =>
      buildCard(cards, 'b-next', (c) => ({ ...c, upTo: 'nowhere' })),
    );
    expect(check(map)).toContain(
      'Merge queue goes up to nowhere, which is no card of its parent level',
    );
  });

  test('a view two cards open fails naming both', () => {
    const map = {
      ...FACTORY_MAP,
      cards: FACTORY_MAP.cards.map((c) => (c.id === 'review' ? { ...c, opens: 'build' } : c)),
    };
    expect(check(map)).toContain('view build is opened by Build and Review');
  });

  test('a view opened only from inside itself fails as unreachable', () => {
    const map = {
      ...withBuildView((cards) => buildCard(cards, 'b-brief', (c) => ({ ...c, opens: 'build' }))),
      cards: FACTORY_MAP.cards.map(({ opens: _, ...c }) => c),
    };
    expect(check(map)).toContain('view build cannot be reached from the root');
  });

  test('a view card naming a workflow its opener does not cover fails', () => {
    const map = withBuildView((cards) =>
      buildCard(cards, 'b-brief', (c) => ({
        ...c,
        covers: [...c.covers, { pack: 'queue', workflow: 'archon-merge-queue', steps: [] }],
      })),
    );
    expect(check(map)).toContain(
      'queue pack: Build view: Write the brief names workflow archon-merge-queue, which Build does not cover',
    );
  });
});
