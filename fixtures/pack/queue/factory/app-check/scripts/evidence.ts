import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { emit, env, readJsonFile } from "../../.shared/utils.ts";

export const LINE = /^(C\d+|P\d+|A\d+)\s{2}(PASS|FAIL|INCOMPLETE)\s{2}(.+?)\s{2}evidence:\s+(.+)$/;

// result.json can arrive as UTF-8 bytes decoded as windows-1252 ("·" as "Â·", "→" as "â†’"), which latin1 alone cannot invert.
const CP1252_BYTE = new Map<string, number>();
for (let b = 0x80; b <= 0x9f; b++) CP1252_BYTE.set(new TextDecoder("windows-1252").decode(Uint8Array.of(b)), b);
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function repairMojibake(text: string): string {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!, byte = CP1252_BYTE.get(ch) ?? text.charCodeAt(i);
    if (byte > 0xff) return text;
    bytes[i] = byte;
  }
  try { return UTF8.decode(bytes); } catch { return text; }
}

const comparable = (text: string) => repairMojibake(text).normalize("NFC");

export function evidenceProblems(result: any, report: string, root: string, preparedAt: number): string[] {
  const problems: string[] = [], lines = Array.isArray(result?.lines) ? result.lines : [];
  if (!lines.length) problems.push("result has no check lines");
  const comparableReport = report.split("\n").map(comparable).join("\n");
  let blocked = false, criteria = 0;
  const seen = new Set<string>();
  for (const raw of lines) {
    const match = typeof raw === "string" ? raw.match(LINE) : null;
    if (!match) { problems.push(`invalid line: ${String(raw)}`); continue; }
    const id = match[1]!;
    if (seen.has(id)) problems.push(`duplicate check id: ${id}`);
    seen.add(id);
    if (id.startsWith("C")) criteria++;
    if (match[2] !== "PASS") blocked = true;
    const cited = match[4]!.trim();
    const path = isAbsolute(cited) ? cited : resolve(root, cited);
    if (!existsSync(path) || !statSync(path).isFile()) problems.push(`${match[1]} cites a missing file: ${cited}`);
    else if (statSync(path).mtimeMs < preparedAt) problems.push(`${match[1]} cites evidence older than prepare: ${cited}`);
    if (!comparableReport.includes(comparable(raw))) problems.push(`${match[1]} is absent from report.md`);
  }
  if (criteria === 0) problems.push("result has no acceptance/core check lines");
  const expectedOverall = blocked ? "FAIL" : "PASS";
  if (result?.overall !== expectedOverall) problems.push(`overall must be ${expectedOverall}`);
  return problems;
}

if (import.meta.main) {
  const root = join(process.env.ARTIFACTS_DIR!, "app-check"), resultPath = join(root, "result.json"), reportPath = join(root, "report.md");
  if (!existsSync(resultPath) || !existsSync(reportPath)) throw new Error("check must write app-check/result.json and app-check/report.md");
  const preparedAt = Number(env("prepared_at"));
  if (statSync(resultPath).mtimeMs < preparedAt || statSync(reportPath).mtimeMs < preparedAt) throw new Error("result.json and report.md must be written after prepare");
  const result = readJsonFile<any>(resultPath), report = readFileSync(reportPath, "utf8");
  const problems = evidenceProblems(result, report, root, preparedAt);
  if (problems.length) throw new Error(problems.join("\n"));
  emit({ overall: result.overall, lines: result.lines, report });
}
