import { linkify, type ManagerLink } from './manager';

/**
 * The small markdown subset the Manager's prose may use: paragraphs, numbered and bulleted lists,
 * bold, inline code, and the links the server checked. Everything else comes out as plain text,
 * never as markup, and inline parsing never crosses a paragraph or list item.
 */
export type Inline =
  | { type: 'text'; text: string }
  | { type: 'bold'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; link: ManagerLink };

export type Block =
  | { type: 'paragraph'; inlines: Inline[] }
  | { type: 'list'; ordered: boolean; start: number; items: Inline[][] };

type Unit = { kind: 'paragraph'; lines: string[] } | RawList;
interface RawList {
  kind: 'list';
  ordered: boolean;
  start: number;
  items: string[][];
}

const FENCE = /^\s*(```|~~~)/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_RULE = /^[\s|:-]+$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)(\s+#+)?\s*$/;
const ORDERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const BULLET = /^\s*[-*+•]\s+(.*)$/;

/** A table row as prose: its cells in one line. */
function tableRow(line: string): string {
  const t = line.trim();
  if (!(t.startsWith('|') && t.endsWith('|') && t.length > 1)) return line;
  return t
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim())
    .join(' · ');
}

function units(text: string): Unit[] {
  const out: Unit[] = [];
  let current: Unit | undefined;
  let blank = false as boolean;
  const end = () => {
    current = undefined;
  };
  const paragraph = (line: string, afterBlank: boolean) => {
    if (current?.kind === 'list' && !afterBlank) {
      current.items[current.items.length - 1].push(line.trim());
      return;
    }
    if (current?.kind !== 'paragraph') {
      current = { kind: 'paragraph', lines: [] };
      out.push(current);
    }
    current.lines.push(line.trim());
  };
  const item = (ordered: boolean, start: number, line: string) => {
    if (current?.kind !== 'list' || current.ordered !== ordered) {
      current = { kind: 'list', ordered, start, items: [] };
      out.push(current);
    }
    current.items.push([line.trim()]);
  };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (raw.trim() === '') {
      if (current?.kind === 'paragraph') end();
      blank = true;
      continue;
    }
    const line = raw.replace(/^(\s*>)+\s?/, '');
    const afterBlank: boolean = blank;
    blank = false;
    if (FENCE.test(line)) {
      blank = afterBlank;
      continue;
    }
    if (RULE.test(line) || (line.includes('|') && line.includes('-') && TABLE_RULE.test(line))) {
      end();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      end();
      out.push({ kind: 'paragraph', lines: [heading[1]] });
      continue;
    }
    const ordered = ORDERED.exec(line);
    if (ordered) {
      item(true, Number(ordered[1]), ordered[2]);
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      item(false, 1, bullet[1]);
      continue;
    }
    paragraph(tableRow(line), afterBlank);
  }
  return out;
}

type Token = { type: 'text'; text: string } | { type: 'code'; text: string } | { type: 'bold' };

/**
 * Emphasis and strikethrough: drawn as nothing. `2 * 3`, `snake_case` and a lone `~` are prose and stay.
 * Runs over the whole inline run, bold marks and code spans already masked, so a pair they cut is still a pair.
 */
const unStyle = (text: string): string =>
  text
    .replace(/(?<![*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?!\*)/g, '$1')
    .replace(/(?<!\w)_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g, '$1')
    .replace(/~~(?=\S)([^~\n]+?)(?<=\S)~~/g, '$1');

/** `***` is bold around italic; `__` is bold only at a word edge, so `__init__x` stays prose. */
const BOLD_MARK = /\*\*\*|\*\*|(?<!\w)__(?=\S)|(?<=\S)__(?!\w)/g;

/** Private-use stand-ins that keep a mark or an already-final span out of the emphasis rules. */
const BOLD_CHAR = '\uE000';
const slotChar = (i: number): string => String.fromCharCode(0xe001 + i);
const MASKED = /[\uE000-\uF8FF]/;

/** Inline forms outside the subset reduced to their text: links and images to their label, autolinks to the URL, HTML tags away. */
const plainForms = (text: string): string =>
  text
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/<([a-z][a-z0-9+.-]*:[^\s<>]*)>/gi, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[a-z][^>\n\uE000-\uF8FF]*>/gi, '');

function tokens(raw: string): Token[] {
  const slots: Token[] = [];
  const slot = (token: Token): string => {
    slots.push(token);
    return slotChar(slots.length - 1);
  };
  const prose = (text: string): string =>
    text.replace(/\\([!-/:-@[-`{-~])|[\uE000-\uF8FF]/g, (glyph, c?: string) =>
      slot({ type: 'text', text: c ?? glyph }),
    );
  let masked = '';
  let at = 0;
  const fence = /`+/g;
  for (let open = fence.exec(raw); open; open = fence.exec(raw)) {
    const size = open[0].length;
    const close = new RegExp(`(?<!\`)\`{${size}}(?!\`)`, 'g');
    close.lastIndex = fence.lastIndex;
    const found = close.exec(raw);
    masked += prose(raw.slice(at, open.index));
    if (found) {
      masked += slot({
        type: 'code',
        text: raw.slice(fence.lastIndex, found.index),
      });
      at = found.index + size;
    } else {
      at = fence.lastIndex;
    }
    fence.lastIndex = at;
  }
  masked += prose(raw.slice(at));
  const out: Token[] = [];
  const styled = unStyle(
    plainForms(masked).replace(BOLD_MARK, (mark) => (mark === '***' ? `${BOLD_CHAR}*` : BOLD_CHAR)),
  );
  for (const piece of styled.split(new RegExp(`(${MASKED.source})`))) {
    if (piece === '') continue;
    if (piece === BOLD_CHAR) out.push({ type: 'bold' });
    else if (MASKED.test(piece)) out.push(slots[piece.charCodeAt(0) - 0xe001]);
    else out.push({ type: 'text', text: piece });
  }
  return out;
}

const startsSpace = (t: Token | undefined): boolean =>
  t === undefined || (t.type === 'text' && /^\s/.test(t.text)) || t.type === 'bold';
const endsSpace = (t: Token | undefined): boolean =>
  t === undefined || (t.type === 'text' && /\s$/.test(t.text)) || t.type === 'bold';

/** Pairs bold marks left to right; a bold never nests, and a mark left unpaired is dropped. */
function inlines(raw: string): Inline[] {
  const toks = tokens(raw);
  const out: Inline[] = [];
  let open: { into: Inline[] } | undefined;
  const push = (into: Inline[], node: Inline) => {
    const last = into[into.length - 1];
    if (node.type === 'text' && last?.type === 'text') last.text += node.text;
    else into.push(node);
  };
  toks.forEach((tok, i) => {
    if (tok.type !== 'bold') {
      push(open ? open.into : out, tok);
      return;
    }
    const canOpen = !startsSpace(toks[i + 1]);
    const canClose = !endsSpace(toks[i - 1]);
    if (open && canClose) {
      if (open.into.length > 0) out.push({ type: 'bold', children: open.into });
      open = undefined;
    } else if (canOpen) {
      if (open) for (const child of open.into) push(out, child);
      open = { into: [] };
    }
  });
  if (open) for (const child of open.into) push(out, child);
  return out;
}

/** Each text leaf with the links it names put in place; `remaining` is the links still unnamed. */
function linked(nodes: Inline[], remaining: ManagerLink[]): Inline[] {
  return nodes.flatMap((node): Inline[] => {
    if (node.type === 'bold') return [{ type: 'bold', children: linked(node.children, remaining) }];
    if (node.type !== 'text') return [node];
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
  const blocks = units(text).map((unit): Block => {
    if (unit.kind === 'paragraph') {
      return {
        type: 'paragraph',
        inlines: linked(inlines(unit.lines.join('\n')), remaining),
      };
    }
    return {
      type: 'list',
      ordered: unit.ordered,
      start: unit.start,
      items: unit.items.map((lines) => linked(inlines(lines.join('\n')), remaining)),
    };
  });
  return { blocks, rest: remaining };
}
