/**
 * pnpm naive:sync [--dry-run]: run after every `naive up`. naive.config.ts already declares
 * the agents' MCP servers, the vault tokens, the team and the schedule; this script sets what
 * the config can't and checks what it should have done:
 *   1. reads back our six agents and their versions,
 *   2. checks the orchestrator's coordinator roster (members are pinned by version),
 *   3. registers the Naive webhook at <APP_URL>/api/webhooks/naive if it isn't there.
 * The webhook secret, shown once, is written to .naive/webhook-secret (0600, git-ignored).
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { AGENTS, NAIVE_WEBHOOK_EVENTS } from "../packages/core/contracts";
import { TEAM } from "../naive/crew";

const BASE = process.env.NAIVE_API_BASE ?? "https://api.vetta.sh";
const key = process.env.NAIVE_API_KEY;
const appUrl = process.env.APP_URL?.replace(/\/$/, "");
const dryRun = process.argv.includes("--dry-run");

if (!key) fail("NAIVE_API_KEY is not set");
if (!appUrl?.startsWith("https://")) fail("APP_URL must be the deployed https origin");

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as {
    error?: { code: string; message: string; request_id?: string };
  };
  if (!res.ok) {
    const e = json.error;
    throw new Error(
      `${method} ${path}: ${res.status} ${e?.code ?? ""} ${e?.message ?? ""} (request ${e?.request_id ?? "?"})`,
    );
  }
  return json as T;
}

interface AgentRow {
  id: string;
  name: string;
  version: number;
  multiagent?:
    { type?: string; agents?: { id?: string; version?: number }[]; board?: boolean } | boolean | null;
}
interface WebhookRow {
  id: string;
  url: string;
  events: string[];
  status?: string;
}

async function listAll<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await api<{ data: T[]; has_more?: boolean; next_cursor?: string }>(
      "GET",
      `${path}?limit=100${after ? `&after=${after}` : ""}`,
    );
    out.push(...page.data);
    if (!page.has_more || !page.next_cursor) return out;
    after = page.next_cursor;
  }
}

async function main(): Promise<void> {
  let problems = 0;
  const agents = await listAll<AgentRow>("/v1/agents");
  const byName = new Map(agents.map((a) => [a.name, a]));
  console.log("agents");
  for (const name of AGENTS) {
    const a = byName.get(name);
    if (!a) {
      problems++;
      console.log(`  MISSING  ${name}  (run pnpm naive:up)`);
    } else console.log(`  ok       ${name}  ${a.id} v${a.version}`);
  }

  const orch = byName.get("orchestrator");
  if (orch) {
    const full = await api<AgentRow>("GET", `/v1/agents/${orch.id}`);
    const m = typeof full.multiagent === "object" && full.multiagent ? full.multiagent : undefined;
    const members = (m?.agents ?? []).map((x) => agents.find((a) => a.id === x.id));
    const stale = (m?.agents ?? []).filter((x) => {
      const live = agents.find((a) => a.id === x.id);
      return live && x.version !== undefined && x.version !== live.version;
    });
    console.log("team");
    if (m?.type !== "coordinator") {
      problems++;
      console.log(
        "  MISSING  the orchestrator has no coordinator roster. Check the naive up report for a refused line.",
      );
    } else {
      console.log(
        `  ok       coordinator with ${members.map((x) => x?.name ?? "?").join(", ")}; board ${m.board ? "on" : "OFF"}`,
      );
      const want = new Set<string>(TEAM);
      if (members.some((x) => !x || !want.has(x.name)) || members.length !== TEAM.length) {
        problems++;
        console.log(`  DRIFT    expected members ${TEAM.join(", ")}`);
      }
      if (stale.length) {
        problems++;
        console.log(
          `  STALE    ${stale.length} member version(s) behind; re-run pnpm naive:up so the roster pins the new versions`,
        );
      }
    }
  }

  const url = `${appUrl}/api/webhooks/naive`;
  const hooks = await listAll<WebhookRow>("/v1/webhooks");
  const hook = hooks.find((h) => h.url === url);
  console.log("webhook");
  if (hook) {
    const missing = NAIVE_WEBHOOK_EVENTS.filter(
      (e) => !hook.events.includes(e) && !hook.events.includes("*"),
    );
    console.log(`  ok       ${hook.id} ${url} ${hook.status ?? ""}`);
    if (missing.length) {
      problems++;
      console.log(`  DRIFT    missing events: ${missing.join(", ")}`);
    }
  } else if (dryRun) {
    console.log(`  would create ${url} for ${NAIVE_WEBHOOK_EVENTS.join(", ")}`);
  } else {
    const created = await api<{ id: string; secret?: string }>("POST", "/v1/webhooks", {
      url,
      events: [...NAIVE_WEBHOOK_EVENTS],
    });
    console.log(`  created  ${created.id} ${url}`);
    if (created.secret) {
      mkdirSync(".naive", { recursive: true });
      writeFileSync(".naive/webhook-secret", `${created.secret}\n`, { mode: 0o600 });
      chmodSync(".naive/webhook-secret", 0o600);
      console.log(
        "  The signing secret is in .naive/webhook-secret (shown once). Set it as NAIVE_WEBHOOK_SECRET in Vercel and Render:",
      );
      console.log("    vercel env add NAIVE_WEBHOOK_SECRET production < .naive/webhook-secret");
    } else {
      console.log("  No secret in the response: read it in the Studio and set NAIVE_WEBHOOK_SECRET.");
    }
  }

  console.log(problems ? `\n${problems} problem(s)` : "\nall in sync");
  process.exit(problems ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
