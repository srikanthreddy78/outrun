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
import type { NaiveClient, NaiveEvent, NaiveSession } from "../integrations/types";

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
      ctx?: (agent: AgentName, clientSlug: string) => ToolContext;
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
        this.opts.ctx(s.agent, s.clientSlug),
      );
    } catch (err) {
      const e = err as { code?: string; message?: string };
      rec.error = { code: e.code ?? "internal", message: e.message ?? String(err) };
    }
  }
}
