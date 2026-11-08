/**
 * pnpm e2e:full: the whole business on one throwaway database, through the real worker, the real
 * job handlers, the real crew tool registry and the real webhook acceptors. Only the outside
 * services are fakes (Naive, Stripe, AgentMail, HubSpot, Apify, Monid, the model, DNS), so it
 * spends nothing and sends nothing. Naive is the scripted FakeNaiveClient: it calls our real
 * tools, holds `ask` tools for a person, and fires session.idle like the webhook does.
 *
 *   A. Outbound: sources → prospector files → scan → researcher → sdr drafts → a person approves
 *      on the Approvals page → AgentMail sends → reply webhook → triage → closer replies with a
 *      checkout link (approved) → Stripe payment → auditor crawls → Kit → report delivered,
 *      with HubSpot mirrored along the way.
 *   B. Agent to agent: a buyer's agent quotes and buys through the public tools, idempotently,
 *      pays, and reads the order back as delivered. No person is involved.
 */
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { loadConfig } from "@outrun/core";
import type { AgentName } from "@outrun/core/contracts";
import type { ToolContext } from "@outrun/core/crew";
import { and, companies, eq, events, messages, orders, prospects, reports, scans } from "@outrun/core/db";
import { createFakes, FakeLlmProvider, FakeNaiveClient } from "@outrun/core/fakes";
import type { LlmRequest } from "@outrun/core/integrations";
import { callPublicTool } from "@outrun/core/public/service";
import type { Runtime } from "@outrun/core/runtime";
import { DEMO_PLACEHOLDER, seedDemo } from "@outrun/core/seed";
import { createTempDatabase } from "@outrun/core/testing/db";
import { acceptAgentMailEvent } from "@outrun/core/webhooks/agentmail";
import { handleApifyWebhook } from "@outrun/core/webhooks/apify";
import { acceptStripeEvent } from "@outrun/core/webhooks/stripe";
import { startWorker } from "@outrun/worker";
import { submitDecisions } from "../apps/web/lib/approvals-core";

const TIMEOUT_MS = 60_000;
const APIFY_SECRET = "e2e-apify-secret"; // gitleaks:allow (throwaway test value)
const DOMAIN = DEMO_PLACEHOLDER.domain;
const INBOX = DEMO_PLACEHOLDER.inbox;

let step = 0;
const ok = (what: string) => console.log(`  ok  ${String(++step).padStart(2)} ${what}`);
function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`FAILED: ${what}`);
}
async function waitFor<T>(what: string, fn: () => Promise<T | undefined | null | false>): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > TIMEOUT_MS) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** A model that answers every schema: triage gets a label, Kit assets cite the first finding. */
function scriptedModel(name: "openai" | "openrouter"): FakeLlmProvider {
  return new FakeLlmProvider(name, {
    triage_reply: { label: "interested", confidence: 0.92 },
    "*": (req: LlmRequest) => {
      const s = req.jsonSchema.name;
      if (s === "kit_server_json")
        return {
          content: JSON.stringify({
            name: "dev.outrun.demo/mcp",
            description: "Demo Co's agent API [f1]",
            version: "1.0.0",
            remotes: [{ type: "streamable-http", url: "https://demo.outrun.dev/mcp" }],
          }),
        };
      if (s.startsWith("kit_")) return { content: `# ${s.slice(4)}\n\nAgents can't find the docs yet [f1].` };
      return new Error(`e2e model: no reply for ${s}`);
    },
  });
}

async function main(): Promise<void> {
  const tmp = await createTempDatabase();
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: tmp.url,
    DATABASE_URL_UNPOOLED: tmp.url,
    OUTRUN_DEMO: "true",
    APP_URL: "https://outrun.example",
    CREW_TOKEN_SECRET: "e2e-crew-secret-0123456789abcdef", // gitleaks:allow (throwaway test value)
  });

  // The fake Naive needs the runtime's registry, which exists only once the worker starts.
  const naiveOpts: ConstructorParameters<typeof FakeNaiveClient>[0] = {};
  const naive = new FakeNaiveClient(naiveOpts);
  const fakes = createFakes({
    naive,
    llm: { openai: scriptedModel("openai"), openrouter: scriptedModel("openrouter") },
  });
  let rt: Runtime | undefined;
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  let passed = false;
  try {
    worker = await startWorker({
      config,
      integrations: fakes,
      mx: async () => true,
      sitePreflight: async () => ({}),
      schedules: false,
      retryDelaySeconds: 1,
      retryBackoff: false,
      pollingIntervalSeconds: 0.5,
      handlers: {
        // The scanner itself fetches live sites (Matthew's tests cover it); here it writes a fixed scan.
        scan_domain: async (env) => {
          const domain = String(env.payload.domain);
          await rt!.db.db.insert(scans).values({
            domain,
            version: 1,
            scannerVersion: "e2e",
            score: 38,
            checks: [
              {
                id: "llms-txt",
                label: "llms.txt",
                status: "fail",
                evidence: "404 at /llms.txt",
                weight: 10,
                category: "readiness",
              },
              {
                id: "openapi",
                label: "OpenAPI",
                status: "pass",
                evidence: "found /openapi.json",
                weight: 6,
                category: "readiness",
              },
            ],
          });
          await rt!.emit({
            actor: "worker",
            type: "scan.completed",
            entityType: "system",
            entityId: domain,
            payload: {},
          });
        },
      },
    });
    rt = worker.runtime;
    const db = rt.db.db;
    naiveOpts.registry = rt.registry;
    naiveOpts.ctx = (agent: AgentName): ToolContext => ({
      agent,
      requestId: randomUUID(),
      db,
      now: () => new Date(),
      enqueue: (job, o) => rt!.queue.enqueue(job, o),
      emit: rt!.emit,
    });
    // Naive's session.idle webhook, as acceptNaiveDelivery enqueues it.
    naiveOpts.onIdle = async (sessionId) => {
      const id = `evt_${randomUUID()}`;
      await rt!.queue.enqueue({
        type: "handle_naive_event",
        payload: {
          envelope: {
            id,
            type: "session.idle",
            created_at: new Date().toISOString(),
            data: { session_id: sessionId },
          },
        },
        idempotencyKey: `naive:${id}`,
        traceId: id,
      });
    };
    const startAgent = (agent: AgentName, entity: { type: "prospect" | "system"; id: string }, key: string) =>
      rt!.queue.enqueue({
        type: "start_session",
        payload: { agent, entity, message: `e2e: ${agent} on ${entity.type} ${entity.id}` },
        idempotencyKey: key,
        traceId: key,
      });
    const draftRef = (calls: { tool: string; result?: unknown }[]) => {
      const d = [...calls]
        .reverse()
        .find((c) => c.tool === "check_draft" && (c.result as { ok?: boolean })?.ok)?.result as
        { draftId: string; hash: string } | undefined;
      if (!d) throw new Error("no passing check_draft before the send");
      return { draftId: d.draftId, hash: d.hash };
    };
    const approveHeld = async (kind: "first" | "reply") => {
      const held = await waitFor(`the ${kind} email to wait for approval`, async () => {
        const [m] = await db
          .select()
          .from(messages)
          .where(and(eq(messages.kind, kind), eq(messages.status, "awaiting_approval")));
        return m;
      });
      const n = await submitDecisions(rt!, "srikanth@outrun.example", {
        ids: [held.id],
        decision: "allow",
        reason: "",
      });
      check(n === 1, "the approval reached Naive");
      return held;
    };
    const failedCall = () => naive.toolCalls.find((c) => c.error);

    console.log("A. outbound, the demo prospect from discovery to a delivered report");
    const { prospectId, contactId } = await seedDemo(db);

    await rt.queue.enqueue({
      type: "refresh_sources",
      payload: {},
      idempotencyKey: "e2e:refresh",
      traceId: "e2e",
    });
    await waitFor(
      "sources to refresh",
      async () => (await db.select().from(events).where(eq(events.type, "sources.refreshed")))[0],
    );
    const candidates = await db.select().from(companies).where(eq(companies.kind, "candidate"));
    check(candidates.length > 0, "refresh_sources added candidates");
    ok(`refresh_sources added ${candidates.length} fixture candidates`);

    naive.script("prospector", [
      { tool: "list_candidates", input: { limit: 5 } },
      {
        tool: "file_prospect",
        input: (calls: { tool: string; result?: unknown }[]) => {
          const list = calls.find((c) => c.tool === "list_candidates")?.result as {
            candidates: { companyId: string }[];
          };
          return { companyId: list.candidates[0]!.companyId, reason: "ships a public API agents call" };
        },
      },
    ]);
    await startAgent("prospector", { type: "system", id: "prospector" }, "e2e:prospector");
    const filed = await waitFor(
      "the prospector to file",
      async () => (await db.select().from(events).where(eq(events.type, "prospect.filed")))[0],
    );
    await waitFor(
      "the filed prospect's CRM sync",
      async () =>
        (
          await db
            .select()
            .from(events)
            .where(and(eq(events.type, "crm.synced"), eq(events.entityId, filed.entityId)))
        )[0],
    );
    ok("prospector listed candidates and filed one; scan and HubSpot sync ran");

    await rt.queue.enqueue({
      type: "scan_domain",
      payload: { domain: DOMAIN, prospectId },
      idempotencyKey: "e2e:scan",
      traceId: "e2e",
    });
    await waitFor(
      "the demo scan",
      async () => (await db.select().from(scans).where(eq(scans.domain, DOMAIN)))[0],
    );
    ok(`scan_domain stored the scan for ${DOMAIN}`);

    naive.script("researcher", [
      { tool: "get_prospect", input: { prospectId } },
      { tool: "enrich_company", input: { prospectId } },
      {
        tool: "save_research",
        input: {
          prospectId,
          facts: [
            {
              key: "product",
              value: "APIs for AI agents, sold to SaaS teams",
              sourceUrl: `https://${DOMAIN}/`,
            },
          ],
          contacts: [],
        },
      },
    ]);
    await startAgent("researcher", { type: "prospect", id: prospectId }, "e2e:researcher");
    const researched = await waitFor("research to be saved", async () => {
      const bad = failedCall();
      if (bad) throw new Error(`${bad.tool} failed: ${bad.error!.code} ${bad.error!.message}`);
      const [p] = await db.select().from(prospects).where(eq(prospects.id, prospectId));
      return p?.stage === "researched" ? p : undefined;
    });
    check(researched.fitScore !== null && researched.gapScore === 62, "fit and gap scores computed");
    ok(`researcher enriched and saved; fit ${researched.fitScore}, gap ${researched.gapScore}`);

    naive.script("sdr", [
      { tool: "get_brief", input: { prospectId } },
      {
        tool: "check_draft",
        input: {
          prospectId,
          kind: "first",
          subject: "AI agents can't find demo.outrun.dev's docs",
          body: "Hi, your site has no llms.txt, so AI agents skip it. Your score: https://outrun.example/score/demo.outrun.dev. The audit kit fixes it for $499.",
          citedCheckIds: ["llms_txt"],
        },
      },
      { tool: "send_email", input: draftRef },
    ]);
    await startAgent("sdr", { type: "prospect", id: prospectId }, "e2e:sdr");
    const first = await approveHeld("first");
    ok("sdr drafted a grounded email; check_draft passed; the send waited for a person");
    await waitFor("the first email to send", async () => {
      const bad = failedCall();
      if (bad) throw new Error(`${bad.tool} failed: ${bad.error!.code} ${bad.error!.message}`);
      const [m] = await db.select().from(messages).where(eq(messages.id, first.id));
      return m?.status === "sent" ? m : undefined;
    });
    const sent1 = fakes.agentmail.sent[0];
    check(sent1 && sent1.to === INBOX, "AgentMail sent to the demo inbox");
    check(
      sent1.listUnsubscribe.includes("/api/unsubscribe/") && sent1.text.includes("/u/"),
      "List-Unsubscribe and the footer link",
    );
    const [contacted] = await db.select().from(prospects).where(eq(prospects.id, prospectId));
    check(contacted?.stage === "contacted", "the prospect is contacted");
    ok("approved on the Approvals page; AgentMail sent once with one-click unsubscribe; prospect contacted");

    const [firstSent] = await db.select().from(messages).where(eq(messages.id, first.id));
    const threadId = firstSent!.threadId!;
    naive.script("closer", [
      { tool: "get_thread", input: { threadId } },
      { tool: "create_checkout_link", input: { prospectId, product: "auditKit" } },
      {
        tool: "check_draft",
        input: (calls: { tool: string; result?: unknown }[]) => {
          const link = [...calls].reverse().find((c) => c.tool === "create_checkout_link")?.result as {
            checkoutUrl: string;
          };
          return {
            prospectId,
            kind: "reply",
            threadId,
            subject: "Re: AI agents can't find demo.outrun.dev's docs",
            body: `Glad it's useful. Here's the Audit + Kit checkout ($499): ${link.checkoutUrl}`,
            citedCheckIds: [],
          };
        },
      },
      { tool: "reply_email", input: draftRef },
    ]);
    const received = {
      event_type: "message.received",
      event_id: "evt_am_reply_1",
      message: {
        message_id: "<reply-1@demo.outrun.dev>",
        thread_id: threadId,
        inbox_id: "hello@send.outrun.example",
        from: INBOX,
        subject: "Re: AI agents can't find demo.outrun.dev's docs",
        text: "Interesting! How do we get the audit?\n\nOn Tue, Outrun wrote:\n> ...",
        extracted_text: "Interesting! How do we get the audit?",
      },
    };
    const reply = await acceptAgentMailEvent({ body: received, db: rt.db, queue: rt.queue, emit: rt.emit });
    check(reply.status === 200, "AgentMail webhook accepted the reply");
    const dup = await acceptAgentMailEvent({ body: received, db: rt.db, queue: rt.queue, emit: rt.emit });
    check((dup.body as { duplicate?: boolean }).duplicate === true, "a redelivered webhook is a no-op");
    const triaged = await waitFor(
      "triage",
      async () => (await db.select().from(events).where(eq(events.type, "triage.classified")))[0],
    );
    check(
      (triaged.payload as { label: string }).label === "interested",
      "triage labelled the reply interested",
    );
    ok("reply webhook stored the reply once; triage labelled it interested and started the closer");

    const replyMsg = await approveHeld("reply");
    await waitFor("the reply to send", async () => {
      const bad = failedCall();
      if (bad) throw new Error(`${bad.tool} failed: ${bad.error!.code} ${bad.error!.message}`);
      const [m] = await db.select().from(messages).where(eq(messages.id, replyMsg.id));
      return m?.status === "sent" ? m : undefined;
    });
    const sent2 = fakes.agentmail.sent[1];
    check(
      sent2?.inReplyTo === "<reply-1@demo.outrun.dev>" && sent2.threadId === threadId,
      "the reply threads under the prospect's email",
    );
    check(
      /https:\/\/checkout\.stripe\.com\/c\/pay\/cs_/.test(sent2.text),
      "the reply carries the checkout link",
    );
    const [order] = await db.select().from(orders).where(eq(orders.prospectId, prospectId));
    check(
      order && order.state === "pending" && Number(order.amountUsd) === 499,
      "a $499 pending order exists",
    );
    ok("closer made a checkout link and replied in the thread after approval");

    naive.script("auditor", [{ tool: "start_crawl", input: { orderId: order.id } }]);
    await pay(rt, order.id, order.stripeCheckoutId!, "evt_e2e_pay_a");
    await waitFor("the paid prospect to be won", async () => {
      const [p] = await db.select().from(prospects).where(eq(prospects.id, prospectId));
      return p?.stage === "won";
    });
    check(
      fakes.agentmail.transactional.some((m) => m.subject.startsWith("Outrun receipt")),
      "a receipt was sent",
    );
    ok("Stripe webhook marked the order paid, sent the receipt and won the prospect");

    await deliverAudit(rt, naive, fakes.apify, order.id);
    ok("auditor crawled, saved cited findings; the Kit was built and the report delivered");

    await waitFor("HubSpot to mirror the won deal", async () => {
      const deal = fakes.hubspot.records.get(`deal:${prospectId}`)?.data as { stage?: string } | undefined;
      return deal?.stage === "won";
    });
    check(fakes.hubspot.records.has(`contact:${contactId}`), "HubSpot has the contact");
    await waitFor("the emails on the HubSpot timeline", async () =>
      fakes.hubspot.emails.length >= 3 ? true : undefined,
    );
    ok(`HubSpot mirrored the company, contact, won deal and ${fakes.hubspot.emails.length} emails`);

    console.log("B. agent to agent, a buyer's agent with no person involved");
    const deps = {
      db,
      emit: rt.emit,
      stripe: fakes.stripe,
      appUrl: config.appUrl,
      scan: async () => {
        throw new Error("not used");
      },
    };
    const meta = { protocol: "a2a" as const, callerIp: "203.0.113.7", requestId: "e2e" };
    const quote = await callPublicTool(deps, "get_quote", { domain: DOMAIN, package: "auditKit" }, meta);
    check((quote as { priceUsd: number }).priceUsd === 499, "the quote is the listed price");
    const buy = {
      domain: DOMAIN,
      package: "auditKit",
      contactEmail: INBOX,
      idempotencyKey: "e2e-agent-buy-0001",
    };
    const a = await callPublicTool(deps, "buy_audit", buy, meta);
    const b = await callPublicTool(deps, "buy_audit", buy, meta);
    check(a.orderId === b.orderId && a.checkoutUrl === b.checkoutUrl, "buy_audit is idempotent");
    ok("quote at $499; buy_audit twice returned one order and one checkout");

    const [agentOrder] = await db.select().from(orders).where(eq(orders.id, a.orderId));
    naive.script("auditor", [{ tool: "start_crawl", input: { orderId: a.orderId } }]);
    await pay(rt, a.orderId, agentOrder!.stripeCheckoutId!, "evt_e2e_pay_b");
    await deliverAudit(rt, naive, fakes.apify, a.orderId);
    const status = await callPublicTool(deps, "get_order_status", { orderId: a.orderId }, meta);
    check(
      status.state === "delivered" && status.reportUrl,
      "get_order_status shows delivered with a report link",
    );
    ok(`paid; delivered; get_order_status → ${status.state}, ${status.reportUrl}`);

    const dead = await db.select().from(events).where(eq(events.type, "job.dead"));
    check(
      dead.length === 0,
      `no job dead-lettered (${dead.map((d) => JSON.stringify(d.payload)).join("; ")})`,
    );
    const bad = failedCall();
    check(!bad, `no crew tool call failed (${bad?.tool}: ${bad?.error?.message})`);
    ok("no job dead-lettered and no tool call failed along the way");
    passed = true;
  } finally {
    await worker?.stop().catch(() => {});
    await tmp.drop().catch(() => {});
  }
  console.log(passed ? "\ne2e:full passed" : "\ne2e:full FAILED");
  if (!passed) process.exit(1);
}

/** Stripe's checkout.session.completed, through the real acceptor (signature checks have their own tests). */
async function pay(rt: Runtime, orderId: string, checkoutId: string, eventId: string): Promise<void> {
  const event = {
    id: eventId,
    object: "event",
    type: "checkout.session.completed",
    livemode: false,
    data: {
      object: {
        id: checkoutId,
        object: "checkout.session",
        mode: "payment",
        payment_status: "paid",
        payment_intent: `pi_${eventId}`,
        client_reference_id: orderId,
        metadata: { orderId, product: "auditKit" },
      },
    },
  } as unknown as Stripe.Event;
  const res = await acceptStripeEvent({ event, db: rt.db, queue: rt.queue });
  check(res.status === 200, "Stripe webhook accepted");
  await waitFor(`order ${orderId} to be paid`, async () => {
    const [o] = await rt.db.db.select().from(orders).where(eq(orders.id, orderId));
    return o && o.state !== "pending" ? o : undefined;
  });
}

/** The auditor's crawl finishes (Apify webhook), it reads pages and saves findings; Kit and report follow. */
async function deliverAudit(
  rt: Runtime,
  naive: FakeNaiveClient,
  apify: ReturnType<typeof createFakes>["apify"],
  orderId: string,
): Promise<void> {
  const db = rt.db.db;
  const session = await waitFor("the auditor's crawl to start", async () =>
    [...naive.sessions.values()].find(
      (s) => s.agent === "auditor" && JSON.stringify(s.steps[0]?.input).includes(orderId) && s.cursor >= 1,
    ),
  );
  const crawl = naive.toolCalls.find((c) => c.sessionId === session.id && c.tool === "start_crawl");
  if (crawl?.error) throw new Error(`start_crawl failed: ${crawl.error.code} ${crawl.error.message}`);
  const run = await waitFor("the Apify run", async () => apify.runs.at(-1));
  // What the auditor does once Naive wakes it with the crawl.
  session.steps.push(
    { tool: "get_crawl_pages", input: { orderId, limit: 10 } },
    {
      tool: "save_audit",
      input: (calls: { tool: string; result?: unknown }[]) => {
        const pages = [...calls].reverse().find((c) => c.tool === "get_crawl_pages")?.result as {
          pages: { url: string }[];
        };
        return {
          orderId,
          summary: "Agents can't find the docs: no llms.txt, and the quickstart is buried.",
          findings: [
            {
              title: "No llms.txt",
              severity: "high",
              detail: "GET /llms.txt returns 404.",
              checkId: "llms_txt",
            },
            {
              title: "Quickstart is hard to find",
              severity: "medium",
              detail: "Only linked from the footer.",
              pageUrl: pages.pages[0]!.url,
            },
          ],
        };
      },
    },
  );
  const body = JSON.stringify({
    eventType: "ACTOR.RUN.SUCCEEDED",
    resource: { id: run.runId, status: "SUCCEEDED", defaultDatasetId: `ds_${run.runId}`, usageTotalUsd: 0.2 },
  });
  const res = await handleApifyWebhook({
    rawBody: body,
    header: APIFY_SECRET,
    secret: APIFY_SECRET,
    db: rt.db,
    queue: rt.queue,
  });
  check(res.status === 200, `Apify webhook accepted (${JSON.stringify(res.body)})`);
  await waitFor(`order ${orderId} to be delivered`, async () => {
    const bad = naive.toolCalls.find((c) => c.error);
    if (bad) throw new Error(`${bad.tool} failed: ${bad.error!.code} ${bad.error!.message}`);
    const dead = (await db.select().from(events).where(eq(events.type, "job.dead")))[0];
    if (dead) throw new Error(`a job dead-lettered: ${JSON.stringify(dead.payload)}`);
    const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
    return o?.state === "delivered" ? o : undefined;
  });
  const [r] = await db.select().from(reports).where(eq(reports.orderId, orderId));
  check(r, "a report row exists");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
