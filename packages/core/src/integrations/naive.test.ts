import { describe, expect, it, vi } from "vitest";
import type { AppError } from "../errors";
import { createNaiveClient, mapSession, naiveError } from "./naive";

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("Naive client", () => {
  it("starts a session with an Idempotency-Key and ids-only metadata", async () => {
    const f = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      reply(201, { id: "ses_1", agent_id: "agt_1", status: "queued", stop_reason: null }),
    );
    const c = createNaiveClient("sk_test", { fetch: f as unknown as typeof fetch });
    await expect(
      c.startSession({
        agentId: "agt_1",
        message: "Research prospect p1",
        metadata: { entityId: "p1" },
        idempotencyKey: "k1",
      }),
    ).resolves.toEqual({ sessionId: "ses_1" });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://api.vetta.sh/v1/sessions");
    const h = init!.headers as Record<string, string>;
    expect(h["idempotency-key"]).toBe("k1");
    expect(h.authorization).toBe("Bearer sk_test");
    expect(JSON.parse(String(init!.body))).toEqual({
      agent_id: "agt_1",
      message: "Research prospect p1",
      metadata: { entityId: "p1" },
    });
  });

  it("provisions over REST: paged lists, keyed POSTs, and the new agent resolvable by name", async () => {
    const f = vi.fn(async (u: string | URL | Request, i?: RequestInit) => {
      const url = String(u);
      if (url.includes("/v1/agents?") && !url.includes("after="))
        return reply(200, { data: [{ id: "agt_a", name: "acme-sdr" }], has_more: true, next_cursor: "c1" });
      if (url.includes("/v1/agents?")) return reply(200, { data: [], has_more: false });
      if (i?.method === "POST" && url.endsWith("/v1/agents")) return reply(201, { id: "agt_new" });
      if (url.includes("/v1/vaults?")) return reply(200, { data: [{ id: "vlt_1", name: "outrun-crew" }] });
      if (url.includes("/credentials?"))
        return reply(200, { data: [{ id: "cr1", kind: "static_bearer", key: "k" }] });
      if (url.endsWith("/credentials")) return reply(201, { id: "cr2" });
      if (url.endsWith("/v1/deployments")) return reply(201, { id: "dep_1" });
      return reply(404, { error: { code: "not_found" } });
    });
    const c = createNaiveClient("sk_test", { fetch: f as unknown as typeof fetch });
    expect(await c.listAgents()).toEqual([{ id: "agt_a", name: "acme-sdr" }]);
    expect(String(f.mock.calls[1]![0])).toBe("https://api.vetta.sh/v1/agents?limit=100&after=c1");
    const body = {
      name: "acme-closer",
      model: "vetta/auto",
      budget: { cap_micro_usd: 1, max_task_micro_usd: 1, period: "day" as const },
    };
    expect(await c.createAgent(body, "provision:c:acme-closer")).toEqual({ id: "agt_new" });
    const post = f.mock.calls.at(-1)!;
    expect((post[1]!.headers as Record<string, string>)["idempotency-key"]).toBe("provision:c:acme-closer");
    expect(JSON.parse(String(post[1]!.body))).toEqual(body);
    expect(await c.resolveAgentId("acme-closer")).toBe("agt_new");
    expect(await c.listVaults()).toEqual([{ id: "vlt_1", name: "outrun-crew" }]);
    expect(await c.listCredentials("vlt_1")).toEqual([
      { id: "cr1", kind: "static_bearer", key: "k", mcp_server_url: null },
    ]);
    await c.createCredential(
      "vlt_1",
      { kind: "static_bearer", key: "crew-acme-closer", value: "v", mcp_server_url: "https://x.dev/m" },
      "k2",
    );
    expect(String(f.mock.calls.at(-1)![0])).toBe("https://api.vetta.sh/v1/vaults/vlt_1/credentials");
    expect(
      await c.createDeployment(
        {
          agent_id: "agt_new",
          cron: "0 9 * * 1-5",
          timezone: "UTC",
          input_template: "go",
          budget_micro_usd: 1,
        },
        "k3",
      ),
    ).toEqual({ id: "dep_1" });
  });

  it("confirms a tool call; the key carries parked seq and decision, a reason only on deny", async () => {
    const f = vi.fn(async () => reply(202, { id: "ses_1", status: "running", pending_actions: [] }));
    const c = createNaiveClient("k", { fetch: f as unknown as typeof fetch });
    await c.confirmTool("ses_1", "call_1", "allow", "ignored", 7);
    await c.confirmTool("ses_1", "call_1", "deny", "off tone", 9);
    const [[url, allow], [, deny]] = f.mock.calls as unknown as [
      [string, RequestInit],
      [string, RequestInit],
    ];
    expect(url).toBe("https://api.vetta.sh/v1/sessions/ses_1/tool_confirmations");
    expect(JSON.parse(String(allow!.body))).toEqual({ tool_call_id: "call_1", decision: "allow" });
    expect(JSON.parse(String(deny!.body))).toEqual({
      tool_call_id: "call_1",
      decision: "deny",
      reason: "off tone",
    });
    expect((allow!.headers as Record<string, string>)["idempotency-key"]).toBe(
      "confirm:ses_1:call_1:7:allow",
    );
  });

  it("sends with queue: true so a running turn doesn't 409", async () => {
    const f = vi.fn(async () => reply(200, { session_id: "ses_1", status: "running" }));
    const c = createNaiveClient("k", { fetch: f as unknown as typeof fetch });
    await c.send("ses_1", "hello", "k1");
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ message: "hello", queue: true });
  });

  it("pages session events with include_accepted, oldest first", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        reply(200, {
          data: [{ seq: 4, type: "tool.confirm.resolved", data: { decision: "allow" }, created_at: "x" }],
          has_more: true,
          next_cursor: "c1",
        }),
      )
      .mockResolvedValueOnce(
        reply(200, { data: [{ seq: 3, type: "session.idle", created_at: "x" }], has_more: false }),
      );
    const c = createNaiveClient("k", { fetch: f as unknown as typeof fetch });
    const evs = await c.getEvents("ses_1", { afterSeq: 2, includeAccepted: true });
    expect(evs.map((e) => e.seq)).toEqual([3, 4]);
    expect(String(f.mock.calls[0]![0])).toContain("after_seq=2&limit=100&include_accepted=true");
    expect(String(f.mock.calls[1]![0])).toContain("after=c1");
  });

  it("refuses a create that returns no session id", async () => {
    const c = createNaiveClient("k", { fetch: (async () => reply(201, {})) as unknown as typeof fetch });
    await expect(
      c.startSession({ agentId: "a", message: "m", metadata: {}, idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "upstream_error", retryable: true });
  });

  it("resolves agent ids by name across pages", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        reply(200, { data: [{ id: "agt_o", name: "orchestrator" }], has_more: true, next_cursor: "c1" }),
      )
      .mockResolvedValueOnce(reply(200, { data: [{ id: "agt_s", name: "sdr" }], has_more: false }));
    const c = createNaiveClient("k", { fetch: f as unknown as typeof fetch });
    expect(await c.resolveAgentId("sdr")).toBe("agt_s");
    expect(await c.resolveAgentId("orchestrator")).toBe("agt_o");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("keeps each client's crew apart by agent name and ignores agents that aren't ours", async () => {
    const f = vi.fn().mockImplementation(async () =>
      reply(200, {
        data: [
          { id: "agt_o_sdr", name: "sdr" },
          { id: "agt_acme_sdr", name: "acme-sdr" },
          { id: "agt_x", name: "someone-elses-bot" },
        ],
        has_more: false,
      }),
    );
    const c = createNaiveClient("k", { fetch: f as unknown as typeof fetch });
    expect(await c.resolveAgentId("sdr")).toBe("agt_o_sdr");
    expect(await c.resolveAgentId("acme-sdr")).toBe("agt_acme_sdr");
    await expect(c.resolveAgentId("beta-sdr")).rejects.toMatchObject({ code: "not_configured" });
    await expect(c.resolveAgentId("someone-elses-bot")).rejects.toMatchObject({ code: "not_configured" });
  });

  it("branches on error.code, never the message", async () => {
    const mk = (status: number, code: string) =>
      createNaiveClient("k", {
        fetch: (async () =>
          reply(status, {
            error: { type: "x", code, message: "m", request_id: "req_1" },
          })) as unknown as typeof fetch,
      });
    const codeOf = async (status: number, code: string) =>
      (
        (await mk(status, code)
          .getSession("s")
          .catch((e: unknown) => e)) as AppError
      ).code;
    expect(await codeOf(402, "insufficient_credits")).toBe("budget_exhausted");
    expect(await codeOf(429, "rate_limited")).toBe("rate_limited");
    expect(await codeOf(503, "unavailable")).toBe("upstream_error");
    expect(await codeOf(404, "not_found")).toBe("not_found");
    expect(await codeOf(401, "unauthorized")).toBe("not_configured");
    expect(await codeOf(403, "forbidden")).toBe("forbidden");
    expect(await codeOf(429, "budget_exceeded")).toBe("budget_exhausted");
    expect(naiveError(409, "version_conflict", "m", null)).toMatchObject({
      code: "conflict",
      retryable: true,
    });
    expect(naiveError(408, "timeout", "m", null).retryable).toBe(true);
    expect(naiveError(429, "rate_limited", "m", "12").retryAfterSeconds).toBe(12);
  });

  it("maps a held session's pending actions", () => {
    const s = mapSession({
      id: "ses_1",
      agent_id: "agt_1",
      status: "idle",
      stop_reason: "awaiting_approval",
      pending_actions: [
        { kind: "tool", tool_call_id: "call_1", name: "outrun.send_email", args: { draftId: "d1" } },
      ],
      consumed_micro_usd: 41870,
    });
    expect(s.pendingActions).toEqual([
      {
        kind: "tool",
        toolCallId: "call_1",
        tool: "outrun.send_email",
        input: { draftId: "d1" },
        parkedSeq: null,
      },
    ]);
    expect(s.consumedUsd).toBeCloseTo(0.04187);
    expect(s.stopReason).toBe("awaiting_approval");
  });
});
