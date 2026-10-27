import { afterEach, expect, test } from 'bun:test';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RewindBranchRow } from '../lib/rewind';
import { RewindIndicator } from './FactoryStrip';
import { RewindBranches, RewindRows } from './RewindList';

const NEWER = 'rewind-2026-10-25t09-30-00z';
const OLDER = 'rewind-2026-10-24t11-00-00z';
const rows: RewindBranchRow[] = [
  {
    name: NEWER,
    parent: 'check-abc',
    at: new Date('2026-10-25T09:30:00Z'),
    created_at: new Date('2026-10-25T09:31:00Z'),
  },
  {
    name: OLDER,
    parent: 'main',
    at: new Date('2026-10-24T11:00:00Z'),
    created_at: new Date('2026-10-24T11:02:00Z'),
  },
];

const render = (shown: string | null) =>
  renderToStaticMarkup(<RewindRows rows={rows} shown={shown} onSwitch={() => {}} />);

const rowHtml = (html: string, name: string) =>
  html.split('<li').find((li) => li.includes(`data-rewind-branch="${name}"`)) ?? '';

const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

test('lists the branches in the order the query gives, each with its moment and parent', () => {
  const html = render(null);
  expect(html.indexOf(NEWER)).toBeLessThan(html.indexOf(OLDER));
  expect(textOf(rowHtml(html, OLDER))).toContain('as of 2026-10-24 11:00:00 UTC');
  expect(textOf(rowHtml(html, OLDER))).toContain('from main');
  expect(rowHtml(html, OLDER)).toContain(`aria-label="Show ${OLDER}"`);
  expect(html).not.toContain('data-current');
  expect(html).not.toContain('Back to the live branch');
});

test('while rewound, the shown branch is marked and has no Show button, and the way back is offered', () => {
  const html = render(OLDER);
  const current = rowHtml(html, OLDER);
  expect(current).toContain('data-current');
  expect(current).not.toContain('<button');
  expect(current).toContain('Shown');
  expect(rowHtml(html, NEWER)).toContain('<button');
  expect(html).toContain('Back to the live branch');
  expect(textOf(html)).toContain(`Showing ${OLDER} , read-only.`);
});

test('before Realtime is ready the list is one loading sentence and no button', () => {
  const html = renderToStaticMarkup(<RewindBranches factory={undefined} shown={null} />);
  expect(textOf(html)).toContain('Loading rewind branches.');
  expect(html).not.toMatch(/<button\b/);
});

test('the indicator names the rewind branch and offers the way back, and is absent on the home branch', () => {
  const html = renderToStaticMarkup(<RewindIndicator rewind={OLDER} />);
  expect(html).toContain(`data-rewind-indicator="${OLDER}"`);
  expect(textOf(html)).toContain('read-only');
  expect(html).toContain('Switch back');
  expect(html).not.toContain('href=');
  expect(renderToStaticMarkup(<RewindIndicator rewind={null} />)).toBe('');
});

type Props = { children?: ReactNode; onClick?: () => void; [key: string]: unknown };

/** The element under `node` that carries `attribute`, walking the tree the component returned. */
const findElement = (node: ReactNode, attribute: string): ReactElement<Props> | undefined => {
  if (node === null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, attribute);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const element = node as ReactElement<Props>;
  if (element.props?.[attribute] !== undefined) return element;
  return findElement(element.props?.children, attribute);
};

const realFetch = globalThis.fetch;
const realWindow = (globalThis as { window?: unknown }).window;
afterEach(() => {
  globalThis.fetch = realFetch;
  (globalThis as { window?: unknown }).window = realWindow;
});

/** Clicks the indicator's Switch back with `fetch` answering `status`; returns what it did. */
const clickSwitchBack = async (status: number) => {
  const posts: { url: string; init: RequestInit | undefined }[] = [];
  const assigned: string[] = [];
  let reloads = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    posts.push({ url, init });
    return new Response(JSON.stringify(status === 200 ? { ok: true } : { error: 'refused' }), {
      status,
    });
  }) as typeof fetch;
  (globalThis as { window?: unknown }).window = {
    location: {
      assign: (to: string) => assigned.push(to),
      reload: () => {
        reloads += 1;
      },
    },
  };
  const tree = RewindIndicator({ rewind: OLDER });
  const button = findElement(tree, 'data-indicator-switch-back');
  expect(button?.type).toBe('button');
  button?.props.onClick?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { posts, assigned, reloads };
};

test('clicking Switch back posts {branch: null} to /api/rewind, then reloads the same screen', async () => {
  const { posts, assigned, reloads } = await clickSwitchBack(200);
  expect(posts).toHaveLength(1);
  expect(posts[0]?.url).toBe('/api/rewind');
  expect(posts[0]?.init?.method).toBe('POST');
  expect(JSON.parse(String(posts[0]?.init?.body))).toEqual({ branch: null });
  expect(reloads).toBe(1);
  expect(assigned).toEqual([]);
});

test('a refused Switch back opens /rewind, where the way back says why', async () => {
  const { posts, assigned, reloads } = await clickSwitchBack(503);
  expect(posts).toHaveLength(1);
  expect(assigned).toEqual(['/rewind']);
  expect(reloads).toBe(0);
});
