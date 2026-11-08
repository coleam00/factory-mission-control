/**
 * The Decisions screen's attention items (PRD 4.9): `db/queries/attention-items.sql`'s rows as the
 * runs waiting on a person, longest-waiting first. Pure, no React; the browser's clock gives the
 * wait. Archon records the question as one message and no structured recommendation, so the title
 * and the question are read from the layout the pack's queues render. `db/queries/decide.sql` has
 * the recommendation, confidence, option descriptions, item number and occurrence id projected
 * (migration 0031); `recommendedChoice` stays for the Decisions screen and the map until the
 * Attention home replaces them.
 */

/** One row of attention-items.sql. Timestamps are the database's; the browser computes elapsed times. */
export interface AttentionRow {
  run_id: string;
  workflow_name: string;
  node_id: string;
  waiting_since: Date;
  form: string;
  /** The choices as JSON text: `[{"id":"ship","label":"Ship"}]`. */
  options: string;
  /** Archon's labels as JSON text: `{"build":"scope"}`. */
  labels: string;
  message: string;
  /** The factory's Archon console, for the run link. */
  console: string;
}

export interface AttentionOption {
  id: string;
  label: string | null;
  /** The choice line's text after its label, when the message has one. */
  description: string | null;
}

/** One row of decide.sql: an attention-items.sql row with what #516's cards and #521's Answer need. */
export interface DecideRow extends AttentionRow {
  /** Archon's occurrence of the wait: its pause id, else `legacy:<step>`. What an answer names. */
  occurrence_id: string;
  recommended: string | null;
  confidence: string | null;
  item_number: number | null;
}

export type DecideItem = AttentionItem &
  Pick<DecideRow, 'occurrence_id' | 'recommended' | 'confidence' | 'item_number'>;

export const UNSTICK_ACTIONS = ['retriage', 'resume', 'release_claim'] as const;

/** One row of unstick.sql: work that stopped moving, what it waits on, since when, and the one action that moves it. */
export interface UnstickRow {
  kind: 'blocked' | 'parked' | 'capacity' | 'claim';
  number: number | null;
  run_id: string | null;
  workflow_name: string | null;
  waits_on: string;
  since: Date | null;
  action: (typeof UNSTICK_ACTIONS)[number];
}

export interface AttentionItem extends Omit<AttentionRow, 'options' | 'labels'> {
  options: AttentionOption[];
  labels: Record<string, string>;
}

/** The choices, in order; an unreadable value is no choices rather than a broken screen. */
export function parseChoices(text: string): AttentionOption[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((option) =>
      option && typeof option.id === 'string'
        ? [
            {
              id: option.id,
              label: typeof option.label === 'string' ? option.label : null,
              description: typeof option.description === 'string' ? option.description : null,
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}

function parseLabels(text: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, value]) =>
        typeof value === 'string' ? [[key, value]] : [],
      ),
    );
  } catch {
    return {};
  }
}

/** The items, longest-waiting first, then by run. */
export function attentionItems<Row extends AttentionRow>(
  rows: readonly Row[],
): (Omit<Row, 'options' | 'labels'> & Pick<AttentionItem, 'options' | 'labels'>)[] {
  return rows
    .map((row) => ({ ...row, options: parseChoices(row.options), labels: parseLabels(row.labels) }))
    .sort(
      (a, b) =>
        a.waiting_since.getTime() - b.waiting_since.getTime() || a.run_id.localeCompare(b.run_id),
    );
}

const paragraphs = (message: string) =>
  message
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '');

const plain = (text: string) => text.replace(/\*\*/g, '').replace(/`/g, '').trim();

const WHAT_IT_IS = '**What it is.**';

/** The message's first line when it is wholly bold, such as `**Build queue, issue 15: scope decision**`. */
export function attentionTitle(message: string): string | null {
  const first = message.trim().split('\n')[0]?.trim() ?? '';
  const match = /^\*\*([^*]+)\*\*$/.exec(first);
  return match?.[1]?.trim() ?? null;
}

/**
 * The question in plain words: the "What it is." paragraph without its lead, else the first
 * paragraph that is not the title, else the whole message.
 */
export function attentionQuestion(message: string): string {
  const all = paragraphs(message);
  const what = all.find((paragraph) => paragraph.startsWith(WHAT_IT_IS));
  if (what) return plain(what.slice(WHAT_IT_IS.length));
  const title = attentionTitle(message);
  const body = all.find((paragraph) => !(title !== null && paragraph === `**${title}**`));
  return plain(body ?? message);
}

/** The id the message's "Recommendation: <id>" line names, when it is one of the choices. */
export function recommendedChoice(
  message: string,
  options: readonly Pick<AttentionOption, 'id'>[],
): string | null {
  const id = /\*\*Recommendation: `([^`]+)`\*\*/.exec(message)?.[1];
  return id !== undefined && options.some((option) => option.id === id) ? id : null;
}

/**
 * Where the item came from: its labels as `key: value` joined by ` · `, a label with no value as
 * just its key; without labels, the workflow's name without its `archon-` lead.
 */
export function attentionOrigin(item: Pick<AttentionItem, 'labels' | 'workflow_name'>): string {
  const labels = Object.entries(item.labels).map(([key, value]) =>
    value === '' ? key : `${key}: ${value}`,
  );
  return labels.length > 0 ? labels.join(' · ') : item.workflow_name.replace(/^archon-/, '');
}
