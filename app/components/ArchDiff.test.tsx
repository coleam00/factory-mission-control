import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { type ArchDiffRow, diffVersions } from '../lib/arch-diff';
import { DiffView } from './ArchDiff';

const V1 = `sha256:${'a1'.repeat(32)}`;
const V3 = `sha256:${'c3'.repeat(32)}`;
const workflows: ArchDiffRow = {
  digest: V1,
  kind: 'workflow',
  workflow: null,
  entries: ['archon-loop\tc'],
};

const sentences = (html: string) => [...html.matchAll(/<p[^>]*>([^<]*)<\/p>/g)].map((m) => m[1]);

test('a version against itself is one sentence', () => {
  const html = renderToStaticMarkup(<DiffView result={diffVersions([workflows], V1, V1)} />);
  expect(sentences(html)).toEqual(['The two versions have the same architecture.']);
  expect(html).not.toContain('data-change');
});

test('a version with no architecture rows is named, not shown as empty', () => {
  const html = renderToStaticMarkup(<DiffView result={diffVersions([workflows], V1, V3)} />);
  expect(sentences(html)).toEqual([`No architecture is recorded for sha256:${'c3'.repeat(6)}.`]);
});

test('each change is one row under its kind, marked added, removed or changed', () => {
  const prompts: ArchDiffRow = {
    digest: V3,
    kind: 'prompt',
    workflow: null,
    entries: ['loop/x.md\tc'],
  };
  const html = renderToStaticMarkup(
    <DiffView result={diffVersions([workflows, prompts], V1, V3)} />,
  );
  const rows = [...html.matchAll(/data-kind="(\w+)"|data-change="(\w+)" data-item="([^"]+)"/g)]
    .map((m) => (m[1] ? `[${m[1]}]` : `${m[2]} ${m[3]}`))
    .join(' ');
  expect(rows).toBe('[workflow] removed archon-loop [step] [prompt] added loop/x.md [subagent]');
});
