import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FACTORY_MAP, type FactoryMap } from '../app/map/factory-map';
import { parsePack } from '../parsers/pack';
import { REPO_ROOT } from './lib/cli';
import { mapCheck } from './map-check';

const PACK = join(REPO_ROOT, 'fixtures', 'pack', 'sdlc');
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

const withCards = (cards: FactoryMap['cards']): FactoryMap => ({ ...FACTORY_MAP, cards });

describe('map:check', () => {
  test('fixtures/pack: every step of every covered workflow is covered by exactly one card', () => {
    expect(mapCheck(FACTORY_MAP, parsePack(PACK, TEMPLATE))).toEqual([]);
  });

  test('a covered step removed from a copy of the pack fails naming the step', () => {
    const pack = editedPack((yaml) =>
      yaml
        .replace(/ {2}- id: briefs\n[\s\S]*?(?= {2}- id: check-app\n)/, '')
        .replace('depends_on: [subject, briefs]', 'depends_on: [subject]'),
    );
    expect(mapCheck(FACTORY_MAP, pack)).toEqual([
      'App check names archon-loop briefs, which the pack lacks',
    ]);
  });

  test('a step a lap marks that the pack lacks passes only while a card covers it', () => {
    const pack = parsePack(PACK, TEMPLATE);
    const without = FACTORY_MAP.cards.map((card) =>
      card.id === 'app'
        ? {
            ...card,
            covers: [{ workflow: 'archon-loop', steps: ['briefs', 'check-app', 'evidence'] }],
          }
        : card,
    );
    expect(mapCheck(withCards(without), pack)).toEqual([
      "archon-loop handoff is marked on a lap's row but covered by no card",
    ]);
  });

  test('a step a lap marks that the pack lacks fails when two cards cover it', () => {
    const pack = parsePack(PACK, TEMPLATE);
    const twice = FACTORY_MAP.cards.map((card) =>
      card.id === 'review'
        ? { ...card, covers: [...card.covers, { workflow: 'archon-loop', steps: ['handoff'] }] }
        : card,
    );
    expect(mapCheck(withCards(twice), pack)).toEqual([
      'archon-loop handoff is covered by Review and App check',
    ]);
  });

  test('a step added to a copy of the pack fails naming the step', () => {
    const pack = editedPack((yaml) =>
      yaml.replace(
        '  - id: release\n',
        '  - id: tally\n    script: release\n    runtime: bun\n    depends_on: [land]\n  - id: release\n',
      ),
    );
    expect(mapCheck(FACTORY_MAP, pack)).toEqual(['archon-loop tally is covered by no card']);
  });

  test('a step two cards cover, a workflow the pack lacks and a wrong screen each fail', () => {
    const pack = parsePack(PACK, TEMPLATE);
    const cards = FACTORY_MAP.cards.map((card) => {
      if (card.id === 'merge') {
        return {
          ...card,
          covers: [{ workflow: 'archon-loop', steps: ['review', 'land', 'release', 'deploy'] }],
        };
      }
      if (card.id === 'plan')
        return { ...card, covers: [{ workflow: 'archon-split', steps: ['slice'] }] };
      if (card.id === 'review') {
        return { ...card, covers: card.covers.map(({ screens: _, ...cover }) => cover) };
      }
      return card;
    });
    expect(mapCheck(withCards(cards), pack)).toEqual([
      'Plan names workflow archon-split, which the pack lacks',
      'Review opens archon-loop ship/deliver/rounds/review at archon-loop ship/deliver/rounds/review, not its own screen archon-deliver-block rounds/review',
      'Review opens archon-loop ship/deliver/rounds/rereview at archon-loop ship/deliver/rounds/rereview, not its own screen archon-deliver-block rounds/rereview',
      'archon-loop deploy is covered by Merge and Staging',
      'archon-loop deploy/resolve is covered by Merge and Staging',
      'archon-loop deploy/deploy is covered by Merge and Staging',
      'archon-loop deploy/health is covered by Merge and Staging',
      'archon-loop deploy/verify is covered by Merge and Staging',
    ]);
  });

  test('a value outside the closed sets fails naming it', () => {
    const pack = parsePack(PACK, TEMPLATE);
    const map: FactoryMap = {
      ...FACTORY_MAP,
      cards: FACTORY_MAP.cards.map((card, i) =>
        i === 0 ? { ...card, role: 'robot' as never, chips: ['lost' as never] } : card,
      ),
      lines: FACTORY_MAP.lines.map((line, i) =>
        i === 0 ? { ...line, style: 'flwo' as never } : line,
      ),
      legend: FACTORY_MAP.legend.map((e, i) => (i === 0 ? { ...e, role: 'ghost' as never } : e)),
    };
    const first = FACTORY_MAP.cards[0] as FactoryMap['cards'][number];
    const line = FACTORY_MAP.lines[0] as FactoryMap['lines'][number];
    const entry = FACTORY_MAP.legend[0] as FactoryMap['legend'][number];
    expect(mapCheck(map, pack)).toEqual([
      `${first.title} role "robot" is not one of source, agent, test, person`,
      `${first.title} chip "lost" is not one of queued, failing, waiting, merged`,
      `line ${line.from} to ${line.to} style "flwo" is not one of flow, ask, loop, holdout`,
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
    expect(mapCheck(FACTORY_MAP, pack)).toContain(
      'archon-loop t.ally holds a dot, which the home map reads as a loop group',
    );
  });
});
