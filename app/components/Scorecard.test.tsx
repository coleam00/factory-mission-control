import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { MEASURES, type ScorecardRow } from '../lib/scorecard';
import { ScorecardView } from './Scorecard';

const V1 = `sha256:${'a1'.repeat(32)}`;
const V2 = `sha256:${'b2'.repeat(32)}`;

/** `n` finished laps of `digest`, an hour apart; the first `merged` of them merge. */
function laps(digest: string, n: number, merged: number): ScorecardRow[] {
  return Array.from({ length: n }, (_, i): ScorecardRow[] => {
    const start = new Date(Date.UTC(2026, 9, 1, i));
    const run_id = `${digest.slice(7, 11)}-${String(i).padStart(2, '0')}`;
    return [
      {
        run_id,
        digest,
        workflow_name: 'archon-loop',
        status: 'completed',
        started_at: start,
        completed_at: new Date(start.getTime() + 30 * 60_000),
        step_id: null,
        pin_sha: null,
      },
      {
        run_id,
        step_id: 'land',
        duration_ms: null,
        cost_usd: 0.5,
        route: null,
        outcome: i < merged ? 'merged' : 'refused',
        reason: i < merged ? 'Merged.' : 'it changes ci.yml',
        holdout_catches: 0,
        pin_sha: null,
      },
      {
        run_id,
        step_id: 'check-app',
        duration_ms: 1000,
        cost_usd: null,
        route: null,
        outcome: null,
        reason: null,
        holdout_catches: 0,
        pin_sha: null,
      },
    ];
  }).flat();
}

/** The mc.versions row of `digest`. */
const version = (digest: string, at: string, sha: string | null): ScorecardRow => ({
  run_id: null,
  step_id: null,
  digest,
  first_run_at: new Date(at),
  pin_sha: sha,
});

function render(rows: ScorecardRow[], a: string | undefined, b?: string): string {
  const router = createMemoryRouter([
    { path: '/', element: <ScorecardView factory="mission-control" a={a} b={b} rows={rows} /> },
  ]);
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

/** The number a cell or a difference writes on screen. */
const shownText = (html: string) => /text-\[13px\][^"]*">([^<]*)</.exec(html)?.[1];

/** Each measure cell: its attributes, its summary's number and the laps it lists. */
function cells(html: string) {
  const starts = [...html.matchAll(/<div data-version="(a|b)"[^>]*data-measure="/g)];
  return starts.map((m, i) => {
    const cell = html.slice(m.index, starts[i + 1]?.index ?? html.length);
    const attr = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(cell)?.[1];
    return {
      version: m[1],
      measure: attr('data-measure'),
      value: attr('data-value'),
      text: shownText(cell),
      laps: Number(attr('data-laps')),
      summary: Number(/<summary[^>]*>(\d+) laps?<\/summary>/.exec(cell)?.[1]),
      listed: (cell.split('</details>')[0].match(/data-lap="/g) ?? []).length,
    };
  });
}

const differences = (html: string) =>
  [
    ...html.matchAll(
      /<div data-difference="([^"]*)" data-meaningful="(true|false)"[^>]*>(.*?)<\/div><\/div>/g,
    ),
  ].map(([, value, isMeaningful, body]) => ({ value, meaningful: isMeaningful, body }));

test('every measure carries its key, its plain value and its laps, and lists exactly those laps', () => {
  const shown = cells(render(laps(V1, 12, 3), V1));
  expect(shown).toHaveLength(12);
  for (const cell of shown) {
    expect(cell.value).toMatch(/^\d+(\.\d{1,4})?$/);
    expect(cell.summary).toBe(cell.laps);
    expect(cell.listed).toBe(cell.laps);
  }
  expect(shown.find((c) => c.measure === 'merges')).toMatchObject({ value: '3', laps: 12 });
  expect(shown.find((c) => c.measure === 'cost_per_merge')?.value).toBe('2');
});

test('costs read as the laps screen writes them, counts whole, ratios without trailing zeros', () => {
  const html = render([...laps(V1, 12, 3), ...laps(V2, 12, 4)], V1, V2);
  const text = (side: string) =>
    Object.fromEntries(
      cells(html)
        .filter((c) => c.version === side)
        .map((c) => [c.measure, c.text]),
    );
  const changes = Object.fromEntries(
    differences(html).map((d, i) => [MEASURES[i].key, shownText(d.body)]),
  );
  expect(text('a')).toEqual({
    laps: '12',
    merges: '3',
    empty_laps: '0',
    failed_laps: '0',
    send_backs: '0',
    gate_refusals: '9',
    active_hours: '12',
    merges_per_active_hour: '0.25',
    lap_hours_per_merge: '2',
    app_check_share: '0.0006',
    cost_per_merge: '$2.00',
    new_holdout_catches: '0',
  });
  expect(text('b')).toMatchObject({
    merges: '4',
    gate_refusals: '8',
    merges_per_active_hour: '0.3333',
    lap_hours_per_merge: '1.5',
    cost_per_merge: '$1.50',
  });
  expect(changes).toEqual({
    laps: '0',
    merges: '+1',
    empty_laps: '0',
    failed_laps: '0',
    send_backs: '0',
    gate_refusals: '-1',
    active_hours: '0',
    merges_per_active_hour: '+0.0833',
    lap_hours_per_merge: '-0.5',
    app_check_share: '0',
    cost_per_merge: '-$0.50',
    new_holdout_catches: '0',
  });
  for (const d of differences(html)) expect(shownText(d.body)).toBe(d.value);
});

test('a count marks the laps it counted, and a gate refusal shows its reason', () => {
  const html = render(laps(V1, 3, 1), V1);
  const refusals = html.slice(html.indexOf('data-measure="gate_refusals"'));
  const list = refusals.slice(0, refusals.indexOf('</details>'));
  expect((list.match(/data-counted="true"/g) ?? []).length).toBe(2);
  expect(list).toContain('it changes ci.yml');
  expect(list).not.toContain('Merged.');
});

test('with no merge the per-merge measures show n/a', () => {
  const html = render(laps(V1, 2, 0), V1);
  for (const measure of ['cost_per_merge', 'lap_hours_per_merge']) {
    const cell = cells(html).find((c) => c.measure === measure);
    expect(cell?.value).toBe('n/a');
    expect(html).toMatch(new RegExp(`data-measure="${measure}"[^>]*>.*?>n/a</span>`));
  }
});

test('a side under 10 laps labels each difference not yet meaningful; 12 against 12 does not', () => {
  const thin = differences(render([...laps(V1, 12, 3), ...laps(V2, 9, 4)], V1, V2));
  expect(thin).toHaveLength(12);
  for (const d of thin) {
    expect(d.meaningful).toBe('false');
    expect(d.body).toContain('not yet meaningful');
  }
  const both = differences(render([...laps(V1, 12, 3), ...laps(V2, 12, 4)], V1, V2));
  expect(both).toHaveLength(12);
  for (const d of both) {
    expect(d.meaningful).toBe('true');
    expect(d.body).not.toContain('not yet meaningful');
  }
  expect(both.find((d) => d.value === '+1')).toBeDefined();
});

test('with no version picked, it is an empty state linking to the versions', () => {
  const html = render(laps(V1, 2, 1), undefined);
  expect(html).not.toContain('data-measure=');
  expect(html).toContain('href="/f/mission-control/versions"');
  expect(render([], undefined)).toContain('Pick a version on the versions screen');
});

test('a version no lap ran is still compared: 0 laps, n/a where undefined, not yet meaningful', () => {
  const rows = [...laps(V1, 12, 3), version(V2, '2026-10-09T00:00:00Z', null)];
  const html = render(rows, V1, V2);
  const shown = cells(html);
  expect(shown).toHaveLength(24);
  const a = shown.filter((c) => c.version === 'a');
  const b = shown.filter((c) => c.version === 'b');
  expect(a.find((c) => c.measure === 'merges')).toMatchObject({ value: '3', laps: 12 });
  for (const cell of b) {
    expect(cell).toMatchObject({ laps: 0, summary: 0, listed: 0 });
  }
  const value = (measure: string) => b.find((c) => c.measure === measure)?.value;
  for (const measure of ['laps', 'merges', 'empty_laps', 'active_hours', 'new_holdout_catches']) {
    expect(value(measure)).toBe('0');
  }
  for (const measure of [
    'merges_per_active_hour',
    'lap_hours_per_merge',
    'app_check_share',
    'cost_per_merge',
  ]) {
    expect(value(measure)).toBe('n/a');
  }
  const diffs = differences(html);
  expect(diffs).toHaveLength(12);
  for (const d of diffs) {
    expect(d.meaningful).toBe('false');
    expect(d.body).toContain('not yet meaningful');
  }
  expect(diffs.find((d) => d.value === '-3')).toBeDefined();
  expect(html).toContain('no lap ran yet');
  // The same with the 0-lap version on side a.
  const flipped = cells(render(rows, V2, V1));
  expect(flipped.filter((c) => c.version === 'a').every((c) => c.laps === 0)).toBe(true);
  expect(flipped.find((c) => c.version === 'b' && c.measure === 'merges')?.value).toBe('3');
});

test("a digest that is not one of this factory's versions is not found, one sentence and one button", () => {
  const rows = [...laps(V1, 12, 3), version(V1, '2026-10-01T00:00:00Z', null)];
  const sentences = (html: string) =>
    [...html.matchAll(/<p[^>]*>([^<]*)<\/p>/g)].map((m) => m[1].replaceAll('&#x27;', "'"));
  const OTHER = `sha256:${'d4'.repeat(32)}`;
  for (const [a, b, said] of [
    [OTHER, undefined, `sha256:${'d4'.repeat(6)} is not a version of this factory.`],
    ['8e3e1cef', undefined, '8e3e1cef is not a version of this factory.'],
    ['sha256:zzzz', undefined, 'sha256:zzzz is not a version of this factory.'],
    [V1, OTHER, `sha256:${'d4'.repeat(6)} is not a version of this factory.`],
    [
      OTHER,
      'sha256:zzzz',
      `sha256:${'d4'.repeat(6)} and sha256:zzzz are not versions of this factory.`,
    ],
  ] as const) {
    const html = render(rows, a, b);
    expect(html).not.toContain('data-measure=');
    expect(html).not.toContain('data-version=');
    expect(sentences(html)).toEqual([said]);
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('href="/f/mission-control/versions"');
  }
});

test('each version is named by its version row, as the versions screen names it', () => {
  const laps1And2 = [
    ...laps(V1, 2, 1),
    ...laps(V2, 2, 1).map((r) =>
      r.step_id === null && r.run_id !== null
        ? { ...r, started_at: new Date('2026-10-09T00:00:00Z') }
        : r,
    ),
  ];
  const v1 = version(V1, '2026-10-01T00:00:00Z', '8e3e1cefaf1e1b7955789d6a43a81b6c2dbd7082');
  const header = (html: string, side: string) =>
    new RegExp(
      `<div data-version="${side}" data-digest="[^"]*"( data-pin="([^"]*)")?[^>]*>(.*?)</div></div>`,
    ).exec(html);
  const before = render(
    [
      ...laps1And2,
      v1,
      version(V2, '2026-10-09T00:00:00Z', '8e3e1cefaf1e1b7955789d6a43a81b6c2dbd7082'),
    ],
    V1,
    V2,
  );
  expect(header(before, 'a')?.[2]).toBe('8e3e1cefaf1e1b7955789d6a43a81b6c2dbd7082');
  expect(header(before, 'a')?.[3]).toContain('8e3e1cef');
  expect(header(before, 'a')?.[3]).toContain('first run 2026-10-01');
  expect(header(before, 'b')?.[2]).toBe('8e3e1cefaf1e1b7955789d6a43a81b6c2dbd7082');

  // A pin committed later relabels V2's row (mc.label_versions); the screen follows the row.
  const after = render(
    [
      ...laps1And2,
      v1,
      version(V2, '2026-10-09T00:00:00Z', '5ffd60c6c6e591487f2fbb5ec67ccc8fc55ca915'),
    ],
    V1,
    V2,
  );
  expect(header(after, 'a')?.[2]).toBe('8e3e1cefaf1e1b7955789d6a43a81b6c2dbd7082');
  expect(header(after, 'b')?.[2]).toBe('5ffd60c6c6e591487f2fbb5ec67ccc8fc55ca915');
  expect(header(after, 'b')?.[3]).toContain('5ffd60c6');

  const unpinned = render([...laps(V1, 2, 1), version(V1, '2026-10-01T00:00:00Z', null)], V1);
  expect(header(unpinned, 'a')?.[1]).toBeUndefined();
  expect(header(unpinned, 'a')?.[3]).toContain('not recorded');
  expect(header(unpinned, 'a')?.[3]).toContain('first run 2026-10-01');

  const notAVersion = render(laps(V1, 2, 1), V1);
  expect(header(notAVersion, 'a')?.[1]).toBeUndefined();
  expect(header(notAVersion, 'a')?.[3]).toContain('not recorded');
  expect(header(notAVersion, 'a')?.[3]).not.toContain('first run');
});
