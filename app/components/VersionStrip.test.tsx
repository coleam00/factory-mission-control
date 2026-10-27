import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { NOT_RECORDED, type StripEntry, stripEntries } from '../lib/version-strip';
import {
  SELECT_PARAM,
  toggleSelection,
  useSelectedVersions,
  VersionList,
  withSelection,
} from './VersionStrip';

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
            onSelect={() => {}}
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

test('two versions sharing a pin get select buttons named apart by their digest', () => {
  const V4 = `sha256:${'d4'.repeat(32)}`;
  const rows = [
    entry({ digest: V3, pin: '58c5f77400', date: '2026-10-19' }),
    entry({ digest: V4, pin: '58c5f77400', date: '2026-10-19' }),
    entry({ digest: V1, pin: null, date: NOT_RECORDED }),
  ];
  const names = [...render([V4], '', rows).matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map(
    (m) => m[1],
  );
  expect(names).toEqual([
    `Select 2026-10-19, pin 58c5f774, ${V3.slice(0, 19)}`,
    `Selected 2026-10-19, pin 58c5f774, ${V4.slice(0, 19)}`,
    `Select not recorded, pin not recorded, ${V1.slice(0, 19)}`,
  ]);
  expect(new Set(names).size).toBe(3);
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

test('comparison guidance follows the versions that can be picked, not the entries shown', () => {
  const pending = [
    entry({ pin: 'f00dfeed00', date: '2026-10-25' }),
    entry({ pin: 'cafebabe00', date: '2026-10-26' }),
  ];
  const none = render([], '', pending);
  expect(none.match(/data-kind="pending"/g)).toHaveLength(2);
  expect(none).not.toContain('<button');
  expect(none).toContain('No version has run yet, so there is nothing to compare.');
  expect(none).not.toContain('Select two versions');

  const one = [entry({ digest: V1, pin: '8e3e1cef00', date: '2026-09-30' }), ...pending];
  const unpicked = render([], '', one);
  expect(unpicked).toContain('Only one version has run; a comparison needs a second.');
  expect(unpicked).not.toContain('Select two versions');
  const picked = render([V1], '', one);
  expect(picked).toContain('data-scorecard="one"');
  expect(picked).toContain('A comparison needs a second version that has run.');
  expect(picked).not.toContain('Select another version');

  expect(render([])).toContain('Select two versions to compare.');
  expect(render([V2])).toContain('Select another version to compare.');
  expect(render([V2, V1])).toContain('data-compare="scorecard"');
});

/** The strip with its selection held in the address, as the versions screen wires it. */
function Strip() {
  const [selected, select] = useSelectedVersions();
  return (
    <VersionList
      factory="mission-control"
      entries={entries}
      selected={selected}
      onSelect={select}
    />
  );
}

/** The strip beside a scorecard page, in a router at `path`. */
function screenAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/f/:factory/versions', element: <Strip /> },
      { path: '/f/:factory/scorecard', element: <p>scorecard</p> },
    ],
    { initialEntries: [path] },
  );
  const html = () => renderToStaticMarkup(<RouterProvider router={router} />);
  return { router, html };
}

const selectedDigests = (html: string) =>
  [...html.matchAll(/data-digest="([^"]+)"[^>]*>(?:(?!<li).)*aria-pressed="true"/gs)].map(
    (m) => m[1],
  );

test('a selection is written to the address in order, keeping a destination', () => {
  const was = new URLSearchParams({ pin: '5ffd60c600', [SELECT_PARAM]: V1 });
  const next = withSelection(was, toggleSelection([V1], V2));
  expect(next.getAll(SELECT_PARAM)).toEqual([V1, V2]);
  expect(next.get('pin')).toBe('5ffd60c600');
  expect(was.getAll(SELECT_PARAM)).toEqual([V1]);
  expect(withSelection(next, []).toString()).toBe('pin=5ffd60c600');
});

test('select a version, open its scorecard, press Back: it is still selected with its link', async () => {
  const { router, html } = screenAt(
    `/f/mission-control/versions?${SELECT_PARAM}=${encodeURIComponent(V2)}`,
  );
  const link = /<a data-scorecard="one"[^>]*href="([^"]+)"/.exec(html())?.[1] ?? '';
  expect(link).toBe(`/f/mission-control/scorecard?a=${encodeURIComponent(V2)}`);
  await router.navigate(link.replaceAll('&amp;', '&'));
  expect(html()).toContain('scorecard');
  await router.navigate(-1);
  expect(router.state.location.pathname).toBe('/f/mission-control/versions');
  const back = html();
  expect(selectedDigests(back)).toEqual([V2]);
  expect(back).toContain('data-scorecard="one"');
});

test('two selected versions survive a reload, and their compare links are offered', () => {
  const search = `?${SELECT_PARAM}=${encodeURIComponent(V2)}&${SELECT_PARAM}=${encodeURIComponent(V1)}`;
  const html = screenAt(`/f/mission-control/versions${search}`).html();
  expect(selectedDigests(html)).toEqual([V1, V2]);
  expect(html).toContain('data-compare="scorecard"');
  expect(html).toContain('data-compare="diff"');
});

test('an address naming an unknown or another factory’s version selects nothing, with no error', () => {
  for (const digest of ['sha256:unknown', `sha256:${'ee'.repeat(32)}`, '', V1.toUpperCase()]) {
    const html = screenAt(
      `/f/mission-control/versions?${SELECT_PARAM}=${encodeURIComponent(digest)}`,
    ).html();
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).not.toContain('data-scorecard');
    expect(html).not.toContain('data-compare');
    expect(html).toContain('Select two versions to compare.');
  }
  // An unknown digest beside a known one leaves just the known one picked.
  const mixed = screenAt(
    `/f/mission-control/versions?${SELECT_PARAM}=sha256:unknown&${SELECT_PARAM}=${encodeURIComponent(V3)}`,
  ).html();
  expect(selectedDigests(mixed)).toEqual([V3]);
  expect(mixed).toContain('data-scorecard="one"');
});

test('pressing select toggles a version and keeps the last two picked', () => {
  expect(toggleSelection([], V1)).toEqual([V1]);
  expect(toggleSelection([V1], V1)).toEqual([]);
  expect(toggleSelection([V1, V2], V3)).toEqual([V2, V3]);
  expect(toggleSelection([V1, V2], V1)).toEqual([V2]);
});
