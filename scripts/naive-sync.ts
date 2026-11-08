/**
 * pnpm naive:sync [--dry-run]: run after every `naive up`. naive.config.ts already declares
 * the agents' MCP servers, the vault tokens and the schedule; this script sets what the config
 * can't and checks what it should have done:
 *   1. reads back our six agents and their versions,
 *   2. registers the Naive webhook at <APP_URL>/api/webhooks/naive if it isn't there, sends it a
 *      test event, and re-enables it or fixes its events if it drifted.
 * No team: Naive lists multiagent teams as coming soon, so the orchestrator uses outrun.plan_day.
 * The webhook secret, shown once, is written to .naive/webhook-secret (0600, git-ignored).
 */
import { crew, loadClientCrews } from "../naive/crew";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { NAIVE_WEBHOOK_EVENTS } from "../packages/core/contracts";

const BASE = process.env.NAIVE_API_BASE ?? "https://api.vetta.sh";
const API_VERSION = "2026-09-30";
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
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "vetta-version": API_VERSION,
      ...(method === "POST" || method === "PATCH" ? { "idempotency-key": randomUUID() } : {}),
    },
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
}
interface WebhookRow {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
}

async function listAll<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await api<{ data: T[]; has_more?: boolean; next_cursor?: string }>(
      "GET",
      `${path}?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`,
    );
    out.push(...page.data);
    if (!page.has_more || !page.next_cursor) return out;
    after = page.next_cursor;
  }
}

const sameEvents = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().every((e, i) => e === [...b].sort()[i]);

async function main(): Promise<void> {
  let problems = 0;
  const agents = await listAll<AgentRow>("/v1/agents");
  const byName = new Map(agents.map((a) => [a.name, a]));
  console.log("agents");
  // Every member of the agency: the CEO, Outrun's crew, and each client's (pnpm clients:export).
  for (const { name } of crew(appUrl ?? "", loadClientCrews())) {
    const a = byName.get(name);
    if (!a) {
      problems++;
      console.log(`  MISSING  ${name}  (run pnpm naive:up)`);
    } else console.log(`  ok       ${name}  ${a.id} v${a.version}`);
  }

  const url = `${appUrl}/api/webhooks/naive`;
  const events = [...NAIVE_WEBHOOK_EVENTS];
  const hooks = await listAll<WebhookRow>("/v1/webhooks");
  const hook = hooks.find((h) => h.url === url);
  console.log("webhook");
  if (hook) {
    const drift = !hook.enabled || !sameEvents(hook.events, events);
    if (!drift) console.log(`  ok       ${hook.id} ${url} enabled`);
    else if (dryRun) {
      console.log(
        `  would update ${hook.id}: enabled ${hook.enabled} → true, events [${hook.events.join(", ")}] → [${events.join(", ")}]`,
      );
    } else {
      await api("PATCH", `/v1/webhooks/${hook.id}`, { enabled: true, events });
      console.log(`  updated  ${hook.id} ${url}: enabled, events ${events.join(", ")}`);
    }
  } else if (dryRun) {
    console.log(`  would create ${url} for ${events.join(", ")} and send it a test event`);
  } else {
    const created = await api<{ id: string; secret?: string }>("POST", "/v1/webhooks", { url, events });
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
    try {
      await api("POST", `/v1/webhooks/${created.id}/test`);
      console.log("  sent a test event; check the ledger for it once NAIVE_WEBHOOK_SECRET is set");
    } catch (err) {
      problems++;
      console.log(`  TEST FAILED  ${(err as Error).message}`);
    }
  }

  console.log(problems ? `\n${problems} problem(s)` : "\nall in sync");
  process.exit(problems ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
