/**
 * Agent-to-agent (A2A v0.3, JSON-RPC binding) for other companies' agents: the agent card
 * served at /.well-known/agent-card.json, and /api/a2a with message/send and tasks/get.
 *
 * A message whose data part is { skill, input } runs that public tool and returns a completed
 * Task carrying the tool's output as a data artifact. A message we can't map to a skill gets a
 * Task in input-required, listing the skills and their JSON input schemas, so the calling agent
 * can retry with structured data. Nothing here waits on a person or calls an LLM.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { PUBLIC_TOOLS, type PublicToolName } from "../../contracts";
import { A2A_PROTOCOL_VERSION } from "../constants";
import { events } from "../db/schema";
import { AppError } from "../errors";
import { callPublicTool, type PublicDeps } from "./service";

const SKILL_NAMES: Record<PublicToolName, string> = {
  get_readiness_score: "Agent-readiness score",
  get_quote: "Quote",
  buy_audit: "Buy an audit",
  get_order_status: "Order status",
  hire_agency: "Hire the agency (free trial)",
};
const SKILL_EXAMPLES: Record<PublicToolName, string[]> = {
  get_readiness_score: ['{"skill":"get_readiness_score","input":{"domain":"example.com"}}'],
  get_quote: ['{"skill":"get_quote","input":{"domain":"example.com","package":"auditKit"}}'],
  buy_audit: [
    '{"skill":"buy_audit","input":{"domain":"example.com","package":"auditKit","contactEmail":"founder@example.com","idempotencyKey":"order-2026-11-07-1"}}',
  ],
  get_order_status: ['{"skill":"get_order_status","input":{"orderId":"<uuid from buy_audit>"}}'],
  hire_agency: [
    '{"skill":"hire_agency","input":{"companyName":"Example Inc","domain":"example.com","approverEmail":"founder@example.com"}}',
  ],
};
const SKILLS = Object.keys(PUBLIC_TOOLS) as PublicToolName[];

export function inputSchemas(): Record<PublicToolName, unknown> {
  return Object.fromEntries(
    SKILLS.map((s) => [s, z.toJSONSchema(PUBLIC_TOOLS[s].input, { io: "input" })]),
  ) as Record<PublicToolName, unknown>;
}

export function agentCard(appUrl: string) {
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: "Outrun",
    description:
      "Outrun scores how ready a business is for AI agents and sells an Audit + Kit and a monthly Growth Department. Agents can score a domain, get a quote, buy and track an order without a person. Send a data part {skill, input}.",
    url: `${appUrl}/api/a2a`,
    preferredTransport: "JSONRPC",
    additionalInterfaces: [{ url: `${appUrl}/api/a2a`, transport: "JSONRPC" }],
    provider: { organization: "Outrun", url: appUrl },
    documentationUrl: `${appUrl}/llms.txt`,
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json"],
    skills: SKILLS.map((id) => ({
      id,
      name: SKILL_NAMES[id],
      description: PUBLIC_TOOLS[id].description,
      tags:
        id === "hire_agency"
          ? ["agency", "outbound-marketing"]
          : ["agent-readiness", id === "buy_audit" || id === "get_quote" ? "commerce" : "readiness"],
      examples: SKILL_EXAMPLES[id],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    })),
  };
}

/* ---------- JSON-RPC ---------- */

const Part = z.union([
  z.object({ kind: z.literal("text"), text: z.string() }).passthrough(),
  z.object({ kind: z.literal("data"), data: z.record(z.string(), z.unknown()) }).passthrough(),
  z.object({ kind: z.literal("file") }).passthrough(),
]);
const Message = z
  .object({
    role: z.enum(["user", "agent"]),
    parts: z.array(Part).min(1),
    messageId: z.string().min(1),
    kind: z.literal("message").optional(),
    contextId: z.string().optional(),
    taskId: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const SendParams = z.object({
  message: Message,
  configuration: z.unknown().optional(),
  metadata: z.unknown().optional(),
});
const GetParams = z.object({ id: z.string().min(1), historyLength: z.number().int().optional() });

export const RPC = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  pushNotSupported: -32003,
  unsupported: -32004,
} as const;

type Id = string | number | null;
export type RpcReply = {
  jsonrpc: "2.0";
  id: Id;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

const fail = (id: Id, code: number, message: string, data?: unknown): RpcReply => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

export interface A2aMeta {
  callerIp: string;
}

/** Handles one JSON-RPC request body (already read as text). */
export async function handleA2a(deps: PublicDeps, rawBody: string, meta: A2aMeta): Promise<RpcReply> {
  let req: unknown;
  try {
    req = JSON.parse(rawBody);
  } catch {
    return fail(null, RPC.parse, "Parse error");
  }
  const r = z
    .object({
      jsonrpc: z.literal("2.0"),
      id: z.union([z.string(), z.number(), z.null()]).optional(),
      method: z.string(),
      params: z.unknown(),
    })
    .safeParse(req);
  if (!r.success) return fail(null, RPC.invalidRequest, "Invalid Request");
  const id = r.data.id ?? null;
  switch (r.data.method) {
    case "message/send": {
      const p = SendParams.safeParse(r.data.params);
      if (!p.success) return fail(id, RPC.invalidParams, "Invalid params", p.error.issues.slice(0, 5));
      return { jsonrpc: "2.0", id, result: await send(deps, p.data.message, meta) };
    }
    case "tasks/get": {
      const p = GetParams.safeParse(r.data.params);
      if (!p.success) return fail(id, RPC.invalidParams, "Invalid params");
      const task = await loadTask(deps, p.data.id);
      return task ? { jsonrpc: "2.0", id, result: task } : fail(id, RPC.taskNotFound, "Task not found");
    }
    case "tasks/cancel":
      return fail(
        id,
        RPC.taskNotCancelable,
        "Tasks finish as soon as they're created; there is nothing to cancel",
      );
    case "tasks/pushNotificationConfig/set":
    case "tasks/pushNotificationConfig/get":
      return fail(id, RPC.pushNotSupported, "Push notifications are not supported");
    case "message/stream":
    case "tasks/resubscribe":
      return fail(id, RPC.unsupported, "Streaming is not supported; use message/send");
    default:
      return fail(id, RPC.methodNotFound, "Method not found");
  }
}

type A2aMessage = z.infer<typeof Message>;

/** The skill and input a message asks for, or null when it names none we can run. */
export function intentOf(m: A2aMessage): { skill: PublicToolName; input: unknown } | null {
  for (const part of m.parts) {
    if (part.kind !== "data") continue;
    const d = (part as { data: Record<string, unknown> }).data;
    const skill = (d.skill ?? m.metadata?.skill) as string | undefined;
    if (skill && (SKILLS as string[]).includes(skill)) {
      const { skill: _s, input, ...rest } = d;
      return { skill: skill as PublicToolName, input: input ?? rest };
    }
  }
  return null;
}

async function send(deps: PublicDeps, m: A2aMessage, meta: A2aMeta) {
  const contextId = m.contextId ?? randomUUID();
  const taskId = randomUUID();
  const intent = intentOf(m);
  const now = new Date().toISOString();
  let task: Record<string, unknown>;
  if (!intent) {
    task = {
      kind: "task",
      id: taskId,
      contextId,
      status: {
        state: "input-required",
        timestamp: now,
        message: agentText(
          contextId,
          taskId,
          `Send a data part {"skill": <one of ${SKILLS.join(", ")}>, "input": {...}}. The input schemas are attached.`,
        ),
      },
      artifacts: [
        {
          artifactId: randomUUID(),
          name: "skills",
          parts: [{ kind: "data", data: { skills: inputSchemas() } }],
        },
      ],
    };
  } else {
    try {
      const output = await callPublicTool(deps, intent.skill, intent.input, {
        protocol: "a2a",
        callerIp: meta.callerIp,
        requestId: taskId,
      });
      task = {
        kind: "task",
        id: taskId,
        contextId,
        status: { state: "completed", timestamp: now },
        artifacts: [
          { artifactId: randomUUID(), name: intent.skill, parts: [{ kind: "data", data: output }] },
        ],
      };
    } catch (err) {
      const e = err instanceof AppError ? err : new AppError("internal", "internal error");
      const body = e.toBody(taskId);
      task = {
        kind: "task",
        id: taskId,
        contextId,
        status: {
          // A fixable input is input-required; anything else is a failed task.
          state:
            e.code === "bad_request" ? "input-required" : e.code === "rate_limited" ? "rejected" : "failed",
          timestamp: now,
          message: agentText(contextId, taskId, e.message, body),
        },
      };
    }
  }
  await deps.emit({
    actor: "web",
    type: "agent_to_agent.task",
    entityType: "system",
    entityId: `a2a:${taskId}`,
    // The input is never stored (it can carry an email); the task holds the output only.
    payload: { skill: intent?.skill ?? null, task },
  });
  return task;
}

function agentText(contextId: string, taskId: string, text: string, data?: unknown) {
  return {
    kind: "message",
    role: "agent",
    messageId: randomUUID(),
    contextId,
    taskId,
    parts: [{ kind: "text", text }, ...(data ? [{ kind: "data", data }] : [])],
  };
}

async function loadTask(deps: PublicDeps, taskId: string) {
  const [row] = await deps.db
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.type, "agent_to_agent.task"), eq(events.entityId, `a2a:${taskId}`)));
  return (row?.payload as { task?: unknown } | undefined)?.task ?? null;
}
