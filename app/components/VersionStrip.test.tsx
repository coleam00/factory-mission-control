import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { NOT_RECORDED, type StripEntry, stripEntries } from '../lib/version-strip';
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
  entry({ digest: V1, pin: '8e3e1cef00', date: '2026-09-30' }),
  entry({ digest: V2, pin: '5ffd60c600', date: '2026-10-09' }),
  entry({
    digest: V3,
    pin: '58c5f77400',
    date: '2026-10-19',
    hypothesis: NOT_RECORDED,
    measure: NOT_RECORDED,
  }),
  entry({ pin: 'f00dfeed00', date: '2026-10-25' }),
];

function render(selected: readonly string[], search = '', rows = entries): string {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <VersionList
            factory="mission-control"
            entries={rows}
            selected={selected}
            onToggle={() => {}}
          />
        ),
      },
    ],
    { initialEntries: [`/${search}`] },
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const entryHtml = (html: string, marker: string) =>
  html.split('<li').find((li) => li.includes(marker)) ?? '';

test('the visible date and select label follow the pin, including an unknown pin', () => {
  const row = {
    digest: V1,
    first_run_at: new Date('2026-10-01T09:00:00Z'),
    pin_sha: null,
    committed_at: null,
    reason: null,
    hypothesis: null,
    measure: null,
  };
  const unknown = render([], '', stripEntries([row]));
  expect(unknown).toContain('data-date="not recorded"');
  expect(unknown).toContain('Select not recorded');
  expect(unknown).not.toContain('2026-10-01');
  const labelled = render(
    [],
    '',
    stripEntries([{ ...row, pin_sha: 'latepin1', committed_at: new Date('2026-09-30T18:00:00Z') }]),
  );
  expect(labelled).toContain('data-pin="latepin1"');
  expect(labelled).toContain('data-date="2026-09-30"');
  expect(labelled).toContain('Select 2026-09-30');
  expect(labelled).not.toContain('2026-10-01');
});

test('a version with no trailers shows not recorded, and a pin not yet run cannot be picked', () => {
  const html = render([]);
  expect(entryHtml(html, `data-digest="${V3}"`)).toContain(`data-hypothesis="${NOT_RECORDED}"`);
  expect(entryHtml(html, `data-digest="${V3}"`)).toContain(`data-measure="${NOT_RECORDED}"`);
  const pending = entryHtml(html, 'data-kind="pending"');
  expect(pending).toContain('Not yet run');
  expect(pending).not.toContain('<button');
  expect(html).not.toContain('data-compare');
});

test('a copied destination highlights only its exact pin and digest without picking comparisons', () => {
  const rows = [...entries, entry({ pin: entries[1].pin, digest: 'sha256:another' })];
  const html = render([], `?pin=${entries[1].pin}&digest=${encodeURIComponent(V2)}`, rows);
  expect(entryHtml(html, `data-digest="${V2}"`)).toContain('aria-current="true"');
  expect(html.match(/aria-current="true"/g)).toHaveLength(1);
  expect(html).not.toContain('aria-pressed="true"');
  expect(html).not.toContain('data-compare');
});

test('an unused pin is the destination and an unknown or mismatched version never targets another', () => {
  const html = render([], '?pin=f00dfeed00');
  const pending = entryHtml(html, 'data-kind="pending"');
  expect(pending).toContain('aria-current="true"');
  expect(pending).toContain('bg-surface-hover');
  expect(pending).toContain('Not yet run');
  expect(html.match(/aria-current="true"/g)).toHaveLength(1);
  expect(render([], '?pin=unknown')).not.toContain('aria-current');
  expect(render([], `?pin=f00dfeed00&digest=${encodeURIComponent(V1)}`)).not.toContain(
    'aria-current',
  );
  expect(render([])).not.toContain('aria-current');
});

test('two picked versions link to their scorecard and diff, older as a, whatever the click order', () => {
  const html = render([V2, V1]);
  const href = (kind: string) =>
    new RegExp(`<a data-compare="${kind}"[^>]*href="([^"]+)"`).exec(html)?.[1];
  const query = `?a=${encodeURIComponent(V1)}&amp;b=${encodeURIComponent(V2)}`;
  expect(href('scorecard')).toBe(`/f/mission-control/scorecard${query}`);
  expect(href('diff')).toBe(`/f/mission-control/diff${query}`);
});

test('one picked version links to its own scorecard, and none or two picked show no such link', () => {
  const html = render([V2]);
  const href = /<a data-scorecard="one"[^>]*href="([^"]+)"/.exec(html)?.[1];
  expect(href).toBe(`/f/mission-control/scorecard?a=${encodeURIComponent(V2)}`);
  expect(html).not.toContain('data-compare');
  expect(render([])).not.toContain('data-scorecard');
  expect(render([V2, V1])).not.toContain('data-scorecard');
});
