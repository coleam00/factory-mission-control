import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { sourceOf } from './Decisions';
import { CountMark, DecisionsCount } from './DecisionsCount';

test("the badge's panels are named apart from the screen's panels of the same queries", () => {
  const html = renderToStaticMarkup(<DecisionsCount factory="f" />);
  expect(html).toContain('data-live="decisions-count:attention-items"');
  expect(html).not.toContain('data-live="attention-items"');
  expect(html).not.toContain('data-live="owner-queue"');
});

test('either query in error shows the unavailable mark, not a hidden badge', () => {
  for (const [attentionState, ownerState] of [
    ['error', 'ready'],
    ['ready', 'error'],
  ] as const) {
    const html = renderToStaticMarkup(
      <CountMark attention={sourceOf([{}], attentionState)} owner={sourceOf([{}], ownerState)} />,
    );
    expect(html).toContain('data-decisions-count="unavailable"');
    expect(html).toContain('Waiting count unavailable');
    expect(html).not.toContain('amber');
  }
});

test('healthy rows are counted, and a loading query shows nothing', () => {
  expect(renderToStaticMarkup(<CountMark attention={[{}]} owner={[{}, {}]} />)).toContain(
    'data-decisions-count="3"',
  );
  expect(
    renderToStaticMarkup(<CountMark attention={sourceOf(undefined, 'loading')} owner={[{}]} />),
  ).toBe('');
});

test('the badge is a solid violet chip with dark text, as the mockup draws it', () => {
  const html = renderToStaticMarkup(<CountMark attention={[{}]} owner={[]} />);
  expect(html).toContain('color:#0b0c10');
  expect(html).toContain('background-color:var(--v3-you)');
});
