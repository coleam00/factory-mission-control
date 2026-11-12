/**
 * The Manager's stream: what `POST /api/manager/chat` and `POST /api/manager/briefing` answer.
 *
 * `200`, `content-type: application/x-ndjson`, one JSON object per line, in this order: `text*`,
 * `link*`, at most one `runs`, at most 3 `proposal`, any `notice`, then `done` as the last line.
 * A proposal is data only: the panel turns it into a button that goes through the action
 * endpoint (#521), whose inputs it carries. `answer`: the run, the option (or `text` for
 * "Something else") and the `occurrence` id. `resume`: the run, optionally `from_step`.
 * `retriage`, `close` and `comment` (with `text`): the work item's `number`. This
 * file holds no secret and no server code, so the panel can import from it.
 */
import type { ActionRequest } from '../app/lib/actions';

export type ManagerEvent =
  | { type: 'text'; text: string }
  | { type: 'link'; kind: 'run'; id: string; href: string }
  | { type: 'link'; kind: 'item'; id: number; href: string }
  | { type: 'runs'; runs: RunSummary[] }
  | ({
      type: 'proposal';
      label: string;
      /** Answer by option only: the choice's wording, for the Undo toast. Never sent to the action endpoint. */
      detail?: string;
    } & ActionRequest)
  | {
      type: 'notice';
      kind: 'message-cap' | 'day-cap' | 'unavailable' | 'unstructured';
      text: string;
    }
  | {
      type: 'done';
      cost_usd: number;
      day_spent_usd: number;
      day_cap_usd: number;
      /** Briefing only. */
      generated_at?: string;
      cached?: boolean;
    };

type KeysOfEach<T> = T extends unknown ? keyof T : never;
/** The request the action endpoint takes, with the envelope stripped. The type check fails to compile when a key the endpoint does not accept is left in the rest object. */
export function proposalRequest(proposal: Proposal): ActionRequest {
  const { type: _type, label: _label, detail: _detail, ...request } = proposal;
  const exact: [Exclude<KeysOfEach<typeof request>, KeysOfEach<ActionRequest>>] extends [never]
    ? typeof request
    : never = request;
  return exact;
}

export type NoticeKind = Extract<ManagerEvent, { type: 'notice' }>['kind'];
type Proposal = Extract<ManagerEvent, { type: 'proposal' }>;
export type ProposalAction = Extract<ManagerEvent, { type: 'proposal' }>['action'];
export type LinkKind = Extract<ManagerEvent, { type: 'link' }>['kind'];

export const LINK_KINDS: Record<LinkKind, true> = { run: true, item: true };
export const PROPOSAL_ACTIONS: Record<ProposalAction, true> = {
  answer: true,
  resume: true,
  retriage: true,
  close: true,
  comment: true,
};

function isLinkKind(value: unknown): value is LinkKind {
  return typeof value === 'string' && Object.hasOwn(LINK_KINDS, value);
}

function isProposalAction(value: unknown): value is ProposalAction {
  return typeof value === 'string' && Object.hasOwn(PROPOSAL_ACTIONS, value);
}

export const PLACES = ['attention', 'factory', 'board', 'runs', 'run', 'work', 'step'] as const;

export interface ChatRequest {
  factory: string;
  context: {
    place: (typeof PLACES)[number];
    run?: string;
    item?: number;
    workflow?: string;
    step?: string;
    order?: string;
  };
  messages: { role: 'owner' | 'manager'; text: string }[];
}

/** The statuses of a run the owner can resume: the prompt names them and the proposal check admits them. */
export const RESUMABLE_STATUSES = ['failed', 'paused'] as const;

/** The longest workflow, step or work-order name the context carries. */
export const MAX_NAME_CHARS = 100;

/** A name from the owner's address: free text, so no line breaks or other control characters can reach the prompt. */
export function isName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_NAME_CHARS &&
    ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  );
}

/** The longest conversation and message the chat endpoint accepts; the panel trims to the same. */
export const MAX_MESSAGES = 20;
export const MAX_MESSAGE_CHARS = 4000;

/** At most this many runs in one `runs` event. */
export const MAX_RUNS = 8;
/** At most this many proposals in one answer. */
export const MAX_PROPOSALS = 3;

export interface RunSummary {
  run_id: string;
  workflow_name: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  href: string;
}

export function encodeEvent(event: ManagerEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * What the model names at the end of its answer, in a fenced block with info string `mc`. The
 * server checks every entry against the database before it becomes an event.
 */
export interface RawStructure {
  links: { kind: LinkKind; id: string | number }[];
  runs: string[];
  proposals: {
    action: ProposalAction;
    run_id?: string;
    number?: number;
    option?: string;
    text?: string;
    from_step?: string;
  }[];
}

const FENCE = '```mc';

/**
 * Passes the answer's prose through and stops at the `mc` fence. It holds back a tail that could
 * be the start of the fence, so a fence split across deltas is never shown.
 */
export class AnswerSplitter {
  private pending = '';
  private block: string | null = null;

  push(delta: string): string {
    if (this.block !== null) {
      this.block += delta;
      return '';
    }
    this.pending += delta;
    const at = this.pending.indexOf(FENCE);
    if (at >= 0) {
      const prose = this.pending.slice(0, at);
      this.block = this.pending.slice(at + FENCE.length);
      this.pending = '';
      return prose;
    }
    let keep = 0;
    for (let n = Math.min(FENCE.length - 1, this.pending.length); n > 0; n--) {
      if (FENCE.startsWith(this.pending.slice(-n))) {
        keep = n;
        break;
      }
    }
    const shown = this.pending.slice(0, this.pending.length - keep);
    this.pending = this.pending.slice(this.pending.length - keep);
    return shown;
  }

  /** The held-back tail (no fence came) and the block's JSON text, without its closing fence. */
  end(): { text: string; block: string | null } {
    const text = this.pending;
    this.pending = '';
    const close = this.block?.indexOf('```') ?? -1;
    const block = this.block === null ? null : close >= 0 ? this.block.slice(0, close) : this.block;
    return { text, block };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Keeps only entries of the right shape; bad JSON is an empty structure. */
export function parseBlock(block: string | null): RawStructure {
  const empty: RawStructure = { links: [], runs: [], proposals: [] };
  if (block === null) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return empty;
  }
  if (!isRecord(parsed)) return empty;
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const links: RawStructure['links'] = [];
  for (const entry of list(parsed.links)) {
    if (!isRecord(entry)) continue;
    const { kind, id } = entry;
    if (isLinkKind(kind) && (typeof id === 'string' || typeof id === 'number')) {
      links.push({ kind, id });
    }
  }
  const proposals: RawStructure['proposals'] = [];
  for (const entry of list(parsed.proposals)) {
    if (!isRecord(entry) || !isProposalAction(entry.action)) continue;
    const { run_id, number } = entry;
    if (typeof run_id !== 'string' && !(typeof number === 'number' && Number.isInteger(number))) {
      continue;
    }
    proposals.push({
      action: entry.action,
      run_id: typeof run_id === 'string' ? run_id : undefined,
      number: typeof number === 'number' ? number : undefined,
      option: optionalString(entry.option),
      text: optionalString(entry.text),
      from_step: optionalString(entry.from_step),
    });
  }
  return {
    links,
    runs: list(parsed.runs).filter((run): run is string => typeof run === 'string'),
    proposals,
  };
}
