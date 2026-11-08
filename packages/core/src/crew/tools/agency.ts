/**
 * The agency's own tools. Every client role reads its client with get_client_profile; the CEO,
 * the one agent above every crew, tracks all clients and their agents, starts each client's
 * day, and leaves the owner a brief. None of them send outreach, approve, set prices or move money.
 */
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gte, max, min, sql, sum } from "drizzle-orm";
import {
  OPTIONAL_CLIENT_ROLES,
  PROSPECT_STAGES,
  staffedRoles,
  type OptionalClientRole,
  type ProspectStage,
} from "../../../contracts";
import { openQuestionCount } from "../../accountManager";
import { CLIENT_FOCUS_MIN, CRON_TZ, OUTRUN_CLIENT_ID, STUCK_APPROVAL_HOURS } from "../../constants";
import type { Db } from "../../db/client";
import { agentSessions, clients, events, messages, prospects } from "../../db/schema";
import { AppError } from "../../errors";
import { saveDraftProfile } from "../../clients";
import {
  listProblems,
  makePrediction,
  pauseClient,
  readPlaybook,
  recordLesson,
  resumeClient,
  saveBoardMemo,
  trackRecord,
} from "../../brain";
import { replayDeadJob } from "../../replay";
import {
  clientInsights,
  goalProgress,
  insightsSince,
  proposeProfileChange,
  setClientFocus,
} from "../../insights";
import { dayIn } from "../../time";
import { naiveAgentName } from "../identity";
import { defineTool } from "../registry";

const HOUR = 3_600_000;
const STATUSES = ["draft", "profiling", "awaiting_confirmation", "email_setup", "active", "paused"] as const;

/** A client's crew: the six core roles plus any the CEO staffed. */
const crewOf = (slug: string, roles?: readonly string[] | null) =>
  staffedRoles(roles).map((role) => ({ role, naiveAgent: naiveAgentName(role, slug) }));

export async function clientById(db: Db, clientId: string) {
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
        crew: crewOf(c.slug, c.crewRoles),
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
  const openQuestions = clientId === OUTRUN_CLIENT_ID ? 0 : await openQuestionCount(db, clientId);
  return {
    openQuestions,
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
      agents: crewOf(c.slug, c.crewRoles).map((m) => {
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
  c: { status: string; dnsStatus: string; profileConfirmedAt: Date | null; crewRoles?: string[] | null },
  n: {
    approvalsWaiting: number;
    oldestApprovalHours: number | null;
    perRole: { failed: number | string }[];
    openQuestions?: number;
  },
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
  if (n.openQuestions)
    out.push(
      staffedRoles(c.crewRoles).includes("account_manager")
        ? `${n.openQuestions} client question(s) wait for its account manager`
        : `${n.openQuestions} client question(s) wait and it has no account manager; staff one with outrun.staff_client`,
    );
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

/** client_insights: what is working for one client, from the ledger. Read-only. */
export const clientInsightsTool = defineTool({
  name: "client_insights",
  handler: async ({ clientId }, ctx) => {
    const c = await clientById(ctx.db, clientId);
    return clientInsights(ctx.db, c.id, { since: insightsSince(ctx.now()) });
  },
});

/** propose_profile_change: an ICP change for the owner to accept or reject on the dashboard. */
export const proposeProfileChangeTool = defineTool({
  name: "propose_profile_change",
  handler: async ({ clientId, changes, evidence }, ctx) =>
    proposeProfileChange(
      { db: ctx.db, emit: ctx.emit, now: ctx.now },
      { clientId, changes, evidence },
      `naive:${ctx.agent}`,
    ),
});

/** set_client_focus: how many first emails a client's crew drafts a day; plan_day reads it. */
export const setClientFocusTool = defineTool({
  name: "set_client_focus",
  handler: async (input, ctx) => {
    const c = await clientById(ctx.db, input.clientId);
    if (c.id === OUTRUN_CLIENT_ID) throw new AppError("bad_request", "Outrun's own crew plans its own day");
    return setClientFocus({ db: ctx.db, emit: ctx.emit }, input, `naive:${ctx.agent}`);
  },
});

/** record_lesson: a lesson with numbers, for one client or the whole agency. */
export const recordLessonTool = defineTool({
  name: "record_lesson",
  handler: async (input, ctx) => recordLesson({ db: ctx.db, emit: ctx.emit }, input, `naive:${ctx.agent}`),
});

/** read_playbook: this client's lessons, the agency's, similar clients' and experiments. */
export const readPlaybookTool = defineTool({
  name: "read_playbook",
  handler: async ({ clientId }, ctx) => readPlaybook(ctx.db, clientId),
});

/** make_prediction: what a decision should do, scored by score_predictions when due. */
export const makePredictionTool = defineTool({
  name: "make_prediction",
  handler: async (input, ctx) =>
    makePrediction({ db: ctx.db, emit: ctx.emit, now: ctx.now }, input, `naive:${ctx.agent}`),
});

export const ceoTrackRecordTool = defineTool({
  name: "ceo_track_record",
  handler: async (_input, ctx) => trackRecord(ctx.db),
});

/** list_problems: brain.listProblems plus the clients attentionReasons flags. */
export const listProblemsTool = defineTool({
  name: "list_problems",
  handler: async (_input, ctx) => {
    const now = ctx.now();
    const since = new Date(now.getTime() - 7 * 24 * HOUR);
    const problems = await listProblems({ db: ctx.db, now: ctx.now });
    const attention: { clientId: string; slug: string; reason: string }[] = [];
    for (const c of await ctx.db.select().from(clients).orderBy(clients.createdAt)) {
      const n = await clientNumbers(ctx.db, c.id, since, now);
      for (const reason of attentionReasons(c, n)) attention.push({ clientId: c.id, slug: c.slug, reason });
    }
    return { ...problems, attention };
  },
});

/** replay_job: the dashboard's replay, for the CEO. */
export const replayJobTool = defineTool({
  name: "replay_job",
  handler: async ({ jobId }, ctx) =>
    replayDeadJob(
      { db: ctx.db, emit: ctx.emit, enqueue: (job) => ctx.enqueue(job) },
      { jobId },
      `naive:${ctx.agent}`,
    ),
});

export const pauseClientTool = defineTool({
  name: "pause_client",
  handler: async (input, ctx) => pauseClient({ db: ctx.db, emit: ctx.emit }, input, `naive:${ctx.agent}`),
});

/** resume_client: only a pause the CEO made itself. */
export const resumeClientTool = defineTool({
  name: "resume_client",
  handler: async (input, ctx) => resumeClient({ db: ctx.db, emit: ctx.emit }, input, `naive:${ctx.agent}`),
});

/** save_board_memo: once per ISO week; send_ceo_brief emails it to the owner. */
export const saveBoardMemoTool = defineTool({
  name: "save_board_memo",
  handler: async (input, ctx) =>
    saveBoardMemo(
      { db: ctx.db, emit: ctx.emit, now: ctx.now, enqueue: (job) => ctx.enqueue(job) },
      input,
      `naive:${ctx.agent}`,
    ),
});

/**
 * staff_client: adds optional roles to a client's crew. Unions into clients.crew_roles in SQL, so
 * it never removes one, and enqueues provision_client_crew keyed on the client and its full role
 * list, so the same staffing provisions once.
 */
export const staffClientTool = defineTool({
  name: "staff_client",
  handler: async ({ clientId, add, reason }, ctx) => {
    const c = await clientById(ctx.db, clientId);
    if (c.id === OUTRUN_CLIENT_ID)
      throw new AppError("bad_request", "Outrun's own crew is fixed; staff a client's crew instead");
    const before = staffedRoles(c.crewRoles);
    const want = [...new Set(add)].filter((r): r is OptionalClientRole =>
      (OPTIONAL_CLIENT_ROLES as readonly string[]).includes(r),
    );
    const added = want.filter((r) => !before.includes(r));
    if (added.length) {
      const extra = sql.join(
        added.map((r) => sql`${r}`),
        sql`, `,
      );
      await ctx.db
        .update(clients)
        .set({
          crewRoles: sql`(select array_agg(distinct r) from unnest(${clients.crewRoles} || array[${extra}]::text[]) as r)`,
          updatedAt: new Date(),
        })
        .where(eq(clients.id, c.id));
      await ctx.emit({
        actor: `naive:${ctx.agent}`,
        type: "ceo.staffed",
        entityType: "client",
        entityId: c.id,
        payload: { added, reason },
      });
    }
    const [row] = await ctx.db
      .select({ crewRoles: clients.crewRoles })
      .from(clients)
      .where(eq(clients.id, c.id));
    const roles = staffedRoles(row?.crewRoles);
    const { jobId } = await ctx.enqueue({
      type: "provision_client_crew",
      payload: { clientId: c.id },
      idempotencyKey: `provision:${c.id}:${[...roles].sort().join(",")}`,
      traceId: ctx.requestId,
    });
    return { roles, added, provisioning: jobId !== null };
  },
});

/** client_goal: a client's goal and how far along it is. */
export const clientGoalTool = defineTool({
  name: "client_goal",
  handler: async ({ clientId }, ctx) => {
    const c = await clientById(ctx.db, clientId);
    return { clientId: c.id, goal: await goalProgress(ctx.db, c.id, ctx.now()) };
  },
});

/** mark_goal_met: only when code counts it met; then the client's crew goes to maintenance. */
export const markGoalMetTool = defineTool({
  name: "mark_goal_met",
  handler: async ({ clientId }, ctx) => {
    const c = await clientById(ctx.db, clientId);
    if (c.id === OUTRUN_CLIENT_ID) return { ok: false as const, reason: "Outrun has no client goal" };
    const g = await goalProgress(ctx.db, c.id, ctx.now());
    if (!g) return { ok: false as const, reason: "the client has no confirmed goal" };
    if (!g.met)
      return {
        ok: false as const,
        reason: `not met yet: ${g.current} of ${g.target} ${g.metric} by ${g.by}`,
      };
    await ctx.emit({
      actor: `naive:${ctx.agent}`,
      type: "client.goal_met",
      entityType: "client",
      entityId: c.id,
      payload: { goal: g },
    });
    const f = await setClientFocus(
      { db: ctx.db, emit: ctx.emit },
      {
        clientId: c.id,
        dailyDraftLimit: CLIENT_FOCUS_MIN,
        reason: `goal met (${g.current} of ${g.target} ${g.metric}): maintenance`,
      },
      `naive:${ctx.agent}`,
    );
    return { ok: true as const, dailyDraftLimit: f.dailyDraftLimit };
  },
});

export const agencyTools = [
  getClientProfile,
  saveClientProfile,
  listClients,
  clientReport,
  agencyStatus,
  kickClient,
  saveBrief,
  clientInsightsTool,
  proposeProfileChangeTool,
  setClientFocusTool,
  recordLessonTool,
  readPlaybookTool,
  makePredictionTool,
  ceoTrackRecordTool,
  listProblemsTool,
  replayJobTool,
  pauseClientTool,
  resumeClientTool,
  saveBoardMemoTool,
  staffClientTool,
  clientGoalTool,
  markGoalMetTool,
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
      crew: crewOf(c.slug, c.crewRoles).map((m) => {
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
