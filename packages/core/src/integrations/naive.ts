/**
 * Naive REST client (https://api.vetta.sh). Thin on purpose: budgets, policies and approvals are
 * Naive's, never ours. Mutating calls carry an Idempotency-Key. Errors branch on error.code first,
 * then the HTTP status.
 */
import { parseNaiveAgentName } from "../crew/identity";
import { STOP_REASONS, type StopReason } from "../../contracts";
import { AppError } from "../errors";
import type { NaiveClient, NaiveEvent, NaivePendingAction, NaiveSession } from "./types";

export const NAIVE_API_BASE = "https://api.vetta.sh";
export const NAIVE_API_VERSION = "2026-09-30";
const EVENT_PAGE_LIMIT = 100;
const EVENT_MAX_PAGES = 20;

interface RawSession {
  id: string;
  agent_id: string;
  status: string;
  stop_reason: string | null;
  pending_actions?: {
    kind?: string;
    tool_call_id: string;
    name: string;
    args?: unknown;
    parked_seq?: number | null;
  }[];
  metadata?: Record<string, unknown>;
  consumed_micro_usd?: number;
}

interface RawEvent {
  seq: number;
  type: string;
  data?: Record<string, unknown>;
  created_at: string;
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
      parkedSeq: typeof a.parked_seq === "number" ? a.parked_seq : null,
    })),
    metadata: r.metadata ?? {},
    consumedUsd: (r.consumed_micro_usd ?? 0) / 1_000_000,
  };
}

const BUDGET_CODES = new Set(["insufficient_credits", "subscription_required", "budget_exceeded"]);

/** Maps a Naive error response to an AppError. Exported for tests. */
export function naiveError(status: number, code: string, msg: string, retryAfter: string | null): AppError {
  if (BUDGET_CODES.has(code)) return new AppError("budget_exhausted", msg, { retryable: false });
  if (code === "version_conflict") return new AppError("conflict", msg, { retryable: true });
  if (status === 429) {
    const s = Number(retryAfter);
    return new AppError("rate_limited", msg, {
      retryable: true,
      ...(Number.isFinite(s) && s > 0 ? { retryAfterSeconds: s } : {}),
    });
  }
  if (status >= 500 || status === 408 || status === 425)
    return new AppError("upstream_error", msg, { retryable: true });
  if (status === 409) return new AppError("conflict", msg, { retryable: false });
  if (status === 404) return new AppError("not_found", msg);
  if (status === 401) return new AppError("not_configured", msg);
  if (status === 403) return new AppError("forbidden", msg);
  return new AppError("upstream_error", msg, { retryable: false });
}

export function createNaiveClient(
  apiKey: string,
  opts: { baseUrl?: string; fetch?: typeof fetch } = {},
): NaiveClient {
  const base = (opts.baseUrl ?? NAIVE_API_BASE).replace(/\/$/, "");
  const f = opts.fetch ?? fetch;
  const agentIds = new Map<string, string>();

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
      error?: { code?: string; request_id?: string };
    };
    if (res.ok) return json as T;
    const code = json.error?.code ?? "unknown";
    const msg = `naive: ${method} ${path} → ${res.status} ${code} (request ${json.error?.request_id ?? "?"})`;
    throw naiveError(res.status, code, msg, res.headers.get("retry-after"));
  }

  async function listAgents(): Promise<void> {
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await call<{
        data: { id: string; name: string }[];
        has_more?: boolean;
        next_cursor?: string;
      }>("GET", `/v1/agents?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`);
      for (const a of r.data) {
        if (parseNaiveAgentName(a.name)) agentIds.set(a.name, a.id);
      }
      if (!r.has_more || !r.next_cursor) return;
      after = r.next_cursor;
    }
  }

  /** Every row of a cursor-paged list. */
  async function listAll<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const r = await call<{ data: T[]; has_more?: boolean; next_cursor?: string }>(
        "GET",
        `${path}${sep}limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`,
      );
      out.push(...r.data);
      if (!r.has_more || !r.next_cursor) break;
      after = r.next_cursor;
    }
    return out;
  }

  /** A 404 on an agent-scoped call means `naive up` recreated it: forget the cached id. */
  function forgetOn404<T>(p: Promise<T>, agentId: string): Promise<T> {
    return p.catch((err: unknown) => {
      if (err instanceof AppError && err.code === "not_found") {
        for (const [name, id] of agentIds) if (id === agentId) agentIds.delete(name);
      }
      throw err;
    });
  }

  return {
    async resolveAgentId(name) {
      if (!agentIds.has(name)) await listAgents();
      const id = agentIds.get(name);
      if (!id) throw new AppError("not_configured", `naive: no agent named ${name}; run pnpm naive:up`);
      return id;
    },

    async startSession(req) {
      const r = await forgetOn404(
        call<RawSession>(
          "POST",
          "/v1/sessions",
          { agent_id: req.agentId, message: req.message, metadata: req.metadata },
          req.idempotencyKey,
        ),
        req.agentId,
      );
      if (typeof r.id !== "string" || !r.id) {
        throw new AppError("upstream_error", "naive: session create returned no id", { retryable: true });
      }
      return { sessionId: r.id };
    },

    async send(sessionId, message, idempotencyKey) {
      // queue: true waits for a running turn instead of answering 409 session_running.
      await call(
        "POST",
        `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
        { message, queue: true },
        idempotencyKey,
      );
    },

    async confirmTool(sessionId, toolCallId, decision, reason, parkedSeq) {
      await call(
        "POST",
        `/v1/sessions/${encodeURIComponent(sessionId)}/tool_confirmations`,
        {
          tool_call_id: toolCallId,
          decision,
          ...(decision === "deny" ? { reason: reason.slice(0, 500) } : {}),
        },
        `confirm:${sessionId}:${toolCallId}:${parkedSeq ?? "-"}:${decision}`,
      );
    },

    async getSession(sessionId) {
      return mapSession(await call<RawSession>("GET", `/v1/sessions/${encodeURIComponent(sessionId)}`));
    },

    async getEvents(sessionId, o) {
      const out: NaiveEvent[] = [];
      let after: string | undefined;
      for (let page = 0; page < EVENT_MAX_PAGES; page++) {
        const q = new URLSearchParams({ after_seq: String(o.afterSeq), limit: String(EVENT_PAGE_LIMIT) });
        if (o.includeAccepted) q.set("include_accepted", "true");
        if (after) q.set("after", after);
        const r = await call<{ data: RawEvent[]; has_more?: boolean; next_cursor?: string }>(
          "GET",
          `/v1/sessions/${encodeURIComponent(sessionId)}/events?${q.toString()}`,
        );
        for (const e of r.data)
          out.push({ seq: e.seq, type: e.type, data: e.data ?? {}, createdAt: e.created_at });
        if (!r.has_more || !r.next_cursor) break;
        after = r.next_cursor;
      }
      return out.sort((a, b) => a.seq - b.seq);
    },

    async listWebhooks() {
      type Row = { id: string; url: string; enabled?: boolean; status?: string; events?: string[] };
      const out: { id: string; url: string; enabled: boolean; events: string[] }[] = [];
      let after: string | undefined;
      for (let page = 0; page < EVENT_MAX_PAGES; page++) {
        const q = new URLSearchParams({ limit: "100" });
        if (after) q.set("after", after);
        const r = await call<{ data: Row[]; has_more?: boolean; next_cursor?: string }>(
          "GET",
          `/v1/webhooks?${q.toString()}`,
        );
        for (const w of r.data)
          out.push({
            id: w.id,
            url: w.url,
            enabled: w.enabled ?? w.status !== "disabled",
            events: w.events ?? [],
          });
        if (!r.has_more || !r.next_cursor) break;
        after = r.next_cursor;
      }
      return out;
    },

    async agentSpendUsd(agentId) {
      const r = await forgetOn404(
        call<{ spent_micro_usd?: number }>("GET", `/v1/agents/${encodeURIComponent(agentId)}/spend`),
        agentId,
      );
      return (r.spent_micro_usd ?? 0) / 1_000_000;
    },

    async listAgents() {
      const rows = await listAll<{ id: string; name: string }>("/v1/agents");
      for (const a of rows) if (parseNaiveAgentName(a.name)) agentIds.set(a.name, a.id);
      return rows.map((a) => ({ id: a.id, name: a.name }));
    },

    async createAgent(body, idempotencyKey) {
      const r = await call<{ id?: string }>("POST", "/v1/agents", body, idempotencyKey);
      if (typeof r.id !== "string" || !r.id)
        throw new AppError("upstream_error", "naive: agent create returned no id", { retryable: true });
      agentIds.set(body.name, r.id);
      return { id: r.id };
    },

    async listVaults() {
      const rows = await listAll<{ id: string; name: string }>("/v1/vaults");
      return rows.map((v) => ({ id: v.id, name: v.name }));
    },

    async listCredentials(vaultId) {
      const rows = await listAll<{ id: string; kind: string; key: string; mcp_server_url?: string | null }>(
        `/v1/vaults/${encodeURIComponent(vaultId)}/credentials`,
      );
      return rows.map((c) => ({
        id: c.id,
        kind: c.kind,
        key: c.key,
        mcp_server_url: c.mcp_server_url ?? null,
      }));
    },

    async createCredential(vaultId, body, idempotencyKey) {
      const r = await call<{ id?: string }>(
        "POST",
        `/v1/vaults/${encodeURIComponent(vaultId)}/credentials`,
        body,
        idempotencyKey,
      );
      return { id: r.id ?? "" };
    },

    async listDeployments() {
      const rows = await listAll<{ id: string; agent_id: string; cron: string }>("/v1/deployments");
      return rows.map((d) => ({ id: d.id, agent_id: d.agent_id, cron: d.cron }));
    },

    async createDeployment(body, idempotencyKey) {
      const r = await call<{ id?: string }>("POST", "/v1/deployments", body, idempotencyKey);
      return { id: r.id ?? "" };
    },
  };
}
