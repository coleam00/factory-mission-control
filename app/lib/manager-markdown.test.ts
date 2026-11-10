import { expect, test } from 'bun:test';
import type { ManagerLink } from './manager';
import { type Block, type Inline, parseMessage } from './manager-markdown';

const item = (id: number): ManagerLink => ({
  type: 'link',
  kind: 'item',
  id,
  label: `#${id} Some title`,
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

test('bold that opens in one item and closes in the next is in neither', () => {
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

test('code keeps its text verbatim and unlinked', () => {
  const { blocks, rest } = parseMessage('Run `**x** #522` now', [item(522)]);
  expect(inlinesOf(blocks[0])).toMatchObject([
    { type: 'text' },
    { type: 'code', text: '**x** #522' },
    { type: 'text' },
  ]);
  expect(rest).toHaveLength(1);
});

test('what is outside the subset is plain text, without its markers', () => {
  const text =
    '# Title\n\n> quoted [here](http://x.test) and *soft*\n\n---\n\n```sql\nSELECT 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |';
  const { blocks } = parseMessage(text, []);
  expect(blocks.map((b) => flat(inlinesOf(b)))).toEqual([
    'Title',
    'quoted here and soft',
    'SELECT 1',
    'a · b',
    '1 · 2',
  ]);
});

test.each<[string, string, Inline['type'][]]>([
  ['***x*** end', 'x end', ['bold', 'text']],
  ['___x___ end', 'x end', ['bold', 'text']],
  ['__bold__ end', 'bold end', ['bold', 'text']],
  ['an _it_ end', 'an it end', ['text']],
  ['a ~~gone~~ end', 'a gone end', ['text']],
  ['![img](http://x.test) end', 'img end', ['text']],
  ['snake_case and my_var_name', 'snake_case and my_var_name', ['text']],
])('%s leaves no markup', (text, shown, shape) => {
  const inl = inlinesOf(parseMessage(text, []).blocks[0]);
  expect(flat(inl)).toBe(shown);
  expect(kinds(inl)).toEqual(shape);
});

test.each<[string, string, Inline['type'][]]>([
  ['*a **b** c* end', 'a b c end', ['text', 'bold', 'text']],
  ['~~**x**~~ end', 'x end', ['bold', 'text']],
  ['_**x**_ end', 'x end', ['bold', 'text']],
  ['*see **here*** end', 'see here end', ['text', 'bold', 'text']],
  ['***a** b* end', 'a b end', ['bold', 'text']],
  ['**a *b*** end', 'a b end', ['bold', 'text']],
  ['*a `c` b* end', 'a c b end', ['text', 'code', 'text']],
  ['_a `c` b_ end', 'a c b end', ['text', 'code', 'text']],
  ['~~a `c` b~~ end', 'a c b end', ['text', 'code', 'text']],
  ['\\*not\\* end', '*not* end', ['text']],
  ['line<br>two', 'line two', ['text']],
  ['see <https://x.test> now', 'see https://x.test now', ['text']],
])('%s leaves no markup across a boundary', (text, shown, shape) => {
  const inl = inlinesOf(parseMessage(text, []).blocks[0]);
  expect(flat(inl)).toBe(shown);
  expect(kinds(inl)).toEqual(shape);
});

test('step ids, products and a stray ** stay readable', () => {
  const { blocks } = parseMessage('pr__prepare took 2 * 3 s ** end', []);
  expect(flat(inlinesOf(blocks[0]))).toBe('pr__prepare took 2 * 3 s  end');
});

test('a link the prose never names is left over; a list follows a paragraph line', () => {
  const { blocks, rest } = parseMessage('Two things:\n- one\n- two', [item(9)]);
  expect(rest).toEqual([item(9)]);
  expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'list']);
  expect(list(blocks[1]).items).toHaveLength(2);
});
