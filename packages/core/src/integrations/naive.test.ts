import { describe, expect, it, vi } from "vitest";
import type { AppError } from "../errors";
import { createNaiveClient, mapSession } from "./naive";

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

  it("confirms a tool call with the decision and a reason", async () => {
    const f = vi.fn(async () => reply(200, { id: "ses_1", status: "running", pending_actions: [] }));
    const c = createNaiveClient("k", { fetch: f as unknown as typeof fetch });
    await c.confirmTool("ses_1", "call_1", "allow", "user:sri");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.vetta.sh/v1/sessions/ses_1/tool_confirmations");
    expect(JSON.parse(String(init.body))).toEqual({
      tool_call_id: "call_1",
      decision: "allow",
      reason: "user:sri",
    });
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
      { kind: "tool", toolCallId: "call_1", tool: "outrun.send_email", input: { draftId: "d1" } },
    ]);
    expect(s.consumedUsd).toBeCloseTo(0.04187);
    expect(s.stopReason).toBe("awaiting_approval");
  });
});
