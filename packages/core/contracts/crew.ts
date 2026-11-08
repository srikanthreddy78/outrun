/**
 * The crew contract: who the agents are, which `outrun.*` tools exist, who may call each,
 * and its Naive policy. `naive/crew.ts` and the tool registry both read this file, and
 * `naive.config.test.ts` fails if they drift. Changes need all three approvals.
 */
import { z } from "zod";
import { ClientProfile, ClientStatus, ProfileChanges } from "./clients";
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

/**
 * The six roles on every client's crew. The agency runs one crew per client: Outrun's own
 * keeps the bare names (`sdr`), any other client's is `<slug>-<role>` on Naive.
 */
/** The six roles every client's crew starts with. */
export const CORE_CLIENT_ROLES = [
  "orchestrator",
  "prospector",
  "researcher",
  "sdr",
  "closer",
  "auditor",
] as const;
/** Roles the CEO adds to a client's crew when its needs call for them (outrun.staff_client). */
export const OPTIONAL_CLIENT_ROLES = ["account_manager", "signal_scout", "experimenter"] as const;
export type OptionalClientRole = (typeof OPTIONAL_CLIENT_ROLES)[number];
export const CLIENT_ROLES = [...CORE_CLIENT_ROLES, ...OPTIONAL_CLIENT_ROLES] as const;
export type ClientRole = (typeof CLIENT_ROLES)[number];
export const ClientRoleName = z.enum(CLIENT_ROLES);
export const OptionalClientRoleName = z.enum(OPTIONAL_CLIENT_ROLES);
/** A client's roles in CLIENT_ROLES order, always including the six core roles. */
export function staffedRoles(roles?: readonly string[] | null): ClientRole[] {
  const want = new Set<string>([...CORE_CLIENT_ROLES, ...(roles ?? [])]);
  return CLIENT_ROLES.filter((r) => want.has(r));
}
/** Every agent: the client roles, plus the agency's one CEO, which serves no single client. */
export const AGENTS = [...CLIENT_ROLES, "ceo"] as const;
/** Outrun's own crew: the six core roles plus the agency's CEO. */
export const OUTRUN_AGENTS = [...CORE_CLIENT_ROLES, "ceo"] as const;
export const AgentName = z.enum(AGENTS);
export type AgentName = z.infer<typeof AgentName>;

const CrewMember = z.object({ role: AgentName, naiveAgent: z.string() });

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
/** One slice of a client's first emails: how many went out, got a reply, showed interest. */
const InsightRow = z.object({
  key: z.string(),
  contacted: z.number().int().nonnegative(),
  replied: z.number().int().nonnegative(),
  interested: z.number().int().nonnegative(),
  replyRate: z.number().min(0).max(1),
  interestRate: z.number().min(0).max(1),
});
export const SignalKind = z.enum(["funding", "hiring", "launch", "news"]);
/** A calendar date, YYYY-MM-DD. */
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");
const VariantKey = z.enum(["A", "B"]);
const VariantResult = z.object({
  key: VariantKey,
  angle: z.string(),
  sent: z.number().int().nonnegative(),
  replies: z.number().int().nonnegative(),
  interested: z.number().int().nonnegative(),
  replyRate: z.number().min(0).max(1),
});
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
  plan_day: {
    agents: ["orchestrator"],
    policy: "allow",
    description:
      "Enqueues today's sessions: researcher for filed prospects, sdr for researched ones (within the send cap), one prospector batch. Returns at once.",
    input: z.object({ limitPerAgent: Limit(25, 10) }),
    output: z.object({
      /** prospectId is null for batch sessions (the prospector's discovery, the sdr's follow-ups). */
      enqueued: z.array(z.object({ agent: AgentName, prospectId: Id.nullable() })),
      capsLeft: z.object({ send: z.number().int(), discovery: z.number().int() }),
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
      checks: z
        .array(
          z.object({
            id: CheckId,
            title: z.string(),
            status: z.enum(["pass", "fail", "unknown", "gated"]),
            evidence: z.string(),
          }),
        )
        .nullable(),
    }),
  },
  get_brief: {
    agents: ["sdr", "closer"],
    policy: "allow",
    description:
      "Scan checks with their ids (Outrun) or the client's offer (other clients), facts, the contact and earlier emails for a prospect, and for a client the lessons: what its approvers rejected and which subject lines got replies.",
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
      /** Outrun's own prospects only: the public score page and the audit offer. */
      scoreUrl: z.url().nullable(),
      offer: z.object({ product: PaidProductKey, priceUsd: z.number() }).nullable(),
      /** A client's prospects: what the client offers. Cite the prospect's fact keys, not scan checks. */
      client: z
        .object({
          name: z.string(),
          pitch: z.string(),
          callToActionUrl: z.url(),
          prices: z.array(z.object({ label: z.string(), amount: z.string() })),
          sender: z.string(),
          tone: z.string(),
        })
        .nullable(),
      /**
       * A client's prospects: what this client's approvers rejected and the subject lines that got
       * replies, newest first. Avoid the first, imitate the second. Null for Outrun.
       */
      lessons: z
        .object({
          rejectionReasons: z.array(z.string()),
          repliedSubjects: z.array(z.string()),
        })
        .nullable(),
      /** The prospect's freshest signal (signal scout), if any: open with it and cite its fact key. */
      signal: z
        .object({
          factKey: z.string(),
          kind: SignalKind,
          summary: Untrusted,
          sourceUrl: z.url(),
          date: DateOnly,
        })
        .nullable(),
      /** While the client runs an experiment: the angle to write for this prospect. Prices, links and the CTA stay. */
      variant: z.object({ key: VariantKey, angle: z.string(), hypothesis: z.string() }).nullable(),
    }),
  },
  check_draft: {
    agents: ["sdr", "closer"],
    policy: "allow",
    description:
      "Rejects any claim without a real citation (a scan check id for Outrun, a saved fact key for other clients), unlisted prices or links; stores the draft and its hash.",
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
      pages: z.array(z.object({ url: z.url(), title: Untrusted, content: Untrusted })),
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
  get_client_profile: {
    agents: [...CLIENT_ROLES],
    policy: "allow",
    description:
      "The client your crew works for: its name, domain, status, and the confirmed target customer, offer, prices and links. Read it before any client-facing work.",
    input: z.object({}),
    output: z.object({
      clientId: Id,
      slug: z.string(),
      name: z.string(),
      domain: z.string(),
      status: ClientStatus,
      confirmed: z.boolean(),
      profile: z.record(z.string(), z.unknown()),
    }),
  },
  save_client_profile: {
    agents: ["researcher"],
    policy: "allow",
    description:
      "Saves the draft profile for your client (target customer, offer, prices, sender, sources), drafted from the client's own site. The owner confirms it before any outreach.",
    input: z.object({ profile: ClientProfile }),
    output: z.object({ status: ClientStatus }),
  },
  list_clients: {
    agents: ["ceo"],
    policy: "allow",
    description:
      "Every client of the agency: status, profile and email setup, and the six agents on its crew.",
    input: z.object({}),
    output: z.object({
      clients: z.array(
        z.object({
          clientId: Id,
          slug: z.string(),
          name: z.string(),
          domain: z.string(),
          status: ClientStatus,
          profileConfirmed: z.boolean(),
          dnsStatus: z.string(),
          crew: z.array(CrewMember),
        }),
      ),
    }),
  },
  client_report: {
    agents: ["ceo"],
    policy: "allow",
    description:
      "One client over the last N days: pipeline by stage, sent, replies and wins, approvals waiting, and per agent its sessions, failures, last run and spend.",
    input: z.object({ clientId: Id, days: Limit(30, 7) }),
    output: z.object({
      clientId: Id,
      slug: z.string(),
      stages: z.record(ProspectStage, z.number().int().nonnegative()),
      sent: z.number().int().nonnegative(),
      replies: z.number().int().nonnegative(),
      won: z.number().int().nonnegative(),
      approvalsWaiting: z.number().int().nonnegative(),
      oldestApprovalHours: z.number().nonnegative().nullable(),
      agents: z.array(
        CrewMember.extend({
          sessions: z.number().int().nonnegative(),
          failed: z.number().int().nonnegative(),
          lastSessionAt: IsoDateTime.nullable(),
          spendUsd: z.number().nonnegative(),
        }),
      ),
    }),
  },
  agency_status: {
    agents: ["ceo"],
    policy: "allow",
    description:
      "The whole agency at a glance: clients by status, totals for the last 7 days, and the clients that need attention and why.",
    input: z.object({}),
    output: z.object({
      clients: z.record(ClientStatus, z.number().int().nonnegative()),
      totals: z.object({
        sent: z.number().int().nonnegative(),
        replies: z.number().int().nonnegative(),
        won: z.number().int().nonnegative(),
        approvalsWaiting: z.number().int().nonnegative(),
        spendUsd: z.number().nonnegative(),
      }),
      attention: z.array(z.object({ clientId: Id, slug: z.string(), reason: z.string() })),
    }),
  },
  kick_client: {
    agents: ["ceo"],
    policy: "allow",
    description:
      "Starts an active client's orchestrator for today's run, once per client per day. Refuses a client that isn't active or whose profile isn't confirmed.",
    input: z.object({ clientId: Id }),
    output: z.object({ enqueued: z.boolean(), reason: z.string().nullable() }),
  },
  save_brief: {
    agents: ["ceo"],
    policy: "allow",
    description:
      "Saves today's brief for the owner: what each client's crew did and what needs a person. Our code emails it to the team once a day.",
    input: z.object({ summary: z.string().min(1).max(4000) }),
    output: z.object({ saved: z.literal(true) }),
  },
  ping: {
    agents: [...AGENTS],
    policy: "allow",
    description: "Health check.",
    input: z.object({}),
    output: z.object({ ok: z.literal(true), agent: AgentName, ts: IsoDateTime }),
  },
  client_insights: {
    agents: ["ceo"],
    policy: "allow",
    description:
      "What is working for one client over the last 30 days: sent, replies, interest, wins, unsubscribes and bounces; reply and interest rates by ICP keyword, fit signal and buyer role; the approval reject rate with the last rejection reasons; and the subject lines that got replies. Read-only.",
    input: z.object({ clientId: Id }),
    output: z.object({
      clientId: Id,
      slug: z.string(),
      since: IsoDateTime,
      sent: z.number().int().nonnegative(),
      contacted: z.number().int().nonnegative(),
      replies: z.number().int().nonnegative(),
      interested: z.number().int().nonnegative(),
      replyRate: z.number().min(0).max(1),
      interestRate: z.number().min(0).max(1),
      wins: z.number().int().nonnegative(),
      unsubscribes: z.number().int().nonnegative(),
      bounces: z.number().int().nonnegative(),
      byKeyword: z.array(InsightRow),
      bySignal: z.array(InsightRow),
      byBuyerRole: z.array(InsightRow),
      approvals: z.object({
        decided: z.number().int().nonnegative(),
        rejected: z.number().int().nonnegative(),
        rejectRate: z.number().min(0).max(1),
        lastRejectionReasons: z.array(z.string()),
      }),
      repliedSubjects: z.array(z.string()),
      focus: z.object({ dailyDraftLimit: z.number().int(), reason: z.string(), at: IsoDateTime }).nullable(),
      openProposal: z.object({ proposalId: Id, at: IsoDateTime }).nullable(),
    }),
  },
  propose_profile_change: {
    agents: ["ceo"],
    policy: "allow",
    description:
      "Proposes a change to who a client's crew looks for (include and exclude keywords, buyer roles, company sizes), with the numbers behind it. The owner accepts or rejects it on the dashboard. Never prices, the offer, the sender or links. One per client per 7 days.",
    input: z.object({
      clientId: Id,
      changes: ProfileChanges,
      /** The numbers from outrun.client_insights that support it. */
      evidence: z
        .string()
        .min(1)
        .max(1000)
        .refine((s) => /\d/.test(s), "evidence needs numbers from outrun.client_insights"),
    }),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), proposalId: Id }),
      z.object({ ok: z.literal(false), reason: z.string() }),
    ]),
  },
  set_client_focus: {
    agents: ["ceo"],
    policy: "allow",
    description:
      "Sets how many first emails a client's crew drafts per day (2 to 25), to move effort toward clients that get replies. Still capped by the client's send cap. Moves no money and changes no price.",
    input: z.object({
      clientId: Id,
      /** CLIENT_FOCUS_MIN..CLIENT_FOCUS_MAX in constants.ts. */
      dailyDraftLimit: z.number().int().min(2).max(25),
      reason: z.string().min(1).max(300),
    }),
    output: z.object({ dailyDraftLimit: z.number().int(), previous: z.number().int().nullable() }),
  },
  find_signals: {
    agents: ["signal_scout"],
    policy: "allow",
    description:
      "One Monid news search (5 results) for a prospect's company: candidate funding, hiring, launch and news items, wrapped as untrusted. Saves nothing.",
    input: z.object({ prospectId: Id }),
    output: z.object({
      prospectId: Id,
      company: z.object({ domain: Domain, name: z.string() }),
      items: z.array(
        z.object({ title: Untrusted, summary: Untrusted, url: z.url(), date: DateOnly.nullable() }),
      ),
    }),
  },
  save_signal: {
    agents: ["signal_scout"],
    policy: "allow",
    description:
      "Saves one sourced signal on a prospect as the fact signal:<kind>, so the sdr can open with it and cite it. Fresh signals put the prospect first in today's plan.",
    input: z.object({
      prospectId: Id,
      kind: SignalKind,
      summary: z.string().min(1).max(280),
      sourceUrl: z.url(),
      date: DateOnly,
    }),
    output: z.object({ factKey: z.string(), fresh: z.boolean() }),
  },
  start_experiment: {
    agents: ["experimenter"],
    policy: "allow",
    description:
      "Starts an A/B test of two email angles for your client; the sdr alternates them by prospect. One active experiment per client. Angles never change prices, links or the call to action.",
    input: z.object({
      hypothesis: z.string().min(1).max(300),
      variants: z.tuple([
        z.object({ key: z.literal("A"), angle: z.string().min(1).max(300) }),
        z.object({ key: z.literal("B"), angle: z.string().min(1).max(300) }),
      ]),
    }),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), experimentId: Id }),
      z.object({ ok: z.literal(false), reason: z.string() }),
    ]),
  },
  experiment_results: {
    agents: ["experimenter"],
    policy: "allow",
    description:
      "The active experiment (or the last one) per variant: first emails sent, prospects that replied, interested, and the reply rate. Read-only.",
    input: z.object({}),
    output: z.object({
      experiment: z
        .object({
          experimentId: Id,
          hypothesis: z.string(),
          startedAt: IsoDateTime,
          active: z.boolean(),
          variants: z.array(VariantResult),
        })
        .nullable(),
    }),
  },
  end_experiment: {
    agents: ["experimenter"],
    policy: "allow",
    description:
      "Ends the active experiment with its winner (or none) and the lesson, which goes to the CEO's playbook with the numbers behind it.",
    input: z.object({ winner: z.enum(["A", "B", "none"]), lesson: z.string().min(1).max(300) }),
    output: z.object({
      experimentId: Id,
      winner: z.enum(["A", "B", "none"]),
      variants: z.array(VariantResult),
    }),
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

/** Tools only Outrun's own crew gets: they sell Outrun's products through Outrun's Stripe. */
export const OUTRUN_ONLY_TOOLS: readonly CrewToolName[] = ["create_checkout_link"];

/** A crew member's tools: its role's, less Outrun-only ones on another client's crew. */
export function toolsForMember(agent: AgentName, isOutrun: boolean): CrewToolName[] {
  return toolsForAgent(agent).filter((t) => isOutrun || !OUTRUN_ONLY_TOOLS.includes(t));
}

/** Name as Naive sees it: `outrun.send_email`. */
export const qualified = (tool: CrewToolName): string => `${MCP_SERVER_NAME}.${tool}`;

export function toolsForAgent(agent: AgentName): CrewToolName[] {
  return CREW_TOOL_NAMES.filter((t) => (CREW_TOOLS[t].agents as readonly AgentName[]).includes(agent));
}

/**
 * Naive built-in tools each agent gets; everything else is denied. `read_skill` loads the agent's
 * playbook. No team tools: Naive lists multiagent teams as coming soon, so the orchestrator plans
 * with outrun.plan_day instead.
 */
export const BUILTIN_TOOLS: Record<AgentName, readonly string[]> = {
  orchestrator: ["read_skill"],
  prospector: ["read_skill"],
  researcher: ["read_skill", "web_search", "web_fetch"],
  sdr: ["read_skill"],
  closer: ["read_skill"],
  auditor: ["read_skill", "web_search", "web_fetch"],
  account_manager: ["read_skill"],
  signal_scout: ["read_skill", "web_search", "web_fetch"],
  experimenter: ["read_skill"],
  ceo: ["read_skill"],
};
