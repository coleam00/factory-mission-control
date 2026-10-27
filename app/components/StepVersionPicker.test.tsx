import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { StepVersionRow } from '../lib/step-detail';
import type { PanelState } from '../live/LivePanel';
import { StepVersionPickerBody } from './StepVersionPicker';

const OLDER = '8e3e1cefaf1e1b7955789d6a43a81b6c2dbd7082';
const CURRENT = '5ffd60c6c6e591487f2fbb5ec67ccc8fc55ca915';
const ROWS: StepVersionRow[] = [
  { sha: OLDER, reason: 'V1', committed_at: new Date('2026-01-01T00:00:00Z'), is_current: false },
  { sha: CURRENT, reason: 'V2', committed_at: new Date('2026-02-01T00:00:00Z'), is_current: true },
];

const render = (rows: StepVersionRow[] | undefined, state: PanelState, at: string | null) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <StepVersionPickerBody
        rows={rows}
        state={state}
        at={at}
        workflow="archon-loop"
        path="review"
        open
        onToggle={() => {}}
      />
    </MemoryRouter>,
  );

/** Each listed version: its pin, link and whether it is the one shown. */
const entries = (html: string) =>
  [...html.matchAll(/<li data-version-entry="([^"]*)"><a ([^>]*)>/g)].map(
    ([, sha, attrs = '']) => ({
      sha,
      href: attrs.match(/href="([^"]*)"/)?.[1],
      shown: attrs.includes('aria-current="true"'),
    }),
  );

const summary = (html: string) =>
  html
    .match(/<summary[^>]*>(.*?)<\/summary>/)?.[1]
    ?.replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

test('without a version the current one is shown, and opens the address without a version', () => {
  const html = render(ROWS, 'ready', null);
  expect(entries(html)).toEqual([
    { sha: CURRENT, href: '/steps/archon-loop/review', shown: true },
    { sha: OLDER, href: `/steps/archon-loop/review?at=${OLDER}`, shown: false },
  ]);
  expect(summary(html)).toBe('Version 5ffd60c6 2026-02-01 current');
  expect(html).toContain('data-step-version');
});

test('an older version in the address is the one shown', () => {
  const html = render(ROWS, 'ready', OLDER);
  expect(entries(html).map(({ sha, shown }) => [sha, shown])).toEqual([
    [CURRENT, false],
    [OLDER, true],
  ]);
  expect(summary(html)).toBe('Version 8e3e1cef 2026-01-01');
});

test('a version nobody recorded is named as given, and none is shown as chosen', () => {
  const html = render(ROWS, 'ready', 'not-a-version');
  expect(entries(html).some((entry) => entry.shown)).toBe(false);
  expect(summary(html)).toBe('Version not-a-version');
});

test('loading, unavailable and empty lists each read one sentence', () => {
  expect(render(undefined, 'loading', null)).toContain('Loading versions.');
  expect(render(undefined, 'error', null)).toContain('Live data is unavailable.');
  expect(render([], 'ready', null)).toContain('No version with architecture is recorded.');
});
