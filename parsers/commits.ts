// Parses the pin and verdict commits on ai-software-factory (PRD 11.5). Pure functions over a full
// commit message; malformed input returns null.

export interface Pin {
  archonSha: string;
  reason: string;
  hypothesis: string | null;
  measure: string | null;
}

export const VERDICT_OUTCOMES = ['helped', 'hurt', 'inconclusive'] as const;
export type VerdictOutcome = (typeof VERDICT_OUTCOMES)[number];

export interface Verdict {
  pin: string;
  verdict: VerdictOutcome;
  sentence: string;
}

function trailer(lines: string[], key: string): string | null {
  const prefix = `${key}:`;
  const line = lines.find((l) => l.startsWith(prefix));
  const value = line?.slice(prefix.length).trim();
  return value ? value : null;
}

export function parsePin(message: string): Pin | null {
  const lines = message.trim().split(/\r?\n/);
  const subject = /^Pin Archon ([0-9a-f]{7,40}): (.+?)\s*$/.exec(lines[0] ?? '');
  if (!subject?.[1] || !subject[2]) return null;
  const body = lines.slice(1);
  return {
    archonSha: subject[1],
    reason: subject[2],
    hypothesis: trailer(body, 'Hypothesis'),
    measure: trailer(body, 'Measure'),
  };
}

export function parseVerdict(message: string): Verdict | null {
  for (const line of message.split(/\r?\n/)) {
    const match = /^Verdict: ([0-9a-f]{7,40}) (helped|hurt|inconclusive): (.+?)\s*$/.exec(line);
    if (match?.[1] && match[2] && match[3]) {
      return { pin: match[1], verdict: match[2] as VerdictOutcome, sentence: match[3] };
    }
  }
  return null;
}
