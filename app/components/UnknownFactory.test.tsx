import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { UnknownFactory } from './UnknownFactory';

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const render = (factory: string, fallback: string | undefined) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <UnknownFactory factory={factory} fallback={fallback} />
    </MemoryRouter>,
  );

test('names the key as typed in one sentence and links to the default map', () => {
  const html = render('Mission-Control', 'mission-control');
  expect(text(html)).toBe(
    'No factory is named &quot;Mission-Control&quot;. Go to mission-control&#x27;s map',
  );
  expect(html.match(/<p/g)).toHaveLength(1);
  expect(html.match(/<a /g)).toHaveLength(1);
  expect(html).toContain('href="/f/mission-control"');
  expect(html).not.toContain('Live data is unavailable.');
});

test('a padded, path-like or very long key is named whole', () => {
  expect(render(' mission-control', 'mission-control')).toContain('&quot; mission-control&quot;');
  expect(render('a/b', 'mission-control')).toContain('&quot;a/b&quot;');
  const long = 'x'.repeat(300);
  expect(render(long, 'mission-control')).toContain(`&quot;${long}&quot;`);
});

test('before the server names a default it links home', () => {
  expect(render('nope', undefined)).toContain('href="/"');
});

test('the empty key names no factory and links home, not to a map', () => {
  const html = render('', 'mission-control');
  expect(text(html)).toBe('No factory is named in this address. Go to home');
  expect(html.match(/<p/g)).toHaveLength(1);
  expect(html.match(/<a /g)).toHaveLength(1);
  expect(html).toContain('href="/"');
  expect(html).not.toContain('mission-control');
});
