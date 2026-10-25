import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import Home from './index';

test('the home route is an empty state of one sentence and at most one button', () => {
  const html = renderToStaticMarkup(<Home />);
  const text = html.replace(/<[^>]+>/g, ' ').trim();
  expect(text.match(/[.!?](\s|$)/g)?.length).toBe(1);
  expect(text.endsWith('.')).toBe(true);
  expect((html.match(/<button\b/g) ?? []).length).toBeLessThanOrEqual(1);
});
