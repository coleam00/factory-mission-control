/**
 * The Manager's stream: what `POST /api/manager/chat` and `POST /api/manager/briefing` answer.
 *
 * `200`, `content-type: application/x-ndjson`, one JSON object per line, in this order: `text*`,
 * `link*`, at most one `runs`, at most 3 `proposal`, any `notice`, then `done` as the last line.
 * A proposal is data only: the panel turns it into a button that goes through the action
 * endpoint (#521), whose inputs it carries. `answer`: the run, the option (or `text` for
 * "Something else") and the `occurrence` id. `resume`: the run, optionally `from_step`. This
 * file holds no secret and no server code, so the panel can `import type` from it.
 */
export type ManagerEvent =
  | { type: 'text'; text: string }
  | { type: 'link'; kind: 'run'; id: string; label: string; href: string }
  | { type: 'link'; kind: 'item'; id: number; label: string; href: string }
  | { type: 'runs'; runs: RunSummary[] }
  | {
      type: 'proposal';
      action: 'answer';
      factory: string;
      run_id: string;
      occurrence: string;
      option: string | null;
      text: string | null;
      label: string;
    }
  | {
      type: 'proposal';
      action: 'resume';
      factory: string;
      run_id: string;
      from_step: string | null;
      label: string;
    }
  | { type: 'notice'; kind: 'message-cap' | 'day-cap' | 'unavailable' | 'unstructured'; text: string }
  | {
      type: 'done';
      cost_usd: number;
      day_spent_usd: number;
      day_cap_usd: number;
      /** Briefing only. */
      generated_at?: string;
      cached?: boolean;
    };

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
  links: { kind: 'run' | 'item'; id: string | number }[];
  runs: string[];
  proposals: {
    action: 'answer' | 'resume';
    run_id: string;
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
    if ((kind === 'run' || kind === 'item') && (typeof id === 'string' || typeof id === 'number')) {
      links.push({ kind, id });
    }
  }
  const proposals: RawStructure['proposals'] = [];
  for (const entry of list(parsed.proposals)) {
    if (!isRecord(entry) || typeof entry.run_id !== 'string') continue;
    if (entry.action !== 'answer' && entry.action !== 'resume') continue;
    proposals.push({
      action: entry.action,
      run_id: entry.run_id,
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
