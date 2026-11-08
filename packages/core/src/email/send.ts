/**
 * SH-6: the send_email job. Sends one approved outreach message, once.
 *
 * It refuses (and records why) when the message isn't approved, the address or its domain is
 * suppressed, sending is paused, the domain has no MX, or demo mode forbids the recipient. Past
 * today's warmup cap it re-queues itself for tomorrow. The status moves approved → sending
 * before the provider call, so a retried or duplicated job never sends twice; a crash between
 * the call and `sent` leaves it `sending`, which check_stuck reports rather than resending.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { CRON_TZ } from "../constants";
import type { Db } from "../db/client";
import { messages, prospects } from "../db/schema";
import { assertDemoRecipient } from "../demo";
import { AppError } from "../errors";
import type { Emit } from "../events";
import type { AgentMailClient } from "../integrations/types";
import { startOfDayIn } from "../time";
import type { MxLookup } from "./mx";
import { effectiveSendCap, isSuppressed, sendPause, sentToday } from "./rules";
import { listUnsubscribe, unsubscribeLine, unsubscribeToken } from "./unsubscribe";

export interface SendDeps {
  db: Db;
  emit: Emit;
  agentmail: Pick<AgentMailClient, "send">;
  mx: MxLookup;
  enqueue: (job: {
    type: "send_email";
    payload: Record<string, unknown>;
    idempotencyKey: string;
    traceId: string;
    runAfter?: string;
  }) => Promise<unknown>;
  appUrl: string;
  unsubscribeSecret: string | undefined;
  inbox: string | undefined;
  settings: { sendDailyCap: number; demo: boolean };
  now?: () => Date;
}

export type SendOutcome =
  | { status: "sent"; providerId: string }
  | { status: "already_sent" }
  | { status: "deferred"; until: string }
  | { status: "refused"; reason: string };

async function refuse(deps: SendDeps, id: string, reason: string): Promise<SendOutcome> {
  await deps.db
    .update(messages)
    .set({ status: "failed" })
    .where(and(eq(messages.id, id), eq(messages.status, "approved")));
  await deps.emit({
    actor: "worker",
    type: "email.refused",
    entityType: "message",
    entityId: id,
    payload: { reason },
  });
  return { status: "refused", reason };
}

export async function runSendEmail(deps: SendDeps, messageId: string, traceId: string): Promise<SendOutcome> {
  const now = deps.now?.() ?? new Date();
  const [m] = await deps.db.select().from(messages).where(eq(messages.id, messageId));
  if (!m) throw new AppError("not_found", `message ${messageId}`);
  if (m.status === "sent") return { status: "already_sent" };
  if (m.status === "sending") return { status: "already_sent" };
  if (m.status !== "approved") return { status: "refused", reason: `status is ${m.status}` };
  if (!m.toEmail || !m.contactId) return refuse(deps, m.id, "no recipient");

  if (await isSuppressed(deps.db, m.toEmail)) return refuse(deps, m.id, "suppressed");
  const pause = await sendPause(deps.db);
  if (pause.paused) {
    // Paused sends wait; a person resumes with pnpm email:resume. They don't fail.
    const until = new Date(now.getTime() + 3_600_000).toISOString();
    await deps.enqueue({
      type: "send_email",
      payload: { messageId },
      idempotencyKey: `send:${m.id}:paused:${until.slice(0, 13)}`,
      traceId,
      runAfter: until,
    });
    return { status: "deferred", until };
  }
  try {
    await assertDemoRecipient(deps.db, deps.settings, m.toEmail);
  } catch {
    return refuse(deps, m.id, "demo mode: not the demo inbox");
  }
  const domain = m.toEmail.split("@")[1] ?? "";
  if (!(await deps.mx(domain))) return refuse(deps, m.id, "no MX record");

  const cap = await effectiveSendCap(deps.db, deps.settings.sendDailyCap, now);
  // sentToday counts this approved message too, so over the cap means strictly more.
  if ((await sentToday(deps.db, now)) > cap) {
    const tomorrow = new Date(
      startOfDayIn(CRON_TZ, now).getTime() + 86_400_000 + 9 * 3_600_000,
    ).toISOString();
    await deps.enqueue({
      type: "send_email",
      payload: { messageId },
      idempotencyKey: `send:${m.id}:${tomorrow.slice(0, 10)}`,
      traceId,
      runAfter: tomorrow,
    });
    return { status: "deferred", until: tomorrow };
  }

  const claimed = await deps.db
    .update(messages)
    .set({ status: "sending" })
    .where(and(eq(messages.id, m.id), eq(messages.status, "approved")))
    .returning({ id: messages.id });
  if (!claimed[0]) return { status: "already_sent" };

  // A reply answers the latest inbound message in the thread.
  let inReplyTo: string | undefined;
  if (m.kind === "reply" && m.threadId) {
    const [last] = await deps.db
      .select({ providerId: messages.providerId })
      .from(messages)
      .where(
        and(
          eq(messages.threadId, m.threadId),
          eq(messages.direction, "inbound"),
          sql`${messages.providerId} is not null`,
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1);
    inReplyTo = last?.providerId ?? undefined;
  }
  const token = unsubscribeToken(deps.unsubscribeSecret, m.contactId);
  let sent: { providerId: string; threadId: string };
  try {
    sent = await deps.agentmail.send({
      to: m.toEmail,
      subject: m.subject,
      text: m.body + unsubscribeLine(deps.appUrl, token),
      ...(m.threadId ? { threadId: m.threadId } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      listUnsubscribe: listUnsubscribe(deps.appUrl, token, deps.inbox),
      idempotencyKey: `send:${m.id}`,
    });
  } catch (err) {
    // An HTTP answer (429, 4xx, 5xx) means AgentMail didn't send: put it back for the retry.
    // A dropped connection may have sent, so it stays `sending` for a person to check.
    const answered =
      err instanceof AppError && (err.code === "rate_limited" || /HTTP \d{3}/.test(err.message));
    if (answered) {
      await deps.db.update(messages).set({ status: "approved" }).where(eq(messages.id, m.id));
      throw err;
    }
    await deps.emit({
      actor: "worker",
      type: "email.send_unknown",
      entityType: "message",
      entityId: m.id,
      payload: { reason: "connection failed during send; check AgentMail before resending" },
    });
    return { status: "refused", reason: "send outcome unknown" };
  }
  await deps.db
    .update(messages)
    .set({ status: "sent", providerId: sent.providerId, threadId: sent.threadId, sentAt: now })
    .where(eq(messages.id, m.id));
  if (m.prospectId) {
    await deps.db
      .update(prospects)
      .set({
        lastContactedAt: now,
        ...(m.kind === "followup" ? { followupStep: sql`${prospects.followupStep} + 1` } : {}),
        ...(m.kind === "first" ? { stage: "contacted" as const, followupStep: 0 } : {}),
      })
      .where(eq(prospects.id, m.prospectId));
  }
  await deps.emit({
    actor: "worker",
    type: "email.sent",
    entityType: "message",
    entityId: m.id,
    payload: { kind: m.kind, providerId: sent.providerId },
  });
  return { status: "sent", providerId: sent.providerId };
}
