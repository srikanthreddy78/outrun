/**
 * Naive REST client (https://api.vetta.sh). Thin on purpose: budgets, policies and approvals are
 * Naive's, never ours. Mutating calls carry an Idempotency-Key. Errors branch on error.code.
 */
import { AGENTS, type AgentName, STOP_REASONS, type StopReason } from "../../contracts";
import { AppError } from "../errors";
import type { NaiveClient, NaivePendingAction, NaiveSession } from "./types";

export const NAIVE_API_BASE = "https://api.vetta.sh";
export const NAIVE_API_VERSION = "2026-09-30";

interface RawSession {
  id: string;
  agent_id: string;
  status: string;
  stop_reason: string | null;
  pending_actions?: { kind?: string; tool_call_id: string; name: string; args?: unknown }[];
  metadata?: Record<string, unknown>;
  consumed_micro_usd?: number;
}

const toStop = (s: string | null): StopReason | null =>
  s && (STOP_REASONS as readonly string[]).includes(s) ? (s as StopReason) : s ? "error" : null;

export function mapSession(r: RawSession): NaiveSession {
  return {
    id: r.id,
    agentId: r.agent_id,
    status: r.status,
    stopReason: toStop(r.stop_reason),
    pendingActions: (r.pending_actions ?? []).map((a): NaivePendingAction => ({
      kind: a.kind === "question" ? "question" : "tool",
      toolCallId: a.tool_call_id,
      tool: a.name,
      input: a.args ?? {},
    })),
    metadata: r.metadata ?? {},
    consumedUsd: (r.consumed_micro_usd ?? 0) / 1_000_000,
  };
}

export function createNaiveClient(
  apiKey: string,
  opts: { baseUrl?: string; fetch?: typeof fetch } = {},
): NaiveClient {
  const base = (opts.baseUrl ?? NAIVE_API_BASE).replace(/\/$/, "");
  const f = opts.fetch ?? fetch;
  const agentIds = new Map<AgentName, string>();

  async function call<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    let res: Response;
    try {
      res = await f(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "vetta-version": NAIVE_API_VERSION,
          ...(body ? { "content-type": "application/json" } : {}),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new AppError("upstream_error", `naive: ${method} ${path} failed`, {
        retryable: true,
        cause: err,
      });
    }
    const json = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string; request_id?: string };
    };
    if (res.ok) return json as T;
    const code = json.error?.code ?? "unknown";
    const msg = `naive: ${method} ${path} → ${res.status} ${code} (request ${json.error?.request_id ?? "?"})`;
    if (res.status === 429) throw new AppError("rate_limited", msg, { retryable: true });
    if (res.status >= 500) throw new AppError("upstream_error", msg, { retryable: true });
    if (code === "insufficient_credits" || code === "subscription_required" || code === "budget_exceeded") {
      throw new AppError("budget_exhausted", msg, { retryable: false });
    }
    if (res.status === 409 && code !== "version_conflict")
      throw new AppError("conflict", msg, { retryable: false });
    if (res.status === 404) throw new AppError("not_found", msg);
    if (res.status === 401 || res.status === 403) throw new AppError("not_configured", msg);
    throw new AppError("upstream_error", msg, { retryable: false });
  }

  return {
    async resolveAgentId(agent) {
      const hit = agentIds.get(agent);
      if (hit) return hit;
      let after: string | undefined;
      for (;;) {
        const page = await call<{
          data: { id: string; name: string }[];
          has_more?: boolean;
          next_cursor?: string;
        }>("GET", `/v1/agents?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`);
        for (const a of page.data)
          if ((AGENTS as readonly string[]).includes(a.name)) agentIds.set(a.name as AgentName, a.id);
        if (agentIds.has(agent) || !page.has_more || !page.next_cursor) break;
        after = page.next_cursor;
      }
      const id = agentIds.get(agent);
      if (!id) throw new AppError("not_configured", `naive: no agent named ${agent}; run pnpm naive:up`);
      return id;
    },

    async startSession(req) {
      const r = await call<RawSession>(
        "POST",
        "/v1/sessions",
        { agent_id: req.agentId, message: req.message, metadata: req.metadata },
        req.idempotencyKey,
      );
      return { sessionId: r.id };
    },

    async send(sessionId, message, idempotencyKey) {
      await call(
        "POST",
        `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
        { message, idempotency_key: idempotencyKey },
        idempotencyKey,
      );
    },

    async confirmTool(sessionId, toolCallId, decision, reason) {
      await call(
        "POST",
        `/v1/sessions/${encodeURIComponent(sessionId)}/tool_confirmations`,
        { tool_call_id: toolCallId, decision, reason: reason.slice(0, 500) },
        `confirm:${sessionId}:${toolCallId}`,
      );
    },

    async getSession(sessionId) {
      return mapSession(await call<RawSession>("GET", `/v1/sessions/${encodeURIComponent(sessionId)}`));
    },

    async agentSpendUsd(agentId) {
      const r = await call<{ spent_micro_usd?: number }>(
        "GET",
        `/v1/agents/${encodeURIComponent(agentId)}/spend`,
      );
      return (r.spent_micro_usd ?? 0) / 1_000_000;
    },
  };
}
