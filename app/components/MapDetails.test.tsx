import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { allCards, type Card, FACTORY_MAP } from '../map/factory-map';
import { MapDetails } from './MapDetails';

const card = (id: string) => {
  const found = allCards(FACTORY_MAP).find((c) => c.id === id);
  if (found === undefined) throw new Error(`no card ${id}`);
  return found;
};

// Server rendering cannot click a tab, so the card's first tab state is the Right now tab.
const realState: (initial: unknown) => unknown = React.useState;
beforeEach(() => {
  spyOn(React, 'useState').mockImplementation(((initial: unknown) => {
    if (initial === 'about') {
      return ['live', () => {}];
    }
    return realState(initial);
  }) as unknown as typeof React.useState);
});
afterEach(() => {
  (React.useState as unknown as { mockRestore?: () => void }).mockRestore?.();
});

const rightNow = (shown: Card) =>
  renderToStaticMarkup(
    <RouterProvider
      router={createMemoryRouter([
        {
          path: '/',
          element: (
            <MapDetails
              card={shown}
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

test('a card has three tabs: About holds when it runs, what it does and how it works', () => {
  (React.useState as unknown as { mockRestore?: () => void }).mockRestore?.();
  const html = rightNow(card('a-check'));
  expect(html.match(/role="tab"/g)).toHaveLength(3);
  expect(html).toContain('data-tab="about"');
  expect(html).toContain('data-tab="live"');
  expect(html).toContain('data-tab="behind"');
  expect(html).toContain('aria-selected="true" data-tab="about"');
  for (const key of ['when', 'what', 'how']) {
    if (card('a-check').details[key as 'when' | 'what' | 'how'] !== undefined) {
      expect(html).toContain(`data-about="${key}"`);
    }
  }
  expect(html).not.toContain('data-tab="when"');
});
