import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { PanelState } from '../live/LivePanel';
import { factoryPath } from '../routing';
import {
  FactorySetupNotice,
  FactorySwitcherBody,
  type FactorySwitcherRow,
  isSwitched,
} from './FactorySwitcher';

const SCREENS = [{ path: 'laps', label: 'Laps' }];

const render = (
  rows: FactorySwitcherRow[] | undefined,
  state: PanelState,
  current = 'mission-control',
) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <FactorySwitcherBody
        rows={rows}
        state={state}
        current={current}
        hrefFor={(factory) => factoryPath('/f/mission-control/laps', factory, SCREENS)}
        open
        onToggle={() => {}}
      />
    </MemoryRouter>,
  );

/** Each listed factory: its name, running count, link and whether it is the current one. */
const entries = (html: string) =>
  [...html.matchAll(/<li data-factory-entry="([^"]*)" data-running="(\d+)"><a ([^>]*)>/g)].map(
    ([, factory, running, attrs = '']) => ({
      factory,
      running: Number(running),
      href: attrs.match(/href="([^"]*)"/)?.[1],
      current: attrs.includes('aria-current="true"'),
    }),
  );

test('two factories are listed with their running laps, the default first, linking the same screen', () => {
  const html = render(
    [
      { factory: 'second-factory', running: 1, is_default: false },
      { factory: 'mission-control', running: 2, is_default: true },
    ],
    'ready',
  );
  expect(entries(html)).toEqual([
    { factory: 'mission-control', running: 2, href: '/f/mission-control/laps', current: true },
    { factory: 'second-factory', running: 1, href: '/f/second-factory/laps', current: false },
  ]);
  expect(html).toContain('data-factory-switcher');
});

test('with one factory the switcher lists that factory and nothing else', () => {
  const html = render([{ factory: 'mission-control', running: 0, is_default: true }], 'ready');
  expect(entries(html)).toEqual([
    { factory: 'mission-control', running: 0, href: '/f/mission-control/laps', current: true },
  ]);
  expect(html.match(/data-factory-entry=/g)).toHaveLength(1);
});

test('loading and error are each one sentence and no button, and list no factory', () => {
  for (const [html, sentence] of [
    [render(undefined, 'loading'), 'Loading the factories.'],
    [render(undefined, 'error'), 'Live data is unavailable.'],
  ] as const) {
    expect(html).toContain(sentence);
    expect(html).not.toMatch(/<button\b/);
    expect(html).not.toContain('data-factory-entry');
  }
});

test('with no factories the open switcher says so in one sentence, with no list or button', () => {
  const html = render([], 'ready');
  expect(html).toContain(
    '<p class="px-3 py-2 text-sm text-text-secondary">No factory has recorded laps yet.</p>',
  );
  expect(html).not.toMatch(/<ul\b/);
  expect(html).not.toMatch(/<button\b/);
  expect(html).not.toContain('data-factory-entry');
});

const registered = [{ factory: 'mission-control', running: 0, is_default: true }];
const configured = ['mission-control', 'new-factory'];
const notice = (
  factories: readonly string[] | undefined,
  rows: FactorySwitcherRow[] | undefined,
  state: PanelState = 'ready',
  rewind: string | null = null,
) => renderToStaticMarkup(<FactorySetupNotice {...{ factories, rows, state, rewind }} />);

test('a missing configured factory gets setup commands until its live registration arrives', () => {
  const html = notice(configured, registered);
  expect(html).toContain('“new-factory”');
  expect(html).not.toContain('“mission-control”');
  expect(html).toContain('bun run migrate -- --configured-factories');
  expect(html).toContain('bun run migrate:main -- --configured-factories');
  expect(html).toContain('on check-*');
  expect(html).toContain('the owner run');
  expect(html).toContain('on main, using the server&#x27;s environment');
  expect(html).not.toMatch(/<a\b|data-running|data-factory-entry/);
  expect(
    notice(configured, [...registered, { factory: 'new-factory', running: 0, is_default: false }]),
  ).toBe('');
});

test('an empty registry names every missing factory in configuration order as escaped text', () => {
  expect(notice(['z', '<script>'], [])).toContain('“z”, “&lt;script&gt;”');
});

test.each(['loading', 'error'] as const)(
  'no setup diagnosis during %s, even with retained rows',
  (state) => {
    expect(notice(configured, undefined, state)).toBe('');
    expect(notice(configured, registered, state)).toBe('');
  },
);

test('absent configuration or rows, zero laps and database-only factories need no notice', () => {
  expect(notice(undefined, registered)).toBe('');
  expect(notice(configured, undefined)).toBe('');
  expect(notice([], registered)).toBe('');
  expect(notice(['mission-control'], registered)).toBe('');
  expect(
    notice(
      ['mission-control'],
      [...registered, { factory: 'retired', running: 2, is_default: false }],
    ),
  ).toBe('');
});

test('historical absence asks to return live before deciding whether setup is needed', () => {
  const html = notice(configured, registered, 'ready', 'rewind-before-setup');
  expect(html).toContain('“new-factory” are absent from this read-only rewind');
  expect(html).toContain('switch back and, if setup is still needed, run');
  expect(html).toContain('bun run migrate -- --configured-factories');
  expect(html).toContain('bun run migrate:main -- --configured-factories');
});

test("from a scorecard the entries keep its versions, and from a step's page they stay on it", () => {
  const rows = [
    { factory: 'mission-control', running: 0, is_default: true },
    { factory: 'second-factory', running: 0, is_default: false },
  ];
  const hrefs = (pathname: string, search: string) =>
    entries(
      renderToStaticMarkup(
        <MemoryRouter>
          <FactorySwitcherBody
            rows={rows}
            state="ready"
            current="mission-control"
            hrefFor={(factory) =>
              factoryPath(pathname, factory, [{ path: 'scorecard', label: 'Scorecard' }], search)
            }
            open
            onToggle={() => {}}
          />
        </MemoryRouter>,
      ),
    ).map(({ href }) => href?.replaceAll('&amp;', '&'));
  expect(hrefs('/f/mission-control/scorecard', '?a=sha256%3Aa1&b=sha256%3Ab2')).toEqual([
    '/f/mission-control/scorecard?a=sha256%3Aa1&b=sha256%3Ab2',
    '/f/second-factory/scorecard?a=sha256%3Aa1&b=sha256%3Ab2',
  ]);
  expect(hrefs('/steps/archon-loop/review', '?at=8e3e1cef')).toEqual([
    '/steps/archon-loop/review?at=8e3e1cef',
    '/steps/archon-loop/review?at=8e3e1cef',
  ]);
});

test('only a page the switcher opened reads as switched', () => {
  expect(isSwitched({ switched: true })).toBe(true);
  for (const state of [null, undefined, {}, { switched: 'yes' }, 'switched']) {
    expect(isSwitched(state)).toBe(false);
  }
});
