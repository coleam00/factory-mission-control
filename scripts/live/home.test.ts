import { expect, test } from 'bun:test';
import type { Page } from '../lib/cdp';
import { observeHomePanels } from './home';
import { emptyPanelTimings } from './timings';

test.each(['timeout', 'error state', 'evaluation throws', 'ready'])(
  'home observations retain the ready strip when the map is %s',
  async (mapState) => {
    const panels = ['status-strip', 'home-map'].map((query) => ({
      query,
      name: query,
      selector: `[data-live="${query}"]`,
      timings: emptyPanelTimings(),
    }));
    const calls: string[] = [];
    const page: Page = {
      async evaluate<T>(expression: string): Promise<T> {
        const query = expression.includes('status-strip') ? 'status-strip' : 'home-map';
        if (expression.includes('document.querySelector')) {
          calls.push(`ready:${query}`);
          if (query === 'home-map') {
            if (mapState === 'evaluation throws') throw new Error('evaluation failed');
            return (mapState === 'ready') as T;
          }
          return true as T;
        }
        calls.push(`marks:${query}`);
        return {
          [query]: {
            readyAt: 125,
            sentAt: 100,
            firstAt: 110,
            renderedAt: 125,
            subscribedAt: 100,
            context: {
              id: query,
              query,
              factory: 'factory-a',
              args: [],
              home: false,
              branch: null,
              queryFingerprint: 'fingerprint',
            },
          },
        } as T;
      },
      async goto() {},
      async setViewport() {},
      async screenshot() {
        return Buffer.alloc(0);
      },
      async close() {},
    };
    const observing = observeHomePanels(page, panels);
    if (mapState === 'ready') await observing;
    else
      await expect(observing).rejects.toThrow(
        mapState === 'evaluation throws' ? 'evaluation failed' : 'home-map did not reach',
      );
    const persisted = JSON.parse(JSON.stringify(panels.map((panel) => panel.timings)));
    expect(persisted[0]).toMatchObject({
      readyMs: 125,
      firstSnapshotMs: 25,
      subscribeToFirstResultMs: 10,
      renderMs: 15,
      queryExecutionMs: null,
    });
    expect(persisted[1].readyMs).toBe(mapState === 'ready' ? 125 : null);
    expect(calls).toEqual([
      'ready:status-strip',
      'marks:status-strip',
      'ready:home-map',
      ...(mapState === 'ready' ? ['marks:home-map'] : []),
    ]);
  },
);
