/**
 * pnpm listing [url] [--publish]
 *
 * SR-13. Writes server.json (the MCP Registry entry) for the deployed app and checks that the
 * deployment answers what the listing promises: the public MCP lists four tools, and the A2A card,
 * llms.txt and the MCP server card are served. Without --publish it changes nothing outside this
 * repo and prints the publish steps. With --publish it runs `mcp-publisher publish`, which is
 * outward-facing: only on the team's go, after `mcp-publisher login github` as the repo owner.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { PUBLIC_TOOLS } from "../packages/core/contracts";
import { REGISTRY_NAME, serverJson } from "../packages/core/src/public/discovery";

const args = process.argv.slice(2);
const publish = args.includes("--publish");
const base = (args.find((a) => !a.startsWith("--")) ?? process.env.APP_URL ?? "").replace(/\/$/, "");

async function get(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(20_000) });
}

async function main(): Promise<void> {
  if (!/^https:\/\//.test(base) || /localhost|127\.0\.0\.1/.test(base)) {
    throw new Error(
      "pass the deployed https URL (or set APP_URL); a registry entry can't point at localhost",
    );
  }
  const problems: string[] = [];

  const res = await get("/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const text = await res.text();
  const data = text.includes("data:")
    ? text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .at(-1)
    : text;
  const tools = (
    (JSON.parse(data || "{}") as { result?: { tools?: { name: string }[] } }).result?.tools ?? []
  ).map((t) => t.name);
  const want = Object.keys(PUBLIC_TOOLS).sort();
  if (JSON.stringify(tools.sort()) !== JSON.stringify(want))
    problems.push(`/api/mcp lists [${tools.join(", ")}], want [${want.join(", ")}]`);

  for (const path of ["/.well-known/agent-card.json", "/.well-known/mcp/server-card.json", "/llms.txt"]) {
    const r = await get(path);
    if (!r.ok) problems.push(`${path}: HTTP ${r.status}`);
    else if (!(await r.text()).includes(new URL(base).host))
      problems.push(`${path} doesn't point at ${base}`);
  }

  if (problems.length) {
    for (const p of problems) console.log(`FAIL ${p}`);
    throw new Error("the deployment doesn't match the listing; fix it before publishing");
  }

  writeFileSync("server.json", `${JSON.stringify(serverJson(base), null, 2)}\n`);
  console.log(`ok   ${base} serves the four tools and the discovery files`);
  console.log(`ok   wrote server.json for ${REGISTRY_NAME}`);

  if (!publish) {
    console.log(`
To list Outrun (each step is public; do it only on the team's go):
  1. MCP Registry: brew install mcp-publisher, then as the GitHub owner of the namespace
     mcp-publisher login github && pnpm listing ${base} --publish
  2. A2A directories: submit ${base}/.well-known/agent-card.json
  3. Glama / Smithery / PulseMCP: add the remote server ${base}/api/mcp; they read the registry too.`);
    return;
  }
  const run = spawnSync("mcp-publisher", ["publish"], { stdio: "inherit" });
  if (run.error) throw new Error(`mcp-publisher isn't installed: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`mcp-publisher publish exited ${run.status}`);
  console.log(`published ${REGISTRY_NAME}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
