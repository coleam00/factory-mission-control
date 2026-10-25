import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { ScorecardRow } from '../lib/scorecard';
import { ScorecardView } from './Scorecard';

const V1 = `sha256:${'a1'.repeat(32)}`;
const V2 = `sha256:${'b2'.repeat(32)}`;

/** `n` finished laps of `digest`, an hour apart; the first `merged` of them merge. */
function laps(digest: string, n: number, merged: number): ScorecardRow[] {
  return Array.from({ length: n }, (_, i) => {
    const start = new Date(Date.UTC(2026, 9, 1, i));
    return {
      run_id: `${digest.slice(7, 11)}-${String(i).padStart(2, '0')}`,
      digest,
      status: 'completed',
      started_at: start,
      completed_at: new Date(start.getTime() + 30 * 60_000),
      step_id: 'land',
      duration_ms: 1000,
      cost_usd: 0.5,
      route: null,
      outcome: i < merged ? 'merged' : 'refused',
      reason: i < merged ? 'Merged.' : 'it changes ci.yml',
    };
  });
}

function render(rows: ScorecardRow[], a: string | undefined, b?: string): string {
  const router = createMemoryRouter([
    { path: '/', element: <ScorecardView factory="mission-control" a={a} b={b} rows={rows} /> },
  ]);
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

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

test('every measure carries its key, a 4-decimal value and its laps, and lists exactly those laps', () => {
  const shown = cells(render(laps(V1, 12, 3), V1));
  expect(shown).toHaveLength(12);
  for (const cell of shown) {
    expect(cell.value).toMatch(/^\d+\.\d{4}$/);
    expect(cell.summary).toBe(cell.laps);
    expect(cell.listed).toBe(cell.laps);
  }
  expect(shown.find((c) => c.measure === 'merges')).toMatchObject({ value: '3.0000', laps: 12 });
  expect(shown.find((c) => c.measure === 'cost_per_merge')?.value).toBe('2.0000');
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
  expect(both.find((d) => d.value === '+1.0000')).toBeDefined();
});

test('with no version picked, or one no lap ran, it is an empty state linking to the versions', () => {
  for (const html of [render(laps(V1, 2, 1), undefined), render(laps(V1, 2, 1), V2)]) {
    expect(html).not.toContain('data-measure=');
    expect(html).toContain('href="/f/mission-control/versions"');
  }
  expect(render([], undefined)).toContain('Pick a version on the versions screen');
});
