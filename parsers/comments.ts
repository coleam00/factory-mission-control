// Parses the comments and issue bodies the loop leaves on GitHub (PRD appendix): claims, claim
// releases, review outcomes, owner questions, and the `Depends on:` and `Phase:` lines of an issue.
// Every function is pure: text in, a row or null out. Malformed input returns null, never throws.

export type Route = 'simple' | 'complex' | 'continue';

export interface Claim {
  runId: string;
  route: Route;
  area: string;
}

export interface ClaimReleased {
  runId: string;
}

export type Review =
  | { outcome: 'merged'; route: Route; sha: string }
  | { outcome: 'refused'; route: Route; reason: string }
  | { outcome: 'sent-back'; route: Route };

export const REVIEW_OUTCOMES = [
  'merged',
  'refused',
  'sent-back',
] as const satisfies readonly Review['outcome'][];

export interface OwnerOption {
  key: string;
  text: string;
}

export interface OwnerQuestion {
  number: number;
  question: string;
  options: OwnerOption[];
  recommendation: string | null;
  default: string | null;
  /** ISO 8601 UTC, e.g. `2026-10-27T14:00:00Z`. */
  defaultAt: string | null;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROUTES = new Set<string>(['simple', 'complex', 'continue']);

function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

function route(value: string | undefined): Route | null {
  return value && ROUTES.has(value) ? (value as Route) : null;
}

/** The trimmed value of the first `<label>: <value>` line, or null. */
function field(all: string[], label: string): string | null {
  const prefix = `${label}:`;
  const line = all.find((l) => l.trim().startsWith(prefix));
  const value = line?.trim().slice(prefix.length).trim();
  return value ? value : null;
}

export function parseClaim(text: string): Claim | null {
  const all = lines(text);
  const head = new RegExp(`^Loop claim: run (${UUID})\\s*$`).exec(all[0]?.trim() ?? '');
  const runId = head?.[1];
  const parsedRoute = route(field(all, 'Route') ?? undefined);
  const area = field(all, 'Area');
  if (!runId || !parsedRoute || !area) return null;
  return { runId, route: parsedRoute, area };
}

export function parseClaimReleased(text: string): ClaimReleased | null {
  const match = new RegExp(`^Loop claim released: run (${UUID})\\b`).exec(text.trim());
  return match?.[1] ? { runId: match[1] } : null;
}

export function parseReview(text: string): Review | null {
  const all = lines(text.trim());
  const head = all[0]?.trim() ?? '';

  const merged = /^Loop review: merged \(route: (\w+)\) at ([0-9a-f]{40})\b/.exec(head);
  if (merged) {
    const r = route(merged[1]);
    return r && merged[2] ? { outcome: 'merged', route: r, sha: merged[2] } : null;
  }

  const refused = /^Loop review: not merged \(route: (\w+)\)/.exec(head);
  if (refused) {
    const r = route(refused[1]);
    const reasons = all
      .slice(1)
      .map((l) => /^\s*[-*] (.+)$/.exec(l)?.[1]?.trim())
      .filter((reason): reason is string => Boolean(reason));
    return r && reasons.length > 0
      ? { outcome: 'refused', route: r, reason: reasons.join('\n') }
      : null;
  }

  const sentBack = /^Loop review: sent back \(route: (\w+)\)/.exec(head);
  if (sentBack) {
    const r = route(sentBack[1]);
    return r ? { outcome: 'sent-back', route: r } : null;
  }

  return null;
}

function question(section: string[]): OwnerQuestion | null {
  const head = /^###\s+Q(\d+)\.\s+(.+?)\s*$/.exec(section[0] ?? '');
  if (!head?.[1] || !head[2]) return null;

  const options: OwnerOption[] = [];
  const optionText = field(section, 'Options');
  if (optionText) {
    for (const part of optionText.replace(/\.$/, '').split(/;\s*(?=[A-Z]\)\s)/)) {
      const option = /^([A-Z])\)\s+(.+?)\s*$/.exec(part.trim());
      if (!option?.[1] || !option[2]) return null;
      options.push({ key: option[1], text: option[2] });
    }
  }

  let fallback: string | null = null;
  let defaultAt: string | null = null;
  const deadline = section
    .map((l) =>
      /^If there is no answer by (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC, the loop will use ([A-Z])\b/.exec(
        l.trim(),
      ),
    )
    .find(Boolean);
  if (deadline?.[1] && deadline[2] && deadline[3]) {
    defaultAt = `${deadline[1]}T${deadline[2]}:00Z`;
    fallback = deadline[3];
  }

  return {
    number: Number(head[1]),
    question: head[2],
    options,
    recommendation: field(section, 'Recommendation'),
    default: fallback,
    defaultAt,
  };
}

/** Every `### Q<n>.` section of the `Owner decisions needed` issue body that parses. */
export function parseOwnerQuestions(body: string): OwnerQuestion[] {
  const sections: string[][] = [];
  for (const line of lines(body)) {
    if (/^###\s+Q\d+\./.test(line)) sections.push([line]);
    else if (/^#{1,3}\s/.test(line)) sections.push([]);
    else sections.at(-1)?.push(line);
  }
  return sections
    .filter((s) => s.length > 0)
    .map(question)
    .filter((q): q is OwnerQuestion => q !== null);
}

/** The issue numbers on an issue body's `Depends on:` lines, in order, without repeats. */
export function parseDependsOn(body: string): number[] {
  const found: number[] = [];
  for (const line of lines(body)) {
    const match = /^\s*Depends on:(.*)$/.exec(line);
    if (!match?.[1]) continue;
    for (const ref of match[1].matchAll(/#(\d+)\b/g)) {
      const n = Number(ref[1]);
      if (!found.includes(n)) found.push(n);
    }
  }
  return found;
}

/** The value of an issue body's first `Phase:` line. */
export function parsePhase(body: string): string | null {
  for (const line of lines(body)) {
    const match = /^\s*Phase:\s*(.+?)\s*$/.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}
