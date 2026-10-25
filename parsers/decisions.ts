// Parses `DECISIONS.md` (PRD 11.5): entries of the fixed shape `## YYYY-MM-DD Title`, then
// `Decision:`, `Why:`, `Replaces:` and `Version:`. A malformed entry becomes an error naming it,
// never a throw, so one bad entry does not hide the others.

export interface Decision {
  date: string;
  title: string;
  decision: string;
  why: string;
  replaces: string;
  /** A pin sha prefix; joins to a pin by prefix. */
  version: string;
}

export interface DecisionError {
  /** The entry's heading as written, without the `## `. */
  entry: string;
  /** 1-based line of the heading. */
  line: number;
  message: string;
}

export interface Decisions {
  entries: Decision[];
  errors: DecisionError[];
}

const FIELDS = ['Decision', 'Why', 'Replaces', 'Version'] as const;
type Field = (typeof FIELDS)[number];

export function parseDecisions(text: string): Decisions {
  const entries: Decision[] = [];
  const errors: DecisionError[] = [];
  const lines = text.split(/\r?\n/);

  let at = 0;
  while (at < lines.length) {
    const heading = /^##\s+(.*?)\s*$/.exec(lines[at] ?? '');
    if (!heading) {
      at++;
      continue;
    }
    const headingLine = at + 1;
    const entry = heading[1] ?? '';
    const body: string[] = [];
    for (at++; at < lines.length && !/^##\s/.test(lines[at] ?? ''); at++) {
      body.push(lines[at] ?? '');
    }

    const fields = new Map<Field, string>();
    let current: Field | null = null;
    for (const line of body) {
      const match = /^(Decision|Why|Replaces|Version):\s*(.*)$/.exec(line);
      if (match?.[1]) {
        current = match[1] as Field;
        fields.set(current, (match[2] ?? '').trim());
      } else if (current && line.trim() !== '') {
        fields.set(current, `${fields.get(current)} ${line.trim()}`.trim());
      } else if (line.trim() === '') {
        current = null;
      }
    }

    const dated = /^(\d{4}-\d{2}-\d{2})\s+(.+)$/.exec(entry);
    const missing = FIELDS.filter((f) => !fields.get(f));
    if (!dated?.[1] || !dated[2]) {
      errors.push({ entry, line: headingLine, message: 'heading is not `## YYYY-MM-DD Title`' });
    } else if (missing.length > 0) {
      errors.push({
        entry,
        line: headingLine,
        message: `missing ${missing.map((f) => `\`${f}:\``).join(', ')}`,
      });
    } else {
      entries.push({
        date: dated[1],
        title: dated[2],
        decision: fields.get('Decision') ?? '',
        why: fields.get('Why') ?? '',
        replaces: fields.get('Replaces') ?? '',
        version: fields.get('Version') ?? '',
      });
    }
  }
  return { entries, errors };
}
