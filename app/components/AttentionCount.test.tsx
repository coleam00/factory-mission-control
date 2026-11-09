import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Source } from '../live/Feed';
import { AttentionCount, CountMark } from './AttentionCount';

const ready = (n: number): Source<object> => ({
  rows: Array.from({ length: n }, () => ({})),
  state: 'ready',
});
const loading: Source<object> = { rows: undefined, state: 'loading' };

test("the badge's panels are named apart from the page's panels of the same queries", () => {
  const html = renderToStaticMarkup(<AttentionCount factory="f" />);
  for (const q of ['decide', 'owner-queue', 'unstick', 'failure-groups']) {
    expect(html).toContain(`data-live="attention-count:${q}"`);
    expect(html).not.toContain(`data-live="${q}"`);
  }
});

test('any query in error shows the unavailable mark, whatever rows it kept', () => {
  const errored: Source<object> = { rows: [{}], state: 'error' };
  const html = renderToStaticMarkup(
    <CountMark sources={[ready(1), errored, ready(0), ready(0)]} />,
  );
  expect(html).toContain('data-attention-count="unavailable"');
  expect(html).toContain('Waiting count unavailable');
});

test('healthy rows across the four queries are counted, and a loading query shows nothing', () => {
  expect(
    renderToStaticMarkup(<CountMark sources={[ready(1), ready(2), ready(1), ready(3)]} />),
  ).toContain('data-attention-count="7"');
  expect(renderToStaticMarkup(<CountMark sources={[loading, ready(1)]} />)).toBe('');
  expect(renderToStaticMarkup(<CountMark sources={[ready(0), ready(0)]} />)).toBe('');
});

test('the badge is a solid violet chip with dark text, as the mockup draws it', () => {
  const html = renderToStaticMarkup(<CountMark sources={[ready(1)]} />);
  expect(html).toContain('color:var(--v3-bg)');
  expect(html).toContain('background-color:var(--v3-you)');
});
