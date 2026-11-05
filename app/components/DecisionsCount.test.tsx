import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DecisionsCount } from './DecisionsCount';

test("the badge's panels are named apart from the screen's panels of the same queries", () => {
  const html = renderToStaticMarkup(<DecisionsCount factory="f" />);
  expect(html).toContain('data-live="decisions-count:attention-items"');
  expect(html).not.toContain('data-live="attention-items"');
  expect(html).not.toContain('data-live="owner-queue"');
});
