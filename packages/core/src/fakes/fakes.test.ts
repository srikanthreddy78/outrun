import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { ToolRegistry, defineTool } from "../crew/registry";
import type { ToolContext } from "../crew/types";
import { createIntegrations } from "../integrations";
import { FakeNaiveClient, createFakeScan, createFakes } from ".";
import { OUTRUN_CLIENT_ID } from "../constants";

const ctx = (agent: ToolContext["agent"]): ToolContext => ({
  agent,
  requestId: "r",
  clientId: OUTRUN_CLIENT_ID,
  db: {} as never,
  now: () => new Date("2026-11-07T00:00:00Z"),
  enqueue: async () => ({ jobId: null }),
  emit: async () => {},
});

const DRAFT = { draftId: "0190f6a0-0000-7000-8000-000000000001", hash: "a".repeat(64) };

describe("fake selection", () => {
  it("selects fakes for missing keys in dev, and says which", () => {
    const { fakes } = createIntegrations(loadConfig({ NODE_ENV: "development" }));
    expect(fakes).toContain("llm.openai");
    expect(fakes).toContain("naive");
    expect(fakes).toContain("stripe");
  });

  it("uses the real LLM providers when their keys are set", () => {
    const { fakes, integrations } = createIntegrations(
      loadConfig({ NODE_ENV: "development", OPENAI_API_KEY: "x", OPENROUTER_API_KEY: "y" }),
    );
    expect(fakes).not.toContain("llm.openai");
    expect(integrations.llm.openai.name).toBe("openai");
  });

  it("fails boot in production when a key is missing", () => {
    expect(() => createIntegrations(loadConfig({ NODE_ENV: "production" }))).toThrow(
      /production cannot run on a fake/,
    );
  });

  it("uses a real factory once its key is set", () => {
    const fakeNaive = new FakeNaiveClient();
    const { fakes, integrations } = createIntegrations(
      loadConfig({ NODE_ENV: "development", NAIVE_API_KEY: "k" }),
      {
        naive: { key: "naive", make: () => fakeNaive },
      },
    );
    expect(fakes).not.toContain("naive");
    expect(integrations.naive).toBe(fakeNaive);
  });
});

describe("FakeNaiveClient", () => {
  const registry = new ToolRegistry([
    defineTool({
      name: "ping",
      handler: async (_i, c) => ({ ok: true as const, agent: c.agent, ts: c.now().toISOString() }),
    }),
    defineTool({
      name: "send_email",
      handler: async () => ({ messageId: "0190f6a0-0000-7000-8000-000000000009", status: "queued" as const }),
    }),
  ]);
  const start = (naive: FakeNaiveClient, agent: "sdr" | "closer", key: string) =>
    naive.startSession({ agentId: naive.agentIdOf(agent), message: "go", metadata: {}, idempotencyKey: key });

  it("replays scripted calls against our handlers", async () => {
    const naive = new FakeNaiveClient({ registry, ctx }).script("sdr", [{ tool: "ping", input: {} }]);
    const { sessionId } = await start(naive, "sdr", "k1");
    expect(naive.toolCalls[0]).toMatchObject({ tool: "ping", result: { ok: true, agent: "sdr" } });
    expect((await naive.getSession(sessionId)).stopReason).toBe("end_turn");
  });

  it("holds ask tools until confirmed", async () => {
    const naive = new FakeNaiveClient({ registry, ctx }).script("sdr", [
      { tool: "send_email", input: DRAFT },
      { tool: "ping", input: {} },
    ]);
    const { sessionId } = await start(naive, "sdr", "k2");
    let s = await naive.getSession(sessionId);
    expect(s.stopReason).toBe("awaiting_approval");
    expect(s.pendingActions[0]?.tool).toBe("outrun.send_email");
    expect(naive.toolCalls).toHaveLength(0);

    await naive.confirmTool(sessionId, s.pendingActions[0]!.toolCallId, "allow", "user:sri");
    s = await naive.getSession(sessionId);
    expect(s.stopReason).toBe("end_turn");
    expect(naive.toolCalls.map((c) => [c.tool, c.decision])).toEqual([
      ["send_email", "allow"],
      ["ping", undefined],
    ]);
  });

  it("records a denial and doesn't run the tool", async () => {
    const naive = new FakeNaiveClient({ registry, ctx }).script("sdr", [
      { tool: "send_email", input: DRAFT },
    ]);
    const { sessionId } = await start(naive, "sdr", "k3");
    const s = await naive.getSession(sessionId);
    await naive.confirmTool(sessionId, s.pendingActions[0]!.toolCallId, "deny", "not this one");
    expect(naive.toolCalls[0]).toMatchObject({ decision: "deny" });
    expect(naive.toolCalls[0]?.result).toBeUndefined();
  });

  it("surfaces tool errors to the session like Naive does", async () => {
    const naive = new FakeNaiveClient({ registry, ctx }).script("sdr", [
      { tool: "pipeline_status", input: {} },
    ]);
    await start(naive, "sdr", "k4");
    expect(naive.toolCalls[0]?.error?.code).toBe("forbidden");
  });

  it("is idempotent on the session key", async () => {
    const naive = new FakeNaiveClient();
    const a = await start(naive, "closer", "same");
    const b = await start(naive, "closer", "same");
    expect(a.sessionId).toBe(b.sessionId);
  });
});

describe("other fakes", () => {
  it("scan is deterministic per domain", async () => {
    const scan = createFakeScan();
    expect(await scan("acme.dev")).toEqual(await scan("acme.dev"));
    expect(scan.calls).toEqual(["acme.dev", "acme.dev"]);
  });

  it("stripe checkout is idempotent and priced from constants", async () => {
    const f = createFakes();
    const req = {
      orderId: "o1",
      product: "auditKit" as const,
      customerEmail: "a@b.dev",
      successUrl: "https://x",
      cancelUrl: "https://x",
      idempotencyKey: "o1",
    };
    const a = await f.stripe.createCheckout(req);
    const b = await f.stripe.createCheckout(req);
    expect(a).toEqual(b);
    expect(f.stripe.checkouts).toEqual([
      { orderId: "o1", product: "auditKit", amountUsd: 499, checkoutId: a.checkoutId },
    ]);
  });

  it("transactional email dedupes on its key", async () => {
    const f = createFakes();
    await f.sendTransactional({ to: "a@b.dev", subject: "s", text: "t", idempotencyKey: "r1" });
    await f.sendTransactional({ to: "a@b.dev", subject: "s", text: "t", idempotencyKey: "r1" });
    expect(f.agentmail.transactional).toHaveLength(1);
  });
});
