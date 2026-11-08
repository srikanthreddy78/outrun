import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@outrun/core";
import { allTools } from "@outrun/core/crew/tools";
import { ToolRegistry } from "@outrun/core/crew";
import { crewToken } from "@outrun/core/crew/tokens";
import { eq, events } from "@outrun/core/db";
import { clients, companies, prospects } from "@outrun/core/db/schema";
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
      "get_client_profile",
      "ping",
      "pipeline_status",
      "plan_day",
    ]);
    const s = await rpc(await call("sdr", list, crewToken(SECRET, "sdr")));
    expect((s.result?.tools as { name: string }[]).map((x) => x.name).sort()).toEqual([
      "get_client_profile",
      "ping",
    ]);
    const ceo = await rpc(await call("ceo", list, crewToken(SECRET, "ceo")));
    expect((ceo.result?.tools as { name: string }[]).map((x) => x.name)).toContain("agency_status");
    expect((await call("acme/ceo", list, crewToken(SECRET, "ceo", "acme"))).status).toBe(404);
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
      // Warmup (SH-6): 10 sends on the first sending day.
      capsLeft: { send: 10, discovery: 200 },
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

  describe("another client's crew", () => {
    let outrunProspectId: string;
    beforeAll(async () => {
      await t.db.insert(clients).values([
        { slug: "acme", name: "Acme", domain: "acme.example", status: "active" },
        { slug: "beta", name: "Beta", domain: "beta.example", status: "active" },
        { slug: "sleepy", name: "Sleepy", domain: "sleepy.example", status: "paused" },
      ]);
      const [co] = await t.db
        .insert(companies)
        .values({ domain: "target.example", source: "fixture", kind: "prospect" })
        .returning();
      const [p] = await t.db.insert(prospects).values({ companyId: co!.id }).returning();
      outrunProspectId = p!.id;
    });
    const status = async (path: string, token: string) => {
      const r = await rpc(
        await call(
          path,
          { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "pipeline_status", arguments: {} } },
          token,
        ),
      );
      return JSON.parse((r.result?.content as { text: string }[])[0]!.text) as {
        stages: Record<string, number>;
        candidatesWaiting: number;
      };
    };

    it("answers at /<slug>/<role> with that client's own token only", async () => {
      const ok = await rpc(await call("acme/orchestrator", list, crewToken(SECRET, "orchestrator", "acme")));
      expect((ok.result?.tools as { name: string }[]).map((x) => x.name)).toContain("pipeline_status");
      expect((await call("acme/orchestrator", list, crewToken(SECRET, "orchestrator"))).status).toBe(401);
      expect((await call("acme/orchestrator", list, crewToken(SECRET, "orchestrator", "beta"))).status).toBe(
        401,
      );
      expect((await call("orchestrator", list, crewToken(SECRET, "orchestrator", "acme"))).status).toBe(401);
    });

    it("404s an unknown client, Outrun under a slug, and deeper paths; 403s a paused client", async () => {
      expect((await call("ghost/sdr", list, crewToken(SECRET, "sdr", "ghost"))).status).toBe(404);
      expect((await call("outrun/sdr", list, crewToken(SECRET, "sdr"))).status).toBe(404);
      expect((await call("acme/sdr/x", list, crewToken(SECRET, "sdr", "acme"))).status).toBe(404);
      expect((await call("Acme/sdr", list, crewToken(SECRET, "sdr", "Acme"))).status).toBe(404);
      expect((await call("sleepy/sdr", list, crewToken(SECRET, "sdr", "sleepy"))).status).toBe(403);
    });

    it("sees only its own client's pipeline, and records calls under its agent name", async () => {
      expect(outrunProspectId).toBeTruthy();
      const mine = await status("orchestrator", crewToken(SECRET, "orchestrator"));
      expect(mine.stages.filed).toBeGreaterThan(0);
      const theirs = await status("acme/orchestrator", crewToken(SECRET, "orchestrator", "acme"));
      expect(theirs.stages.filed).toBe(0);
      expect(theirs.candidatesWaiting).toBe(0);
      const rows = await t.db.select().from(events).where(eq(events.actor, "naive:acme-orchestrator"));
      expect(rows.length).toBeGreaterThan(0);
    });
  });
});
