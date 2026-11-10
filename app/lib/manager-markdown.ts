import MarkdownIt from 'markdown-it';
import { linkify, type ManagerLink } from './manager';

/**
 * The small markdown subset the Manager's prose may use: paragraphs, numbered and bulleted lists,
 * bold, inline code, and the links the server checked. markdown-it parses it with every other rule
 * off, so headings, quotes, fences, tables, raw HTML and the rest come out as plain text.
 */
export type Inline =
  | { type: 'text'; text: string; literal?: true }
  | { type: 'bold'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; link: ManagerLink };

export type Block =
  | { type: 'paragraph'; inlines: Inline[] }
  | { type: 'list'; ordered: boolean; start: number; items: Inline[][] };

const md = new MarkdownIt('zero', { html: false });
md.enable(['paragraph', 'list', 'emphasis', 'backticks', 'link', 'autolink', 'escape', 'newline']);

type Token = ReturnType<typeof md.parse>[number];

const push = (into: Inline[], node: Inline) => {
  const last = into[into.length - 1];
  if (node.type === 'text' && last?.type === 'text' && last.literal === node.literal)
    last.text += node.text;
  else into.push(node);
};

/** Bold and code kept, emphasis and link targets dropped to their text. A `**` that found no partner is not shown. */
function inlines(children: Token[]): Inline[] {
  const root: Inline[] = [];
  const stack: Inline[][] = [root];
  let inLink = 0;
  for (const t of children) {
    const into = stack[stack.length - 1];
    if (t.type === 'strong_open') {
      const bold: Inline = { type: 'bold', children: [] };
      into.push(bold);
      stack.push(bold.children);
    } else if (t.type === 'strong_close') {
      stack.pop();
    } else if (t.type === 'code_inline') {
      into.push({ type: 'code', text: t.content });
    } else if (t.type === 'link_open') {
      inLink++;
    } else if (t.type === 'link_close') {
      inLink--;
    } else if (t.type === 'text') {
      const text = t.content.replaceAll('**', '');
      push(into, inLink > 0 ? { type: 'text', text, literal: true } : { type: 'text', text });
    } else if (t.type === 'softbreak' || t.type === 'hardbreak') {
      push(into, { type: 'text', text: '\n' });
    }
  }
  return root.filter((n) => n.type !== 'bold' || n.children.length > 0);
}

/** Each text leaf with the links it names put in place (text inside a model-written link is left as it is); `remaining` is the links still unnamed. */
function linked(nodes: Inline[], remaining: ManagerLink[]): Inline[] {
  return nodes.flatMap((node): Inline[] => {
    if (node.type === 'bold') return [{ type: 'bold', children: linked(node.children, remaining) }];
    if (node.type !== 'text' || node.literal) return [node];
    const { segments, rest } = linkify(node.text, remaining);
    remaining.splice(0, remaining.length, ...rest);
    return segments.map(
      (s): Inline =>
        typeof s === 'string' ? { type: 'text', text: s } : { type: 'link', link: s },
    );
  });
}

export function parseMessage(
  text: string,
  links: readonly ManagerLink[],
): { blocks: Block[]; rest: ManagerLink[] } {
  const remaining = [...links];
  const blocks: Block[] = [];
  const lists: Extract<Block, { type: 'list' }>[] = [];
  // What goes before the next inline in the open top-level item: a nested item's marker, or a paragraph gap.
  let before = '';
  for (const t of md.parse(text, {})) {
    if (t.type === 'bullet_list_open' || t.type === 'ordered_list_open') {
      const ordered = t.type === 'ordered_list_open';
      const start = Number(t.attrGet('start') ?? 1);
      const list: Extract<Block, { type: 'list' }> = { type: 'list', ordered, start, items: [] };
      if (lists.length === 0) blocks.push(list);
      lists.push(list);
    } else if (t.type === 'bullet_list_close' || t.type === 'ordered_list_close') {
      lists.pop();
    } else if (t.type === 'list_item_open') {
      const list = lists[lists.length - 1];
      if (lists.length === 1) {
        list.items.push([]);
        before = '';
      } else {
        // A nested list reads as marked lines inside its parent item, in the order written.
        const n = list.start + list.items.length;
        list.items.push([]);
        before = `\n${'  '.repeat(lists.length - 1)}${list.ordered ? `${n}.` : '-'} `;
      }
    } else if (t.type === 'inline') {
      const nodes = linked(inlines(t.children ?? []), remaining);
      if (lists.length === 0) {
        blocks.push({ type: 'paragraph', inlines: nodes });
      } else {
        const item = lists[0].items[lists[0].items.length - 1];
        if (before) push(item, { type: 'text', text: before });
        for (const n of nodes) push(item, n);
        before = '\n\n';
      }
    }
  }
  return { blocks, rest: remaining };
}
