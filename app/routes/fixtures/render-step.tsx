import type { WebSocketLike } from '@neon/realtime/client';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { StepRow } from '../../lib/step-detail';
import { FactoryProvider } from '../../live/FactoryProvider';
import { LiveProvider } from '../../live/LiveProvider';
import StepDetail from '../steps.$workflow.$step';

type Cell = string | number | string[] | null;
type Rows = Record<string, Cell>[];

/** What one seal was asked for: the query and its parameters after the factory. */
export interface Asked {
  query: string;
  args: string[];
}

const TEXT = 25;
const INT4 = 23;
const TEXT_ARRAY = 1009;

function column(name: string, value: Cell) {
  const type_oid = Array.isArray(value) ? TEXT_ARRAY : typeof value === 'number' ? INT4 : TEXT;
  return { name, type_oid, typmod: -1, codec: 'pg_text' };
}

const cell = (value: Cell): string | null =>
  value === null ? null : Array.isArray(value) ? `{${value.join(',')}}` : String(value);

/** A socket that answers each subscribe with the rows of the seal it authorizes. */
class Socket implements WebSocketLike {
  readyState = 1;
  private listeners = new Map<string, ((event: { data: unknown }) => void)[]>();

  constructor(private rowsOf: (capability: string) => Rows) {}

  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  private receive(message: object) {
    for (const listener of this.listeners.get('message') ?? [])
      listener({ data: JSON.stringify(message) });
  }

  send(data: string) {
    const message = JSON.parse(data);
    if (message.type !== 'subscribe') return;
    const rows = this.rowsOf(message.authorization);
    const live_id = message.request_id;
    queueMicrotask(() => {
      const first = rows[0] ?? { value: null };
      this.receive({
        type: 'subscribed',
        request_id: message.request_id,
        live_id,
        epoch: '1',
        first_sequence: '1',
        columns: Object.entries(first).map(([name, value]) => column(name, value)),
      });
      const version = { live_id, epoch: '1', baseline_sync_attempt: '1' };
      this.receive({
        type: 'baseline_sync_start',
        ...version,
        mvcc: { xmin: '1', xmax: '1', xip: [] },
      });
      if (rows.length > 0)
        this.receive({
          type: 'baseline_sync_batch',
          ...version,
          index: 0,
          rows: rows.map((row, i) => ({
            row_key: i.toString(16).padStart(64, '0'),
            values: Object.values(row).map(cell),
          })),
        });
      this.receive({ type: 'baseline_sync_end', ...version, batch_count: rows.length > 0 ? 1 : 0 });
    });
  }

  close() {
    this.readyState = 3;
  }
}

/** A step row of the workflow `archon-loop`, its prompt naming the version it was read at. */
export function stepRow(path: string, prompt: string): StepRow {
  return {
    workflow: 'archon-loop',
    path,
    parent_path: null,
    position: 0,
    step_id: path,
    kind: 'prompt',
    description: null,
    model: null,
    when_condition: null,
    depends_on: [],
    trigger_rule: null,
    include: null,
    command_file: null,
    script: null,
    script_file: null,
    runtime: null,
    bash: null,
    prompt,
    defined_in: 'archon-loop',
    file: 'archon-loop.yaml',
  };
}

async function until(done: () => boolean, what: string): Promise<void> {
  const by = performance.now() + 5000;
  while (!done()) {
    if (performance.now() > by) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Mounts the step screen at `url` over a server whose step-detail answers, for the version `at`,
 * `steps[at]`, and every other query no rows. A seal `hold` matches waits until it is released.
 */
function mount(url: string, steps: Record<string, StepRow[]>) {
  const originalFetch = window.fetch;
  const header = btoa(JSON.stringify({ alg: 'dir', enc: 'A256GCM', v: 1 })).replace(/=+$/, '');
  const asked: Asked[] = [];
  let held: (asked: Asked) => boolean = () => false;
  let released = Promise.resolve();
  window.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const query = String(input).replace('/api/live/', '');
      const { args = [] }: { args?: string[] } = JSON.parse(String(init?.body));
      const n = asked.push({ query, args }) - 1;
      if (held({ query, args })) await released;
      return Response.json({
        capability: `${header}..${n}.test.tag`,
        queryFingerprint: n.toString(16).padStart(64, '0'),
        expiresAt: Date.now() + 60_000,
        rewind: null,
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  const rowsOf = (capability: string): Rows => {
    const { query, args } = asked[Number(capability.split('.')[2])];
    return query === 'step-detail' ? (steps[args[0]] ?? []).map((row) => ({ ...row })) : [];
  };
  window.__MC_LIVE__ = {
    url: 'wss://test/',
    home: 'wss://test/',
    factories: ['factory-a'],
    rewind: null,
    protocol: 'neon.realtime.v1',
    early: [JSON.stringify({ type: 'ready' })],
    socket: new Socket(rowsOf) as unknown as WebSocket,
  };
  const router = createMemoryRouter(
    [
      {
        path: '/steps/:workflow/:step',
        element: (
          <FactoryProvider>
            <StepDetail />
          </FactoryProvider>
        ),
      },
    ],
    { initialEntries: [url] },
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  root.render(
    <LiveProvider>
      <RouterProvider router={router} />
    </LiveProvider>,
  );
  return {
    container,
    asked,
    navigate: (to: string) => router.navigate(to),
    hold(next: (asked: Asked) => boolean): () => void {
      let open = () => {};
      released = new Promise((resolve) => {
        open = resolve;
      });
      held = next;
      return () => {
        held = () => false;
        open();
      };
    },
    unmount() {
      root.unmount();
      container.remove();
      window.fetch = originalFetch;
      delete window.__MC_LIVE__;
    },
  };
}

type Screen = ReturnType<typeof mount>;

/** What the screen shows: the step-detail panel's state, the prompt, and else its one sentence. */
function shown({ container }: Screen) {
  const detail = container.querySelector('[data-live="step-detail"]');
  const prompt = container.querySelector('[data-prompt]');
  return {
    state: detail?.getAttribute('data-state'),
    prompt: prompt?.textContent ?? null,
    sentence: prompt ? null : (detail?.textContent ?? null),
  };
}

/** Every panel has answered: the step's seven and the picker, or the picker and a sentence. */
function settled({ container }: Screen): boolean {
  const panels = [...container.querySelectorAll('[data-live]')];
  const detail = container.querySelector('[data-live="step-detail"]');
  return (
    panels.every((panel) => panel.getAttribute('data-state') === 'ready') &&
    (panels.length === 8 || (panels.length === 2 && detail?.textContent !== ''))
  );
}

export const OLDER = '8e3e1cefaf1e1b7955789d6a43a81b6c2dbd7082';
export const NEWER = '5ffd60c6c6e591487f2fbb5ec67ccc8fc55ca915';
/** A pin at which `review` did not exist yet. */
export const BEFORE_REVIEW = '1b2a52a5d44d3a1b1d8f2d4d3c6c2e0f9a8b7c6d';

const STEPS: Record<string, StepRow[]> = {
  '': [stepRow('review', 'Review, current')],
  [OLDER]: [stepRow('review', `Review at ${OLDER}`)],
  [NEWER]: [stepRow('review', `Review at ${NEWER}`)],
  [BEFORE_REVIEW]: [stepRow('implement', 'Implement')],
};

/** Opens the review step at `url`: what it showed once every panel answered, and what it asked. */
export async function openStep(url: string) {
  const screen = mount(url, STEPS);
  try {
    await until(() => settled(screen), 'every panel to answer');
    return { shown: shown(screen), asked: screen.asked };
  } finally {
    screen.unmount();
  }
}

/**
 * Opens the review step at the older version, then chooses the newer one in place while its seals
 * are unanswered: every distinct thing the screen showed while they were, and once they were.
 */
export async function switchVersion() {
  const screen = mount(`/steps/archon-loop/review?at=${OLDER}`, STEPS);
  try {
    await until(() => settled(screen) && shown(screen).prompt !== null, 'the older version');
    const release = screen.hold(({ args }) => args.at(-1) === NEWER);
    await screen.navigate(`/steps/archon-loop/review?at=${NEWER}`);
    await until(
      () => screen.asked.some(({ query, args }) => query === 'step-detail' && args[0] === NEWER),
      'the newer version to be asked for',
    );
    const pending = new Set<string>();
    for (let i = 0; i < 20; i++) {
      pending.add(JSON.stringify(shown(screen)));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    release();
    await until(
      () => settled(screen) && shown(screen).prompt === `Review at ${NEWER}`,
      'the newer version',
    );
    return { pending: [...pending].map((json) => JSON.parse(json)), after: shown(screen) };
  } finally {
    screen.unmount();
  }
}
