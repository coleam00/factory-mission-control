import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { type ArchDiffRow, diffVersions } from '../lib/arch-diff';
import { DefaultDiff, DiffView } from './ArchDiff';

const V1 = `sha256:${'a1'.repeat(32)}`;
const V3 = `sha256:${'c3'.repeat(32)}`;
const workflows: ArchDiffRow = {
  digest: V1,
  kind: 'workflow',
  workflow: null,
  entries: ['archon-loop\tc'],
};
const version = (digest: string): ArchDiffRow => ({
  digest,
  kind: 'version',
  workflow: null,
  entries: [],
});
const v1 = version(V1);
const v3 = version(V3);

const sentences = (html: string) => [...html.matchAll(/<p[^>]*>([^<]*)<\/p>/g)].map((m) => m[1]);

test('a version against itself is one sentence', () => {
  const html = renderToStaticMarkup(<DiffView result={diffVersions([v1, workflows], V1, V1)} />);
  expect(sentences(html)).toEqual(['The two versions have the same architecture.']);
  expect(html).not.toContain('data-change');
});

test('a version with no architecture rows is named, not shown as empty', () => {
  const html = renderToStaticMarkup(
    <DiffView result={diffVersions([v1, workflows, v3], V1, V3)} versions={<a href="/v">V</a>} />,
  );
  expect(sentences(html)).toEqual([`No architecture is recorded for sha256:${'c3'.repeat(6)}.`]);
  expect(html).not.toContain('href');
});

test("a digest that is not one of this factory's versions is not found, with one button back", () => {
  for (const [a, b, said] of [
    [V1, V3, `sha256:${'c3'.repeat(6)} is not a version of this factory.`],
    ['8e3e1cef', V1, '8e3e1cef is not a version of this factory.'],
    [
      'sha256:zzzz',
      V3,
      `sha256:zzzz and sha256:${'c3'.repeat(6)} are not versions of this factory.`,
    ],
  ] as const) {
    const html = renderToStaticMarkup(
      <DiffView result={diffVersions([v1, workflows], a, b)} versions={<a href="/v">V</a>} />,
    );
    expect(sentences(html)).toEqual([said]);
    expect(html.match(/<a /g)).toHaveLength(1);
  }
});

test('each change is one row under its kind, marked added, removed or changed', () => {
  const prompts: ArchDiffRow = {
    digest: V3,
    kind: 'prompt',
    workflow: null,
    entries: ['loop/x.md\tc'],
  };
  const html = renderToStaticMarkup(
    <DiffView result={diffVersions([v1, workflows, v3, prompts], V1, V3)} />,
  );
  const rows = [...html.matchAll(/data-kind="(\w+)"|data-change="(\w+)" data-item="([^"]+)"/g)]
    .map((m) => (m[1] ? `[${m[1]}]` : `${m[2]} ${m[3]}`))
    .join(' ');
  expect(rows).toBe('[workflow] removed archon-loop [step] [prompt] added loop/x.md [subagent]');
});

test('with no pair named it shows the newest two versions and says so; with one, one sentence', () => {
  const dated = (row: ArchDiffRow, day: number): ArchDiffRow => ({
    ...row,
    first_run_at: new Date(Date.UTC(2026, 9, day)),
  });
  const v3Changed: ArchDiffRow = { ...workflows, digest: V3, entries: ['archon-loop\td'] };
  const html = renderToStaticMarkup(
    <DefaultDiff
      rows={[dated(v1, 1), workflows, dated(v3, 4), v3Changed]}
      versions={<a href="/v">Open the versions</a>}
    />,
  );
  expect(html).toContain(`data-default-pair="${V1} ${V3}"`);
  expect(html).toContain('Showing the newest two versions with a recorded architecture');
  expect(html).toContain('data-change="changed"');
  expect(html).toContain('href="/v"');
  const one = renderToStaticMarkup(<DefaultDiff rows={[v1, workflows]} />);
  expect(sentences(one)).toEqual(['This factory needs two versions to diff.']);
});
