/**
 * Fake Naive client. Records every call and, when given a registry, replays scripted tool
 * calls for each agent against our real tool handlers. Tools whose policy is `ask` are held
 * as pending actions until `confirmTool`, exactly as Naive holds them. Like Naive, each session
 * keeps an event log (tool.confirm, tool.confirm.resolved, session.idle) with a seq, and
 * `onIdle` fires on every idle the way the session.idle webhook does.
 */
import { randomUUID } from "node:crypto";
import { type AgentName, CREW_TOOLS, type CrewToolName, type StopReason } from "../../contracts";
import type { ToolRegistry } from "../crew/registry";
import type { ToolContext } from "../crew/types";
import { parseNaiveAgentName } from "../crew/identity";
import { AppError } from "../errors";
import { naiveError } from "../integrations/naive";
import type {
  NaiveAgentBody,
  NaiveClient,
  NaiveCredentialRow,
  NaiveEvent,
  NaiveSession,
} from "../integrations/types";

export interface ScriptedCall {
  tool: CrewToolName;
  /** Or a function of the calls so far, resolved when the step comes up (e.g. a draft's id). */
  input: unknown;
}

export interface ToolCallRecord {
  sessionId: string;
  agent: AgentName;
  tool: CrewToolName;
  input: unknown;
  result?: unknown;
  error?: { code: string; message: string };
  decision?: "allow" | "deny";
}

interface FakeSession extends NaiveSession {
  agent: AgentName;
  clientSlug: string;
  steps: ScriptedCall[];
  cursor: number;
  messages: string[];
  events: NaiveEvent[];
  seq: number;
}

export class FakeNaiveClient implements NaiveClient {
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly toolCalls: ToolCallRecord[] = [];
  readonly sessions = new Map<string, FakeSession>();
  private readonly byKey = new Map<string, string>();
  private readonly sentKeys = new Set<string>();
  private readonly scripts = new Map<string, ScriptedCall[][]>();
  readonly spend = new Map<string, number>();

  constructor(
    private readonly opts: {
      registry?: ToolRegistry;
      /** The tool context for a crew member: its role, and its client by slug. */
      ctx?: (agent: AgentName, clientSlug: string) => ToolContext | Promise<ToolContext>;
      /** Called on every idle, like Naive's session.idle webhook. */
      onIdle?: (sessionId: string, stopReason: StopReason) => void | Promise<void>;
    } = {},
  ) {}

  /** Who the fake records as deciding a confirmation. */
  actor: { type: "user" | "key" | "system"; id: string } = { type: "user", id: "usr_fake" };

  /** By Naive agent name: the role for Outrun's crew, `<slug>-<role>` for another client's. */
  agentIdOf(name: string): string {
    return `agt_fake_${name}`;
  }

  /** Queue a script for the next session this agent (by Naive agent name) starts. */
  script(agent: string, steps: ScriptedCall[]): this {
    const list = this.scripts.get(agent) ?? [];
    list.push(steps);
    this.scripts.set(agent, list);
    return this;
  }

  async resolveAgentId(name: string): Promise<string> {
    this.calls.push({ method: "resolveAgentId", args: [name] });
    if (!parseNaiveAgentName(name)) throw new AppError("not_configured", `naive: no agent named ${name}`);
    return this.agentIdOf(name);
  }

  async startSession(req: {
    agentId: string;
    message: string;
    metadata: Record<string, unknown>;
    idempotencyKey: string;
  }) {
    this.calls.push({ method: "startSession", args: [req] });
    const existing = this.byKey.get(req.idempotencyKey);
    if (existing) return { sessionId: existing };
    const name = req.agentId.replace(/^agt_fake_/, "");
    const member = parseNaiveAgentName(name);
    if (!req.agentId.startsWith("agt_fake_") || !member)
      throw new Error(`FakeNaiveClient: unknown agent id ${req.agentId}`);
    const { agent, clientSlug } = member;
    const id = `ses_fake_${randomUUID().slice(0, 8)}`;
    const steps = this.scripts.get(name)?.shift() ?? [];
    const s: FakeSession = {
      id,
      agentId: req.agentId,
      agent,
      clientSlug,
      status: "running",
      stopReason: null,
      pendingActions: [],
      metadata: req.metadata,
      consumedUsd: 0,
      steps,
      cursor: 0,
      messages: [req.message],
      events: [],
      seq: 0,
    };
    this.sessions.set(id, s);
    this.byKey.set(req.idempotencyKey, id);
    await this.run(s);
    return { sessionId: id };
  }

  async send(sessionId: string, message: string, idempotencyKey: string): Promise<void> {
    this.calls.push({ method: "send", args: [sessionId, message, idempotencyKey] });
    const s = this.must(sessionId);
    if (this.sentKeys.has(idempotencyKey)) return;
    this.sentKeys.add(idempotencyKey);
    s.messages.push(message);
    if (s.pendingActions.length === 0) await this.run(s);
  }

  async confirmTool(
    sessionId: string,
    toolCallId: string,
    decision: "allow" | "deny",
    reason: string,
  ): Promise<void> {
    this.calls.push({ method: "confirmTool", args: [sessionId, toolCallId, decision, reason] });
    const s = this.must(sessionId);
    const pending = s.pendingActions.find((p) => p.toolCallId === toolCallId);
    if (!pending) throw new Error(`FakeNaiveClient: no pending call ${toolCallId}`);
    s.pendingActions = s.pendingActions.filter((p) => p.toolCallId !== toolCallId);
    const step = s.steps[s.cursor]!;
    this.event(s, "tool.confirm.resolved", {
      tool_call_id: toolCallId,
      decision,
      reason: decision === "deny" ? reason : null,
      scope: "call",
      actor: this.actor,
      proposed_args: pending.input,
      final_args: pending.input,
    });
    s.cursor++;
    if (decision === "allow") await this.invoke(s, step, "allow");
    else
      this.toolCalls.push({
        sessionId,
        agent: s.agent,
        tool: step.tool,
        input: step.input,
        decision: "deny",
      });
    await this.run(s);
  }

  async getSession(sessionId: string): Promise<NaiveSession> {
    this.calls.push({ method: "getSession", args: [sessionId] });
    const s = this.must(sessionId);
    return {
      id: s.id,
      agentId: s.agentId,
      status: s.status,
      stopReason: s.stopReason,
      pendingActions: [...s.pendingActions],
      metadata: s.metadata,
      consumedUsd: s.consumedUsd,
    };
  }

  async getEvents(
    sessionId: string,
    o: { afterSeq: number; includeAccepted?: boolean },
  ): Promise<NaiveEvent[]> {
    this.calls.push({ method: "getEvents", args: [sessionId, o] });
    return this.must(sessionId).events.filter(
      (e) => e.seq > o.afterSeq && (o.includeAccepted || e.type !== "tool.confirm.resolved"),
    );
  }

  /** Ends a session as if cancelled in the Studio. */
  cancel(sessionId: string): void {
    const s = this.must(sessionId);
    s.status = "cancelled";
    s.pendingActions = [];
  }

  /** Tests flip `enabled` to force the webhook alert. */
  readonly webhooks: { id: string; url: string; enabled: boolean; events: string[] }[] = [];
  async listWebhooks() {
    this.calls.push({ method: "listWebhooks", args: [] });
    return this.webhooks.map((w) => ({ ...w }));
  }

  async agentSpendUsd(agentId: string): Promise<number> {
    this.calls.push({ method: "agentSpendUsd", args: [agentId] });
    return this.spend.get(agentId) ?? 0;
  }

  /* ---------- runtime provisioning ---------- */

  /** Agents created through createAgent; their ids are agentIdOf(name), so startSession works. */
  readonly agents: (NaiveAgentBody & { id: string })[] = [];
  /** The org vault `naive up` made; tests empty it to see the "no vault" path. */
  readonly vaults: { id: string; name: string }[] = [{ id: "vlt_fake_outrun-crew", name: "outrun-crew" }];
  /** Credential rows, values included so tests can check them (the real API never returns them). */
  readonly credentials: (NaiveCredentialRow & { vaultId: string; value: string; agent_id?: string })[] = [];
  readonly deployments: {
    id: string;
    agent_id: string;
    cron: string;
    timezone: string;
    input_template: string;
    budget_micro_usd: number;
  }[] = [];
  /** Answer every provisioning call with this status (401/403 scope errors, 409 conflicts). */
  provisionStatus: { status: number; code: string } | null = null;
  private readonly postKeys = new Map<string, { id: string }>();

  private provisionGate(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
    const s = this.provisionStatus;
    if (s) throw naiveError(s.status, s.code, `fake naive: ${method} → ${s.status} ${s.code}`, null);
  }

  async listAgents() {
    this.provisionGate("listAgents", []);
    return this.agents.map((a) => ({ id: a.id, name: a.name }));
  }

  async createAgent(body: NaiveAgentBody, idempotencyKey: string) {
    this.provisionGate("createAgent", [body.name, idempotencyKey]);
    const seen = this.postKeys.get(idempotencyKey);
    if (seen) return seen;
    if (this.agents.some((a) => a.name === body.name))
      throw naiveError(409, "already_exists", `fake naive: agent ${body.name} exists`, null);
    const id = this.agentIdOf(body.name);
    this.agents.push({ ...body, id });
    this.postKeys.set(idempotencyKey, { id });
    return { id };
  }

  async listVaults() {
    this.provisionGate("listVaults", []);
    return this.vaults.map((v) => ({ ...v }));
  }

  async listCredentials(vaultId: string) {
    this.provisionGate("listCredentials", [vaultId]);
    return this.credentials
      .filter((c) => c.vaultId === vaultId)
      .map(({ id, kind, key, mcp_server_url }) => ({ id, kind, key, mcp_server_url }));
  }

  async createCredential(
    vaultId: string,
    body: { kind: "static_bearer"; key: string; value: string; mcp_server_url: string; agent_id?: string },
    idempotencyKey: string,
  ) {
    // Never record the value in `calls`.
    this.provisionGate("createCredential", [vaultId, body.key, idempotencyKey]);
    const seen = this.postKeys.get(idempotencyKey);
    if (seen) return seen;
    if (!this.vaults.some((v) => v.id === vaultId)) throw naiveError(404, "not_found", "no vault", null);
    const id = `cred_fake_${randomUUID().slice(0, 8)}`;
    this.credentials.push({ id, vaultId, ...body });
    this.postKeys.set(idempotencyKey, { id });
    return { id };
  }

  async listDeployments() {
    this.provisionGate("listDeployments", []);
    return this.deployments.map(({ id, agent_id, cron }) => ({ id, agent_id, cron }));
  }

  async createDeployment(
    body: {
      agent_id: string;
      cron: string;
      timezone: string;
      input_template: string;
      budget_micro_usd: number;
    },
    idempotencyKey: string,
  ) {
    this.provisionGate("createDeployment", [body.agent_id, body.cron, idempotencyKey]);
    const seen = this.postKeys.get(idempotencyKey);
    if (seen) return seen;
    const id = `dep_fake_${randomUUID().slice(0, 8)}`;
    this.deployments.push({ id, ...body });
    this.postKeys.set(idempotencyKey, { id });
    return { id };
  }

  private must(id: string): FakeSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`FakeNaiveClient: unknown session ${id}`);
    return s;
  }

  private async run(s: FakeSession): Promise<void> {
    s.status = "running";
    while (s.cursor < s.steps.length) {
      const step = s.steps[s.cursor]!;
      // A step sees its own session's calls, as an agent sees only its own transcript.
      if (typeof step.input === "function")
        step.input = (step.input as (c: ToolCallRecord[]) => unknown)(
          this.toolCalls.filter((c) => c.sessionId === s.id),
        );
      if (CREW_TOOLS[step.tool].policy === "ask") {
        const toolCallId = `tc_${randomUUID().slice(0, 8)}`;
        const parked = this.event(s, "tool.confirm", {
          tool_call_id: toolCallId,
          name: `outrun.${step.tool}`,
        });
        s.pendingActions.push({
          kind: "tool",
          toolCallId,
          tool: `outrun.${step.tool}`,
          input: step.input,
          parkedSeq: parked.seq,
        });
        await this.idle(s, "awaiting_approval");
        return;
      }
      s.cursor++;
      await this.invoke(s, step);
    }
    await this.idle(s, "end_turn");
  }

  private event(s: FakeSession, type: string, data: Record<string, unknown>): NaiveEvent {
    const e = {
      seq: ++s.seq,
      type,
      data: { session_id: s.id, ...data },
      createdAt: new Date().toISOString(),
    };
    s.events.push(e);
    return e;
  }

  private async idle(s: FakeSession, reason: StopReason): Promise<void> {
    s.status = "idle";
    s.stopReason = reason;
    this.event(s, "session.idle", { stop_reason: reason });
    await this.opts.onIdle?.(s.id, reason);
  }

  private async invoke(s: FakeSession, step: ScriptedCall, decision?: "allow"): Promise<void> {
    const rec: ToolCallRecord = {
      sessionId: s.id,
      agent: s.agent,
      tool: step.tool,
      input: step.input,
      ...(decision ? { decision } : {}),
    };
    this.toolCalls.push(rec);
    if (!this.opts.registry || !this.opts.ctx) return;
    try {
      rec.result = await this.opts.registry.call(
        s.agent,
        step.tool,
        step.input,
        await this.opts.ctx(s.agent, s.clientSlug),
      );
    } catch (err) {
      const e = err as { code?: string; message?: string };
      rec.error = { code: e.code ?? "internal", message: e.message ?? String(err) };
    }
  }
}
