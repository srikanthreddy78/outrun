/**
 * The agency learns from its own ledger. Triage labels, outcomes and approval decisions were
 * written and never read back; this reads them, per client:
 *
 *   clientInsights      sent, replies, interest, wins, unsubscribes, bounces; reply and interest
 *                       rates by ICP keyword, fit signal and buyer role; the approval reject rate
 *                       and its reasons; the subject lines of first emails that got a reply
 *   lessonsFor          what get_brief hands the sdr and closer: rejection reasons, replied subjects
 *   focus               the CEO's daily first-email limit per client (the latest ceo.focus_set)
 *   proposals           the CEO proposes an ICP change with evidence; the owner accepts or rejects
 *
 * Joins go through messages and prospects, which carry client_id. Every number is counted by
 * code; nothing here moves money, sets a price or deletes data.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { ClientProfile, ProfileChanges } from "../contracts";
import { validProfileFor } from "./clients";
import {
  CLIENT_FOCUS_MAX,
  CLIENT_FOCUS_MIN,
  INSIGHT_DAYS,
  LESSONS_KEPT,
  OUTRUN_CLIENT_ID,
  PROPOSAL_COOLDOWN_DAYS,
} from "./constants";
import type { Db } from "./db/client";
import { clients, companies, contacts, events, messages, prospects } from "./db/schema";
import { AppError } from "./errors";
import type { Emit } from "./events";
import { mentions, type FitPart } from "./scoring/fit";
import { REPLY_CLASSES } from "./triage";

const DAY = 86_400_000;

export interface InsightRow {
  key: string;
  contacted: number;
  replied: number;
  interested: number;
  replyRate: number;
  interestRate: number;
}

const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : 0);

/** The labels that count as a person answering: not a bounce, an auto-reply or an unsubscribe. */
const isReply = (label: string | null) =>
  label === null || (REPLY_CLASSES as readonly string[]).includes(label);
const isInterest = (label: string | null) => label === "interested" || label === "question";

/** Inbound messages for a client with their triage label (null while unlabelled). */
async function labelledInbound(db: Db, clientId: string, since?: Date) {
  const rows = await db
    .select({
      id: messages.id,
      prospectId: messages.prospectId,
      at: messages.createdAt,
      label: sql<
        string | null
      >`(select e.payload->>'label' from events e where e.type = 'triage.classified' and e.entity_id = "messages"."id"::text order by e.ts desc limit 1)`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.clientId, clientId),
        eq(messages.direction, "inbound"),
        since ? gte(messages.createdAt, since) : undefined,
      ),
    );
  return rows;
}

/** Approval decisions on this client's messages: approval.submitted (ours) and Naive's own. */
async function approvalDecisions(db: Db, clientId: string, since?: Date) {
  const rows = await db
    .select({ type: events.type, payload: events.payload, ts: events.ts, messageId: events.entityId })
    .from(events)
    .innerJoin(messages, sql`${messages.id}::text = ${events.entityId}`)
    .where(
      and(
        inArray(events.type, ["approval.submitted", "approval.approved", "approval.rejected"]),
        eq(messages.clientId, clientId),
        since ? gte(events.ts, since) : undefined,
      ),
    )
    .orderBy(desc(events.ts));
  // One decision per message: the newest. Reasons come only from approval.submitted.
  const decided = new Map<string, "allow" | "deny">();
  const reasons: string[] = [];
  for (const r of rows) {
    const p = r.payload as { decision?: string; reason?: string | null };
    const d =
      r.type === "approval.submitted"
        ? p.decision === "deny"
          ? "deny"
          : "allow"
        : r.type === "approval.rejected"
          ? "deny"
          : "allow";
    if (!decided.has(r.messageId)) decided.set(r.messageId, d);
    if (r.type === "approval.submitted" && d === "deny" && p.reason && reasons.length < LESSONS_KEPT)
      reasons.push(p.reason.slice(0, 300));
  }
  const rejected = [...decided.values()].filter((d) => d === "deny").length;
  return { decided: decided.size, rejected, reasons };
}

/** Subject lines of this client's first emails whose prospect then replied, newest first. */
async function repliedSubjects(db: Db, clientId: string, since?: Date): Promise<string[]> {
  const rows = await db
    .select({ subject: messages.subject })
    .from(messages)
    .where(
      and(
        eq(messages.clientId, clientId),
        eq(messages.direction, "outbound"),
        eq(messages.kind, "first"),
        eq(messages.status, "sent"),
        since ? gte(messages.sentAt, since) : undefined,
        sql`exists (select 1 from messages r where r.prospect_id = ${messages.prospectId} and r.direction = 'inbound'
          and coalesce((select e.payload->>'label' from events e where e.type = 'triage.classified' and e.entity_id = r.id::text order by e.ts desc limit 1), 'unlabelled')
            not in ('bounce', 'auto_reply', 'unsubscribe'))`,
      ),
    )
    .orderBy(desc(messages.sentAt))
    .limit(LESSONS_KEPT * 3);
  return [...new Set(rows.map((r) => r.subject))].slice(0, LESSONS_KEPT);
}

/** get_brief's lessons for a client's sdr and closer: no human needed. */
export async function lessonsFor(db: Db, clientId: string) {
  const [a, subjects] = await Promise.all([approvalDecisions(db, clientId), repliedSubjects(db, clientId)]);
  return { rejectionReasons: a.reasons, repliedSubjects: subjects };
}

/** The CEO's latest focus for a client, or null. */
export async function clientFocus(db: Db, clientId: string) {
  const [e] = await db
    .select({ payload: events.payload, ts: events.ts })
    .from(events)
    .where(and(eq(events.type, "ceo.focus_set"), eq(events.entityId, clientId)))
    .orderBy(desc(events.ts))
    .limit(1);
  if (!e) return null;
  const p = e.payload as { dailyDraftLimit: number; reason?: string };
  const n = Math.max(CLIENT_FOCUS_MIN, Math.min(CLIENT_FOCUS_MAX, Math.round(Number(p.dailyDraftLimit))));
  return Number.isFinite(n) ? { dailyDraftLimit: n, reason: p.reason ?? "", at: e.ts } : null;
}

export interface Proposal {
  proposalId: string;
  clientId: string;
  changes: ProfileChanges;
  evidence: string;
  by: string;
  at: Date;
  status: "open" | "accepted" | "rejected";
}

/** A client's proposals, newest first, with how each was resolved. */
export async function proposalsFor(db: Db, clientId: string): Promise<Proposal[]> {
  const rows = await db
    .select({ type: events.type, payload: events.payload, ts: events.ts, actor: events.actor })
    .from(events)
    .where(
      and(
        inArray(events.type, ["ceo.proposal", "ceo.proposal_accepted", "ceo.proposal_rejected"]),
        eq(events.entityId, clientId),
      ),
    )
    .orderBy(desc(events.ts));
  const resolved = new Map<string, "accepted" | "rejected">();
  for (const r of rows) {
    const id = (r.payload as { proposalId?: string }).proposalId;
    if (!id) continue;
    if (r.type === "ceo.proposal_accepted") resolved.set(id, "accepted");
    if (r.type === "ceo.proposal_rejected") resolved.set(id, "rejected");
  }
  return rows
    .filter((r) => r.type === "ceo.proposal")
    .map((r) => {
      const p = r.payload as { proposalId: string; changes: ProfileChanges; evidence: string };
      return {
        proposalId: p.proposalId,
        clientId,
        changes: p.changes,
        evidence: p.evidence,
        by: r.actor,
        at: r.ts,
        status: resolved.get(p.proposalId) ?? ("open" as const),
      };
    });
}

/** The profile with the changes applied; the caller validates it. */
export function applyChanges(profile: ClientProfile, changes: ProfileChanges): ClientProfile {
  const norm = (s: string) => s.trim().toLowerCase();
  const drop = new Set((changes.dropIncludeKeywords ?? []).map(norm));
  const merge = (base: readonly string[], add: readonly string[] = []) => {
    const out = [...base];
    for (const k of add) if (!out.some((o) => norm(o) === norm(k))) out.push(k.trim());
    return out;
  };
  return {
    ...profile,
    icp: {
      ...profile.icp,
      includeKeywords: merge(profile.icp.includeKeywords, changes.addIncludeKeywords).filter(
        (k) => !drop.has(norm(k)),
      ),
      excludeKeywords: merge(profile.icp.excludeKeywords, changes.addExcludeKeywords),
      buyerRoles: changes.buyerRoles ?? profile.icp.buyerRoles,
      companySizes: changes.companySizes ?? profile.icp.companySizes,
    },
  };
}

async function confirmedRow(db: Db, clientId: string) {
  const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!c || c.id === OUTRUN_CLIENT_ID) throw new AppError("not_found", "no such client");
  return c;
}

/** The changed profile, validated as the dashboard and the researcher's draft are. */
function changedProfile(c: { domain: string; profile: unknown }, changes: ProfileChanges): ClientProfile {
  const next = applyChanges(ClientProfile.parse(c.profile), ProfileChanges.parse(changes));
  try {
    return validProfileFor(c.domain, next);
  } catch (err) {
    const msg = err instanceof AppError ? err.message : "the changed profile isn't valid";
    throw new AppError("bad_request", `the change would leave an invalid profile: ${msg}`);
  }
}

/** propose_profile_change: refused while one is open or within the cooldown. */
export async function proposeProfileChange(
  deps: { db: Db; emit: Emit; now: () => Date },
  input: { clientId: string; changes: ProfileChanges; evidence: string },
  actor: string,
): Promise<{ ok: true; proposalId: string } | { ok: false; reason: string }> {
  const c = await confirmedRow(deps.db, input.clientId);
  if (!c.profileConfirmedAt)
    return { ok: false, reason: "the client's profile isn't confirmed yet; the owner confirms it first" };
  const [last] = await proposalsFor(deps.db, c.id);
  if (last?.status === "open")
    return {
      ok: false,
      reason: `proposal ${last.proposalId} from ${last.at.toISOString().slice(0, 10)} still waits for the owner`,
    };
  const since = deps.now().getTime() - PROPOSAL_COOLDOWN_DAYS * DAY;
  if (last && last.at.getTime() > since)
    return {
      ok: false,
      reason: `one proposal per client per ${PROPOSAL_COOLDOWN_DAYS} days; the last was ${last.at.toISOString().slice(0, 10)}, try again after ${new Date(last.at.getTime() + PROPOSAL_COOLDOWN_DAYS * DAY).toISOString().slice(0, 10)}`,
    };
  try {
    changedProfile(c, input.changes);
  } catch (err) {
    if (err instanceof AppError) return { ok: false, reason: err.message };
    throw err;
  }
  const proposalId = randomUUID();
  await deps.emit({
    actor: actor as never,
    type: "ceo.proposal",
    entityType: "client",
    entityId: c.id,
    payload: { proposalId, changes: input.changes, evidence: input.evidence },
  });
  return { ok: true, proposalId };
}

async function openProposal(db: Db, clientId: string, proposalId: string) {
  const p = (await proposalsFor(db, clientId)).find((x) => x.proposalId === proposalId);
  if (!p) throw new AppError("not_found", "no such proposal for this client");
  if (p.status !== "open") throw new AppError("conflict", `the proposal was already ${p.status}`);
  return p;
}

/**
 * The owner accepts: the changes are applied to the confirmed profile, validated as any profile
 * is, and the profile stays confirmed. Sources and fit read the profile, so the crew picks it up.
 */
export async function applyProfileProposal(
  deps: { db: Db; emit: Emit },
  clientId: string,
  proposalId: string,
  actor: string,
) {
  const c = await confirmedRow(deps.db, clientId);
  if (!c.profileConfirmedAt) throw new AppError("conflict", "the client's profile isn't confirmed");
  const p = await openProposal(deps.db, c.id, proposalId);
  const profile = changedProfile(c, p.changes);
  await deps.db.update(clients).set({ profile }).where(eq(clients.id, c.id));
  await deps.emit({
    actor: actor as never,
    type: "ceo.proposal_accepted",
    entityType: "client",
    entityId: c.id,
    payload: { proposalId, changes: p.changes },
  });
  return { profile };
}

export async function rejectProfileProposal(
  deps: { db: Db; emit: Emit },
  clientId: string,
  proposalId: string,
  reason: string,
  actor: string,
) {
  const c = await confirmedRow(deps.db, clientId);
  await openProposal(deps.db, c.id, proposalId);
  await deps.emit({
    actor: actor as never,
    type: "ceo.proposal_rejected",
    entityType: "client",
    entityId: c.id,
    payload: { proposalId, reason: reason.trim().slice(0, 500) || null },
  });
}

/** set_client_focus: the CEO's daily first-email limit for a client, in bounds. */
export async function setClientFocus(
  deps: { db: Db; emit: Emit },
  input: { clientId: string; dailyDraftLimit: number; reason: string },
  actor: string,
) {
  const c = await confirmedRow(deps.db, input.clientId);
  const n = input.dailyDraftLimit;
  if (!Number.isInteger(n) || n < CLIENT_FOCUS_MIN || n > CLIENT_FOCUS_MAX)
    throw new AppError("bad_request", `dailyDraftLimit is ${CLIENT_FOCUS_MIN} to ${CLIENT_FOCUS_MAX}`);
  const previous = (await clientFocus(deps.db, c.id))?.dailyDraftLimit ?? null;
  await deps.emit({
    actor: actor as never,
    type: "ceo.focus_set",
    entityType: "client",
    entityId: c.id,
    payload: { dailyDraftLimit: n, previous, reason: input.reason },
  });
  return { dailyDraftLimit: n, previous };
}

function tally(rows: Map<string, { contacted: number; replied: number; interested: number }>): InsightRow[] {
  return [...rows.entries()]
    .map(([key, v]) => ({
      key,
      ...v,
      replyRate: rate(v.replied, v.contacted),
      interestRate: rate(v.interested, v.contacted),
    }))
    .sort((a, b) => b.contacted - a.contacted || a.key.localeCompare(b.key));
}

/**
 * What is working for one client since `since`. Rates are per contacted prospect: a prospect
 * whose first email went out in the window. Breakdowns:
 *   byKeyword    the ICP include keywords (current profile) its company's summary and saved facts
 *                mention; "(none)" when none
 *   bySignal     each part of its fit score as saved at research (prospect.researched), e.g.
 *                "contact +30"
 *   byBuyerRole  the profile's buyer role its contact's title matches; "(other)" otherwise
 */
export async function clientInsights(db: Db, clientId: string, opts: { since: Date }) {
  const { since } = opts;
  const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!c) throw new AppError("not_found", `client ${clientId}`);
  const icp = ClientProfile.safeParse(c.profile).data?.icp ?? null;

  const [sentRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(messages)
    .where(
      and(
        eq(messages.clientId, c.id),
        eq(messages.direction, "outbound"),
        eq(messages.status, "sent"),
        gte(messages.sentAt, since),
      ),
    );
  const firsts = await db
    .select({
      prospectId: messages.prospectId,
      summary: companies.summary,
      facts: prospects.facts,
      role: contacts.role,
    })
    .from(messages)
    .innerJoin(prospects, eq(messages.prospectId, prospects.id))
    .innerJoin(companies, eq(prospects.companyId, companies.id))
    .leftJoin(contacts, eq(prospects.contactId, contacts.id))
    .where(
      and(
        eq(messages.clientId, c.id),
        eq(prospects.clientId, c.id),
        eq(messages.direction, "outbound"),
        eq(messages.kind, "first"),
        eq(messages.status, "sent"),
        gte(messages.sentAt, since),
      ),
    );
  const contacted = new Map<string, (typeof firsts)[number]>();
  for (const f of firsts) if (f.prospectId) contacted.set(f.prospectId, f);

  const inbound = await labelledInbound(db, c.id);
  const inWindow = inbound.filter((m) => m.at >= since);
  const replied = new Set<string>();
  const interested = new Set<string>();
  for (const m of inbound) {
    if (!m.prospectId || !contacted.has(m.prospectId)) continue;
    if (isReply(m.label)) replied.add(m.prospectId);
    if (isInterest(m.label)) interested.add(m.prospectId);
  }

  // The fit parts each contacted prospect was scored with, from its latest research.
  const ids = [...contacted.keys()];
  const researched = ids.length
    ? await db
        .select({ entityId: events.entityId, payload: events.payload, ts: events.ts })
        .from(events)
        .where(and(eq(events.type, "prospect.researched"), inArray(events.entityId, ids)))
        .orderBy(desc(events.ts))
    : [];
  const partsOf = new Map<string, FitPart[]>();
  for (const r of researched)
    if (!partsOf.has(r.entityId)) partsOf.set(r.entityId, (r.payload as { parts?: FitPart[] }).parts ?? []);

  const byKeyword = new Map<string, { contacted: number; replied: number; interested: number }>();
  const bySignal = new Map<string, { contacted: number; replied: number; interested: number }>();
  const byRole = new Map<string, { contacted: number; replied: number; interested: number }>();
  const bump = (m: typeof byKeyword, key: string, pid: string) => {
    const v = m.get(key) ?? { contacted: 0, replied: 0, interested: 0 };
    v.contacted += 1;
    if (replied.has(pid)) v.replied += 1;
    if (interested.has(pid)) v.interested += 1;
    m.set(key, v);
  };
  for (const [pid, f] of contacted) {
    const text = [f.summary, ...f.facts.map((x) => `${x.key} ${x.value}`)].join(" ");
    const hits = icp ? icp.includeKeywords.filter((k) => mentions(text, k)) : [];
    for (const k of hits.length ? hits : ["(none)"]) bump(byKeyword, k, pid);
    for (const part of partsOf.get(pid) ?? [])
      bump(bySignal, `${part.signal} ${part.points >= 0 ? "+" : ""}${part.points}`, pid);
    const role = f.role ? icp?.buyerRoles.find((r) => mentions(f.role!, r)) : undefined;
    bump(byRole, role ?? "(other)", pid);
  }

  const [wins] = await db
    .select({ n: sql<number>`count(*)` })
    .from(prospects)
    .where(
      and(
        eq(prospects.clientId, c.id),
        sql`(${prospects.stage} = 'won' and ${prospects.updatedAt} >= ${since.toISOString()})
          or exists (select 1 from events e where e.type = 'prospect.outcome' and e.entity_id = ${prospects.id}::text
            and e.ts >= ${since.toISOString()} and (e.payload->>'outcome' = 'won' or e.payload->>'stage' = 'won'))`,
      ),
    );
  const approvals = await approvalDecisions(db, c.id, since);
  const focus = await clientFocus(db, c.id);
  const open = (await proposalsFor(db, c.id)).find((p) => p.status === "open") ?? null;

  return {
    clientId: c.id,
    slug: c.slug,
    since: since.toISOString(),
    sent: Number(sentRow?.n ?? 0),
    contacted: contacted.size,
    replies: inWindow.filter((m) => isReply(m.label)).length,
    interested: inWindow.filter((m) => isInterest(m.label)).length,
    replyRate: rate(replied.size, contacted.size),
    interestRate: rate(interested.size, contacted.size),
    wins: Number(wins?.n ?? 0),
    unsubscribes: inWindow.filter((m) => m.label === "unsubscribe").length,
    bounces: inWindow.filter((m) => m.label === "bounce").length,
    byKeyword: tally(byKeyword),
    bySignal: tally(bySignal),
    byBuyerRole: tally(byRole),
    approvals: {
      decided: approvals.decided,
      rejected: approvals.rejected,
      rejectRate: rate(approvals.rejected, approvals.decided),
      lastRejectionReasons: approvals.reasons,
    },
    repliedSubjects: await repliedSubjects(db, c.id, since),
    focus: focus ? { ...focus, at: focus.at.toISOString() } : null,
    openProposal: open ? { proposalId: open.proposalId, at: open.at.toISOString() } : null,
  };
}

/** client_insights' default window. */
export const insightsSince = (now: Date) => new Date(now.getTime() - INSIGHT_DAYS * DAY);
