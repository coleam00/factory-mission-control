import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { Shell } from '../../Shell';
import Attention from '../../routes/f.$factory';
import Board from '../../routes/f.$factory.board';
import Runs from '../../routes/f.$factory.runs';
import { Socket } from './render-flow';

let current: { unmount: () => void } | undefined;

/** Mounts the real shell with the real Attention, Board and Runs routes over a server with no rows. */
export function mount(url: string) {
  current?.unmount();
  const originalFetch = window.fetch;
  const header = btoa(JSON.stringify({ alg: 'dir', enc: 'A256GCM', v: 1 })).replace(/=+$/, '');
  const asked: string[] = [];
  window.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const n = asked.push(String(input).replace('/api/live/', '')) - 1;
      return Response.json({
        capability: `${header}..${n}.test.tag`,
        queryFingerprint: n.toString(16).padStart(64, '0'),
        expiresAt: Date.now() + 60_000,
        rewind: null,
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  window.__MC_LIVE__ = {
    url: 'wss://test/',
    home: 'wss://test/',
    factories: ['x'],
    rewind: null,
    protocol: 'neon.realtime.v1',
    early: [JSON.stringify({ type: 'ready' })],
    socket: new Socket(
      (capability) => asked[Number(capability.split('.')[2])],
    ) as unknown as WebSocket,
  };
  const router = createMemoryRouter(
    [
      {
        element: <Shell />,
        children: [
          { path: '/f/:factory', element: <Attention /> },
          { path: '/f/:factory/board', element: <Board /> },
          { path: '/f/:factory/runs', element: <Runs /> },
        ],
      },
    ],
    { initialEntries: [url] },
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  root.render(<RouterProvider router={router} />);
  current = {
    unmount() {
      root.unmount();
      container.remove();
      window.fetch = originalFetch;
      delete window.__MC_LIVE__;
    },
  };
}

/** The gaps either side of the page's column in its pane, and whether the pane scrolls sideways. */
export function gaps() {
  const column = document.querySelector('main');
  const pane = column?.parentElement;
  if (!column || !pane) return null;
  const c = column.getBoundingClientRect();
  const p = pane.getBoundingClientRect();
  return {
    left: Math.round(c.left - p.left),
    right: Math.round(p.left + pane.clientWidth - c.right),
    sideways: pane.scrollWidth > pane.clientWidth,
  };
}

/** Opens or closes the Manager, the dock or the phone's tab, whatever state the browser remembered. */
export const setManager = (open: boolean) => {
  const button = document.querySelector<HTMLButtonElement>('nav button[aria-pressed]');
  const tab = document.querySelector('aside[data-manager="tab"]');
  if (open && button?.getAttribute('aria-pressed') !== 'true') button?.click();
  else if (!open && tab)
    tab.querySelector<HTMLButtonElement>('button[aria-label="Close the Manager"]')?.click();
  else if (!open && button?.getAttribute('aria-pressed') === 'true') button.click();
};

/** Which shell is drawn, and how much of the viewport Attention's column and the Manager take. */
export function shell() {
  const nav = document.querySelector('nav[aria-label="Places"]');
  const attention = document.querySelector('section[data-attention]');
  const aside = document.querySelector('aside[data-manager]');
  const a = attention?.getBoundingClientRect();
  const m = aside?.getBoundingClientRect();
  return {
    phone: nav ? getComputedStyle(nav).position === 'sticky' : null,
    attention:
      a && a.width > 0 ? { width: Math.round(a.width), left: a.left, right: a.right } : null,
    manager: m ? { width: Math.round(m.width), left: m.left } : null,
  };
}
