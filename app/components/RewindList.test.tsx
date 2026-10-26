import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
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

test('the indicator names the rewind branch and links back, and is absent on the home branch', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <RewindIndicator rewind={OLDER} />
    </MemoryRouter>,
  );
  expect(html).toContain(`data-rewind-indicator="${OLDER}"`);
  expect(textOf(html)).toContain('read-only');
  expect(html).toContain('href="/rewind"');
  expect(
    renderToStaticMarkup(
      <MemoryRouter>
        <RewindIndicator rewind={null} />
      </MemoryRouter>,
    ),
  ).toBe('');
});
