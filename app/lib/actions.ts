/**
 * The dashboard's five writes from the browser's side (PRD invariant 2): answer a paused run's
 * question, resume a run, re-triage a work item, close it, comment on it. Every button starts the same flow: a toast with Undo for 5 seconds, a
 * send only if it was not undone, then the result. The server (`server/actions.ts`) holds the
 * allowlist and the factory's CLI; this module holds the request shape, the wording and the timer.
 */
export type ActionRequest =
  | {
      factory: string;
      action: 'answer';
      run_id: string;
      occurrence: string;
      option: string | null;
      text: string | null;
    }
  | { factory: string; action: 'resume'; run_id: string; from_step: string | null }
  | { factory: string; action: 'retriage'; number: number }
  | { factory: string; action: 'close'; number: number }
  | { factory: string; action: 'comment'; number: number; text: string };

/** What the toast says an answer typed by the owner was. */
export const TEXT_ANSWER_DETAIL = 'your text';

/** Text as a button or toast shows it: in quotes, cut after 40 characters. */
export const quoted = (text: string): string =>
  `“${text.length > 40 ? `${text.slice(0, 40)}…` : text}”`;

export type AnswerRequest = Extract<ActionRequest, { action: 'answer' }>;
export type ResumeRequest = Extract<ActionRequest, { action: 'resume' }>;
export type CommentRequest = Extract<ActionRequest, { action: 'comment' }>;

/** What goes over the wire: the request plus whether the owner undid it. */
export type ActionBody = ActionRequest & { undone: boolean };

export type ActionResult = {
  id: number;
  sent: boolean;
  ok: boolean | null;
  exit_code: number | null;
  summary: string;
};

export const UNDO_MS = 5000;

type Fetch = typeof fetch;

/** The server's refusal; `noReply` when none came, so the action may still have been sent. */
export type ActionError = { error: string; noReply?: true };

/** The server's answer, or its refusal (the toast shows why). */
export async function postAction(
  request: ActionRequest,
  undone: boolean,
  fetchImpl: Fetch = fetch,
): Promise<ActionResult | ActionError> {
  try {
    const body: ActionBody = { ...request, undone };
    const response = await fetchImpl('/api/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const reply: unknown = await response.json();
    if (response.ok) return reply as ActionResult;
    const error = (reply as { error?: unknown } | null)?.error;
    return { error: typeof error === 'string' ? error : `the server answered ${response.status}` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), noReply: true };
  }
}

/** The factories the server holds an operator for, and those whose operator has a `login`. */
export type Operators = { factories: string[]; logins: string[] };

/** An operator with no `login`: the server refuses re-triage and comment for it. False when there is no operator. */
export const loginMissing = ({ factories, logins }: Operators, factory: string): boolean =>
  factories.includes(factory) && !logins.includes(factory);

const names = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : [];

/** The operators in a `GET /api/actions` body. */
export const operatorsOf = (body: unknown): Operators => {
  const { factories, logins } = (body ?? {}) as { factories?: unknown; logins?: unknown };
  return { factories: names(factories), logins: names(logins) };
};

/** The server's operators; none on any failure, so buttons stay links. */
export async function fetchEnabled(fetchImpl: Fetch = fetch): Promise<Operators> {
  try {
    const response = await fetchImpl('/api/actions');
    if (!response.ok) return { factories: [], logins: [] };
    return operatorsOf(await response.json());
  } catch {
    return { factories: [], logins: [] };
  }
}

const shortRun = (runId: string) => runId.slice(0, 8);

/** What the toast says while Undo is open; `label` is the chosen option's wording. */
export function pendingText(
  request: ActionRequest,
  context: { item: number | null; label: string },
): { lead: string; detail: string } {
  if (request.action === 'answer') {
    const target = context.item === null ? `run ${shortRun(request.run_id)}` : `#${context.item}`;
    return { lead: `Answered ${target}: `, detail: context.label };
  }
  if (request.action === 'retriage') return { lead: `Re-triaged #${request.number}`, detail: '' };
  if (request.action === 'close') return { lead: `Closed #${request.number}`, detail: '' };
  if (request.action === 'comment') {
    return {
      lead: `Commented on #${request.number} and re-triaged it: `,
      detail: quoted(request.text),
    };
  }
  const lead = `Resumed run ${shortRun(request.run_id)}`;
  return request.from_step === null
    ? { lead, detail: '' }
    : { lead: `${lead}: `, detail: `from ${request.from_step}` };
}

const firstLine = (text: string) => text.split('\n', 1)[0].trim();

/** What the result toast says once the server answered. */
export function resultText(
  sentText: string,
  result: ActionResult | ActionError,
): { text: string; ok: boolean } {
  if ('error' in result) {
    return result.noReply
      ? { text: 'No reply from the server; it may have been sent, check the run', ok: false }
      : { text: `Not sent: ${firstLine(result.error)}`, ok: false };
  }
  if (result.ok) return { text: `${sentText} · sent`, ok: true };
  if (result.exit_code === null) {
    return {
      text: `Unknown outcome, check the run: ${firstLine(result.summary) || 'no output'}`,
      ok: false,
    };
  }
  const why = firstLine(result.summary) || 'no output';
  return { text: `Archon refused it: ${why}`, ok: false };
}

export type ActionState =
  | { phase: 'idle' }
  | { phase: 'pending'; request: ActionRequest; lead: string; detail: string }
  | { phase: 'sending' }
  | { phase: 'done'; text: string; ok: boolean };

interface FlowDeps {
  post: (request: ActionRequest, undone: boolean) => Promise<ActionResult | ActionError>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

/** The Undo state machine: one action at a time, a post only when the window closes or Undo is pressed. */
export function createActionFlow({ post, setTimer, clearTimer }: FlowDeps) {
  let state: ActionState = { phase: 'idle' };
  let timer: unknown;
  const listeners = new Set<() => void>();
  const set = (next: ActionState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const finish = (text: string, ok: boolean) => {
    set({ phase: 'done', text, ok });
    timer = setTimer(() => set({ phase: 'idle' }), UNDO_MS);
  };

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start(request: ActionRequest, context: { item: number | null; label: string }) {
      if (state.phase !== 'idle') return;
      const { lead, detail } = pendingText(request, context);
      set({ phase: 'pending', request, lead, detail });
      timer = setTimer(async () => {
        set({ phase: 'sending' });
        const result = await post(request, false);
        const shown = resultText(`${lead}${detail}`, result);
        finish(shown.text, shown.ok);
      }, UNDO_MS);
    },
    async undo() {
      if (state.phase !== 'pending') return;
      const { request } = state;
      clearTimer(timer);
      set({ phase: 'sending' });
      const result = await post(request, true);
      if ('error' in result) finish(`Not recorded: ${firstLine(result.error)}`, false);
      else finish('Undone. Nothing was sent.', true);
    },
  };
}
