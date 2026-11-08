/**
 * pnpm smoke [url]: checks a running environment from outside, read-only. Defaults to
 * APP_URL, then http://localhost:3000. Starts no Naive session and sends nothing.
 *
 *   landing page renders without JS · /api/health ok (db, migrations, queue)
 *   crew MCP: unknown agent 404, no token 401, and with CREW_TOKEN_SECRET set, each agent
 *     lists its own tools and orchestrator's ping answers
 *   Naive webhook: unsigned delivery refused (401; 503 means NAIVE_WEBHOOK_SECRET is unset)
 *
 * In production it also fails on fakes in use or a missing webhook secret.
 */
import type { CREW_TOOLS } from "@outrun/core/contracts";
import { AGENTS } from "@outrun/core/contracts";
import { toolsForAgent } from "@outrun/core/contracts";
import { crewToken } from "@outrun/core/crew/tokens";

const base = (process.argv[2] ?? process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(base);
const secret = process.env.CREW_TOKEN_SECRET;
const IMPLEMENTED = new Set(["ping", "pipeline_status", "plan_day"]);

type Result = { name: string; ok: boolean; detail?: string };
const results: Result[] = [];
const check = async (name: string, fn: () => Promise<string | void>) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, ...(detail ? { detail } : {}) });
  } catch (err) {
    results.push({ name, ok: false, detail: (err as Error).message });
  }
};
const expectStatus = (res: Response, ...want: number[]) => {
  if (!want.includes(res.status)) throw new Error(`HTTP ${res.status}, want ${want.join(" or ")}`);
};
const get = (path: string, init?: RequestInit) =>
  fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(20_000) });

async function mcp(agent: string, body: unknown, token?: string): Promise<Response> {
  return get(`/api/crew/mcp/${agent}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}
async function rpcResult(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const json = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? JSON.parse(
        text
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5))
          .at(-1) ?? "{}",
      )
    : JSON.parse(text);
  if (json.error) throw new Error(`rpc error ${JSON.stringify(json.error)}`);
  return json.result ?? {};
}

async function main(): Promise<void> {
  console.log(`smoke: ${base}`);
  let health: { demo?: boolean; fakes?: string[]; checks?: Record<string, boolean> } = {};

  await check("landing page", async () => {
    const res = await get("/");
    expectStatus(res, 200);
    if (!(await res.text()).includes("Outrun")) throw new Error("page doesn't mention Outrun");
  });

  await check("health", async () => {
    const res = await get("/api/health");
    health = (await res.json()) as typeof health;
    expectStatus(res, 200);
    return `demo=${health.demo} fakes=${(health.fakes ?? []).join(",") || "none"}`;
  });

  if (!isLocal) {
    await check("no fakes in a deployed environment", async () => {
      if (health.fakes?.length) throw new Error(`fakes in use: ${health.fakes.join(", ")}`);
    });
  }

  const list = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  await check("crew MCP: unknown agent 404", async () => expectStatus(await mcp("nobody", list, "x"), 404));
  await check("crew MCP: no token 401", async () => expectStatus(await mcp("orchestrator", list), 401));

  if (secret) {
    for (const agent of AGENTS) {
      await check(`crew MCP: ${agent} sees only its tools`, async () => {
        const r = await rpcResult(await mcp(agent, list, crewToken(secret, agent)));
        const got = new Set((r.tools as { name: string }[]).map((t) => t.name));
        const allowed = new Set(toolsForAgent(agent));
        for (const t of got)
          if (!allowed.has(t as keyof typeof CREW_TOOLS)) throw new Error(`unexpected tool ${t}`);
        const missing = [...allowed].filter((t) => IMPLEMENTED.has(t) && !got.has(t));
        if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
        return [...got].sort().join(", ") || "(none yet)";
      });
    }
    await check("crew MCP: orchestrator ping", async () => {
      const r = await rpcResult(
        await mcp(
          "orchestrator",
          { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ping", arguments: {} } },
          crewToken(secret, "orchestrator"),
        ),
      );
      const text = (r.content as { text: string }[])[0]?.text ?? "";
      if (!JSON.parse(text).ok) throw new Error(text);
    });
  } else {
    results.push({ name: "crew MCP: tool lists", ok: true, detail: "skipped, CREW_TOKEN_SECRET not set" });
  }

  await check("Naive webhook refuses unsigned", async () => {
    const res = await get("/api/webhooks/naive", { method: "POST", body: "{}" });
    if (res.status === 503 && !isLocal) throw new Error("503: NAIVE_WEBHOOK_SECRET is not set");
    expectStatus(res, 401, 503);
    return res.status === 503 ? "no secret configured (local)" : undefined;
  });

  for (const r of results)
    console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `smoke: ${failed} failed` : "smoke: green");
  process.exit(failed ? 1 : 0);
}

void main();
