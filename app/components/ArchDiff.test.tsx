import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { diffVersions } from '../lib/arch-diff';
import { DiffView } from './ArchDiff';

const V1 = `sha256:${'a1'.repeat(32)}`;
const V3 = `sha256:${'c3'.repeat(32)}`;
const row = {
  digest: V1,
  kind: 'workflow' as const,
  workflow: 'archon-loop',
  step: null,
  name: 'archon-loop',
  content: 'c',
  depends_on: [],
};

const sentences = (html: string) => [...html.matchAll(/<p[^>]*>([^<]*)<\/p>/g)].map((m) => m[1]);

test('a version against itself is one sentence', () => {
  const html = renderToStaticMarkup(<DiffView result={diffVersions([row], V1, V1)} />);
  expect(sentences(html)).toEqual(['The two versions have the same architecture.']);
  expect(html).not.toContain('data-change');
});

test('a version with no architecture rows is named, not shown as empty', () => {
  const html = renderToStaticMarkup(<DiffView result={diffVersions([row], V1, V3)} />);
  expect(sentences(html)).toEqual([
    `No architecture is recorded for sha256:${'c3'.repeat(6)}.`,
  ]);
});

test('each change is one row under its kind, marked added, removed or changed', () => {
  const html = renderToStaticMarkup(
    <DiffView
      result={diffVersions(
        [row, { ...row, digest: V3, kind: 'prompt', workflow: null, name: 'loop/x.md' }],
        V1,
        V3,
      )}
    />,
  );
  expect([...html.matchAll(/data-change="(\w+)" data-item="([^"]+)"/g)].map((m) => m.slice(1))).toEqual([
    ['removed', 'archon-loop'],
    ['added', 'loop/x.md'],
  ]);
});
