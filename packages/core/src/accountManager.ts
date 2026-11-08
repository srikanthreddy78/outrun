/**
 * The account manager's ledger: weekly reports and the client's portal questions and answers.
 * All of it lives in events, scoped by client:
 *
 *   client.report    a weekly report: numbers and goal built by code, plus the agent's short note
 *   client.question  a question an approver asked in the portal (untrusted text)
 *   client.answer    the account manager's answer to one question
 *
 * The email that a report is ready is a fixed template with a portal link; no agent text goes in
 * it. Nothing here sends outreach, moves money, sets a price or deletes data.
 */
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { ClientProfile, staffedRoles } from "../contracts";
import { CLIENT_QUESTION_MAX_CHARS, CLIENT_QUESTIONS_PER_DAY, OUTRUN_CLIENT_ID } from "./constants";
import { clientLinkHosts, groundingProblems, priceWords } from "./crew/tools/outreach";
import type { Db } from "./db/client";
import { clientUsers, clients, events } from "./db/schema";
import { AppError } from "./errors";
import type { Emit } from "./events";
import type { SendTransactionalFn } from "./integrations/types";
import type { JobEnvelopeInput } from "../contracts";

const DAY = 86_400_000;

export interface ClientReport {
  day: string;
  since: string;
  sent: number;
  replies: number;
  won: number;
  approvalsWaiting: number;
  stages: Record<string, number>;
  goal: {
    metric: "interested" | "meetings" | "customers";
    target: number;
    by: string;
    current: number;
    met: boolean;
    onTrack: boolean;
  } | null;
  note: string | null;
}

/** The latest weekly report for a client, or null. */
export async function latestClientReport(db: Db, clientId: string) {
  const [e] = await db
    .select({ payload: events.payload, ts: events.ts })
    .from(events)
    .where(
      and(eq(events.type, "client.report"), eq(events.entityType, "client"), eq(events.entityId, clientId)),
    )
    .orderBy(desc(events.ts))
    .limit(1);
  if (!e) return null;
  const p = e.payload as { reportId: string; report: ClientReport };
  return { reportId: p.reportId, report: p.report, at: e.ts };
}

/** A report's note: plain words only. No links or email addresses; the client reads it. */
export function noteProblems(note: string): string[] {
  const out: string[] = [];
  if (/https?:\/\/|www\.|\b[\w-]+\.(com|io|dev|ai|co|net|org|app)\b/i.test(note))
    out.push("no links in the note; the portal already links everything");
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(note)) out.push("no email addresses in the note");
  return out;
}

/**
 * The fixed notice to each of the client's approvers that a report is ready. One email per
 * approver per report (the idempotency key). Returns how many went out.
 */
export async function sendClientReportNotice(
  deps: { db: Db; emit: Emit; sendTransactional: SendTransactionalFn; appUrl: string },
  clientId: string,
  reportId: string,
): Promise<number> {
  const [c] = await deps.db.select().from(clients).where(eq(clients.id, clientId));
  if (!c || c.id === OUTRUN_CLIENT_ID) return 0;
  const approvers = await deps.db
    .select({ email: clientUsers.email })
    .from(clientUsers)
    .where(and(eq(clientUsers.clientId, c.id), eq(clientUsers.role, "approver")));
  for (const a of approvers)
    await deps.sendTransactional({
      to: a.email,
      subject: `Your weekly report for ${c.name} is ready`,
      text: [
        `Your weekly report for ${c.name} is ready in your client portal:`,
        `${deps.appUrl}/portal/${c.slug}`,
        "",
        "Sign in with this address to read it and to ask your account manager a question.",
      ].join("\n"),
      idempotencyKey: `client-report:${reportId}:${a.email}`,
    });
  await deps.emit({
    actor: "worker",
    type: "client.report_sent",
    entityType: "client",
    entityId: c.id,
    payload: { reportId, approvers: approvers.length },
  });
  return approvers.length;
}

export interface ClientQuestion {
  questionId: string;
  question: string;
  at: Date;
  answer: { text: string; at: Date } | null;
}

/** A client's questions, newest first, each with its latest answer. */
export async function clientQuestions(db: Db, clientId: string, limit = 20): Promise<ClientQuestion[]> {
  const qs = await db
    .select({ payload: events.payload, ts: events.ts })
    .from(events)
    .where(
      and(eq(events.type, "client.question"), eq(events.entityType, "client"), eq(events.entityId, clientId)),
    )
    .orderBy(desc(events.ts))
    .limit(limit);
  const as = await db
    .select({ payload: events.payload, ts: events.ts })
    .from(events)
    .where(
      and(eq(events.type, "client.answer"), eq(events.entityType, "client"), eq(events.entityId, clientId)),
    )
    .orderBy(desc(events.ts));
  const answers = new Map<string, { text: string; at: Date }>();
  for (const a of as) {
    const p = a.payload as { questionId: string; answer: string };
    if (!answers.has(p.questionId)) answers.set(p.questionId, { text: p.answer, at: a.ts });
  }
  return qs.map((q) => {
    const p = q.payload as { questionId: string; question: string };
    return {
      questionId: p.questionId,
      question: p.question,
      at: q.ts,
      answer: answers.get(p.questionId) ?? null,
    };
  });
}

/** Unanswered portal questions per client, for agency_status' attention. */
export async function openQuestionCount(db: Db, clientId: string): Promise<number> {
  const qs = await clientQuestions(db, clientId, 50);
  return qs.filter((q) => !q.answer).length;
}

/**
 * A portal question from an approver: stored as client.question, and, only when the CEO staffed
 * the client an account manager, its session starts. Otherwise the CEO sees it in agency_status.
 */
export async function askClientQuestion(
  deps: {
    db: Db;
    emit: Emit;
    enqueue: (job: JobEnvelopeInput) => Promise<{ jobId: string | null }>;
    now?: () => Date;
  },
  clientId: string,
  email: string,
  raw: string,
): Promise<{ questionId: string; routed: "account_manager" | "ceo" }> {
  const question = raw.trim();
  if (!question) throw new AppError("bad_request", "ask a question");
  if (question.length > CLIENT_QUESTION_MAX_CHARS)
    throw new AppError("bad_request", `keep it under ${CLIENT_QUESTION_MAX_CHARS} characters`);
  const [c] = await deps.db.select().from(clients).where(eq(clients.id, clientId));
  if (!c || c.id === OUTRUN_CLIENT_ID) throw new AppError("not_found", "no such client");
  const now = deps.now?.() ?? new Date();
  const [today] = await deps.db
    .select({ n: count() })
    .from(events)
    .where(
      and(
        eq(events.type, "client.question"),
        eq(events.entityType, "client"),
        eq(events.entityId, c.id),
        gte(events.ts, new Date(now.getTime() - DAY)),
      ),
    );
  if (Number(today?.n ?? 0) >= CLIENT_QUESTIONS_PER_DAY)
    throw new AppError(
      "rate_limited",
      `up to ${CLIENT_QUESTIONS_PER_DAY} questions a day; try again tomorrow`,
    );
  const questionId = randomUUID();
  await deps.emit({
    actor: `client:${email.trim().toLowerCase()}`,
    type: "client.question",
    entityType: "client",
    entityId: c.id,
    payload: { questionId, question },
  });
  if (!staffedRoles(c.crewRoles).includes("account_manager")) return { questionId, routed: "ceo" };
  await deps.enqueue({
    type: "start_session",
    payload: {
      agent: "account_manager",
      clientId: c.id,
      entity: { type: "client", id: c.id },
      message: `Your client asked question ${questionId} in its portal. Read it with outrun.client_questions and answer it with outrun.answer_client.`,
    },
    idempotencyKey: `am:question:${questionId}`,
    traceId: randomUUID(),
  });
  return { questionId, routed: "account_manager" };
}

/**
 * The account manager's answer. Grounded like a reply: prices only from the profile, links only
 * to the client's own hosts, no email addresses. Returns the reasons when it fails.
 */
export async function answerClientQuestion(
  deps: { db: Db; emit: Emit },
  clientId: string,
  questionId: string,
  answer: string,
  actor: string,
): Promise<{ ok: true } | { ok: false; reasons: string[] }> {
  const [c] = await deps.db.select().from(clients).where(eq(clients.id, clientId));
  if (!c || c.id === OUTRUN_CLIENT_ID) throw new AppError("not_found", "no such client");
  const [q] = await deps.db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.type, "client.question"),
        eq(events.entityType, "client"),
        eq(events.entityId, c.id),
        sql`${events.payload}->>'questionId' = ${questionId}`,
      ),
    )
    .limit(1);
  if (!q) throw new AppError("not_found", `question ${questionId}`);
  const profile = ClientProfile.safeParse(c.profile).data;
  const reasons = groundingProblems({
    subject: "",
    body: answer,
    kind: "reply",
    citedCheckIds: [],
    scanCheckIds: new Set(),
    allowedHosts: profile ? clientLinkHosts({ domain: c.domain, profile }, c.domain) : [c.domain],
    client: { prices: priceWords((profile?.offer.prices ?? []).map((p) => p.amount)) },
  });
  if (reasons.length) return { ok: false, reasons };
  await deps.emit({
    actor: actor as never,
    type: "client.answer",
    entityType: "client",
    entityId: c.id,
    payload: { questionId, answer },
  });
  return { ok: true };
}
