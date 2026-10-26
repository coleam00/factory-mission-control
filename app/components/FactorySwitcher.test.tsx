import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { PanelState } from '../live/LivePanel';
import { factoryPath } from '../routing';
import { FactorySwitcherBody, type FactorySwitcherRow } from './FactorySwitcher';

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
