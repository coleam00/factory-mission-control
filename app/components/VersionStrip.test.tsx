import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { NOT_RECORDED, type StripEntry } from '../lib/version-strip';
import { VersionList } from './VersionStrip';

const entry = (over: Partial<StripEntry>): StripEntry => ({
  digest: null,
  pin: null,
  date: '2026-10-01',
  reason: 'a reason',
  hypothesis: 'a hypothesis',
  measure: 'a measure',
  ...over,
});

const V1 = `sha256:${'a1'.repeat(32)}`;
const V2 = `sha256:${'b2'.repeat(32)}`;
const V3 = `sha256:${'c3'.repeat(32)}`;
const entries = [
  entry({ digest: V1, pin: '8e3e1cef00', date: '2026-10-01' }),
  entry({ digest: V2, pin: '5ffd60c600', date: '2026-10-10' }),
  entry({
    digest: V3,
    pin: '58c5f77400',
    date: '2026-10-20',
    hypothesis: NOT_RECORDED,
    measure: NOT_RECORDED,
  }),
  entry({ pin: 'f00dfeed00', date: '2026-10-25' }),
];

function render(selected: readonly string[]): string {
  const router = createMemoryRouter([
    {
      path: '/',
      element: (
        <VersionList
          factory="mission-control"
          entries={entries}
          selected={selected}
          onToggle={() => {}}
        />
      ),
    },
  ]);
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const entryHtml = (html: string, marker: string) =>
  html.split('<li').find((li) => li.includes(marker)) ?? '';

test('a version with no trailers shows not recorded, and a pin not yet run cannot be picked', () => {
  const html = render([]);
  expect(entryHtml(html, `data-digest="${V3}"`)).toContain(`data-hypothesis="${NOT_RECORDED}"`);
  expect(entryHtml(html, `data-digest="${V3}"`)).toContain(`data-measure="${NOT_RECORDED}"`);
  const pending = entryHtml(html, 'data-kind="pending"');
  expect(pending).toContain('Not yet run');
  expect(pending).not.toContain('<button');
  expect(html).not.toContain('data-compare');
});

test('two picked versions link to their scorecard and diff, older as a, whatever the click order', () => {
  const html = render([V2, V1]);
  const href = (kind: string) =>
    new RegExp(`<a data-compare="${kind}"[^>]*href="([^"]+)"`).exec(html)?.[1];
  const query = `?a=${encodeURIComponent(V1)}&amp;b=${encodeURIComponent(V2)}`;
  expect(href('scorecard')).toBe(`/f/mission-control/scorecard${query}`);
  expect(href('diff')).toBe(`/diff${query}`);
});
