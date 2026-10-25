// Parses the `Loop metrics` issue body (one line per manager pass, PRD appendix) and the holdout
// scenario id of an app-check line (PRD 11.7). Pure functions; malformed input returns null.
// Holdout parsers return ids and verdicts only, never a scenario's or a line's text (invariant 3).

export interface MetricsLine {
  /** As written, e.g. `2026-10-25T14:20Z`. */
  at: string;
  merged: { total: number; simple: number; complex: number; continue: number };
  openPrs: number;
  sendBacks: number;
  gateRefusals: number;
  correctionRounds: number;
  needsOwnerOpen: number;
  ownerQuestionsOpen: number;
  /** As written, e.g. `green (CI)`. */
  defaultBranchChecks: string;
  laps: { total: number; empty: number; failed: number };
  healthActions: number;
}

export const HOLDOUT_VERDICTS = ['PASS', 'FAIL', 'INCOMPLETE'] as const;
export type HoldoutVerdict = (typeof HOLDOUT_VERDICTS)[number];

export interface HoldoutResult {
  id: string;
  verdict: HoldoutVerdict;
  /** The issue filed for a failing or incomplete scenario. */
  issue: number | null;
}

export interface HoldoutsLine {
  sha: string;
  holdouts: HoldoutResult[];
}

const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z$/;

function segments(line: string): string[] {
  return line.trim().split(/\s+\|\s+/);
}

function count(value: string | undefined): number | null {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

export function parseMetricsLine(line: string): MetricsLine | null {
  const [at, ...rest] = segments(line);
  if (!at || !AT.test(at)) return null;
  const values = new Map<string, string>();
  for (const segment of rest) {
    const match = /^([^:]+):\s*(.+)$/.exec(segment);
    if (match?.[1] && match[2]) values.set(match[1].trim(), match[2].trim());
  }

  const merged = /^(\d+) \(simple (\d+), complex (\d+), continue (\d+)\)$/.exec(
    values.get('merged since last pass') ?? '',
  );
  const laps = /^(\d+) \(empty (\d+), failed (\d+)\)$/.exec(
    values.get('laps since last pass') ?? '',
  );
  const openPrs = count(values.get('open PRs'));
  const sendBacks = count(values.get('loop send-backs since last pass'));
  const gateRefusals = count(values.get('merge-gate refusals'));
  const correctionRounds = count(values.get('ship correction rounds'));
  const needsOwnerOpen = count(values.get('needs-owner open'));
  const ownerQuestionsOpen = count(values.get('owner questions open'));
  const healthActions = count(values.get('health actions'));
  const defaultBranchChecks = values.get('default branch checks');
  if (
    !merged ||
    !laps ||
    openPrs === null ||
    sendBacks === null ||
    gateRefusals === null ||
    correctionRounds === null ||
    needsOwnerOpen === null ||
    ownerQuestionsOpen === null ||
    healthActions === null ||
    !defaultBranchChecks
  ) {
    return null;
  }

  return {
    at,
    merged: {
      total: Number(merged[1]),
      simple: Number(merged[2]),
      complex: Number(merged[3]),
      continue: Number(merged[4]),
    },
    openPrs,
    sendBacks,
    gateRefusals,
    correctionRounds,
    needsOwnerOpen,
    ownerQuestionsOpen,
    defaultBranchChecks,
    laps: { total: Number(laps[1]), empty: Number(laps[2]), failed: Number(laps[3]) },
    healthActions,
  };
}

export function parseHoldoutsLine(line: string): HoldoutsLine | null {
  const [at, body, ...extra] = segments(line);
  if (!at || !AT.test(at) || !body || extra.length > 0) return null;
  const head = /^holdouts at ([0-9a-f]{7,40}):\s*(.*)$/.exec(body);
  if (!head?.[1] || head[2] === undefined) return null;

  const holdouts: HoldoutResult[] = [];
  if (head[2].trim() !== '') {
    for (const item of head[2].split(/,\s*/)) {
      const match = /^(H-\d{2,}) (PASS|FAIL|INCOMPLETE)(?: #(\d+))?$/.exec(item.trim());
      if (!match?.[1] || !match[2]) return null;
      holdouts.push({
        id: match[1],
        verdict: match[2] as HoldoutVerdict,
        issue: match[3] ? Number(match[3]) : null,
      });
    }
  }
  return { sha: head[1], holdouts };
}

/** The first `H-<nn>` in an app-check holdout line, or `unidentified`; nothing else of the line. */
export function holdoutId(line: string): string {
  return /\bH-\d{2,}\b/.exec(line)?.[0] ?? 'unidentified';
}
