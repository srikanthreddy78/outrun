/**
 * Fake Naive client. Records every call and, when given a registry, replays scripted tool
 * calls for each agent against our real tool handlers. Tools whose policy is `ask` are held
 * as pending actions until `confirmTool`, exactly as Naive holds them.
 */
import { randomUUID } from "node:crypto";
import { AGENTS, type AgentName, CREW_TOOLS, type CrewToolName, type StopReason } from "../../contracts";
import type { ToolRegistry } from "../crew/registry";
import type { ToolContext } from "../crew/types";
import type { NaiveClient, NaiveSession } from "../integrations/types";

export interface ScriptedCall {
  tool: CrewToolName;
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
  steps: ScriptedCall[];
  cursor: number;
  messages: string[];
}

export class FakeNaiveClient implements NaiveClient {
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly toolCalls: ToolCallRecord[] = [];
  readonly sessions = new Map<string, FakeSession>();
  private readonly byKey = new Map<string, string>();
  private readonly scripts = new Map<AgentName, ScriptedCall[][]>();
  readonly spend = new Map<string, number>();

  constructor(
    private readonly opts: {
      registry?: ToolRegistry;
      ctx?: (agent: AgentName) => ToolContext;
    } = {},
  ) {}

  agentIdOf(agent: AgentName): string {
    return `agt_fake_${agent}`;
  }

  /** Queue a script for the next session this agent starts. */
  script(agent: AgentName, steps: ScriptedCall[]): this {
    const list = this.scripts.get(agent) ?? [];
    list.push(steps);
    this.scripts.set(agent, list);
    return this;
  }

  async resolveAgentId(agent: AgentName): Promise<string> {
    this.calls.push({ method: "resolveAgentId", args: [agent] });
    return this.agentIdOf(agent);
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
    const agent = AGENTS.find((a) => this.agentIdOf(a) === req.agentId);
    if (!agent) throw new Error(`FakeNaiveClient: unknown agent id ${req.agentId}`);
    const id = `ses_fake_${randomUUID().slice(0, 8)}`;
    const steps = this.scripts.get(agent)?.shift() ?? [];
    const s: FakeSession = {
      id,
      agentId: req.agentId,
      agent,
      status: "running",
      stopReason: null,
      pendingActions: [],
      metadata: req.metadata,
      steps,
      cursor: 0,
      messages: [req.message],
    };
    this.sessions.set(id, s);
    this.byKey.set(req.idempotencyKey, id);
    await this.run(s);
    return { sessionId: id };
  }

  async send(sessionId: string, message: string, idempotencyKey: string): Promise<void> {
    this.calls.push({ method: "send", args: [sessionId, message, idempotencyKey] });
    const s = this.must(sessionId);
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
    };
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
      if (CREW_TOOLS[step.tool].policy === "ask") {
        s.pendingActions.push({
          toolCallId: `tc_${randomUUID().slice(0, 8)}`,
          tool: `outrun.${step.tool}`,
          input: step.input,
        });
        this.idle(s, "awaiting_approval");
        return;
      }
      s.cursor++;
      await this.invoke(s, step);
    }
    this.idle(s, "end_turn");
  }

  private idle(s: FakeSession, reason: StopReason): void {
    s.status = "idle";
    s.stopReason = reason;
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
      rec.result = await this.opts.registry.call(s.agent, step.tool, step.input, this.opts.ctx(s.agent));
    } catch (err) {
      const e = err as { code?: string; message?: string };
      rec.error = { code: e.code ?? "internal", message: e.message ?? String(err) };
    }
  }
}
