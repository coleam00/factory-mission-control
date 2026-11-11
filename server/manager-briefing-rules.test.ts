import { describe, expect, test } from 'bun:test';
import { ATTENTION_SOURCES, attentionCount } from '../app/lib/attention-page';
import { parseMessage, topLevelBlocks } from '../app/lib/manager-markdown';
import { LIVE_QUERIES_DIR, loadLiveQueries } from './live';
import { type AttentionTally, attentionLine, briefingFault, capBriefingProse } from './manager';
import { withheldFromBriefing } from './manager-tools';

const keys = Object.keys(ATTENTION_SOURCES) as (keyof typeof ATTENTION_SOURCES)[];
const tallyOf = (counts: number[]): AttentionTally => {
  const t = { failureRuns: 0, failures: 0 } as AttentionTally;
  keys.forEach((key, i) => {
    t[key] = counts[i] ?? 0;
  });
  return t;
};

describe('the count line and its reader', () => {
  test('the line states the total attentionCount gives, and the reader accepts it', () => {
    for (const counts of [[1], [0, 2], [3, 1, 4, 1, 5], [1, 1, 1, 1, 1, 1, 1, 1]]) {
      const tally = tallyOf(counts);
      const total = attentionCount(
        keys.map((key) => ({ state: 'ready' as const, rows: new Array(tally[key]).fill({}) })),
      );
      expect(attentionLine(tally)).toMatch(new RegExp(`\\b${total} things? needs? you:`));
      expect(briefingFault(attentionLine(tally), tally)).toBeNull();
    }
    expect(attentionLine(tallyOf([]))).toBe('Nothing needs you.');
    expect(briefingFault('Nothing needs you.', tallyOf([]))).toBeNull();
  });
});

describe('the briefing queries', () => {
  test('the withheld queries are real query files, and none of them is offered', () => {
    const queries = loadLiveQueries(LIVE_QUERIES_DIR);
    const named = [
      'attention-items',
      'home-map',
      ...Object.values(ATTENTION_SOURCES).map((s) => s.query),
    ];
    for (const name of named) expect(queries.has(name)).toBe(true);
    const offered = withheldFromBriefing(queries);
    for (const name of named) expect(offered.has(name)).toBe(false);
    expect(offered.size).toBe(queries.size - new Set(named).size);
  });
});

describe('the briefing cap and the panel agree on what a block is', () => {
  const units = (text: string): number =>
    parseMessage(text, []).blocks.reduce((n, b) => n + (b.type === 'list' ? b.items.length : 1), 0);

  test.each([
    ['paragraphs', 'a\n\nb\n\nc\n\nd'],
    ['a list', '- a\n- b\n- c\n- d'],
    ['lead and list', 'Two failed.\n  - a\n  - b\n  - c'],
    ['nested list', '- a\n  - b\n  - c\n- d'],
    ['ordered list', '1. a\n2. b\n3. c'],
    ['indented paragraphs', 'Quiet.\n\n  two\n\n  three'],
    ['bare returns', 'a\r\rb\r\rc'],
    ['crlf', 'a\r\n\r\nb\r\n\r\n- c\r\n- d'],
    ['headings and quotes', '# h\n\n> q\n\n```\ncode\n```\n\ntext'],
    ['mixed', 'intro\n\n1. one\n2. two\n\n- x\n\nend'],
  ])('%s', (_name, text) => {
    expect(topLevelBlocks(text)).toHaveLength(units(text));
    expect(units(capBriefingProse(text))).toBe(Math.min(units(text), 3));
  });
});
