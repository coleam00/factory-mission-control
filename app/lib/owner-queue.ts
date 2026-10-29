/**
 * The owner queue (PRD 4.4): `db/queries/owner-queue.sql`'s rows as the items waiting on the
 * owner, longest-waiting first. Pure, no React; the browser's clock gives the wait.
 */

/** One row of owner-queue.sql. Timestamps are the database's; the browser computes elapsed times. */
export interface OwnerQueueRow {
  kind: 'issue' | 'question';
  issue_number: number;
  /** A question's number in its issue; null for an issue. */
  question_number: number | null;
  /** The issue's title, or the question. */
  title: string;
  /** The issue's GitHub URL; null when the issue is not mirrored. */
  url: string | null;
  /** A question's options as JSON text: `[{"key":"A","text":"..."}]`. */
  options: string | null;
  recommendation: string | null;
  default_option: string | null;
  default_at: Date | null;
  waiting_since: Date | null;
  /** True for an issue whose label time was never recorded: it waits since its last update. */
  approximate: boolean;
}

export interface OwnerOption {
  key: string;
  text: string;
}

export interface OwnerItem extends Omit<OwnerQueueRow, 'options'> {
  /** `issue-17` or `question-17-2`: one per item. */
  id: string;
  options: OwnerOption[];
}

/** A question's options, in order; an unreadable value is no options rather than a broken screen. */
export function parseOptions(text: string | null): OwnerOption[] {
  if (text === null) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((option) =>
      option && typeof option.key === 'string' && typeof option.text === 'string'
        ? [{ key: option.key, text: option.text }]
        : [],
    );
  } catch {
    return [];
  }
}

const timeOf = (at: Date | null) => (at === null ? Number.POSITIVE_INFINITY : at.getTime());

/** The queue: longest-waiting first, then issues before questions, then by number. */
export function ownerQueue(rows: readonly OwnerQueueRow[]): OwnerItem[] {
  return rows
    .map((row) => ({
      ...row,
      id:
        row.kind === 'issue'
          ? `issue-${row.issue_number}`
          : `question-${row.issue_number}-${row.question_number}`,
      options: parseOptions(row.options),
    }))
    .sort(
      (a, b) =>
        timeOf(a.waiting_since) - timeOf(b.waiting_since) ||
        a.kind.localeCompare(b.kind) ||
        a.issue_number - b.issue_number ||
        (a.question_number ?? 0) - (b.question_number ?? 0),
    );
}

/** `3d 4h`, `5h 12m`, `12m`: how long an item has waited, to the minute. */
export function waited(seconds: number): string {
  const minutes = Math.max(0, Math.floor(seconds / 60));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${rest}m`;
  return `${rest}m`;
}
