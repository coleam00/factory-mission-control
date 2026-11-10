import { expect, test } from 'bun:test';
import type { ManagerLink } from './manager';
import { type Block, type Inline, parseMessage } from './manager-markdown';

const item = (id: number): ManagerLink => ({
  type: 'link',
  kind: 'item',
  id,
  href: `/f/x/work/${id}`,
});

const flat = (nodes: Inline[]): string =>
  nodes
    .map((n) =>
      n.type === 'bold' ? flat(n.children) : n.type === 'link' ? `#${n.link.id}` : n.text,
    )
    .join('');
const kinds = (nodes: Inline[]) => nodes.map((n) => n.type);
const list = (b: Block | undefined) => {
  if (b?.type !== 'list') throw new Error('not a list');
  return b;
};
const inlinesOf = (b: Block | undefined) => {
  if (b?.type !== 'paragraph') throw new Error('not a paragraph');
  return b.inlines;
};

test('bold that opens in one item and closes in the next is in neither and shows no **', () => {
  const { blocks } = parseMessage(
    '1. **Build-queue failures on issue #522\n2. keep recurring.** Fix the gate.',
    [item(522)],
  );
  const l = list(blocks[0]);
  expect(blocks).toHaveLength(1);
  expect(l).toMatchObject({ ordered: true, start: 1 });
  expect(l.items.map(kinds)).toEqual([['text', 'link'], ['text']]);
  expect(l.items.map(flat)).toEqual([
    'Build-queue failures on issue #522',
    'keep recurring. Fix the gate.',
  ]);
});

test('bold paired inside one item keeps its link inside', () => {
  const { blocks } = parseMessage('- **issue #522 keeps failing** today', [item(522)]);
  const l = list(blocks[0]);
  expect(l.ordered).toBe(false);
  expect(kinds(l.items[0])).toEqual(['bold', 'text']);
  expect(l.items[0][0]).toMatchObject({
    children: [{ type: 'text' }, { type: 'link' }, { type: 'text' }],
  });
});

test('an issue reference becomes a link and its title is not shown', () => {
  const { blocks, rest } = parseMessage('See #522 now', [item(522)]);
  expect(flat(inlinesOf(blocks[0]))).toBe('See #522 now');
  expect(kinds(inlinesOf(blocks[0]))).toEqual(['text', 'link', 'text']);
  expect(rest).toEqual([]);
});

test('code keeps its text verbatim and unlinked', () => {
  const { blocks, rest } = parseMessage('Run `**x** #522` now', [item(522)]);
  expect(inlinesOf(blocks[0])).toMatchObject([
    { type: 'text' },
    { type: 'code', text: '**x** #522' },
    { type: 'text' },
  ]);
  expect(rest).toHaveLength(1);
});

test('raw HTML shows as text, never as markup', () => {
  const { blocks } = parseMessage('a <b>x</b> <script>y</script>\n\n<div>z</div>', []);
  expect(blocks.map((b) => flat(inlinesOf(b)))).toEqual([
    'a <b>x</b> <script>y</script>',
    '<div>z</div>',
  ]);
});

test('a link the prose never names is left over; a list follows a paragraph line', () => {
  const { blocks, rest } = parseMessage('Two things:\n\n- one\n- two', [item(9)]);
  expect(rest).toEqual([item(9)]);
  expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'list']);
  expect(list(blocks[1]).items).toHaveLength(2);
});

const itemText = (b: Block) =>
  b.type === 'list'
    ? b.items.map((i) => i.map((n) => (n.type === 'text' ? n.text : '')).join(''))
    : [];

test('a nested list stays inside its item, in reading order', () => {
  const { blocks } = parseMessage('- a\n  - b\n- c', []);
  expect(blocks).toHaveLength(1);
  expect(itemText(blocks[0])).toEqual(['a\n  - b', 'c']);
});

test('two paragraphs in one item do not run together', () => {
  const { blocks } = parseMessage('- first para\n\n  second para\n- c', []);
  expect(itemText(blocks[0])[0]).toBe('first para\n\nsecond para');
});

test('a reference inside a model-written link stays text and stays unnamed', () => {
  const link = { kind: 'item', id: '522', href: '/i/522' } as unknown as ManagerLink;
  const { blocks, rest } = parseMessage('See [the fix #522](https://e.com) now', [link]);
  const p = blocks[0] as Extract<Block, { type: 'paragraph' }>;
  expect(p.inlines.some((n) => n.type === 'link')).toBe(false);
  expect(rest).toEqual([link]);
});
