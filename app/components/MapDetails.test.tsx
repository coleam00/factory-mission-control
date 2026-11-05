import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { allCards, type Card, FACTORY_MAP } from '../map/factory-map';
import { MapDetails } from './MapDetails';

// Server rendering cannot click a tab, so the card's first tab state is the Right now tab.
const realState: (initial: unknown) => unknown = React.useState;
beforeEach(() => {
  spyOn(React, 'useState').mockImplementation(((initial: unknown) => {
    if (initial === 'when') {
      return ['live', () => {}];
    }
    return realState(initial);
  }) as unknown as typeof React.useState);
});
afterEach(() => {
  (React.useState as unknown as { mockRestore?: () => void }).mockRestore?.();
});

const rightNow = (card: Card) =>
  renderToStaticMarkup(
    <RouterProvider
      router={createMemoryRouter([
        {
          path: '/',
          element: (
            <MapDetails
              card={card}
              live={undefined}
              factory="mission-control"
              at={null}
              steps={undefined}
              onClose={() => {}}
            />
          ),
        },
      ])}
    />,
  );

test('the card listing checks shows the pull requests under check on its Right now tab, and no other card does', () => {
  const cards = allCards(FACTORY_MAP);
  expect(cards.some((c) => c.lists?.includes('checks'))).toBe(true);
  for (const c of cards) {
    const html = rightNow(c);
    expect(html).toContain('aria-selected="true" data-tab="live"');
    expect(html.includes('Pull requests under check')).toBe(c.lists?.includes('checks') === true);
  }
});
