// Self-test for the judges: runs each judge on its records and checks the verdict the file name
// starts with (pass-, fail-, inconclusive-). Usage: bun .factory/holdout/judges/records/check.js
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const here = import.meta.dir;
let bad = 0;
for (const judge of readdirSync(here, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  for (const f of readdirSync(join(here, judge.name)).filter((f) => f.endsWith(".json")).sort()) {
    const want = f.split("-")[0].toUpperCase();
    const r = spawnSync(process.execPath, [join(here, "..", `${judge.name}.js`), join(here, judge.name, f)], { encoding: "utf8" });
    const got = r.stdout.split("\n")[0].trim();
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "BAD "} ${judge.name}/${f}: ${got} (want ${want})`);
  }
}
process.exit(bad ? 1 : 0);
