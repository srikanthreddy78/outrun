/**
 * pnpm eval: replays evals/crew/*.yaml on the fake Naive client.
 * SH-9 fills in scenarios; until then this checks that every file parses.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const dir = join(import.meta.dirname, "..", "evals", "crew");
const files = readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
let failed = 0;
for (const file of files) {
  try {
    parse(readFileSync(join(dir, file), "utf8"));
    console.log(`ok   ${file}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${file}: ${(err as Error).message}`);
  }
}
console.log(`${files.length} scenario file(s), ${failed} failed`);
process.exit(failed ? 1 : 0);
