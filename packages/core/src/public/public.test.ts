import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PUBLIC_TOOLS } from "../../contracts";
import { events, reports } from "../db/schema";
import { createEmitter } from "../events";
import { FakeStripe } from "../fakes";
import { transition } from "../orders";
import { quickScan } from "../scan/scan";
import { createTempDatabase, type TempDb } from "../testing/db";
import { agentCard, handleA2a, RPC } from "./a2a";
import { readFileSync } from "node:fs";
import { llmsTxt, mcpServerCard, openApi, serverJson } from "./discovery";
import { callPublicTool, type PublicDeps } from "./service";

const APP = "https://outrun.example";
const page =
  '<html><body><h1>Automate your support with agents</h1><p>Our platform answers questions and launches reliable workflows for teams every single day of the week.</p><a href="/signup">Get started</a></body></html>';

describe("public tools for other agents", () => {
  let t: TempDb;
  let deps: PublicDeps;
  beforeAll(async () => {
    t = await createTempDatabase();
    deps = {
      db: t.db,
      emit: createEmitter(t.db),
      stripe: new FakeStripe(),
      appUrl: APP,
      // The real scanner on a fixture site, no network.
      scan: (domain) =>
        quickScan(domain, async (url) => ({
          url,
          status: url.endsWith("/") ? 200 : 404,
          headers: {},
          body: page,
        })),
    };
  });
  afterAll(async () => {
    await t?.drop();
  });
  const meta = (ip = "203.0.113.7") => ({ protocol: "mcp" as const, callerIp: ip, requestId: "r" });

  it("scores a domain in the contract's shape", async () => {
    const out = await callPublicTool(deps, "get_readiness_score", { domain: "acme.dev" }, meta());
    expect(PUBLIC_TOOLS.get_readiness_score.output.safeParse(out).success).toBe(true);
    expect(out.reportUrl.startsWith(APP)).toBe(true);
    expect(out.checks.every((c) => /^[a-z][a-z0-9_]+$/.test(c.id))).toBe(true);
  });

  it("quotes from PRODUCTS and rejects a bad package", async () => {
    expect(
      await callPublicTool(deps, "get_quote", { domain: "acme.dev", package: "growth" }, meta()),
    ).toMatchObject({
      priceUsd: 1500,
      interval: "month",
    });
    await expect(
      callPublicTool(deps, "get_quote", { domain: "acme.dev", package: "free" }, meta()),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("buys once per key, keeps keys per caller, and reports status", async () => {
    const input = {
      domain: "acme.dev",
      package: "auditKit",
      contactEmail: "Founder@Acme.dev",
      idempotencyKey: "buy-acme-0001",
    };
    const a = await callPublicTool(deps, "buy_audit", input, meta());
    const b = await callPublicTool(deps, "buy_audit", input, meta());
    expect(b).toEqual(a);
    // The same key from another caller is another order, never the first caller's.
    const other = await callPublicTool(deps, "buy_audit", input, meta("198.51.100.9"));
    expect(other.orderId).not.toBe(a.orderId);
    expect(await callPublicTool(deps, "get_order_status", { orderId: a.orderId }, meta())).toMatchObject({
      state: "pending",
      reportUrl: null,
    });
    // After payment a repeat call returns the status page, not a second checkout.
    await transition(deps, a.orderId, "paid");
    expect((await callPublicTool(deps, "buy_audit", input, meta())).checkoutUrl).toBe(
      `${APP}/orders/${a.orderId}`,
    );
    const calls = await t.db.select().from(events).where(eq(events.type, "public.tool_called"));
    expect(JSON.stringify(calls.map((c) => c.payload))).not.toMatch(/@|203\.0\.113/);
  });

  it("limits new orders per caller per hour, while a repeated key stays free", async () => {
    const ip = "192.0.2.50";
    const buy = (i: number) =>
      callPublicTool(
        deps,
        "buy_audit",
        {
          domain: `d${i}.dev`,
          package: "auditKit",
          contactEmail: "a@b.dev",
          idempotencyKey: `limit-key-${i}`,
        },
        meta(ip),
      );
    for (let i = 0; i < 10; i++) await buy(i);
    await expect(buy(10)).rejects.toMatchObject({ code: "rate_limited" });
    await expect(buy(3)).resolves.toBeTruthy();
  });

  it("pays with a Shared Payment Token when agent payments are on, and falls back to Checkout when off", async () => {
    const stripe = new FakeStripe();
    const input = (k: string, pkg = "auditKit") => ({
      domain: "spt.dev",
      package: pkg,
      contactEmail: "ops@spt.dev",
      idempotencyKey: k,
      sharedPaymentToken: "spt_test_0001",
    });
    const on = { ...deps, stripe, agentPayments: true };
    const paid = await callPublicTool(on, "buy_audit", input("spt-on-0001"), meta("192.0.2.80"));
    expect(paid.checkoutUrl).toBe(`${APP}/orders/${paid.orderId}`);
    expect(stripe.tokenPayments).toHaveLength(1);
    expect(stripe.checkouts).toHaveLength(0);
    // Repeating the call doesn't charge twice.
    await callPublicTool(on, "buy_audit", input("spt-on-0001"), meta("192.0.2.80"));
    expect(stripe.tokenPayments).toHaveLength(1);
    // Growth, or agent payments off: Checkout as before.
    const growth = await callPublicTool(
      on,
      "buy_audit",
      input("spt-growth-01", "growth"),
      meta("192.0.2.80"),
    );
    expect(growth.checkoutUrl).toMatch(/checkout\.stripe\.test/);
    const off = await callPublicTool(
      { ...deps, stripe },
      "buy_audit",
      input("spt-off-0001"),
      meta("192.0.2.80"),
    );
    expect(off.checkoutUrl).toMatch(/checkout\.stripe\.test/);
    expect(stripe.tokenPayments).toHaveLength(1);
    await expect(
      callPublicTool(
        on,
        "buy_audit",
        { ...input("spt-bad-0001"), sharedPaymentToken: "pm_card_visa" },
        meta(),
      ),
    ).rejects.toMatchObject({ code: "bad_request" });
    const logged = await t.db.select().from(events);
    expect(JSON.stringify(logged.map((e) => e.payload))).not.toContain("spt_test_0001");
  });

  it("answers not_found for an unknown order", async () => {
    await expect(
      callPublicTool(deps, "get_order_status", { orderId: "0192f4a8-0000-7000-8000-000000000000" }, meta()),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  describe("A2A", () => {
    const rpc = async (method: string, params: unknown, id: number | string = 1) =>
      handleA2a(deps, JSON.stringify({ jsonrpc: "2.0", id, method, params }), { callerIp: "203.0.113.20" });
    const msg = (parts: unknown[]) => ({
      message: { role: "user", kind: "message", messageId: crypto.randomUUID(), parts },
    });
    type Task = {
      id: string;
      kind: string;
      status: { state: string };
      artifacts?: { parts: { kind: string; data: Record<string, unknown> }[] }[];
    };

    it("publishes a card with the four skills at our endpoint", () => {
      const card = agentCard(APP);
      expect(card).toMatchObject({
        protocolVersion: "0.3.0",
        url: `${APP}/api/a2a`,
        preferredTransport: "JSONRPC",
      });
      expect(card.skills.map((s) => s.id).sort()).toEqual(Object.keys(PUBLIC_TOOLS).sort());
      for (const s of card.skills) expect(s.tags.length).toBeGreaterThan(0);
    });

    it("runs a skill from a data part and returns a completed task that tasks/get reads back", async () => {
      const r = await rpc(
        "message/send",
        msg([
          { kind: "data", data: { skill: "get_quote", input: { domain: "acme.dev", package: "auditKit" } } },
        ]),
      );
      const task = r.result as Task;
      expect(task).toMatchObject({ kind: "task", status: { state: "completed" } });
      expect(task.artifacts![0]!.parts[0]).toMatchObject({ kind: "data", data: { priceUsd: 499 } });
      expect((await rpc("tasks/get", { id: task.id })).result).toEqual(task);
    });

    it("asks for structured input when a message has only text", async () => {
      const r = await rpc("message/send", msg([{ kind: "text", text: "how much is an audit?" }]));
      const task = r.result as Task;
      expect(task.status.state).toBe("input-required");
      expect(Object.keys(task.artifacts![0]!.parts[0]!.data.skills as object)).toContain("buy_audit");
    });

    it("turns a bad input into input-required with the error", async () => {
      const r = await rpc(
        "message/send",
        msg([{ kind: "data", data: { skill: "buy_audit", input: { domain: "acme.dev" } } }]),
      );
      expect((r.result as Task).status.state).toBe("input-required");
    });

    it("never stores the buyer's email in the task ledger", async () => {
      await rpc(
        "message/send",
        msg([
          {
            kind: "data",
            data: {
              skill: "buy_audit",
              input: {
                domain: "shop.dev",
                package: "auditKit",
                contactEmail: "owner@shop.dev",
                idempotencyKey: "a2a-shop-001",
              },
            },
          },
        ]),
      );
      const rows = await t.db.select().from(events).where(eq(events.type, "agent_to_agent.task"));
      expect(JSON.stringify(rows.map((r) => r.payload))).not.toContain("owner@shop.dev");
    });

    it("uses the JSON-RPC and A2A error codes", async () => {
      expect((await handleA2a(deps, "{nope", { callerIp: "x" })).error?.code).toBe(RPC.parse);
      expect((await rpc("message/stream", {})).error?.code).toBe(RPC.unsupported);
      expect((await rpc("tasks/get", { id: "missing" })).error?.code).toBe(RPC.taskNotFound);
      expect((await rpc("nope/nope", {})).error?.code).toBe(RPC.methodNotFound);
      expect((await rpc("message/send", { message: { role: "user" } })).error?.code).toBe(RPC.invalidParams);
    });

    it("takes a buyer agent from quote to a delivered order with no person involved", async () => {
      const send = async (skill: string, input: unknown) => {
        const r = await rpc("message/send", msg([{ kind: "data", data: { skill, input } }]));
        const task = r.result as Task;
        expect(task.status.state).toBe("completed");
        return task.artifacts![0]!.parts[0]!.data;
      };
      await send("get_readiness_score", { domain: "buyer.dev" });
      await send("get_quote", { domain: "buyer.dev", package: "auditKit" });
      const { orderId, checkoutUrl } = (await send("buy_audit", {
        domain: "buyer.dev",
        package: "auditKit",
        contactEmail: "ops@buyer.dev",
        idempotencyKey: "buyer-agent-0001",
      })) as { orderId: string; checkoutUrl: string };
      expect(checkoutUrl).toMatch(/^https:\/\//);
      // Payment (the Stripe webhook, SR-8), the audit (MT-6) and delivery (MT-8), on their stand-ins:
      await transition(deps, orderId, "paid");
      await transition(deps, orderId, "auditing");
      await t.db.insert(reports).values({ orderId, accessToken: "tok_buyer_dev_0001", audit: {} });
      await transition(deps, orderId, "delivered");
      expect(await send("get_order_status", { orderId })).toMatchObject({
        state: "delivered",
        reportUrl: `${APP}/report/tok_buyer_dev_0001`,
      });
    });
  });

  describe("discovery files", () => {
    it("llms.txt names the endpoints and the live prices", () => {
      const txt = llmsTxt(APP);
      expect(txt).toContain(`${APP}/api/mcp`);
      expect(txt).toContain(`${APP}/.well-known/agent-card.json`);
      expect(txt).toContain("$499");
      expect(txt).toContain("$1,500/month");
      for (const tool of Object.keys(PUBLIC_TOOLS)) expect(txt).toContain(tool);
    });

    it("server.json meets the MCP Registry schema we vendored", () => {
      const schema = JSON.parse(
        readFileSync(new URL("./fixtures/mcp-server.schema.json", import.meta.url), "utf8"),
      ) as {
        definitions: Record<
          string,
          {
            required?: string[];
            properties: Record<string, { pattern?: string; maxLength?: number; enum?: string[] }>;
          }
        >;
      };
      const def = schema.definitions.ServerDetail!;
      const doc = serverJson(APP) as Record<string, unknown>;
      for (const k of def.required ?? []) expect(doc[k]).toBeTruthy();
      for (const k of Object.keys(doc)) expect(def.properties[k], k).toBeDefined();
      for (const [k, rule] of Object.entries(def.properties)) {
        const v = doc[k];
        if (typeof v !== "string") continue;
        if (rule.pattern) expect(v).toMatch(new RegExp(rule.pattern));
        if (rule.maxLength) expect(v.length, k).toBeLessThanOrEqual(rule.maxLength);
      }
      const remote = schema.definitions.StreamableHttpTransport!.properties;
      expect(remote.type!.enum).toContain((doc.remotes as { type: string }[])[0]!.type);
      expect(doc.remotes).toEqual([{ type: "streamable-http", url: `${APP}/api/mcp` }]);
    });

    it("openapi.json and the server card are generated from the contracts", () => {
      const doc = openApi(APP);
      expect(doc.openapi).toBe("3.1.0");
      expect(Object.keys(doc.components.schemas)).toEqual(
        expect.arrayContaining(["ScoreResponse", "buy_audit_input"]),
      );
      const card = mcpServerCard(APP);
      expect(card.transport.endpoint).toBe(`${APP}/api/mcp`);
      expect(card.tools.map((x) => x.name).sort()).toEqual(Object.keys(PUBLIC_TOOLS).sort());
    });
  });
});
