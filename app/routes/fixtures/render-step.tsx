import type { WebSocketLike } from '@neon/realtime/client';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { StepOrigin, StepRow } from '../../lib/step-detail';
import { ALL_STEP_QUERIES } from '../../lib/step-queries';
import { FactoryProvider } from '../../live/FactoryProvider';
import { LiveProvider } from '../../live/LiveProvider';
import { FACTORY_MAP, mapOrigin, selectOnArrival } from '../../map/factory-map';
import { OldStepAddress } from '../../routing';
import StepDetail from '../f.$factory.steps.$workflow.$step';

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
  /** Each subscription's live id, by the capability that authorized it. */
  readonly live = new Map<string, string>();

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
    this.live.set(message.authorization, live_id);
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

  /** Ends the subscription `capability` authorized with an error it cannot recover from. */
  fail(capability: string) {
    const live_id = this.live.get(capability);
    this.receive({ type: 'subscription_error', live_id, code: 'protocol_error', message: 'test' });
  }

  close() {
    this.readyState = 3;
  }
}

/** A step row of the workflow `archon-loop`, its prompt naming the version it was read at. */
function stepRow(path: string, prompt: string, fields: Partial<StepRow> = {}): StepRow {
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
    child_workflow: null,
    command_file: null,
    script: null,
    script_file: null,
    runtime: null,
    bash: null,
    prompt,
    defined_in: 'archon-loop',
    file: 'archon-loop.yaml',
    ...fields,
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
function mount(url: string, steps: Record<string, StepRow[]>, state?: unknown) {
  performance.clearMarks();
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
  const socket = new Socket(rowsOf);
  window.__MC_LIVE__ = {
    url: 'wss://test/',
    home: 'wss://test/',
    factories: ['factory-a'],
    rewind: null,
    protocol: 'neon.realtime.v1',
    early: [JSON.stringify({ type: 'ready' })],
    socket: socket as unknown as WebSocket,
  };
  const at = new URL(url, 'http://test');
  const router = createMemoryRouter(
    [
      {
        path: '/f/:factory/steps/:workflow/:step',
        element: (
          <FactoryProvider>
            <StepDetail />
          </FactoryProvider>
        ),
      },
      { path: '/f/:factory', element: null },
      {
        path: '/steps/:workflow/:step',
        element: (
          <FactoryProvider>
            <OldStepAddress />
          </FactoryProvider>
        ),
      },
    ],
    { initialEntries: [{ pathname: at.pathname, search: at.search, state }] },
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
    state: () => router.state.location.state,
    location: () => `${router.state.location.pathname}${router.state.location.search}`,
    fail(query: string) {
      for (const capability of socket.live.keys())
        if (asked[Number(capability.split('.')[2])].query === query) socket.fail(capability);
    },
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

/** Every panel has answered, and step-detail shows the step or its one sentence. */
function settled({ container }: Screen): boolean {
  const panels = [...container.querySelectorAll('[data-live]')];
  const detail = container.querySelector('[data-live="step-detail"]');
  return (
    panels.length === ALL_STEP_QUERIES.length &&
    panels.every((panel) => panel.getAttribute('data-state') === 'ready') &&
    detail?.textContent !== ''
  );
}

const OLDER = '8e3e1cefaf1e1b7955789d6a43a81b6c2dbd7082';
const NEWER = '5ffd60c6c6e591487f2fbb5ec67ccc8fc55ca915';
/** A pin at which `review` did not exist yet. */
const BEFORE_REVIEW = '1b2a52a5d44d3a1b1d8f2d4d3c6c2e0f9a8b7c6d';

/** A pin at which `archon-loop` includes the workflow `block` twice, `rereview` after `fix`. */
const TWICE = 'ac1ace0000000000000000000000000000000000';

const STEPS: Record<string, StepRow[]> = {
  [TWICE]: [
    stepRow('review', '', { kind: 'include', include: 'block', position: 1 }),
    stepRow('rereview', '', {
      kind: 'include',
      include: 'block',
      position: 2,
      depends_on: ['fix'],
    }),
    stepRow('code', 'Write the code', {
      workflow: 'block',
      defined_in: 'block',
      file: 'block.yaml',
    }),
  ],
  '': [
    stepRow('review', 'Review, current'),
    stepRow('finalize', 'Finalize', { trigger_rule: 'all_done' }),
  ],
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
 * Opens the review step with step-detail's seal unanswered until every query was asked for: what
 * was asked, step-detail's state and which panels had marked their request by then, and what the
 * screen showed once step-detail answered.
 */
export async function openHeld() {
  const screen = mount('/f/factory-a/steps/archon-loop/review', STEPS);
  try {
    const release = screen.hold(({ query }) => query === 'step-detail');
    const asked = () => new Set(screen.asked.map(({ query }) => query));
    await until(
      () => ALL_STEP_QUERIES.every((query) => asked().has(query)),
      'every query to be asked for',
    );
    const whileHeld = {
      asked: [...asked()].sort(),
      detail: screen.container
        .querySelector('[data-live="step-detail"]')
        ?.getAttribute('data-state'),
      requested: ALL_STEP_QUERIES.filter(
        (query) => performance.getEntriesByName(`live:${query}:requested`).length > 0,
      ).sort(),
    };
    release();
    await until(() => settled(screen), 'every panel to answer');
    return { whileHeld, after: shown(screen) };
  } finally {
    screen.unmount();
  }
}

/**
 * Opens the review step at the older version, then chooses the newer one in place while its seals
 * are unanswered: every distinct thing the screen showed while they were, and once they were.
 */
export async function switchVersion() {
  const screen = mount(`/f/factory-a/steps/archon-loop/review?at=${OLDER}`, STEPS);
  try {
    await until(() => settled(screen) && shown(screen).prompt !== null, 'the older version');
    const release = screen.hold(({ args }) => args.at(-1) === NEWER);
    await screen.navigate(`/f/factory-a/steps/archon-loop/review?at=${NEWER}`);
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

/**
 * Opens the review step, then ends step-detail's subscription with an error once the step shows:
 * step-detail's state then, and the headings of every section still shown.
 */
export async function loseStep() {
  const screen = mount('/f/factory-a/steps/archon-loop/review', STEPS);
  try {
    await until(() => settled(screen) && shown(screen).prompt !== null, 'the step');
    screen.fail('step-detail');
    const detail = () =>
      screen.container.querySelector('[data-live="step-detail"]')?.getAttribute('data-state');
    await until(() => detail() !== 'ready', 'step-detail to leave ready');
    return {
      detail: detail(),
      sentence: shown(screen).sentence,
      headings: [...screen.container.querySelectorAll('h2')].map((h2) => h2.textContent),
    };
  } finally {
    screen.unmount();
  }
}

/**
 * Opens `url` at the pin where `archon-loop` includes `block` twice: where the address ended up,
 * the place it shows, the routing around it and every place of its definition.
 */
export async function openPlace(url: string) {
  const screen = mount(url, STEPS);
  try {
    await until(() => settled(screen) && shown(screen).prompt !== null, 'the place');
    const text = (selector: string) =>
      [...screen.container.querySelectorAll(selector)].map((el) => el.textContent);
    return {
      location: screen.location(),
      title: screen.container.querySelector('h1')?.textContent,
      routes: [...screen.container.querySelectorAll('[data-route]')].map((el) => ({
        path: el.getAttribute('data-route'),
        inputs: el.querySelector('[data-route-inputs]')?.getAttribute('data-route-inputs'),
      })),
      includedAt: [...screen.container.querySelectorAll('[data-included-at]')].map((el) => ({
        place: el.getAttribute('data-included-at'),
        current: el.querySelector('a')?.getAttribute('aria-current') === 'page',
      })),
      prompt: text('[data-prompt]'),
    };
  } finally {
    screen.unmount();
  }
}

/** The Trigger rule the step screen at `url` shows. */
export async function triggerRuleAt(url: string) {
  const screen = mount(url, STEPS);
  try {
    await until(() => settled(screen) && shown(screen).prompt !== null, 'the step');
    return screen.container.querySelector('[data-trigger-rule]')?.textContent ?? null;
  } finally {
    screen.unmount();
  }
}

/** Where the review step's breadcrumb leads and reads, as opened with `state` and after moving in place. */
export async function breadcrumbOf(state: { from: StepOrigin } | undefined) {
  const screen = mount('/f/factory-a/steps/archon-loop/review', STEPS, state);
  try {
    await until(() => settled(screen) && shown(screen).prompt !== null, 'the step');
    const back = () => {
      const link = screen.container.querySelector('[data-breadcrumb-back]');
      return { href: link?.getAttribute('href') ?? null, text: link?.textContent ?? null };
    };
    const opened = back();
    await screen.navigate(`/f/factory-a/steps/archon-loop/review?at=${NEWER}`);
    await until(() => shown(screen).prompt === `Review at ${NEWER}`, 'the newer version');
    const moved = back();
    const before = screen.location();
    screen.container.querySelector<HTMLElement>('[data-breadcrumb-back]')?.click();
    await until(() => screen.location() !== before, 'the opener');
    return {
      opened,
      moved,
      selected: selectOnArrival(screen.state()) ?? null,
      expectedDefault: mapOrigin(FACTORY_MAP, 'factory-a', 'archon-loop', 'review', null),
    };
  } finally {
    screen.unmount();
  }
}
