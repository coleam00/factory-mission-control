import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { Shell } from '../../Shell';
import { Socket } from './render-flow';

const RUN = '5eed0001-0000-4000-8000-0000000000a1';

interface Request {
  kind: string;
  url: string;
  method?: string;
  body?: string;
}

declare global {
  interface Window {
    __requests: Request[];
  }
}

const lines = (...events: object[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events)
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
        controller.close();
      },
    }),
  );

const DONE = { type: 'done', cost_usd: 0, day_spent_usd: 0, day_cap_usd: 5 };

/** Every way a page can reach the network, wrapped to write what it was asked for into `window.__requests`. */
function record() {
  window.__requests = [];
  const note = (request: Request) => window.__requests.push(request);
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
  ) {
    note({ kind: 'xhr', url: String(url), method });
    return open.call(this, method, url, true);
  };
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      note({ kind: 'websocket', url: String(url) });
      super(url, protocols);
    }
  };
  window.EventSource = class {
    constructor(url: string | URL) {
      note({ kind: 'eventsource', url: String(url) });
    }
  } as unknown as typeof EventSource;
  navigator.sendBeacon = (url: string | URL) => {
    note({ kind: 'beacon', url: String(url) });
    return true;
  };
  return note;
}

let current: { unmount: () => void; go: (url: string) => void } | undefined;

/** Mounts the real shell over a fake dashboard server at `url`. */
export function mount(url: string) {
  current?.unmount();
  const note = record();
  const originalFetch = window.fetch;
  const header = btoa(JSON.stringify({ alg: 'dir', enc: 'A256GCM', v: 1 })).replace(/=+$/, '');
  let asked = 0;
  window.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      note({
        kind: 'fetch',
        url: target,
        method: init?.method ?? 'GET',
        body: String(init?.body ?? ''),
      });
      if (target === '/api/actions' && init?.method === 'POST') {
        return Response.json({ id: 1, sent: false, ok: null, exit_code: null, summary: '' });
      }
      if (target === '/api/actions') return Response.json({ factories: ['x', 'y'] });
      if (target === '/api/manager/briefing') {
        return lines(
          { type: 'text', text: 'Quiet night.' },
          { ...DONE, generated_at: '2026-11-09T07:30:00Z' },
        );
      }
      if (target === '/api/manager/chat') {
        return lines(
          { type: 'text', text: `Run ${RUN.slice(0, 8)} stopped at implement.` },
          { type: 'link', kind: 'run', id: RUN, label: 'run', href: `/f/x/runs/${RUN}` },
          {
            type: 'runs',
            runs: [
              {
                run_id: RUN,
                workflow_name: 'factory-manager',
                status: 'failed',
                started_at: '2026-11-09T06:00:00Z',
                completed_at: null,
                href: `/f/x/runs/${RUN}`,
              },
            ],
          },
          {
            type: 'proposal',
            label: 'Resume',
            factory: 'x',
            action: 'resume',
            run_id: RUN,
            from_step: null,
          },
          {
            type: 'proposal',
            label: 'Answer "Ship it"',
            detail: 'Ship it',
            factory: 'x',
            action: 'answer',
            run_id: RUN,
            occurrence: 'ask-1',
            option: 'yes',
            text: null,
          },
          DONE,
        );
      }
      const n = asked++;
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
    factories: ['x', 'y'],
    rewind: null,
    protocol: 'neon.realtime.v1',
    early: [JSON.stringify({ type: 'ready' })],
    socket: new Socket(() => '') as unknown as WebSocket,
  };
  const router = createMemoryRouter(
    [
      {
        element: <Shell />,
        children: [
          { path: '/f/:factory', element: <p>Attention</p> },
          { path: '/f/:factory/runs/:runId', element: <p>Run</p> },
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
    go: (to) => void router.navigate(to),
    unmount() {
      root.unmount();
      container.remove();
      window.fetch = originalFetch;
      delete window.__MC_LIVE__;
    },
  };
}

const q = (selector: string) => document.querySelector<HTMLElement>(selector);

export const clickSuggestion = (i: number) =>
  document.querySelectorAll<HTMLButtonElement>('[data-suggestion]')[i]?.click();

export const clickProposal = (action = 'resume') => q(`button[data-proposal="${action}"]`)?.click();

export const clickUndo = () =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="status"] button')]
    .find((b) => b.textContent === 'Undo')
    ?.click();

export const shown = () => ({
  briefing: q('[data-message="briefing"]')?.textContent ?? null,
  answer: q('[data-message="answer"]')?.dataset.managerState ?? null,
  runLinks: [...document.querySelectorAll<HTMLElement>('[data-run-link]')].map(
    (a) => a.dataset.runLink,
  ),
  toastDetail: q('[role="status"] b')?.textContent ?? null,
  undo: q('[role="status"]')?.textContent?.includes('Undo') ?? false,
  chip: q('[data-manager-context] span')?.textContent ?? null,
  surface: q('[data-manager]')?.dataset.manager ?? null,
});

export const go = (url: string) => current?.go(url);

export const requests = () => window.__requests;
