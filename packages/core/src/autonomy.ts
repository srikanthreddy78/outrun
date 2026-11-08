/**
 * The autonomy scoreboard: how much of the company ran without a person, read from the events
 * ledger alone. Who acted (agent, system, human), what got delivered, the decisions agents made
 * and where a human stepped in. `redact` makes it safe for the public /ops page.
 */
import { and, eq, gt, gte, inArray, lte, or } from "drizzle-orm";
import { OUTRUN_CLIENT_ID } from "./constants";
import type { Db } from "./db/client";
import { agentSessions, clients, companies, events, messages, prospects } from "./db/schema";

export type ActorClass = "agent" | "system" | "human";
export const ACTOR_CLASSES = ["agent", "system", "human"] as const;

/** `naive:*` is a crew agent; `user:*` and `client:*` are people; code and providers are system. */
export function classifyActor(actor: string): ActorClass {
  if (actor.startsWith("naive:")) return "agent";
  if (actor.startsWith("user:") || actor.startsWith("client:")) return "human";
  return "system";
}

/**
 * The actions the autonomy % counts: business work and decisions, by anyone. Plumbing
 * (llm.call, llm.cost, job.done, tool.called, webhook.received, session.idle, crm.*, ...) is
 * left out, and so are approval.approved/rejected, which only echo a person's approval.submitted.
 */
export const COUNTED_TYPES = [
  // prospecting and research
  "candidate.discovered",
  "prospect.filed",
  "prospect.enriched",
  "prospect.researched",
  "prospect.outcome",
  "scan.completed",
  // outreach and replies
  "draft.checked",
  "draft.rejected",
  "email.sent",
  "triage.classified",
  // orders and delivery
  "order.created",
  "order.paid",
  "order.delivered",
  "order.renewed",
  "public.order_created",
  "agent_to_agent.task",
  "audit.saved",
  "report.delivered",
  "kit.built",
  "kit.completed",
  // clients and the CEO
  "client.added",
  "client.profiling",
  "client.profile_drafted",
  "client.profile_confirmed",
  "client.domain_registered",
  "client.domain_verified",
  "client.paused",
  "client.resumed",
  "ceo.brief",
  "ceo.brief_sent",
  "session.started",
  // people stepping in
  "approval.submitted",
  "email.resumed",
  "job.replayed",
  "portal.link_used",
] as const;
const COUNTED = new Set<string>(COUNTED_TYPES);

/** Read for the feeds but not counted on their own (a CEO kick on a live session). */
const EXTRA_TYPES = ["session.messaged"] as const;

const STEP_IN_TYPES = new Set([
  "approval.submitted",
  "client.added",
  "client.profiling",
  "client.profile_confirmed",
  "client.paused",
  "client.resumed",
  "email.resumed",
  "job.replayed",
  "portal.link_used",
]);

/** Prospect stages after the first email went out; only these prospects' domains are public. */
const CONTACTED_STAGES = new Set([
  "contacted",
  "replied",
  "interested",
  "checkout_sent",
  "won",
  "not_now",
  "lost",
  "unsubscribed",
]);

const FEED_LIMIT = 50;
const ROW_LIMIT = 20_000;

export interface FeedItem {
  id: string;
  at: string;
  /** The event type; a CEO kick is reported as `ceo.kick`. */
  type: string;
  actor: string;
  actorClass: ActorClass;
  client: string | null;
  summary: string;
}

export interface AutonomyReport {
  since: string;
  until: string;
  clientId: string | null;
  redacted: boolean;
  counts: Record<ActorClass, number> & { total: number };
  /** Non-human share of counted actions, 0-100 with one decimal; null with nothing counted. */
  autonomyPct: number | null;
  deliveries: {
    emailsSent: number;
    repliesHandled: number;
    reportsDelivered: number;
    auditsSaved: number;
    clientsOnboarded: number;
    clientsActivated: number;
    prospectsFiled: number;
    prospectsResearched: number;
    ordersCreated: number;
    ordersPaid: number;
  };
  decisions: FeedItem[];
  stepIns: FeedItem[];
  spend: { agentUsd: number; systemUsd: number; humanUsd: number; totalUsd: number };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /[^\s@<>()"',;:]*@[^\s@<>()"',;:]*/g;
const DOMAIN =
  /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|io|ai|dev|co|net|org|app|xyz|tech|us|uk|de|so|sh|gg|me|biz|info|cloud|site)\b/gi;

/** Free text made public: no email addresses, and no domain outside `allowed`. */
export function redactText(text: string, allowed: ReadonlySet<string> = new Set(), max = 280): string {
  const out = text
    .replace(EMAIL, "[email]")
    .replace(DOMAIN, (d) => (allowed.has(d.toLowerCase()) ? d : "[domain]"))
    .replace(/@/g, "");
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const usd = (n: number) => Math.round(n * 1e6) / 1e6;

type Row = typeof events.$inferSelect;

export async function autonomyReport(
  db: Db,
  opts: { since: Date; until?: Date; clientId?: string; redact?: boolean },
): Promise<AutonomyReport> {
  const until = opts.until ?? new Date();
  const redact = opts.redact ?? false;
  const rows: Row[] = await db
    .select()
    .from(events)
    .where(
      and(
        gte(events.ts, opts.since),
        lte(events.ts, until),
        or(inArray(events.type, [...COUNTED_TYPES, ...EXTRA_TYPES]), gt(events.costUsd, "0")),
      ),
    )
    .limit(ROW_LIMIT);

  // Resolve every event to its client, and prospects to their domain and stage.
  const idsOf = (type: string) => [
    ...new Set(rows.filter((r) => r.entityType === type && UUID.test(r.entityId)).map((r) => r.entityId)),
  ];
  const msgIds = idsOf("message");
  const sessionIds = idsOf("agent_session");
  const msgRows = msgIds.length
    ? await db
        .select({ id: messages.id, clientId: messages.clientId, prospectId: messages.prospectId })
        .from(messages)
        .where(inArray(messages.id, msgIds))
    : [];
  const sessionRows = sessionIds.length
    ? await db
        .select({ id: agentSessions.id, clientId: agentSessions.clientId, key: agentSessions.idempotencyKey })
        .from(agentSessions)
        .where(inArray(agentSessions.id, sessionIds))
    : [];
  const prospectIds = [
    ...new Set([...idsOf("prospect"), ...msgRows.flatMap((m) => (m.prospectId ? [m.prospectId] : []))]),
  ];
  const prospectRows = prospectIds.length
    ? await db
        .select({
          id: prospects.id,
          clientId: prospects.clientId,
          stage: prospects.stage,
          reason: prospects.filedReason,
          domain: companies.domain,
        })
        .from(prospects)
        .innerJoin(companies, eq(companies.id, prospects.companyId))
        .where(inArray(prospects.id, prospectIds))
    : [];
  const clientRows = await db
    .select({ id: clients.id, name: clients.name, domain: clients.domain })
    .from(clients);

  const msgById = new Map(msgRows.map((m) => [m.id, m]));
  const sessionById = new Map(sessionRows.map((s) => [s.id, s]));
  const prospectById = new Map(prospectRows.map((p) => [p.id, p]));
  const clientById = new Map(clientRows.map((c) => [c.id, c]));
  const allowedDomains = new Set<string>([
    ...clientRows.map((c) => c.domain.toLowerCase()),
    ...prospectRows.filter((p) => CONTACTED_STAGES.has(p.stage)).map((p) => p.domain.toLowerCase()),
  ]);

  const entityOf = (payload: Record<string, unknown>) =>
    (payload.entity ?? null) as { type?: string; id?: string } | null;
  const clientOf = (r: Row): string | null => {
    switch (r.entityType) {
      case "client":
        return r.entityId;
      case "message":
        return msgById.get(r.entityId)?.clientId ?? null;
      case "prospect":
        return prospectById.get(r.entityId)?.clientId ?? null;
      case "agent_session":
        return sessionById.get(r.entityId)?.clientId ?? null;
      case "order":
      case "report":
        return OUTRUN_CLIENT_ID;
      default:
        if (r.entityId.startsWith("a2a:")) return OUTRUN_CLIENT_ID;
        return null;
    }
  };
  const scoped = opts.clientId ? rows.filter((r) => clientOf(r) === opts.clientId) : rows;

  const isKick = (r: Row) => {
    if (r.type === "session.started") return sessionById.get(r.entityId)?.key.startsWith("ceo:") === true;
    if (r.type === "session.messaged") return str(r.payload.idempotencyKey)?.startsWith("ceo:") === true;
    return false;
  };

  // Counts and spend.
  const counts = { agent: 0, system: 0, human: 0, total: 0 };
  const spend = { agentUsd: 0, systemUsd: 0, humanUsd: 0, totalUsd: 0 };
  for (const r of scoped) {
    const cls = classifyActor(r.actor);
    const cost = Number(r.costUsd);
    spend[`${cls}Usd`] += cost;
    spend.totalUsd += cost;
    if (!COUNTED.has(r.type)) continue;
    counts[cls] += 1;
    counts.total += 1;
  }
  // Naive's session spend is kept on the session, not on its events.
  const sessionSpend = await db
    .select({ clientId: agentSessions.clientId, spend: agentSessions.spendUsd })
    .from(agentSessions)
    .where(and(gte(agentSessions.createdAt, opts.since), lte(agentSessions.createdAt, until)));
  for (const s of sessionSpend) {
    if (opts.clientId && s.clientId !== opts.clientId) continue;
    spend.agentUsd += Number(s.spend);
    spend.totalUsd += Number(s.spend);
  }

  const countOf = (type: string) => scoped.filter((r) => r.type === type).length;
  const distinctOf = (type: string) =>
    new Set(scoped.filter((r) => r.type === type).map((r) => r.entityId)).size;
  const deliveries = {
    emailsSent: countOf("email.sent"),
    repliesHandled: countOf("triage.classified"),
    reportsDelivered: countOf("report.delivered"),
    auditsSaved: countOf("audit.saved"),
    clientsOnboarded: distinctOf("client.profile_confirmed"),
    clientsActivated: distinctOf("client.domain_verified"),
    prospectsFiled: countOf("prospect.filed"),
    prospectsResearched: countOf("prospect.researched"),
    ordersCreated: countOf("order.created"),
    ordersPaid: countOf("order.paid"),
  };

  // Labels.
  const text = (s: string, max?: number) => (redact ? redactText(s, allowedDomains, max) : s);
  const actorLabel = (actor: string) => {
    if (!redact) return actor;
    if (actor.startsWith("user:")) return "owner";
    if (actor.startsWith("client:")) return "client approver";
    return actor;
  };
  const clientName = (r: Row) => {
    const id = clientOf(r) ?? (entityOf(r.payload)?.type === "client" ? entityOf(r.payload)?.id : null);
    return id ? (clientById.get(id)?.name ?? null) : null;
  };
  const prospectDomain = (prospectId: string | null | undefined) => {
    const p = prospectId ? prospectById.get(prospectId) : undefined;
    if (!p) return "a prospect";
    return !redact || CONTACTED_STAGES.has(p.stage) ? p.domain : "a prospect";
  };
  const item = (r: Row, summary: string, type = r.type): FeedItem => ({
    id: r.id,
    at: r.ts.toISOString(),
    type,
    actor: actorLabel(r.actor),
    actorClass: classifyActor(r.actor),
    client: clientName(r),
    summary: text(summary),
  });

  const newest = [...scoped].sort((a, b) => b.ts.getTime() - a.ts.getTime());

  const decisions: FeedItem[] = [];
  for (const r of newest) {
    if (decisions.length >= FEED_LIMIT) break;
    const p = r.payload;
    switch (r.type) {
      case "prospect.filed": {
        const domain = redact ? prospectDomain(r.entityId) : (str(p.domain) ?? prospectDomain(r.entityId));
        const why = prospectById.get(r.entityId)?.reason;
        decisions.push(
          item(
            r,
            `Filed ${domain} as a prospect from ${str(p.source) ?? "research"}${why ? `: ${why}` : ""}`,
          ),
        );
        break;
      }
      case "triage.classified": {
        const m = msgById.get(r.entityId);
        decisions.push(
          item(r, `Read a reply from ${prospectDomain(m?.prospectId)} and labeled it ${str(p.label) ?? "?"}`),
        );
        break;
      }
      case "draft.rejected": {
        const reasons = Array.isArray(p.reasons) ? p.reasons.map(String).join("; ") : "";
        decisions.push(
          item(
            r,
            `Caught its own ${str(p.kind) === "followup" ? "follow-up" : str(p.kind) === "reply" ? "reply" : "first email"} to ${prospectDomain(r.entityId)} before sending: ${reasons || "failed the checks"}`,
          ),
        );
        break;
      }
      case "ceo.brief":
        decisions.push(item(r, `CEO brief: ${str(p.summary) ?? ""}`));
        break;
      case "prospect.outcome": {
        const note = !redact && str(p.note) ? ` (${str(p.note)})` : "";
        decisions.push(
          item(
            r,
            `Marked ${prospectDomain(r.entityId)} as ${(str(p.outcome) ?? "?").replace("_", " ")}${note}`,
          ),
        );
        break;
      }
      case "agent_to_agent.task":
        decisions.push(item(r, `Handled a task from another agent (${str(p.skill) ?? "general"})`));
        break;
      case "public.order_created":
        decisions.push(
          item(r, `Took an order from an outside agent over ${str(p.protocol) ?? "the public API"}`),
        );
        break;
      case "session.started":
      case "session.messaged":
        if (isKick(r)) {
          const e = entityOf(p);
          const name = e?.id ? (clientById.get(e.id)?.name ?? "a client") : "a client";
          decisions.push(
            item(r, `CEO started ${name}'s day: the orchestrator plans and runs it`, "ceo.kick"),
          );
        }
        break;
    }
  }

  const stepIns: FeedItem[] = [];
  for (const r of newest) {
    if (stepIns.length >= FEED_LIMIT) break;
    if (!STEP_IN_TYPES.has(r.type) || classifyActor(r.actor) !== "human") continue;
    const p = r.payload;
    const name = clientName(r) ?? "a client";
    switch (r.type) {
      case "approval.submitted": {
        const m = msgById.get(r.entityId);
        const verb = p.decision === "deny" ? "Rejected" : "Approved";
        const reason = str(p.reason) ? `: ${str(p.reason)}` : "";
        stepIns.push(item(r, `${verb} an email to ${prospectDomain(m?.prospectId)}${reason}`));
        break;
      }
      case "client.added":
        stepIns.push(item(r, `Added ${name} as a client`));
        break;
      case "client.profiling":
        stepIns.push(item(r, `Started profiling ${name}`));
        break;
      case "client.profile_confirmed":
        stepIns.push(item(r, `Confirmed ${name}'s target customer and offer`));
        break;
      case "client.paused":
        stepIns.push(item(r, `Paused ${name}`));
        break;
      case "client.resumed":
        stepIns.push(item(r, `Resumed ${name}`));
        break;
      case "email.resumed":
        stepIns.push(item(r, "Resumed sending email"));
        break;
      case "job.replayed":
        stepIns.push(item(r, `Replayed a failed ${str(p.type) ?? ""} job`.replace("  ", " ")));
        break;
      case "portal.link_used":
        stepIns.push(item(r, "Signed in to the client portal"));
        break;
    }
  }

  const nonHuman = counts.agent + counts.system;
  const report: AutonomyReport = {
    since: opts.since.toISOString(),
    until: until.toISOString(),
    clientId: opts.clientId ?? null,
    redacted: redact,
    counts,
    autonomyPct: counts.total ? Math.round((nonHuman / counts.total) * 1000) / 10 : null,
    deliveries,
    decisions,
    stepIns,
    spend: {
      agentUsd: usd(spend.agentUsd),
      systemUsd: usd(spend.systemUsd),
      humanUsd: usd(spend.humanUsd),
      totalUsd: usd(spend.totalUsd),
    },
  };
  return redact ? stripAt(report) : report;
}

/** Last line of defense for the public page: no string in the output carries an "@". */
function stripAt<T>(v: T): T {
  if (typeof v === "string") return v.replace(EMAIL, "[email]").replace(/@/g, "") as T;
  if (Array.isArray(v)) return v.map(stripAt) as T;
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripAt(x)])) as T;
  return v;
}
