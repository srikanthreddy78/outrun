/**
 * SH-1: AgentMail webhooks, signed by Svix. Verify the raw body, dedupe on the event id, then
 * in one transaction:
 *   message.received   store the inbound message and enqueue triage_reply (ids only)
 *   message.bounced    a permanent bounce suppresses the address (hard_bounce)
 *   message.complained suppresses the address (complaint), which pauses sending
 * Other events are acknowledged and ignored. Email text is untrusted data, never instructions.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { WEBHOOK_TOLERANCE_SECONDS } from "../../contracts";
import { transaction, type DbHandle } from "../db/client";
import { clients, contacts, messages, prospects } from "../db/schema";
import { OUTRUN_CLIENT_ID } from "../constants";
import type { Emit } from "../events";
import { recordWebhookOnce } from "../events";
import { suppress } from "../email/rules";
import type { Queue } from "../queue";
import type { WebhookReply } from "./naive";

/** Svix: HMAC-SHA256 over `${id}.${timestamp}.${body}`, keyed with the base64 secret after `whsec_`. */
export function verifySvix(opts: {
  rawBody: string;
  headers: Headers;
  secrets: (string | undefined)[];
  nowSeconds?: number;
}): WebhookReply | null {
  const secrets = opts.secrets.filter((s): s is string => !!s);
  if (!secrets.length)
    return {
      status: 503,
      body: { error: "webhook secret not configured" },
      headers: { "retry-after": "60" },
    };
  const id = opts.headers.get("svix-id");
  const ts = opts.headers.get("svix-timestamp");
  const sigs = opts.headers.get("svix-signature");
  if (!id || !ts || !sigs) return { status: 401, body: { error: "missing signature" } };
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!/^\d+$/.test(ts) || Math.abs(now - Number(ts)) > WEBHOOK_TOLERANCE_SECONDS)
    return { status: 401, body: { error: "stale signature" } };
  const given = sigs
    .split(" ")
    .map((s) => s.split(",", 2))
    .filter(([v]) => v === "v1")
    .map(([, s]) => Buffer.from(s ?? "", "base64"));
  for (const secret of secrets) {
    const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    const want = createHmac("sha256", key).update(`${id}.${ts}.${opts.rawBody}`).digest();
    if (given.some((g) => g.length === want.length && timingSafeEqual(g, want))) return null;
  }
  return { status: 401, body: { error: "bad signature" } };
}

const Address = z.string().transform((s) => {
  const m = /<([^>]+)>/.exec(s);
  return (m ? m[1]! : s).trim().toLowerCase();
});
const Received = z.object({
  event_type: z.string(),
  event_id: z.string().min(1),
  message: z.object({
    message_id: z.string().min(1),
    thread_id: z.string().min(1),
    inbox_id: z.string(),
    from: z.union([Address, z.array(Address).transform((a) => a[0] ?? "")]),
    subject: z.string().optional().default(""),
    text: z.string().optional(),
    extracted_text: z.string().optional(),
    preview: z.string().optional(),
    in_reply_to: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
});
const Bounced = z.object({
  event_type: z.literal("message.bounced"),
  event_id: z.string().min(1),
  bounce: z.object({
    message_id: z.string().optional(),
    type: z.string().optional(),
    recipients: z.array(z.object({ address: Address, status: z.string().optional() })).default([]),
  }),
});
const Complained = z.object({
  event_type: z.literal("message.complained"),
  event_id: z.string().min(1),
  complaint: z.object({ message_id: z.string().optional(), recipients: z.array(Address).default([]) }),
});

/** The inbound body we keep: the reply without the quoted history when AgentMail extracted it. */
const MAX_BODY = 20_000;

export async function acceptAgentMailEvent(opts: {
  body: unknown;
  db: Pick<DbHandle, "pool" | "db">;
  queue: Pick<Queue, "enqueue">;
  emit: Emit;
}): Promise<WebhookReply> {
  const type = (opts.body as { event_type?: unknown })?.event_type;
  const eventId = (opts.body as { event_id?: unknown })?.event_id;
  if (typeof type !== "string" || typeof eventId !== "string")
    return { status: 400, body: { error: "not an AgentMail event" } };

  if (type === "message.received") {
    const e = Received.safeParse(opts.body);
    if (!e.success) return { status: 400, body: { error: "bad message.received" } };
    const m = e.data.message;
    const first = await transaction(opts.db, async (tx) => {
      if (!(await recordWebhookOnce(tx.db, "agentmail", eventId, { type }))) return false;
      // The inbox says whose reply it is: a client's own inbox is that client's; any other is Outrun's.
      const [owner] = await tx.db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.agentmailInboxId, m.inbox_id))
        .limit(1);
      const clientId = owner?.id ?? OUTRUN_CLIENT_ID;
      // The thread ties a reply to its prospect; a stranger's mail has neither.
      const [prior] = await tx.db
        .select({ prospectId: messages.prospectId, contactId: messages.contactId })
        .from(messages)
        .where(
          and(
            eq(messages.threadId, m.thread_id),
            eq(messages.clientId, clientId),
            sql`${messages.prospectId} is not null`,
          ),
        )
        .limit(1);
      const [contact] = prior
        ? []
        : await tx.db.select({ id: contacts.id }).from(contacts).where(eq(contacts.email, m.from));
      const [row] = await tx.db
        .insert(messages)
        .values({
          clientId,
          prospectId: prior?.prospectId ?? null,
          contactId: prior?.contactId ?? contact?.id ?? null,
          threadId: m.thread_id,
          direction: "inbound",
          kind: "inbound",
          status: "received",
          fromEmail: m.from,
          toEmail: m.inbox_id,
          subject: m.subject.slice(0, 500),
          body: (m.extracted_text ?? m.text ?? m.preview ?? "").slice(0, MAX_BODY),
          providerId: m.message_id,
        })
        .onConflictDoNothing()
        .returning({ id: messages.id });
      if (!row) return true;
      if (prior?.prospectId) {
        await tx.db
          .update(prospects)
          .set({ stage: "replied" })
          .where(and(eq(prospects.id, prior.prospectId), sql`${prospects.stage} in ('contacted','drafted')`));
      }
      await opts.queue.enqueue(
        {
          type: "triage_reply",
          payload: { messageId: row.id },
          idempotencyKey: `triage:${row.id}`,
          traceId: `agentmail-${eventId}`,
        },
        { tx },
      );
      return true;
    });
    return { status: 200, body: first ? { ok: true } : { ok: true, duplicate: true } };
  }

  if (type === "message.bounced" || type === "message.complained") {
    const bounced = type === "message.bounced" ? Bounced.safeParse(opts.body) : null;
    const complained = type === "message.complained" ? Complained.safeParse(opts.body) : null;
    if ((bounced && !bounced.success) || (complained && !complained.success))
      return { status: 400, body: { error: `bad ${type}` } };
    // Only a permanent bounce suppresses; a transient one (mailbox full) may deliver later.
    const addresses = bounced?.success
      ? (bounced.data.bounce.type ?? "Permanent") === "Permanent"
        ? bounced.data.bounce.recipients.map((r) => r.address)
        : []
      : complained?.success
        ? complained.data.complaint.recipients
        : [];
    const reason = type === "message.bounced" ? "hard_bounce" : "complaint";
    const first = await transaction(opts.db, async (tx) => {
      if (!(await recordWebhookOnce(tx.db, "agentmail", eventId, { type }))) return false;
      for (const a of addresses) {
        await suppress(tx.db, a, reason);
        await tx.db.update(contacts).set({ suppressed: true }).where(eq(contacts.email, a));
      }
      return true;
    });
    if (first && addresses.length) {
      await opts.emit({
        actor: "provider:agentmail",
        type: reason === "complaint" ? "email.complaint" : "email.bounced",
        entityType: "system",
        entityId: `agentmail:${eventId}`,
        payload: { count: addresses.length },
      });
    }
    return { status: 200, body: first ? { ok: true } : { ok: true, duplicate: true } };
  }

  return { status: 200, body: { ok: true, ignored: type } };
}
