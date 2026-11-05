import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { FACTORY_MAP } from '../map/factory-map';
import { MapDetails } from './MapDetails';

const card = (id: string) => {
  const found = Object.values(FACTORY_MAP.views ?? {})
    .flatMap((view) => view.cards)
    .find((c) => c.id === id);
  if (found === undefined) throw new Error(`no card ${id}`);
  return found;
};

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

const rightNow = (id: string) =>
  renderToStaticMarkup(
    <RouterProvider
      router={createMemoryRouter([
        {
          path: '/',
          element: (
            <MapDetails
              card={card(id)}
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

test('the App check card lists the pull requests under check on its Right now tab, and no other card does', () => {
  expect(rightNow('a-check')).toContain('Pull requests under check');
  const seal = rightNow('a-seal');
  expect(seal).toContain('aria-selected="true" data-tab="live"');
  expect(seal).not.toContain('Pull requests under check');
});
