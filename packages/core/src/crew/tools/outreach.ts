/**
 * The sdr's and closer's tools (SH-5, SH-7, SH-8). Code grounds every email:
 *
 *   get_brief           checks with their ids, facts, the contact and earlier emails
 *   check_draft         each cited check id is in the latest scan; every price is a PRODUCTS price;
 *                       no email addresses, and links only to us or the prospect; stores the draft
 *                       and the hash of exactly what was checked
 *   send_email / reply_email (ask)
 *                       a person approved the call; the hash still matches; not suppressed; under
 *                       today's cap; the domain takes mail; demo rule. Then enqueue send_email.
 *   list_due_followups  +3 and +7 days after the first email, then none; stops on a reply,
 *                       an unsubscribe or a suppression
 *   get_thread          the thread, outside text wrapped as untrusted
 *   mark_outcome        interested, not now or lost
 */
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { untrusted } from "../../../contracts";
import { confirmedClient } from "../../clients";
import { FOLLOWUP_OFFSETS_DAYS, OUTRUN_CLIENT_ID, PRODUCTS } from "../../constants";
import type { Db } from "../../db/client";
import { companies, contacts, messages, orders, prospects, scans } from "../../db/schema";
import { assertDemoRecipient } from "../../demo";
import type { MxLookup } from "../../email/mx";
import { effectiveSendCap, isSuppressed, sentToday } from "../../email/rules";
import { AppError } from "../../errors";
import { lessonsFor } from "../../insights";
import { defineTool } from "../registry";
import type { ToolContext } from "../types";

export interface OutreachDeps {
  appUrl: string;
  settings: { sendDailyCap: number; demo: boolean };
  mx: MxLookup;
}

const DAY = 86_400_000;
const OFFER = "auditKit" as const;

/** The latest scan's readiness checks in the contract's ScanCheck shape (ids use `_`). */
export async function latestChecks(db: Db, domain: string) {
  const [s] = await db
    .select({ id: scans.id, score: scans.score, checks: scans.checks })
    .from(scans)
    .where(eq(scans.domain, domain))
    .orderBy(desc(scans.createdAt))
    .limit(1);
  if (!s) return null;
  type Stored = {
    id?: string;
    label?: string;
    title?: string;
    status?: string;
    evidence?: string;
    weight?: number;
    category?: string;
  };
  const checks = (s.checks as Stored[])
    .filter((c) => typeof c?.id === "string" && (c.category === undefined || c.category === "readiness"))
    .map((c) => {
      const weight = typeof c.weight === "number" ? c.weight : 1;
      return {
        id: c.id!.replace(/-/g, "_"),
        tier: weight >= 10 ? ("critical" as const) : weight >= 6 ? ("important" as const) : ("nice" as const),
        passed: c.status === "pass",
        title: c.label ?? c.title ?? c.id!,
        evidence: (c.evidence ?? "").slice(0, 500),
        weight,
      };
    });
  return { scanId: s.id, score: s.score, checks };
}

/** A prospect of this client's; another client's prospect is not found. */
async function prospectRow(db: Db, prospectId: string, clientId: string) {
  const [r] = await db
    .select({
      prospect: prospects,
      domain: companies.domain,
      name: companies.name,
      contact: contacts,
    })
    .from(prospects)
    .innerJoin(companies, eq(prospects.companyId, companies.id))
    .leftJoin(contacts, eq(prospects.contactId, contacts.id))
    .where(and(eq(prospects.id, prospectId), eq(prospects.clientId, clientId)));
  if (!r) throw new AppError("not_found", `prospect ${prospectId}`);
  return r;
}

export const draftHash = (d: {
  prospectId: string;
  kind: string;
  threadId: string | null;
  subject: string;
  body: string;
  citedCheckIds: readonly string[];
}): string =>
  createHash("sha256")
    .update(
      JSON.stringify([d.prospectId, d.kind, d.threadId, d.subject, d.body, [...d.citedCheckIds].sort()]),
    )
    .digest("hex");

const PRICE_WORDS = new Set(
  Object.values(PRODUCTS)
    .map((p) => p.priceUsd)
    .filter((n) => n > 0)
    .flatMap((n) => [String(n), n.toLocaleString("en-US")]),
);

/** The numbers in a client's listed prices ("$49/month" → 49), as the price check compares them. */
export function priceWords(amounts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const a of amounts)
    for (const m of a.matchAll(/([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g)) {
      const v = m[1]!.replace(/\.00$/, "");
      out.add(v);
      out.add(v.replace(/,/g, ""));
      const n = Number(v.replace(/,/g, ""));
      if (Number.isFinite(n) && Number.isInteger(n)) out.add(n.toLocaleString("en-US"));
    }
  return out;
}

/** Fact keys as citations: lowercase, spaces and dots to underscores (what CheckId allows). */
export const factCitation = (key: string): string =>
  key
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 41);

/** The hosts a client's email may link to: its own, its call to action, its listed hosts, the prospect's. */
export function clientLinkHosts(
  client: {
    domain: string;
    profile: { offer: { callToActionUrl: string }; allowedLinkHosts: readonly string[] };
  },
  prospectDomain: string,
): string[] {
  return [
    client.domain,
    new URL(client.profile.offer.callToActionUrl).hostname.replace(/^www\./, ""),
    ...client.profile.allowedLinkHosts,
    prospectDomain,
  ];
}

/** The reasons a draft fails grounding; empty when it passes. Exported for the evals. */
export function groundingProblems(opts: {
  subject: string;
  body: string;
  kind: "first" | "followup" | "reply";
  citedCheckIds: readonly string[];
  scanCheckIds: ReadonlySet<string> | null;
  allowedHosts: readonly string[];
  /** Checkout session ids from this prospect's own orders: their Stripe links are allowed. */
  checkoutIds?: readonly string[];
  /**
   * A client's draft: citations are the prospect's saved fact keys (scanCheckIds holds them),
   * and the only prices are the ones in the client's profile.
   */
  client?: { prices: ReadonlySet<string> };
}): string[] {
  const out: string[] = [];
  const text = `${opts.subject}\n${opts.body}`;
  const prices = opts.client?.prices ?? PRICE_WORDS;
  if (opts.client) {
    if (opts.kind !== "reply" && opts.citedCheckIds.length === 0)
      out.push("cite at least one saved fact key about the prospect (outrun.get_brief lists them)");
    for (const id of opts.citedCheckIds)
      if (!opts.scanCheckIds?.has(id)) out.push(`${id} is not a fact saved for this prospect`);
  } else {
    if (opts.kind !== "reply" && opts.citedCheckIds.length === 0)
      out.push("cite at least one check id from the latest scan (outrun.get_brief lists them)");
    if (opts.citedCheckIds.length && !opts.scanCheckIds)
      out.push("there is no scan for this domain yet; cite nothing");
    for (const id of opts.citedCheckIds)
      if (opts.scanCheckIds && !opts.scanCheckIds.has(id))
        out.push(`${id} is not a check in the latest scan`);
  }
  for (const m of text.matchAll(/\$\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g)) {
    const v = m[1]!.replace(/\.00$/, "");
    if (!prices.has(v))
      out.push(
        prices.size
          ? `$${m[1]} is not a listed price; use only ${[...prices]
              .filter((p) => !p.includes(","))
              .map((p) => `$${p}`)
              .join(" or ")}`
          : `$${m[1]}: your client lists no prices; leave prices out`,
      );
  }
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(text))
    out.push("no email addresses in the email; recipients are fixed");
  for (const m of text.matchAll(/https?:\/\/([^\s/)>\]"']+)[^\s)>\]"']*/gi)) {
    const host = m[1]!.toLowerCase().replace(/^www\./, "");
    if (host === "checkout.stripe.com" && !opts.client) {
      if (!(opts.checkoutIds ?? []).some((id) => m[0].includes(id)))
        out.push("a Stripe link must be one outrun.create_checkout_link made for this prospect");
      continue;
    }
    if (!opts.allowedHosts.some((h) => host === h || host.endsWith(`.${h}`)))
      out.push(`link to ${host} isn't allowed; link only to our pages or the prospect's own site`);
  }
  if (/unsubscribe in one click/i.test(text))
    out.push("leave out the unsubscribe line; it's added when sending");
  return [...new Set(out)];
}

export function getBrief(deps: OutreachDeps) {
  return defineTool({
    name: "get_brief",
    handler: async ({ prospectId }, ctx) => {
      const r = await prospectRow(ctx.db, prospectId, ctx.clientId);
      const client = await confirmedClient(ctx.db, ctx.clientId);
      if (ctx.clientId !== OUTRUN_CLIENT_ID && !client)
        throw new AppError("conflict", "your client's profile isn't confirmed yet; draft nothing");
      const scan = client ? null : await latestChecks(ctx.db, r.domain);
      const prior = await ctx.db
        .select({
          direction: messages.direction,
          subject: messages.subject,
          body: messages.body,
          at: messages.createdAt,
        })
        .from(messages)
        .where(and(eq(messages.prospectId, prospectId), inArray(messages.status, ["sent", "received"])))
        .orderBy(asc(messages.createdAt))
        .limit(20);
      const contact =
        r.contact && (client || !r.contact.suppressed)
          ? { contactId: r.contact.id, name: r.contact.name, role: r.contact.role, email: r.contact.email }
          : null;
      return {
        prospectId,
        company: { domain: r.domain, name: r.name },
        contact,
        scanId: scan?.scanId ?? null,
        checks: scan?.checks ?? [],
        facts: client ? r.prospect.facts.map((f) => ({ ...f, key: factCitation(f.key) })) : r.prospect.facts,
        priorMessages: prior.map((m) => ({
          direction: m.direction,
          subject: m.subject,
          body: untrusted(m.body),
          at: m.at.toISOString(),
        })),
        scoreUrl: client ? null : `${deps.appUrl}/score/${r.domain}`,
        offer: client ? null : { product: OFFER, priceUsd: PRODUCTS[OFFER].priceUsd },
        client: client
          ? {
              name: client.name,
              pitch: client.profile.offer.pitch,
              callToActionUrl: client.profile.offer.callToActionUrl,
              prices: client.profile.offer.prices,
              sender: client.profile.sender.name,
              tone: client.profile.tone,
            }
          : null,
        lessons: client ? await lessonsFor(ctx.db, ctx.clientId) : null,
      };
    },
  });
}

export function checkDraft(deps: OutreachDeps) {
  return defineTool({
    name: "check_draft",
    handler: async (input, ctx) => {
      const r = await prospectRow(ctx.db, input.prospectId, ctx.clientId);
      const client = await confirmedClient(ctx.db, ctx.clientId);
      const reasons: string[] = [];
      if (ctx.clientId !== OUTRUN_CLIENT_ID && !client)
        reasons.push("your client's profile isn't confirmed yet; draft nothing");
      // The contact flag is Outrun's own unsubscribe; a client checks its suppressions instead.
      if (!r.contact) reasons.push("this prospect has no contact yet");
      else if (
        (!client && r.contact.suppressed) ||
        (await isSuppressed(ctx.db, r.contact.email, ctx.clientId))
      )
        reasons.push("the contact is suppressed; don't email them");
      if (["unsubscribed", "lost", "won"].includes(r.prospect.stage))
        reasons.push(`the prospect is ${r.prospect.stage}`);
      // An sdr drafts first emails and follow-ups; the closer drafts replies.
      if (ctx.agent === "sdr" && input.kind === "reply") reasons.push("the sdr doesn't reply in threads");
      if (ctx.agent === "closer" && input.kind !== "reply")
        reasons.push("the closer only replies in its thread");
      let threadId: string | null = null;
      if (input.kind === "reply") {
        if (!input.threadId) reasons.push("a reply needs its threadId");
        else {
          const [t] = await ctx.db
            .select({ id: messages.id })
            .from(messages)
            .where(and(eq(messages.threadId, input.threadId), eq(messages.prospectId, input.prospectId)))
            .limit(1);
          if (!t) reasons.push("that thread isn't this prospect's");
          threadId = input.threadId;
        }
      }
      if (input.kind === "first") {
        const [already] = await ctx.db
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.prospectId, input.prospectId),
              eq(messages.kind, "first"),
              inArray(messages.status, ["approved", "sending", "sent"]),
            ),
          )
          .limit(1);
        if (already) reasons.push("a first email already went to this prospect; draft a follow-up instead");
      }
      const scan = client ? null : await latestChecks(ctx.db, r.domain);
      reasons.push(
        ...(client
          ? groundingProblems({
              subject: input.subject,
              body: input.body,
              kind: input.kind,
              citedCheckIds: input.citedCheckIds,
              scanCheckIds: new Set(r.prospect.facts.map((f) => factCitation(f.key))),
              allowedHosts: clientLinkHosts(client, r.domain),
              client: { prices: priceWords(client.profile.offer.prices.map((p) => p.amount)) },
            })
          : []),
        ...(client
          ? []
          : groundingProblems({
              subject: input.subject,
              body: input.body,
              kind: input.kind,
              citedCheckIds: input.citedCheckIds,
              scanCheckIds: scan ? new Set(scan.checks.map((c) => c.id)) : null,
              allowedHosts: [new URL(deps.appUrl).hostname.replace(/^www\./, ""), r.domain],
              checkoutIds: (
                await ctx.db
                  .select({ id: orders.stripeCheckoutId })
                  .from(orders)
                  .where(eq(orders.prospectId, input.prospectId))
              )
                .map((o) => o.id)
                .filter((id): id is string => !!id),
            })),
      );
      if (r.contact && deps.settings.demo) {
        try {
          await assertDemoRecipient(ctx.db, deps.settings, r.contact.email);
        } catch {
          reasons.push("demo mode: only the seeded demo prospect can be emailed");
        }
      }
      if (reasons.length) {
        await ctx.emit({
          actor: `naive:${ctx.agent}`,
          type: "draft.rejected",
          entityType: "prospect",
          entityId: input.prospectId,
          payload: { kind: input.kind, reasons },
        });
        return { ok: false as const, reasons };
      }
      const hash = draftHash({ ...input, threadId });
      const [m] = await ctx.db
        .insert(messages)
        .values({
          clientId: ctx.clientId,
          prospectId: input.prospectId,
          contactId: r.contact!.id,
          threadId,
          direction: "outbound",
          kind: input.kind,
          status: "checked",
          toEmail: r.contact!.email,
          subject: input.subject,
          body: input.body,
          citedCheckIds: [...input.citedCheckIds],
          draftHash: hash,
        })
        .returning({ id: messages.id });
      if (input.kind === "first" && ["filed", "researched"].includes(r.prospect.stage)) {
        await ctx.db.update(prospects).set({ stage: "drafted" }).where(eq(prospects.id, input.prospectId));
      }
      await ctx.emit({
        actor: `naive:${ctx.agent}`,
        type: "draft.checked",
        entityType: "message",
        entityId: m!.id,
        payload: { kind: input.kind, cited: input.citedCheckIds },
      });
      return { ok: true as const, draftId: m!.id, hash };
    },
  });
}

/** Shared by send_email and reply_email: everything is re-checked when the approved call runs. */
async function queueApprovedDraft(
  deps: OutreachDeps,
  ctx: ToolContext,
  input: { draftId: string; hash: string },
  kinds: readonly ("first" | "followup" | "reply")[],
) {
  const [m] = await ctx.db
    .select()
    .from(messages)
    .where(and(eq(messages.id, input.draftId), eq(messages.clientId, ctx.clientId)));
  if (!m || m.direction !== "outbound" || !kinds.includes(m.kind as never))
    throw new AppError("not_found", "no such draft for this tool");
  if (m.status === "approved" || m.status === "sending" || m.status === "sent")
    return { messageId: m.id, status: "queued" as const };
  if (m.status !== "checked" && m.status !== "awaiting_approval")
    throw new AppError("conflict", `the draft is ${m.status}; check a new one`);
  const again = draftHash({
    prospectId: m.prospectId!,
    kind: m.kind,
    threadId: m.threadId,
    subject: m.subject,
    body: m.body,
    citedCheckIds: m.citedCheckIds,
  });
  if (input.hash !== m.draftHash || again !== m.draftHash)
    throw new AppError("conflict", "the draft changed after it was checked; run outrun.check_draft again");
  if (!m.toEmail || (await isSuppressed(ctx.db, m.toEmail, ctx.clientId)))
    throw new AppError("forbidden", "the recipient is suppressed");
  const now = ctx.now();
  const cap = await effectiveSendCap(ctx.db, deps.settings.sendDailyCap, now, ctx.clientId);
  if ((await sentToday(ctx.db, now, ctx.clientId)) >= cap)
    throw new AppError("rate_limited", "today's send cap is used; it resets tomorrow", {
      retryAfterSeconds: 3600,
    });
  if (!(await deps.mx(m.toEmail.split("@")[1] ?? "")))
    throw new AppError("bad_request", "the recipient's domain takes no mail");
  await assertDemoRecipient(ctx.db, deps.settings, m.toEmail);

  // The call only runs once a person allowed it in Naive, so this is the approval.
  const moved = await ctx.db
    .update(messages)
    .set({ status: "approved" })
    .where(and(eq(messages.id, m.id), inArray(messages.status, ["checked", "awaiting_approval"])))
    .returning({ id: messages.id });
  if (moved[0]) {
    await ctx.enqueue({
      type: "send_email",
      payload: { messageId: m.id },
      idempotencyKey: `send:${m.id}`,
      traceId: randomUUID(),
    });
  }
  return { messageId: m.id, status: "queued" as const };
}

export const sendEmailTool = (deps: OutreachDeps) =>
  defineTool({
    name: "send_email",
    handler: (input, ctx) => queueApprovedDraft(deps, ctx, input, ["first", "followup"]),
  });
export const replyEmailTool = (deps: OutreachDeps) =>
  defineTool({
    name: "reply_email",
    handler: (input, ctx) => queueApprovedDraft(deps, ctx, input, ["reply"]),
  });

/** Prospects due a follow-up: +3 then +7 days after the first email, no reply, not suppressed. */
export async function dueFollowups(db: Db, clientId: string, now: Date, limit = 50) {
  const rows = await db
    .select({
      prospectId: prospects.id,
      step: prospects.followupStep,
      firstAt: sql<Date>`(select min(m.sent_at) from messages m where m.prospect_id = ${prospects.id} and m.kind = 'first' and m.status = 'sent')`,
    })
    .from(prospects)
    .innerJoin(contacts, eq(prospects.contactId, contacts.id))
    .where(
      and(
        eq(prospects.clientId, clientId),
        eq(prospects.stage, "contacted"),
        eq(contacts.suppressed, false),
        sql`${prospects.followupStep} < ${FOLLOWUP_OFFSETS_DAYS.length}`,
        sql`not exists (select 1 from messages m where m.prospect_id = ${prospects.id} and m.direction = 'inbound')`,
        sql`not exists (select 1 from messages m where m.prospect_id = ${prospects.id} and m.kind = 'followup' and m.status in ('checked','awaiting_approval','approved','sending'))`,
        sql`not exists (select 1 from suppressions s where (s.value = lower(${contacts.email}) or s.value = split_part(lower(${contacts.email}), '@', 2)) and (s.client_id is null or s.client_id = ${clientId}))`,
      ),
    )
    .orderBy(asc(prospects.lastContactedAt));
  const due: { prospectId: string; step: 1 | 2; dueAt: string }[] = [];
  for (const r of rows) {
    if (!r.firstAt) continue;
    const step = (r.step + 1) as 1 | 2;
    const dueAt = new Date(new Date(r.firstAt).getTime() + FOLLOWUP_OFFSETS_DAYS[step - 1]! * DAY);
    if (dueAt <= now) due.push({ prospectId: r.prospectId, step, dueAt: dueAt.toISOString() });
    if (due.length >= limit) break;
  }
  return due;
}

export const listDueFollowups = defineTool({
  name: "list_due_followups",
  handler: async ({ limit }, ctx) => ({ due: await dueFollowups(ctx.db, ctx.clientId, ctx.now(), limit) }),
});

export const followupsDueCount = async (ctx: ToolContext): Promise<number> =>
  (await dueFollowups(ctx.db, ctx.clientId, ctx.now(), 1000)).length;

export const getThread = defineTool({
  name: "get_thread",
  handler: async ({ threadId }, ctx) => {
    const rows = await ctx.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.threadId, threadId),
          eq(messages.clientId, ctx.clientId),
          inArray(messages.status, ["sent", "received"]),
        ),
      )
      .orderBy(asc(messages.createdAt))
      .limit(50);
    const prospectId = rows.find((m) => m.prospectId)?.prospectId;
    if (!prospectId) throw new AppError("not_found", "no thread with a prospect by that id");
    return {
      threadId,
      prospectId,
      messages: rows.map((m) => ({
        id: m.id,
        direction: m.direction,
        subject: m.subject,
        body: untrusted(m.body),
        at: (m.sentAt ?? m.createdAt).toISOString(),
      })),
    };
  },
});

export const markOutcome = defineTool({
  name: "mark_outcome",
  handler: async ({ prospectId, outcome, note }, ctx) => {
    const r = await prospectRow(ctx.db, prospectId, ctx.clientId);
    // A paid or unsubscribed prospect keeps its stage; the closer can't undo either.
    const locked = ["won", "unsubscribed", "checkout_sent"].includes(r.prospect.stage) && outcome !== "lost";
    const stage = locked ? r.prospect.stage : outcome;
    if (!locked) {
      await ctx.db.update(prospects).set({ stage }).where(eq(prospects.id, prospectId));
      await ctx.enqueue({
        type: "sync_crm",
        payload: { prospectId },
        idempotencyKey: `crm:${prospectId}:outcome:${outcome}`,
        traceId: randomUUID(),
      });
    }
    await ctx.emit({
      actor: `naive:${ctx.agent}`,
      type: "prospect.outcome",
      entityType: "prospect",
      entityId: prospectId,
      payload: { outcome, stage, note: note ?? null },
    });
    return { stage };
  },
});

/** Every outreach tool, for allTools. */
export const outreachTools = (deps: OutreachDeps) => [
  getBrief(deps),
  checkDraft(deps),
  sendEmailTool(deps),
  replyEmailTool(deps),
  listDueFollowups,
  getThread,
  markOutcome,
];
