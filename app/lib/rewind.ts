/** A row of `db/queries/rewind-branches.sql`; Realtime delivers its timestamps as dates. */
export interface RewindBranchRow {
  name: string;
  parent: string;
  at: Date;
  created_at: Date;
}

/**
 * Switches the server's sealing to `branch`, or back to its home branch for null, then reloads
 * the page it was called on: the page's Realtime client is bound to one branch, so every panel
 * opens again on the new one. Other open pages follow at their next seal (`followSwitch`). A refused switch
 * throws the server's reason and leaves the page as it is.
 */
export async function switchBranch(branch: string | null): Promise<void> {
  const res = await fetch('/api/rewind', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ branch }),
  });
  if (!res.ok) {
    const answer = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
    throw new Error(
      typeof answer?.error === 'string' ? answer.error : `switching answered ${res.status}`,
    );
  }
  window.location.reload();
}

let following = false;

/**
 * The server switched branches since this page loaded (another tab switched): the page's
 * Realtime client is bound to the branch it loaded on, so it reloads onto the new one, once, on
 * the same screen.
 */
export function followSwitch(): void {
  if (following) return;
  following = true;
  window.location.reload();
}

/** The moment a rewind branch shows, in UTC to the second as its name has it. */
export function rewindMoment(at: Date): string {
  return `${at.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/**
 * Which of `names` have no Neon branch any more, as the server's `GET /api/rewind/branches`
 * answers. A name is gone only when the server says so: when it cannot ask Neon, none is.
 */
export async function goneRewinds(names: readonly string[]): Promise<Set<string>> {
  const res = await fetch('/api/rewind/branches').catch(() => undefined);
  if (!res?.ok) return new Set();
  const answer = (await res.json().catch(() => undefined)) as { branches?: unknown } | undefined;
  const branches = answer?.branches;
  if (!Array.isArray(branches)) return new Set();
  return new Set(names.filter((name) => !branches.includes(name)));
}
