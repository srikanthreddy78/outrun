/**
 * The crew contract: who the agents are, which `outrun.*` tools exist, who may call each,
 * and its Naive policy. `naive/crew.ts` and the tool registry both read this file, and
 * `naive.config.test.ts` fails if they drift. Changes need all three approvals.
 */
import { z } from "zod";
import { Domain, Email, Id, IsoDateTime, Untrusted } from "./common";
import {
  CheckId,
  MessageDirection,
  Outcome,
  PaidProductKey,
  ProspectStage,
  ScanCheck,
  Source,
} from "./domain";

export const AGENTS = ["orchestrator", "prospector", "researcher", "sdr", "closer", "auditor"] as const;
export const AgentName = z.enum(AGENTS);
export type AgentName = z.infer<typeof AgentName>;

/** The MCP server name agents see; tools appear as `outrun.<tool>`. */
export const MCP_SERVER_NAME = "outrun";

export type Policy = "allow" | "ask" | "deny";

const Fact = z.object({
  key: z.string().min(1).max(80),
  value: z.string().min(1).max(1000),
  sourceUrl: z.url(),
});
const BusinessContact = z.object({
  name: z.string().min(1).max(120),
  role: z.string().max(120).default(""),
  email: Email,
  sourceUrl: z.url(),
});
const ContactOut = z.object({ contactId: Id, name: z.string(), role: z.string(), email: z.string() });
const Draft = z.object({ draftId: Id, hash: z.string().regex(/^[0-9a-f]{64}$/) });
const Limit = (max: number, def: number) => z.number().int().min(1).max(max).default(def);

export const CREW_TOOLS = {
  pipeline_status: {
    agents: ["orchestrator"],
    policy: "allow",
    description: "Counts per stage, today's caps left, approvals waiting and follow-ups due.",
    input: z.object({}),
    output: z.object({
      stages: z.record(ProspectStage, z.number().int().nonnegative()),
      candidatesWaiting: z.number().int().nonnegative(),
      capsLeft: z.object({ send: z.number().int(), discovery: z.number().int() }),
      approvalsWaiting: z.number().int().nonnegative(),
      followupsDue: z.number().int().nonnegative(),
      demo: z.boolean(),
    }),
  },
  list_candidates: {
    agents: ["prospector"],
    policy: "allow",
    description: "Candidates from the sources that aren't prospects yet.",
    input: z.object({ limit: Limit(50, 20), source: Source.optional() }),
    output: z.object({
      candidates: z.array(
        z.object({ companyId: Id, domain: Domain, name: z.string(), source: Source, summary: Untrusted }),
      ),
    }),
  },
  file_prospect: {
    agents: ["prospector"],
    policy: "allow",
    description: "Creates a prospect and enqueues its scan and CRM sync; refuses past the discovery cap.",
    input: z.object({ companyId: Id, reason: z.string().min(1).max(500) }),
    output: z.object({ prospectId: Id, status: z.enum(["filed", "duplicate"]) }),
  },
  get_prospect: {
    agents: ["researcher"],
    policy: "allow",
    description: "Company, latest scan and saved facts for a prospect.",
    input: z.object({ prospectId: Id }),
    output: z.object({
      prospect: z.object({
        id: Id,
        stage: ProspectStage,
        fitScore: z.number().nullable(),
        gapScore: z.number().nullable(),
      }),
      company: z.object({ domain: Domain, name: z.string() }),
      scan: z.object({ id: Id, score: z.number(), checks: z.array(ScanCheck) }).nullable(),
      facts: z.array(Fact),
    }),
  },
  enrich_company: {
    agents: ["researcher"],
    policy: "allow",
    description: "Monid lookups for a prospect's company. Business contacts only.",
    input: z.object({ prospectId: Id }),
    output: z.object({ facts: z.array(Fact), contacts: z.array(BusinessContact) }),
  },
  save_research: {
    agents: ["researcher"],
    policy: "allow",
    description: "Saves facts with their sources and business contacts; code computes the fit score.",
    input: z.object({
      prospectId: Id,
      facts: z.array(Fact).max(40),
      contacts: z.array(BusinessContact).max(5).default([]),
    }),
    output: z.object({ fitScore: z.number(), savedFacts: z.number().int(), savedContacts: z.number().int() }),
  },
  scan_domain: {
    agents: ["researcher", "auditor"],
    policy: "allow",
    description: "The readiness scan for a domain (cached 7 days).",
    input: z.object({ domain: Domain }),
    output: z.object({
      scanId: Id.nullable(),
      status: z.enum(["queued", "cached"]),
      score: z.number().nullable(),
    }),
  },
  get_brief: {
    agents: ["sdr"],
    policy: "allow",
    description: "Scan checks with their ids, facts, the contact and earlier emails for a prospect.",
    input: z.object({ prospectId: Id }),
    output: z.object({
      prospectId: Id,
      company: z.object({ domain: Domain, name: z.string() }),
      contact: ContactOut.nullable(),
      scanId: Id.nullable(),
      checks: z.array(ScanCheck),
      facts: z.array(Fact),
      priorMessages: z.array(
        z.object({ direction: MessageDirection, subject: z.string(), body: Untrusted, at: IsoDateTime }),
      ),
      scoreUrl: z.url(),
      offer: z.object({ product: PaidProductKey, priceUsd: z.number() }),
    }),
  },
  check_draft: {
    agents: ["sdr", "closer"],
    policy: "allow",
    description: "Rejects any claim without a real check id; stores the draft and its hash.",
    input: z.object({
      prospectId: Id,
      kind: z.enum(["first", "followup", "reply"]),
      threadId: z.string().optional(),
      subject: z.string().min(1).max(160),
      body: z.string().min(1).max(5000),
      citedCheckIds: z.array(CheckId).max(10),
    }),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), draftId: Id, hash: z.string() }),
      z.object({ ok: z.literal(false), reasons: z.array(z.string()).min(1) }),
    ]),
  },
  send_email: {
    agents: ["sdr"],
    policy: "ask",
    description: "Sends a checked first email or follow-up. A person approves every call.",
    input: Draft,
    output: z.object({ messageId: Id, status: z.literal("queued") }),
  },
  list_due_followups: {
    agents: ["sdr"],
    policy: "allow",
    description: "Prospects due a follow-up today (+3 and +7 days, then none).",
    input: z.object({ limit: Limit(50, 20) }),
    output: z.object({
      due: z.array(
        z.object({ prospectId: Id, step: z.union([z.literal(1), z.literal(2)]), dueAt: IsoDateTime }),
      ),
    }),
  },
  get_thread: {
    agents: ["closer"],
    policy: "allow",
    description: "The email thread, outside text wrapped as untrusted.",
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({
      threadId: z.string(),
      prospectId: Id,
      messages: z.array(
        z.object({
          id: Id,
          direction: MessageDirection,
          subject: z.string(),
          body: Untrusted,
          at: IsoDateTime,
        }),
      ),
    }),
  },
  create_checkout_link: {
    agents: ["closer"],
    policy: "allow",
    description: "A Stripe Checkout link at the listed price.",
    input: z.object({ prospectId: Id, product: PaidProductKey }),
    output: z.object({ orderId: Id, checkoutUrl: z.url(), priceUsd: z.number() }),
  },
  reply_email: {
    agents: ["closer"],
    policy: "ask",
    description: "Sends a checked reply in the thread. A person approves every call.",
    input: Draft,
    output: z.object({ messageId: Id, status: z.literal("queued") }),
  },
  mark_outcome: {
    agents: ["closer"],
    policy: "allow",
    description: "Records interested, not now or lost, and moves the stage.",
    input: z.object({ prospectId: Id, outcome: Outcome, note: z.string().max(500).optional() }),
    output: z.object({ stage: ProspectStage }),
  },
  start_crawl: {
    agents: ["auditor"],
    policy: "allow",
    description: "Starts an Apify crawl; the worker wakes the session when it ends.",
    input: z.object({ orderId: Id }),
    output: z.object({ crawlId: z.string(), status: z.enum(["started", "already_running", "finished"]) }),
  },
  get_crawl_pages: {
    agents: ["auditor"],
    policy: "allow",
    description: "Crawled pages, wrapped as untrusted.",
    input: z.object({ orderId: Id, cursor: z.string().optional(), limit: Limit(20, 10) }),
    output: z.object({
      pages: z.array(z.object({ url: z.url(), title: z.string(), content: Untrusted })),
      nextCursor: z.string().nullable(),
    }),
  },
  save_audit: {
    agents: ["auditor"],
    policy: "allow",
    description: "Checks that every finding cites evidence, stores the audit and enqueues build_kit.",
    input: z.object({
      orderId: Id,
      summary: z.string().min(1).max(4000),
      findings: z
        .array(
          z
            .object({
              title: z.string().min(1).max(200),
              severity: z.enum(["high", "medium", "low"]),
              detail: z.string().min(1).max(2000),
              checkId: CheckId.optional(),
              pageUrl: z.url().optional(),
            })
            .refine(
              (f) => f.checkId !== undefined || f.pageUrl !== undefined,
              "a finding needs a checkId or pageUrl",
            ),
        )
        .min(1)
        .max(40),
    }),
    output: z.object({ reportId: Id }),
  },
  ping: {
    agents: [...AGENTS],
    policy: "allow",
    description: "Health check.",
    input: z.object({}),
    output: z.object({ ok: z.literal(true), agent: AgentName, ts: IsoDateTime }),
  },
} as const satisfies Record<
  string,
  {
    agents: readonly AgentName[];
    policy: Policy;
    description: string;
    input: z.ZodType;
    output: z.ZodType;
  }
>;

export type CrewToolName = keyof typeof CREW_TOOLS;
export const CREW_TOOL_NAMES = Object.keys(CREW_TOOLS) as CrewToolName[];
export type ToolInput<N extends CrewToolName> = z.output<(typeof CREW_TOOLS)[N]["input"]>;
export type ToolOutput<N extends CrewToolName> = z.input<(typeof CREW_TOOLS)[N]["output"]>;

/** Name as Naive sees it: `outrun.send_email`. */
export const qualified = (tool: CrewToolName): string => `${MCP_SERVER_NAME}.${tool}`;

export function toolsForAgent(agent: AgentName): CrewToolName[] {
  return CREW_TOOL_NAMES.filter((t) => (CREW_TOOLS[t].agents as readonly AgentName[]).includes(agent));
}

/** Naive built-in tools each agent gets; everything else is denied. `read_skill` loads the agent's playbook. */
export const BUILTIN_TOOLS: Record<AgentName, readonly string[]> = {
  orchestrator: [
    "read_skill",
    "board_read",
    "board_write",
    "send_to_agent",
    "wait_for_agents",
    "list_agents",
  ],
  prospector: ["read_skill"],
  researcher: ["read_skill", "web_search", "web_fetch"],
  sdr: ["read_skill"],
  closer: ["read_skill"],
  auditor: ["read_skill", "web_search", "web_fetch"],
};
