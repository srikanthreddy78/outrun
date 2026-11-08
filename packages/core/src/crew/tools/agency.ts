/**
 * The agency's own tools. Every client role reads its client with get_client_profile; the CEO,
 * the one agent above every crew, tracks all clients and their agents, starts each client's
 * day, and leaves the owner a brief. None of them send outreach, approve, set prices or move money.
 */
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gte, max, min, sql, sum } from "drizzle-orm";
import { CLIENT_ROLES, PROSPECT_STAGES, type ProspectStage } from "../../../contracts";
import { CRON_TZ, OUTRUN_CLIENT_ID, STUCK_APPROVAL_HOURS } from "../../constants";
import type { Db } from "../../db/client";
import { agentSessions, clients, events, messages, prospects } from "../../db/schema";
import { AppError } from "../../errors";
import { saveDraftProfile } from "../../clients";
import { dayIn } from "../../time";
import { naiveAgentName } from "../identity";
import { defineTool } from "../registry";

const HOUR = 3_600_000;
const STATUSES = ["draft", "profiling", "awaiting_confirmation", "email_setup", "active", "paused"] as const;

const crewOf = (slug: string) =>
  CLIENT_ROLES.map((role) => ({ role, naiveAgent: naiveAgentName(role, slug) }));

async function clientById(db: Db, clientId: string) {
  const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!c) throw new AppError("not_found", `client ${clientId}`);
  return c;
}

export const getClientProfile = defineTool({
  name: "get_client_profile",
  handler: async (_input, ctx) => {
    const c = await clientById(ctx.db, ctx.clientId);
    return {
      clientId: c.id,
      slug: c.slug,
      name: c.name,
      domain: c.domain,
      status: c.status,
      confirmed: c.profileConfirmedAt !== null,
      profile: c.profile,
    };
  },
});

export const saveClientProfile = defineTool({
  name: "save_client_profile",
  handler: async ({ profile }, ctx) =>
    saveDraftProfile({ db: ctx.db, emit: ctx.emit }, ctx.clientId, profile, `naive:${ctx.agent}`),
});

export const listClients = defineTool({
  name: "list_clients",
  handler: async (_input, ctx) => {
    const rows = await ctx.db.select().from(clients).orderBy(clients.createdAt);
    return {
      clients: rows.map((c) => ({
        clientId: c.id,
        slug: c.slug,
        name: c.name,
        domain: c.domain,
        status: c.status,
        profileConfirmed: c.profileConfirmedAt !== null,
        dnsStatus: c.dnsStatus,
        crew: crewOf(c.slug),
      })),
    };
  },
});

/** One client's numbers since `since`; shared by client_report, agency_status and the dashboard. */
export async function clientNumbers(db: Db, clientId: string, since: Date, now: Date) {
  const stageRows = await db
    .select({ stage: prospects.stage, n: count() })
    .from(prospects)
    .where(eq(prospects.clientId, clientId))
    .groupBy(prospects.stage);
  const stages = Object.fromEntries(PROSPECT_STAGES.map((s) => [s, 0])) as Record<ProspectStage, number>;
  for (const r of stageRows) stages[r.stage] = Number(r.n);
  const [sent] = await db
    .select({ n: count() })
    .from(messages)
    .where(
      and(
        eq(messages.clientId, clientId),
        eq(messages.direction, "outbound"),
        eq(messages.status, "sent"),
        gte(messages.sentAt, since),
      ),
    );
  const [replies] = await db
    .select({ n: count() })
    .from(messages)
    .where(
      and(eq(messages.clientId, clientId), eq(messages.direction, "inbound"), gte(messages.createdAt, since)),
    );
  const [waiting] = await db
    .select({ n: count(), oldest: min(messages.updatedAt) })
    .from(messages)
    .where(and(eq(messages.clientId, clientId), eq(messages.status, "awaiting_approval")));
  const perRole = await db
    .select({
      agent: agentSessions.agent,
      sessions: count(),
      failed: sql<number>`count(*) filter (where ${agentSessions.status} = 'error')`,
      last: max(agentSessions.createdAt),
      spend: sum(agentSessions.spendUsd),
    })
    .from(agentSessions)
    .where(and(eq(agentSessions.clientId, clientId), gte(agentSessions.createdAt, since)))
    .groupBy(agentSessions.agent);
  const oldest = waiting?.oldest ? new Date(waiting.oldest) : null;
  return {
    stages,
    sent: Number(sent?.n ?? 0),
    replies: Number(replies?.n ?? 0),
    won: stages.won,
    approvalsWaiting: Number(waiting?.n ?? 0),
    oldestApprovalHours: oldest
      ? Math.max(0, Math.round(((now.getTime() - oldest.getTime()) / HOUR) * 10) / 10)
      : null,
    perRole,
  };
}

export const clientReport = defineTool({
  name: "client_report",
  handler: async ({ clientId, days }, ctx) => {
    const c = await clientById(ctx.db, clientId);
    const now = ctx.now();
    const n = await clientNumbers(ctx.db, c.id, new Date(now.getTime() - days * 24 * HOUR), now);
    const byRole = new Map(n.perRole.map((r) => [r.agent, r]));
    return {
      clientId: c.id,
      slug: c.slug,
      stages: n.stages,
      sent: n.sent,
      replies: n.replies,
      won: n.won,
      approvalsWaiting: n.approvalsWaiting,
      oldestApprovalHours: n.oldestApprovalHours,
      agents: crewOf(c.slug).map((m) => {
        const r = byRole.get(m.role);
        return {
          ...m,
          sessions: Number(r?.sessions ?? 0),
          failed: Number(r?.failed ?? 0),
          lastSessionAt: r?.last ? new Date(r.last).toISOString() : null,
          spendUsd: Number(r?.spend ?? 0),
        };
      }),
    };
  },
});

/** Why a client needs a person or the CEO's attention, or nothing. */
export function attentionReasons(
  c: { status: string; dnsStatus: string; profileConfirmedAt: Date | null },
  n: { approvalsWaiting: number; oldestApprovalHours: number | null; perRole: { failed: number | string }[] },
): string[] {
  const out: string[] = [];
  if (c.status === "awaiting_confirmation")
    out.push("its target customer and offer wait for the owner to confirm");
  if (c.status === "email_setup" && c.dnsStatus !== "verified")
    out.push("its sending domain isn't verified yet");
  if (c.status === "paused") out.push("it is paused");
  if (n.oldestApprovalHours !== null && n.oldestApprovalHours >= STUCK_APPROVAL_HOURS)
    out.push(
      `${n.approvalsWaiting} draft(s) waiting for the client's approval for ${n.oldestApprovalHours}h`,
    );
  const failed = n.perRole.reduce((s, r) => s + Number(r.failed), 0);
  if (failed > 0) out.push(`${failed} agent session(s) failed this week`);
  return out;
}

export const agencyStatus = defineTool({
  name: "agency_status",
  handler: async (_input, ctx) => {
    const now = ctx.now();
    const since = new Date(now.getTime() - 7 * 24 * HOUR);
    const rows = await ctx.db.select().from(clients).orderBy(clients.createdAt);
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<
      (typeof STATUSES)[number],
      number
    >;
    const totals = { sent: 0, replies: 0, won: 0, approvalsWaiting: 0, spendUsd: 0 };
    const attention: { clientId: string; slug: string; reason: string }[] = [];
    for (const c of rows) {
      byStatus[c.status] += 1;
      const n = await clientNumbers(ctx.db, c.id, since, now);
      totals.sent += n.sent;
      totals.replies += n.replies;
      totals.won += n.won;
      totals.approvalsWaiting += n.approvalsWaiting;
      totals.spendUsd += n.perRole.reduce((s, r) => s + Number(r.spend ?? 0), 0);
      for (const reason of attentionReasons(c, n)) attention.push({ clientId: c.id, slug: c.slug, reason });
    }
    totals.spendUsd = Math.round(totals.spendUsd * 1e6) / 1e6;
    return { clients: byStatus, totals, attention };
  },
});

export const kickClient = defineTool({
  name: "kick_client",
  handler: async ({ clientId }, ctx) => {
    const c = await clientById(ctx.db, clientId);
    if (c.id === OUTRUN_CLIENT_ID)
      return { enqueued: false, reason: "Outrun's orchestrator runs on its own schedule" };
    if (c.status !== "active" || !c.profileConfirmedAt)
      return {
        enqueued: false,
        reason: `the client is ${c.status}${c.profileConfirmedAt ? "" : ", profile not confirmed"}`,
      };
    const day = dayIn(CRON_TZ, ctx.now());
    const { jobId } = await ctx.enqueue({
      type: "start_session",
      payload: {
        agent: "orchestrator",
        clientId: c.id,
        entity: { type: "client", id: c.id },
        message:
          "Daily run for your client. Call outrun.pipeline_status, then outrun.plan_day once, summarize what it enqueued, and stop.",
      },
      idempotencyKey: `ceo:${day}:${c.id}`,
      traceId: ctx.requestId,
    });
    return { enqueued: jobId !== null, reason: jobId === null ? "already started today" : null };
  },
});

export const saveBrief = defineTool({
  name: "save_brief",
  handler: async ({ summary }, ctx) => {
    const day = dayIn(CRON_TZ, ctx.now());
    await ctx.emit({
      actor: `naive:${ctx.agent}`,
      type: "ceo.brief",
      entityType: "system",
      entityId: `ceo:brief:${day}`,
      payload: { day, summary },
    });
    await ctx.enqueue({
      type: "send_ceo_brief",
      payload: { day },
      idempotencyKey: `ceo:brief:${day}`,
      traceId: randomUUID(),
    });
    return { saved: true as const };
  },
});

/** The latest brief, for the dashboard and the email job. */
export async function latestBrief(db: Db, day?: string) {
  const [e] = await db
    .select({ payload: events.payload, ts: events.ts })
    .from(events)
    .where(and(eq(events.type, "ceo.brief"), day ? eq(events.entityId, `ceo:brief:${day}`) : undefined))
    .orderBy(desc(events.ts))
    .limit(1);
  return e ? { ...(e.payload as { day: string; summary: string }), at: e.ts } : null;
}

export const agencyTools = [
  getClientProfile,
  saveClientProfile,
  listClients,
  clientReport,
  agencyStatus,
  kickClient,
  saveBrief,
];

/** /dashboard/agency: every client, its six agents with what each did this week, and the brief. */
export async function agencyOverview(db: Db, now: Date) {
  const since = new Date(now.getTime() - 7 * 24 * HOUR);
  const rows = await db.select().from(clients).orderBy(clients.createdAt);
  const out = [];
  for (const c of rows) {
    const n = await clientNumbers(db, c.id, since, now);
    const byRole = new Map(n.perRole.map((r) => [r.agent, r]));
    out.push({
      clientId: c.id,
      slug: c.slug,
      name: c.name,
      domain: c.domain,
      status: c.status,
      profileConfirmed: c.profileConfirmedAt !== null,
      dnsStatus: c.dnsStatus,
      sent: n.sent,
      replies: n.replies,
      won: n.won,
      approvalsWaiting: n.approvalsWaiting,
      attention: attentionReasons(c, n),
      crew: crewOf(c.slug).map((m) => {
        const r = byRole.get(m.role);
        return {
          ...m,
          sessions: Number(r?.sessions ?? 0),
          failed: Number(r?.failed ?? 0),
          lastSessionAt: r?.last ? new Date(r.last).toISOString() : null,
          spendUsd: Number(r?.spend ?? 0),
        };
      }),
    });
  }
  return { clients: out, brief: await latestBrief(db) };
}
