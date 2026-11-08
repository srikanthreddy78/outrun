/**
 * pnpm naive:up [--dry-run]: runs the pinned `naive up` with each agent's crew token derived
 * from CREW_TOKEN_SECRET into CREW_TOKEN_<..>, which naive.config.ts seals in the vault: the
 * CEO, Outrun's crew, and a crew for each client in .naive/clients.json (pnpm clients:export).
 * Tokens never touch disk or argv. Only Srikanth applies, from main, after a dry run.
 */
import { spawnSync } from "node:child_process";
import { crewTokenEnvAll } from "../packages/core/src/crew/tokens";
import { loadClientCrews } from "../naive/crew";

const args = process.argv.slice(2);
const secret = process.env.CREW_TOKEN_SECRET;
if (!secret) {
  console.error("CREW_TOKEN_SECRET is not set. It must match the one in Vercel's env.");
  process.exit(2);
}
if (!process.env.APP_URL?.startsWith("https://")) {
  console.error("APP_URL must be the deployed https origin.");
  process.exit(2);
}
const dryRun = args.includes("--dry-run");
if (!dryRun && process.env.OUTRUN_APPLY !== "yes") {
  console.error("Refusing to apply without OUTRUN_APPLY=yes. Run with --dry-run first and read the report.");
  process.exit(2);
}

const r = spawnSync("pnpm", ["exec", "naive", "up", ...args], {
  stdio: "inherit",
  env: { ...process.env, ...crewTokenEnvAll(secret, ["outrun", ...loadClientCrews().map((c) => c.slug)]) },
});
process.exit(r.status ?? 1);
