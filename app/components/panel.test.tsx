import { expect, test } from 'bun:test';
import type { RealtimeClient } from '@neon/realtime/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { type Live, LiveContext, OFFLINE_SENTENCE } from '../live/LiveProvider';
import { PanelBody } from './panel';

const body = (
  <PanelBody rows={undefined} state="error" factory="f" what="things">
    {() => null}
  </PanelBody>
);

test('a panel in error names the connection when its client is offline, else says its data is unavailable (#684)', () => {
  const client = {} as RealtimeClient;
  const offline: Live = {
    status: 'ready',
    factories: [],
    client,
    homeClient: client,
    rewind: null,
    offline: true,
    homeOffline: true,
  };
  expect(
    renderToStaticMarkup(<LiveContext.Provider value={offline}>{body}</LiveContext.Provider>),
  ).toContain(OFFLINE_SENTENCE);
  expect(renderToStaticMarkup(body)).toContain('Live data is unavailable.');
});
