/**
 * The Manager panel's logic (PRD 4.10): which place the page is, what the person may ask there,
 * the request and stream readers, and the conversation's messages. Pure apart from the two
 * request functions; the panel only draws what this returns. Only `/api/...` is called: the model
 * and its credentials stay on the dashboard server.
 */
import type { ChatRequest, ManagerEvent, RunSummary } from '../../server/manager-stream';
import { shortRunId } from './format';
import { ORDER_PARAM, TABLE_VIEW, VIEW_PARAM } from './board';
import { isRunId } from './one-lap';
import { filterOf, RUN_CHIPS } from './runs';

export type ManagerContext = ChatRequest['context'];

/** What an "Ask manager" press hands the panel: the item it was pressed on, and how the chip names it. */
export interface ManagerAsk {
  context: ManagerContext;
  chip: string;
}

export interface ManagerPlace extends ManagerAsk {
  questions: string[];
}

const ATTENTION_QUESTIONS = ['What failed overnight?', 'What did today cost?', 'What is stuck?'];

/** "Ask manager" on an Attention item or a run: that run and work item are what the Manager looks at. */
export function askAbout(
  run: string | null | undefined,
  item: number | null | undefined,
): ManagerAsk {
  const context: ManagerContext = { place: 'attention' };
  if (run) context.run = run;
  if (item) context.item = item;
  const what = item ? `#${item}` : run ? `run ${shortRunId(run)}` : null;
  return { context, chip: what === null ? 'Attention' : `Attention · ${what}` };
}

const decoded = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/** The place an address is, what the Manager is told about it, and what is worth asking there. */
export function managerPlace(
  pathname: string,
  search: URLSearchParams,
  attentionWhat?: string,
): ManagerPlace {
  const [, , , place = '', first = '', second = ''] = pathname.split('/');
  const attention: ManagerPlace = {
    context: { place: 'attention' },
    chip: attentionWhat === undefined ? 'Attention' : `Attention · ${attentionWhat}`,
    questions: ATTENTION_QUESTIONS,
  };
  if (!pathname.startsWith('/f/')) return attention;
  switch (place) {
    case 'map':
      return {
        context: { place: 'factory' },
        chip: 'Factory map',
        questions: ['Where is work piling up?', 'Which step costs the most?'],
      };
    case 'board': {
      const order = search.get(ORDER_PARAM);
      const what = order
        ? `work order ${order}`
        : search.get(VIEW_PARAM) === TABLE_VIEW
          ? 'table'
          : 'pipeline';
      return {
        context: { place: 'board' },
        chip: `Board · ${what}`,
        questions: ['What is the work order waiting on?', 'Which items are blocked?'],
      };
    }
    case 'runs': {
      if (first === '') {
        const state = filterOf(search).state;
        const label = RUN_CHIPS.find((c) => c.state === state)?.label ?? 'All';
        return {
          context: { place: 'runs' },
          chip: `Runs · ${label.toLowerCase()}`,
          questions: [
            'Show only failures',
            'What did today cost?',
            'Which checks did not complete?',
          ],
        };
      }
      const id = decoded(first).toLowerCase();
      const short = shortRunId(id);
      return {
        context: isRunId(id) ? { place: 'run', run: id } : { place: 'run' },
        chip: `Run ${short}`,
        questions: [`Why did ${short} stop?`, `Is it safe to resume ${short}?`],
      };
    }
    case 'work': {
      const n = Number(first);
      return {
        context: Number.isInteger(n) && n > 0 ? { place: 'work', item: n } : { place: 'work' },
        chip: `Work item #${first}`,
        questions: [`What is #${first} waiting on?`, `Which runs worked on #${first}?`],
      };
    }
    case 'steps': {
      const step = decoded(second);
      return {
        context: { place: 'step' },
        chip: `Step ${step}`,
        questions: [`How often does ${step} fail?`, `What does ${step} cost per run?`],
      };
    }
    default:
      return attention;
  }
}

/** One line of the stream at a time, whole, however the network cut it into chunks. */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ManagerEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim() !== '') yield JSON.parse(line) as ManagerEvent;
    }
    pending += decoder.decode();
    if (pending.trim() !== '') yield JSON.parse(pending) as ManagerEvent;
  } finally {
    reader.releaseLock();
  }
}

/** The stream, or the plain sentence that says why there is none. */
export type Outcome = { events: AsyncGenerator<ManagerEvent> } | { failure: string };

type Fetch = typeof fetch;

async function post(
  url: string,
  body: unknown,
  signal: AbortSignal,
  fetchImpl: Fetch,
): Promise<Outcome> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      failure: 'The Manager could not be reached. Check that the dashboard server is running.',
    };
  }
  if (response.status === 503) {
    return { failure: 'The Manager is not set up on this server: it needs a database connection.' };
  }
  if (!response.ok || response.body === null) {
    const reply = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const why = typeof reply?.error === 'string' ? reply.error.split('\n', 1)[0] : response.status;
    return { failure: `The Manager refused the question: ${why}` };
  }
  return { events: readEvents(response.body) };
}

export const postChat = (request: ChatRequest, signal: AbortSignal, fetchImpl: Fetch = fetch) =>
  post('/api/manager/chat', request, signal, fetchImpl);

export const postBriefing = (factory: string, signal: AbortSignal, fetchImpl: Fetch = fetch) =>
  post('/api/manager/briefing', { factory }, signal, fetchImpl);

export type ManagerLink = Extract<ManagerEvent, { type: 'link' }>;
export type ManagerProposal = Extract<ManagerEvent, { type: 'proposal' }>;

export interface ManagerReply {
  role: 'manager';
  kind: 'briefing' | 'answer' | 'action';
  text: string;
  links: ManagerLink[];
  runs: RunSummary[];
  proposals: ManagerProposal[];
  notices: string[];
  state: 'waiting' | 'streaming' | 'done' | 'cut';
  generatedAt?: string;
}

export type ManagerMessage = { role: 'owner'; text: string } | ManagerReply;

export const reply = (
  kind: ManagerReply['kind'],
  text = '',
  state: ManagerReply['state'] = 'waiting',
): ManagerReply => ({
  role: 'manager',
  kind,
  text,
  links: [],
  runs: [],
  proposals: [],
  notices: [],
  state,
});

export function applyEvent(message: ManagerReply, event: ManagerEvent): ManagerReply {
  const next = { ...message, state: 'streaming' as const };
  switch (event.type) {
    case 'text':
      return { ...next, text: message.text + event.text };
    case 'link':
      return { ...next, links: [...message.links, event] };
    case 'runs':
      return { ...next, runs: event.runs };
    case 'proposal':
      return { ...next, proposals: [...message.proposals, event] };
    case 'notice':
      return { ...next, notices: [...message.notices, event.text] };
    case 'done':
      return {
        ...message,
        state: 'done',
        ...(event.generated_at === undefined ? {} : { generatedAt: event.generated_at }),
      };
    default:
      // An event this browser does not know, from a newer server: nothing to show.
      return message;
  }
}

/** A stream that closed before its `done` line. */
export const endWithout = (message: ManagerReply): ManagerReply =>
  message.state === 'done'
    ? message
    : {
        ...message,
        state: 'cut',
        notices: [...message.notices, 'The answer was cut off before it finished.'],
      };

/** A reply that could not start: its one plain sentence. */
export const failed = (message: ManagerReply, why: string): ManagerReply => ({
  ...message,
  state: 'done',
  notices: [...message.notices, why],
});

const MAX_MESSAGES = 20;
const MAX_TEXT = 4000;

/** What the server may be sent: at most its limits, ending with the new question. */
export function historyFor(
  messages: readonly ManagerMessage[],
  question: string,
): ChatRequest['messages'] {
  const kept = messages.flatMap((m) =>
    m.text === '' || (m.role === 'manager' && m.kind === 'action')
      ? []
      : [{ role: m.role, text: m.text.slice(0, MAX_TEXT) }],
  );
  return [...kept, { role: 'owner' as const, text: question.slice(0, MAX_TEXT) }].slice(
    -MAX_MESSAGES,
  );
}

export type Segment = string | ManagerLink;

/** The prose with each link put where the prose names it; links it never names are left over. */
export function linkify(
  text: string,
  links: readonly ManagerLink[],
): { segments: Segment[]; rest: ManagerLink[] } {
  const found: { start: number; end: number; link: ManagerLink }[] = [];
  const rest: ManagerLink[] = [];
  for (const link of links) {
    const names =
      link.kind === 'item' ? [`#${link.id}`] : [link.id, shortRunId(link.id), link.id.slice(0, 8)];
    let hit: { start: number; end: number } | undefined;
    for (const name of names) {
      let from = text.indexOf(name);
      while (from >= 0) {
        const after = text[from + name.length] ?? '';
        const before = text[from - 1] ?? '';
        if (!/[0-9a-z]/i.test(after) && !(link.kind === 'run' && /[0-9a-z-]/i.test(before))) {
          hit = { start: from, end: from + name.length };
          break;
        }
        from = text.indexOf(name, from + 1);
      }
      if (hit) break;
    }
    if (hit) found.push({ ...hit, link });
    else rest.push(link);
  }
  found.sort((a, b) => a.start - b.start);
  const segments: Segment[] = [];
  let at = 0;
  for (const { start, end, link } of found) {
    if (start < at) {
      rest.push(link);
      continue;
    }
    if (start > at) segments.push(text.slice(at, start));
    segments.push(link);
    at = end;
  }
  if (at < text.length) segments.push(text.slice(at));
  return { segments, rest };
}

export const HANDLED_QUERY = 'handled';

/** A row of `db/queries/handled.sql`: an action the owner sent from the dashboard. */
export interface HandledRow {
  id: number;
  action: 'answer' | 'resume';
  run_id: string;
  option: string | null;
  from_step: string | null;
  sent_at: Date;
  exit_code: number | null;
  workflow_name: string | null;
}

/** The rows sent on `now`'s local calendar day. */
export function handledToday(rows: readonly HandledRow[], now: number): HandledRow[] {
  const today = new Date(now).toDateString();
  return rows.filter((row) => new Date(row.sent_at).toDateString() === today);
}

/** "answered 1 question, resumed 2 runs": the answer part first, a part with none left out. */
export function handledSummary(rows: readonly HandledRow[]): string {
  const answers = rows.filter((r) => r.action === 'answer').length;
  const resumes = rows.length - answers;
  return [
    answers === 0 ? null : `answered ${answers} ${answers === 1 ? 'question' : 'questions'}`,
    resumes === 0 ? null : `resumed ${resumes} ${resumes === 1 ? 'run' : 'runs'}`,
  ]
    .filter((part) => part !== null)
    .join(', ');
}

/** The choice an answer proposal's label quotes, else the owner's own words. */
export function proposalChoice(label: string): string {
  return /^Answer "(.*)"$/s.exec(label)?.[1] ?? 'your text';
}

/** HH:MM in the viewer's time zone; empty when there is no time. */
export function clock(at: string | Date | null | undefined): string {
  if (at === null || at === undefined) return '';
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
