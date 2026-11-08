import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { OUTRUN_CLIENT_ID } from "../constants";
import { clients, companies, contacts, messages, prospects, suppressions } from "../db/schema";
import { createEmitter } from "../events";
import { FakeAgentMail } from "../fakes";
import { createTempDatabase, type TempDb } from "../testing/db";
import { acceptAgentMailEvent } from "../webhooks/agentmail";
import { runClientEmailSetup } from "./clientDomain";
import { isSuppressed } from "./rules";
import { runSendEmail, type SendDeps } from "./send";
import { readUnsubscribeToken, unsubscribeContact } from "./unsubscribe";

const SECRET = "unsub-secret-test"; // gitleaks:allow
const now = new Date("2026-11-10T18:00:00Z");

describe("a client's own email", () => {
  let t: TempDb;
  let am: FakeAgentMail;
  let jobs: { type: string; idempotencyKey: string; runAfter?: string }[];
  let clientId: string;
  let contactId: string;
  let prospectId: string;

  const domainDeps = () => ({
    db: t.db,
    emit: createEmitter(t.db),
    agentmail: am,
    enqueue: async (j: { type: string; idempotencyKey: string; runAfter?: string }) => {
      jobs.push(j);
      return { jobId: "j" };
    },
    now: () => now,
  });
  const sendDeps = (): SendDeps => ({
    db: t.db,
    emit: createEmitter(t.db),
    agentmail: am,
    mx: async () => true,
    enqueue: async () => ({}),
    appUrl: "https://outrun.example",
    unsubscribeSecret: SECRET,
    inbox: "hello@outrun.example",
    settings: { sendDailyCap: 30, demo: false },
    now: () => now,
  });
  async function approvedDraft() {
    const [m] = await t.db
      .insert(messages)
      .values({
        clientId,
        prospectId,
        contactId,
        direction: "outbound",
        kind: "first",
        status: "approved",
        toEmail: "cfo@lead.dev",
        subject: "Invoices",
        body: "Hi, quick idea about your invoice matching.",
      })
      .returning();
    return m!;
  }

  beforeAll(async () => {
    t = await createTempDatabase();
    am = new FakeAgentMail();
    jobs = [];
    const [c] = await t.db
      .insert(clients)
      .values({
        slug: "acme-pay",
        name: "Acme Pay",
        domain: "acme-pay.dev",
        status: "email_setup",
        profileConfirmedAt: now,
        profile: { sender: { name: "Ada Lovelace", postalAddress: "1 Market St, San Francisco, CA 94105" } },
      })
      .returning();
    clientId = c!.id;
    const [co] = await t.db.insert(companies).values({ domain: "lead.dev", source: "fixture" }).returning();
    const [ct] = await t.db
      .insert(contacts)
      .values({ companyId: co!.id, name: "Cy", email: "cfo@lead.dev", sourceUrl: "https://lead.dev/team" })
      .returning();
    contactId = ct!.id;
    const [p] = await t.db
      .insert(prospects)
      .values({ clientId, companyId: co!.id, contactId, stage: "drafted" })
      .returning();
    prospectId = p!.id;
    // Outrun prospects the same company and contact.
    await t.db.insert(prospects).values({ companyId: co!.id, contactId, stage: "contacted" });
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("refuses to send before the client's domain is verified", async () => {
    const m = await approvedDraft();
    expect(await runSendEmail(sendDeps(), m.id, "tr")).toEqual({
      status: "refused",
      reason: "the client is email_setup",
    });
    expect(am.sent).toHaveLength(0);
  });

  it("registers the domain, waits for DNS, then creates the client's inbox and goes active", async () => {
    const started = now.toISOString();
    const first = await runClientEmailSetup(domainDeps(), clientId, started, "tr");
    expect(first.state).toBe("pending");
    const [pending] = await t.db.select().from(clients).where(eq(clients.id, clientId));
    expect(pending).toMatchObject({ dnsStatus: "pending", sendingDomain: "acme-pay.dev" });
    expect(pending!.dnsRecords.map((r) => r.type)).toEqual(["TXT", "TXT", "MX"]);
    expect(jobs.at(-1)).toMatchObject({ type: "client_email_setup", runAfter: "2026-11-10T18:15:00.000Z" });

    am.addDns("acme-pay.dev");
    const done = await runClientEmailSetup(domainDeps(), clientId, started, "tr");
    expect(done).toEqual({ state: "verified", inboxId: "hello@acme-pay.dev", status: "active" });
    expect([...am.domains.values()]).toHaveLength(1);
    const [row] = await t.db.select().from(clients).where(eq(clients.id, clientId));
    expect(row).toMatchObject({
      status: "active",
      dnsStatus: "verified",
      agentmailInboxId: "hello@acme-pay.dev",
    });
    // A rerun changes nothing and creates no second inbox.
    await runClientEmailSetup(domainDeps(), clientId, started, "tr");
    expect(am.inboxes.size).toBe(1);
  });

  it("gives up after 72 hours of unverified DNS", async () => {
    const [b] = await t.db
      .insert(clients)
      .values({ slug: "beta", name: "Beta", domain: "beta-co.dev", status: "email_setup" })
      .returning();
    const old = new Date(now.getTime() - 73 * 3_600_000).toISOString();
    expect(await runClientEmailSetup(domainDeps(), b!.id, old, "tr")).toEqual({ state: "gave_up" });
  });

  it("sends from the client's own inbox, signed with its sender and postal address", async () => {
    const m = await approvedDraft();
    const out = await runSendEmail(sendDeps(), m.id, "tr");
    expect(out.status).toBe("sent");
    const sent = am.sent.at(-1)!;
    expect(sent.inboxId).toBe("hello@acme-pay.dev");
    expect(sent.text).toContain("Ada Lovelace, Acme Pay · 1 Market St, San Francisco, CA 94105");
    expect(sent.listUnsubscribe).toContain("mailto:hello@acme-pay.dev");
    const token = /\/u\/([\w.-]+)/.exec(sent.text)![1]!;
    expect(readUnsubscribeToken(SECRET, token)).toEqual({ contactId, clientId });
  });

  it("an unsubscribe from the client's email stops that client only; a hard bounce stops everyone", async () => {
    await unsubscribeContact({ db: t.db, emit: createEmitter(t.db) }, contactId, "link", clientId);
    expect(await isSuppressed(t.db, "cfo@lead.dev", clientId)).toBe(true);
    expect(await isSuppressed(t.db, "cfo@lead.dev", OUTRUN_CLIENT_ID)).toBe(false);
    const stages = await t.db.select({ c: prospects.clientId, s: prospects.stage }).from(prospects);
    expect(stages.find((r) => r.c === clientId)!.s).toBe("unsubscribed");
    expect(stages.find((r) => r.c === OUTRUN_CLIENT_ID)!.s).toBe("contacted");
    // Unsubscribing from Outrun too is its own row, not a conflict.
    await unsubscribeContact({ db: t.db, emit: createEmitter(t.db) }, contactId, "link");
    expect(await t.db.select().from(suppressions).where(eq(suppressions.value, "cfo@lead.dev"))).toHaveLength(
      2,
    );

    await t.db.insert(suppressions).values({ value: "gone@lead.dev", kind: "email", reason: "hard_bounce" });
    expect(await isSuppressed(t.db, "gone@lead.dev", clientId)).toBe(true);
    expect(await isSuppressed(t.db, "gone@lead.dev", OUTRUN_CLIENT_ID)).toBe(true);
  });

  it("a reply to the client's inbox is the client's, threaded to its prospect", async () => {
    const [sent] = await t.db
      .select()
      .from(messages)
      .where(and(eq(messages.clientId, clientId), eq(messages.status, "sent")));
    const r = await acceptAgentMailEvent({
      body: {
        event_type: "message.received",
        event_id: "evt_client_reply",
        message: {
          message_id: "msg_in_1",
          thread_id: sent!.threadId,
          inbox_id: "hello@acme-pay.dev",
          from: "Cy <cfo@lead.dev>",
          subject: "Re: Invoices",
          text: "Tell me more",
        },
      },
      db: { db: t.db, pool: t.pool },
      queue: { enqueue: async () => ({ jobId: "j" }) },
      emit: createEmitter(t.db),
    });
    expect(r.status).toBe(200);
    const [inbound] = await t.db.select().from(messages).where(eq(messages.providerId, "msg_in_1"));
    expect(inbound).toMatchObject({ clientId, prospectId, direction: "inbound" });
  });
});
