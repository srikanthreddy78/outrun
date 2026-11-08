import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@outrun/core";
import { allTools } from "@outrun/core/crew/tools";
import { ToolRegistry } from "@outrun/core/crew";
import { crewToken } from "@outrun/core/crew/tokens";
import { eq, events } from "@outrun/core/db";
import { createEmitter } from "@outrun/core/events";
import { createTempDatabase, type TempDb } from "@outrun/core/testing/db";
import { crewMcpResponse } from "./crewMcp";

const SECRET = "crew-secret-test";

async function rpc(res: Response): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    return JSON.parse(data.at(-1)!);
  }
  return JSON.parse(text);
}

describe("crew MCP server", () => {
  let t: TempDb;
  let rt: Parameters<typeof crewMcpResponse>[0];
  beforeAll(async () => {
    t = await createTempDatabase();
    const config = loadConfig({ CREW_TOKEN_SECRET: SECRET, DATABASE_URL: t.url });
    rt = {
      config,
      db: { db: t.db, pool: t.pool, close: async () => {} },
      emit: createEmitter(t.db),
      queue: { enqueue: async () => ({ jobId: null }) } as never,
      registry: new ToolRegistry(allTools({ settings: config.settings })),
    };
  });
  afterAll(async () => {
    await t?.drop();
  });

  const call = (agent: string, body: unknown, token?: string) =>
    crewMcpResponse(
      rt,
      agent,
      new Request(`https://outrun.example/api/crew/mcp/${agent}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

  it("404s an unknown agent", async () => {
    expect((await call("intruder", list, "x")).status).toBe(404);
  });

  it("401s without a token, with a wrong token, and with another agent's token", async () => {
    expect((await call("orchestrator", list)).status).toBe(401);
    expect((await call("orchestrator", list, "nope")).status).toBe(401);
    const res = await call("orchestrator", list, crewToken(SECRET, "sdr"));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "unauthorized", retryable: false } });
  });

  it("initializes as the outrun server", async () => {
    const r = await rpc(
      await call(
        "orchestrator",
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          },
        },
        crewToken(SECRET, "orchestrator"),
      ),
    );
    expect((r.result?.serverInfo as { name: string }).name).toBe("outrun");
  });

  it("lists only the agent's own tools, unprefixed", async () => {
    const o = await rpc(await call("orchestrator", list, crewToken(SECRET, "orchestrator")));
    expect((o.result?.tools as { name: string }[]).map((x) => x.name).sort()).toEqual([
      "ping",
      "pipeline_status",
    ]);
    const s = await rpc(await call("sdr", list, crewToken(SECRET, "sdr")));
    expect((s.result?.tools as { name: string }[]).map((x) => x.name)).toEqual(["ping"]);
  });

  it("runs a tool and records the call with actor naive:<agent>", async () => {
    const r = await rpc(
      await call(
        "orchestrator",
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pipeline_status", arguments: {} } },
        crewToken(SECRET, "orchestrator"),
      ),
    );
    const content = (r.result?.content as { text: string }[])[0]!;
    expect(JSON.parse(content.text)).toMatchObject({
      capsLeft: { send: 30, discovery: 200 },
      approvalsWaiting: 0,
    });
    const evs = await t.db.select().from(events).where(eq(events.type, "tool.called"));
    expect(evs.at(-1)).toMatchObject({ actor: "naive:orchestrator", entityId: "pipeline_status" });
  });

  it("a failed ledger write after a successful tool still reports success", async () => {
    const broken = {
      ...rt,
      emit: async () => {
        throw new Error("pool timeout");
      },
    };
    const res = await crewMcpResponse(
      broken,
      "orchestrator",
      new Request("https://outrun.example/api/crew/mcp/orchestrator", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
          authorization: `Bearer ${crewToken(SECRET, "orchestrator")}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "ping", arguments: {} },
        }),
      }),
    );
    const r = await rpc(res);
    expect(r.result?.isError).toBeFalsy();
    expect(JSON.parse((r.result?.content as { text: string }[])[0]!.text)).toMatchObject({ ok: true });
  });

  it("an agent cannot call a tool it wasn't given", async () => {
    const r = await rpc(
      await call(
        "sdr",
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "pipeline_status", arguments: {} } },
        crewToken(SECRET, "sdr"),
      ),
    );
    const text = JSON.stringify(r);
    expect(text).not.toContain("capsLeft");
  });
});
