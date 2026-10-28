import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AttemptError } from './LapGraph';

test('a long error leads with its message and keeps the full text behind a toggle', () => {
  const full = '12 | run()\n   ^\nerror: gh pr view failed: no pull requests\n    at gh (a.ts:1:1)';
  const html = renderToStaticMarkup(<AttemptError error={full} />);
  const headline = /data-error-headline[^>]*>(.*?)<\/p>/.exec(html)?.[1];
  expect(headline).toContain('gh pr view failed: no pull requests');
  expect(headline).not.toContain('12 |');
  expect(html).toContain('Show full error');
  expect(html).toContain('<pre data-error-full');
  expect(html).toContain('at gh (a.ts:1:1)');
});

test('a one-line error is shown whole, with no toggle', () => {
  const html = renderToStaticMarkup(<AttemptError error="429 usage limit reached" />);
  expect(html).toContain('429 usage limit reached');
  expect(html).not.toContain('Show full error');
});
