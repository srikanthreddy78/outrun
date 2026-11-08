/**
 * pnpm e2e:agency: two clients of the agency, Acme Pay and Beta Books, side by side with Outrun,
 * on one throwaway database, through the real worker, job handlers, crew tool registry and
 * webhook acceptors. Outside services are fakes (Naive, AgentMail, Monid, the model, DNS), so it
 * spends nothing and sends nothing.
 *
 *   For each client: added → its researcher drafts the profile → the owner confirms → the
 *   sending domain verifies and its inbox is created → Hunter (fake) finds companies → its
 *   prospector files one → its researcher saves facts → its sdr drafts, cited and priced from
 *   the profile → the client's own approver approves in the portal → sent from the client's
 *   own inbox. Then a reply to Acme's inbox reaches Acme's closer, who answers with Acme's
 *   call to action after Acme approves.
 *   Then the CEO learns: it reads Acme's insights, sets Acme's focus and proposes an ICP change
 *   with the numbers; the owner accepts, and Acme's confirmed profile carries the change.
 *   Then the CEO lists problems, predicts Acme's reply rate and records a lesson; a week on,
 *   score_predictions scores the prediction once.
 *
 * Both clients prospect the same company and the same person, so it also proves: drafts,
 * approvals, inboxes, unsubscribes and replies never cross clients, and Outrun is untouched.
 *
 * Then a third client, Gamma Grid, hires the agency itself through the public hire_agency tool:
 * the worker provisions its six agents on the (fake) Naive API, its researcher drafts the
 * profile, the owner confirms it, and its sending domain verifies.
 *
 * Last, the CEO staffs Acme an account manager: the worker adds exactly that agent on the (fake)
 * Naive, it saves a weekly report the client sees in its portal (the email is a fixed notice),
 * and it answers the client's portal question.
 */
import { randomUUID } from "node:crypto";
import { loadConfig } from "@outrun/core";
import { addClient, confirmProfile, startEmailSetup, startProfiling } from "@outrun/core/clients";
import { askClientQuestion, clientQuestions, latestClientReport } from "@outrun/core/accountManager";
import { applyProfileProposal, clientFocus, proposalsFor } from "@outrun/core/insights";
import { OUTRUN_CLIENT_ID } from "@outrun/core/constants";
import { CORE_CLIENT_ROLES, type AgentName } from "@outrun/core/contracts";
import type { ToolContext } from "@outrun/core/crew";
import { agencyOverview } from "@outrun/core/crew/tools/agency";
import { scorePredictions, trackRecord } from "@outrun/core/brain";
import { and, clientCandidates, clients, desc, eq, events, messages, prospects, sql } from "@outrun/core/db";
import { isSuppressed } from "@outrun/core/email/rules";
import { readUnsubscribeToken, unsubscribeContact } from "@outrun/core/email/unsubscribe";
import { createFakes, FakeLlmProvider, FakeNaiveClient } from "@outrun/core/fakes";
import { assertPortalAccess, redeemPortalLink } from "@outrun/core/portal";
import { startVerifiedCrews } from "@outrun/core/selfServe";
import { callPublicTool } from "@outrun/core/public/service";
import type { Runtime } from "@outrun/core/runtime";
import { seedDemo } from "@outrun/core/seed";
import { createTempDatabase } from "@outrun/core/testing/db";
import { acceptAgentMailEvent } from "@outrun/core/webhooks/agentmail";
import { startWorker } from "@outrun/worker";
import { submitDecisions } from "../apps/web/lib/approvals-core";
import { agentConfig, clientCrew } from "../naive/crew";

const TIMEOUT_MS = 180_000;
const OWNER = "user:srikanth@outrun.example";
const LEAD = { domain: "ledgerly.dev", name: "Ledgerly", contact: "cy@ledgerly.dev" };

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

interface ClientSpec {
  slug: string;
  name: string;
  domain: string;
  approver: string;
  keyword: string;
  pitch: string;
  cta: string;
  price: string;
}
const CLIENTS: ClientSpec[] = [
  {
    slug: "acme-pay",
    name: "Acme Pay",
    domain: "acme-pay.dev",
    approver: "ada@acme-pay.dev",
    keyword: "invoicing",
    pitch: "A 20-minute demo of automated invoice matching.",
    cta: "https://acme-pay.dev/demo",
    price: "$49/month",
  },
  {
    slug: "beta-books",
    name: "Beta Books",
    domain: "beta-books.dev",
    approver: "bo@beta-books.dev",
    keyword: "bookkeeping",
    pitch: "A free month of done-for-you bookkeeping.",
    cta: "https://beta-books.dev/start",
    price: "$300/month",
  },
];

const profileOf = (c: ClientSpec) => ({
  summary: `${c.name}: ${c.pitch}`,
  icp: {
    description: "B2B SaaS companies with a finance team",
    includeKeywords: [c.keyword, "finance"],
    excludeKeywords: ["agency"],
    buyerRoles: ["CFO", "Head of Finance"],
    companySizes: ["11-50"],
  },
  offer: { pitch: c.pitch, callToActionUrl: c.cta, prices: [{ label: "Plan", amount: c.price }] },
  allowedLinkHosts: [],
  sender: { name: `The ${c.name} team`, postalAddress: "1 Market St, San Francisco, CA 94105" },
  tone: "plain, specific, friendly",
  sources: [`https://${c.domain}/`, `https://${c.domain}/pricing`],
});

async function main(): Promise<void> {
  const tmp = await createTempDatabase();
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: tmp.url,
    DATABASE_URL_UNPOOLED: tmp.url,
    OUTRUN_DEMO: "false",
    APP_URL: "https://outrun.example",
    CREW_TOKEN_SECRET: "e2e-crew-secret-0123456789abcdef", // gitleaks:allow (throwaway test value)
  });

  const naiveOpts: ConstructorParameters<typeof FakeNaiveClient>[0] = {};
  const naive = new FakeNaiveClient(naiveOpts);
  const model = (name: "openai" | "openrouter") =>
    new FakeLlmProvider(name, { triage_reply: { label: "interested", confidence: 0.9 } });
  const fakes = createFakes({ naive, llm: { openai: model("openai"), openrouter: model("openrouter") } });
  // Hunter answers by the first ICP keyword; both clients find the same lead.
  for (const c of CLIENTS)
    fakes.monid.hunter.set(c.keyword, [
      { domain: LEAD.domain, organization: LEAD.name },
      { domain: c.domain, organization: `${c.name} itself` },
    ]);

  let rt: Runtime | undefined;
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  let passed = false;
  const ids = new Map<string, string>([["outrun", OUTRUN_CLIENT_ID]]);
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
    });
    rt = worker.runtime;
    const db = rt.db.db;
    naiveOpts.registry = rt.registry;
    naiveOpts.ctx = async (agent: AgentName, clientSlug: string): Promise<ToolContext> => {
      // A self-serve client's id is known to the database before it is known here.
      if (!ids.has(clientSlug)) {
        const [row] = await db.select({ id: clients.id }).from(clients).where(eq(clients.slug, clientSlug));
        if (row) ids.set(clientSlug, row.id);
      }
      const clientId = ids.get(clientSlug);
      if (!clientId) throw new Error(`e2e: unknown client ${clientSlug}`);
      return {
        agent,
        requestId: randomUUID(),
        clientId,
        db,
        now: () => new Date(),
        enqueue: (job, o) => rt!.queue.enqueue(job, o),
        emit: rt!.emit,
      };
    };
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
    const failedCall = () => naive.toolCalls.find((c) => c.error);
    const noFailures = () => {
      const bad = failedCall();
      if (bad) throw new Error(`${bad.agent}.${bad.tool} failed: ${bad.error!.code} ${bad.error!.message}`);
    };
    const draftRef = (calls: { tool: string; result?: unknown }[]) => {
      const d = [...calls]
        .reverse()
        .find((c) => c.tool === "check_draft" && (c.result as { ok?: boolean })?.ok)?.result as
        { draftId: string; hash: string } | undefined;
      if (!d) throw new Error("no passing check_draft before the send");
      return { draftId: d.draftId, hash: d.hash };
    };
    const startAgent = (
      slug: string,
      agent: AgentName,
      entity: { type: "prospect" | "system"; id: string },
    ) =>
      rt!.queue.enqueue({
        type: "start_session",
        payload: { agent, entity, clientId: ids.get(slug), message: `e2e: ${slug} ${agent}` },
        idempotencyKey: `e2e:${slug}:${agent}:${entity.id}`,
        traceId: randomUUID(),
      });
    const deps = {
      db,
      emit: rt.emit,
      enqueue: (j: Parameters<Runtime["queue"]["enqueue"]>[0]) => rt!.queue.enqueue(j),
    };
    const held = (clientId: string, kind: "first" | "reply") =>
      waitFor(`a ${kind} email held for ${clientId}`, async () => {
        noFailures();
        const [m] = await db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.clientId, clientId),
              eq(messages.kind, kind),
              eq(messages.status, "awaiting_approval"),
            ),
          );
        return m;
      });
    const sent = (id: string) =>
      waitFor(`message ${id} to send`, async () => {
        noFailures();
        const [m] = await db.select().from(messages).where(eq(messages.id, id));
        if (m?.status === "failed") throw new Error(`message ${id} was refused`);
        return m?.status === "sent" ? m : undefined;
      });

    // Outrun's own demo prospect sits alongside, and must be left alone.
    const outrunDemo = await seedDemo(db);

    console.log("A. onboarding two clients from a name and a domain");
    for (const c of CLIENTS) {
      const row = await addClient(
        deps,
        { name: c.name, domain: c.domain, approverEmails: [c.approver] },
        OWNER,
      );
      check(row.slug === c.slug, `${c.name} got slug ${c.slug}`);
      ids.set(c.slug, row.id);
      naive.script(`${c.slug}-researcher`, [
        { tool: "get_client_profile", input: {} },
        { tool: "save_client_profile", input: { profile: profileOf(c) } },
      ]);
      await startProfiling(deps, row.id, OWNER);
    }
    for (const c of CLIENTS)
      await waitFor(`${c.name}'s profile draft`, async () => {
        noFailures();
        const [r] = await db.select().from(clients).where(eq(clients.slug, c.slug));
        return r?.status === "awaiting_confirmation";
      });
    ok("each client's own researcher drafted its profile from its site; both await the owner");

    for (const c of CLIENTS) await confirmProfile(deps, ids.get(c.slug)!, profileOf(c), OWNER);
    for (const c of CLIENTS)
      await waitFor(`${c.name}'s DNS records`, async () => {
        const [r] = await db.select().from(clients).where(eq(clients.slug, c.slug));
        return r?.dnsStatus === "pending" && r.dnsRecords.length > 0;
      });
    ok("confirmed by the owner; each domain registered on AgentMail with DNS records to add");

    for (const c of CLIENTS) {
      fakes.agentmail.addDns(c.domain);
      await startEmailSetup(deps, ids.get(c.slug)!, new Date(Date.now() + 60_000));
    }
    for (const c of CLIENTS)
      await waitFor(`${c.name} to go active`, async () => {
        const [r] = await db.select().from(clients).where(eq(clients.slug, c.slug));
        return r?.status === "active" && r.agentmailInboxId === `hello@${c.domain}`;
      });
    ok("DNS verified; each client has its own inbox (hello@<its domain>) and is active");

    console.log("B. finding and writing, per client");
    for (const c of CLIENTS)
      await rt.queue.enqueue({
        type: "refresh_client_sources",
        payload: { clientId: ids.get(c.slug) },
        idempotencyKey: `e2e:sources:${c.slug}`,
        traceId: randomUUID(),
      });
    for (const c of CLIENTS)
      await waitFor(`${c.name}'s candidates`, async () => {
        const rows = await db
          .select()
          .from(clientCandidates)
          .where(eq(clientCandidates.clientId, ids.get(c.slug)!));
        return rows.length === 1 ? rows : undefined;
      });
    check(
      fakes.monid.runs.filter((r) => r.endpoint === "hunterio:/discover").length === 2,
      "one Hunter search per client",
    );
    ok("Hunter (fake) searched once per client with its ICP; the client's own domain was skipped");

    const prospectOf = new Map<string, string>();
    for (const c of CLIENTS) {
      naive.script(`${c.slug}-prospector`, [
        { tool: "list_candidates", input: { limit: 5 } },
        {
          tool: "file_prospect",
          input: (calls: { tool: string; result?: unknown }[]) => {
            const list = calls.find((x) => x.tool === "list_candidates")?.result as {
              candidates: { companyId: string; domain: string }[];
            };
            const lead = list.candidates.find((x) => x.domain === LEAD.domain)!;
            return { companyId: lead.companyId, reason: `matches ${c.keyword}` };
          },
        },
      ]);
      await startAgent(c.slug, "prospector", { type: "system", id: "discovery" });
    }
    for (const c of CLIENTS) {
      const p = await waitFor(`${c.name}'s prospect`, async () => {
        noFailures();
        const [r] = await db
          .select()
          .from(prospects)
          .where(eq(prospects.clientId, ids.get(c.slug)!));
        return r;
      });
      prospectOf.set(c.slug, p.id);
    }
    check(prospectOf.get("acme-pay") !== prospectOf.get("beta-books"), "two prospects of one company");
    ok(`both clients filed ${LEAD.domain}: one shared company, a prospect per client`);

    for (const c of CLIENTS) {
      const prospectId = prospectOf.get(c.slug)!;
      naive.script(`${c.slug}-researcher`, [
        { tool: "get_prospect", input: { prospectId } },
        {
          tool: "save_research",
          input: {
            prospectId,
            facts: [
              {
                key: "product",
                value: `${c.keyword} and finance automation for SaaS`,
                sourceUrl: `https://${LEAD.domain}/`,
              },
              { key: "headcount", value: "40 employees", sourceUrl: `https://${LEAD.domain}/about` },
            ],
            contacts: [
              { name: "Cy", role: "CFO", email: LEAD.contact, sourceUrl: `https://${LEAD.domain}/team` },
            ],
          },
        },
      ]);
      await startAgent(c.slug, "researcher", { type: "prospect", id: prospectId });
    }
    for (const c of CLIENTS)
      await waitFor(`${c.name}'s research`, async () => {
        noFailures();
        const [p] = await db
          .select()
          .from(prospects)
          .where(eq(prospects.id, prospectOf.get(c.slug)!));
        return p?.stage === "researched" && (p.fitScore ?? 0) >= 70 ? p : undefined;
      });
    ok("each researcher saved cited facts and the CFO; fit scored from that client's ICP");

    // Acme's experimenter starts an A/B test of angles before its sdr writes.
    const experimenter = () => naiveOpts.ctx!("experimenter", "acme-pay");
    const started = (await rt.registry.call(
      "experimenter",
      "start_experiment",
      {
        hypothesis: "Leading with hours lost to manual work beats leading with speed",
        variants: [
          { key: "A", angle: "the hours finance loses to manual matching" },
          { key: "B", angle: "closing the books faster" },
        ],
      },
      await experimenter(),
    )) as { ok: boolean };
    check(started.ok, "Acme's experiment started");

    for (const c of CLIENTS) {
      const prospectId = prospectOf.get(c.slug)!;
      const amount = c.price.split("/")[0];
      naive.script(`${c.slug}-sdr`, [
        { tool: "get_brief", input: { prospectId } },
        // A first try with an unlisted price and a foreign link: refused, then revised once.
        {
          tool: "check_draft",
          input: {
            prospectId,
            kind: "first",
            subject: `${LEAD.name} and ${c.keyword}`,
            body: `Only $9 today: https://elsewhere.example/deal`,
            citedCheckIds: ["product"],
          },
        },
        {
          tool: "check_draft",
          input: {
            prospectId,
            kind: "first",
            subject: `${LEAD.name} and ${c.keyword}`,
            body: `Hi Cy, saw Ledgerly does ${c.keyword} for SaaS teams. ${c.pitch} Plans start at ${amount} a month: ${c.cta}`,
            citedCheckIds: ["product"],
          },
        },
        { tool: "send_email", input: draftRef },
      ]);
      await startAgent(c.slug, "sdr", { type: "prospect", id: prospectId });
    }
    const firsts = new Map<string, string>();
    for (const c of CLIENTS) firsts.set(c.slug, (await held(ids.get(c.slug)!, "first")).id);
    const rejected = await db.select().from(events).where(eq(events.type, "draft.rejected"));
    check(rejected.length === 2, "each sdr's first try was refused");
    check(
      rejected.every((e) =>
        (e.payload as { reasons: string[] }).reasons.some((r) => r.includes("not a listed price")),
      ),
      "refused for the unlisted price",
    );
    ok("each sdr's ungrounded draft was refused; the revised one waits for that client's approval");

    console.log("C. each client approves its own, in the portal");
    const acme = ids.get("acme-pay")!;
    const beta = ids.get("beta-books")!;
    // Beta's approver can't decide Acme's email, from Beta's scope or by reaching for Acme's.
    const cross = await submitDecisions(
      rt,
      "bo@beta-books.dev",
      { ids: [firsts.get("acme-pay")!], decision: "allow", reason: "" },
      { clientId: beta },
    );
    check(cross === 0, "Beta's approver decided nothing of Acme's");
    let refused = false;
    await assertPortalAccess(db, "bo@beta-books.dev", acme).catch(() => (refused = true));
    check(refused, "Beta's approver has no access to Acme");
    ok("Beta's approver can't see or approve Acme's email");

    const n = await submitDecisions(
      rt,
      "ada@acme-pay.dev",
      { ids: [firsts.get("acme-pay")!], decision: "allow", reason: "" },
      { clientId: acme },
    );
    check(n === 1, "Acme's approval reached Naive");
    const acmeFirst = await sent(firsts.get("acme-pay")!);
    const mail = fakes.agentmail.sent.find((s) => s.inboxId === "hello@acme-pay.dev");
    check(mail && mail.to === LEAD.contact, "sent from Acme's own inbox");
    check(
      mail.text.includes("The Acme Pay team, Acme Pay · 1 Market St"),
      "Acme's sender and postal address",
    );
    check(
      mail.listUnsubscribe.includes("mailto:hello@acme-pay.dev"),
      "the unsubscribe mailto is Acme's inbox",
    );
    const [ev] = await db
      .select()
      .from(events)
      .where(and(eq(events.type, "approval.submitted"), eq(events.entityId, acmeFirst.id)));
    check(ev?.actor === "client:ada@acme-pay.dev", "recorded as Acme's approver");
    ok("Acme approved its own email; it went from hello@acme-pay.dev, signed by Acme");

    console.log("D. unsubscribes and replies stay with their client");
    const token = /\/u\/([\w.-]+)/.exec(mail.text)![1]!;
    const who = readUnsubscribeToken(config.keys.crewTokenSecret, token);
    check(who?.clientId === acme, "Acme's unsubscribe link names Acme");
    // Acme's prospect replies first; then unsubscribes from Acme only.
    const received = {
      event_type: "message.received",
      event_id: "evt_acme_reply_1",
      message: {
        message_id: "<reply-1@ledgerly.dev>",
        thread_id: acmeFirst.threadId!,
        inbox_id: "hello@acme-pay.dev",
        from: `Cy <${LEAD.contact}>`,
        subject: `Re: ${acmeFirst.subject}`,
        text: "Interesting. How do we see a demo?",
      },
    };
    naive.script("acme-pay-closer", [
      { tool: "get_thread", input: { threadId: acmeFirst.threadId! } },
      {
        tool: "check_draft",
        input: {
          prospectId: prospectOf.get("acme-pay")!,
          kind: "reply",
          threadId: acmeFirst.threadId!,
          subject: `Re: ${acmeFirst.subject}`,
          body: "Happy to show you. Pick a time here: https://acme-pay.dev/demo",
          citedCheckIds: [],
        },
      },
      { tool: "reply_email", input: draftRef },
    ]);
    const r = await acceptAgentMailEvent({ body: received, db: rt.db, queue: rt.queue, emit: rt.emit });
    check(r.status === 200, "the reply webhook was accepted");
    const [inbound] = await waitFor("the reply stored", async () => {
      const rows = await db.select().from(messages).where(eq(messages.providerId, "<reply-1@ledgerly.dev>"));
      return rows.length ? rows : undefined;
    });
    check(
      inbound!.clientId === acme && inbound!.prospectId === prospectOf.get("acme-pay"),
      "the reply is Acme's",
    );
    const replyHeld = await held(acme, "reply");
    check(
      naive.toolCalls.some(
        (t) => t.tool === "get_thread" && naive.sessions.get(t.sessionId)?.clientSlug === "acme-pay",
      ),
      "Acme's own closer took it",
    );
    await submitDecisions(
      rt,
      "ada@acme-pay.dev",
      { ids: [replyHeld.id], decision: "allow", reason: "" },
      { clientId: acme },
    );
    await sent(replyHeld.id);
    const replyMail = fakes.agentmail.sent.find((s) => s.inReplyTo === "<reply-1@ledgerly.dev>");
    check(
      replyMail?.inboxId === "hello@acme-pay.dev" && replyMail.text.includes("https://acme-pay.dev/demo"),
      "Acme's call to action, from Acme",
    );
    ok("the reply reached Acme's inbox, Acme's closer answered with Acme's call to action, Acme approved");

    await unsubscribeContact({ db, emit: rt.emit }, who!.contactId, "link", who!.clientId);
    check(await isSuppressed(db, LEAD.contact, acme), "unsubscribed from Acme");
    check(!(await isSuppressed(db, LEAD.contact, beta)), "still reachable for Beta");
    check(!(await isSuppressed(db, LEAD.contact, OUTRUN_CLIENT_ID)), "still reachable for Outrun");
    await submitDecisions(
      rt,
      "bo@beta-books.dev",
      { ids: [firsts.get("beta-books")!], decision: "allow", reason: "" },
      { clientId: beta },
    );
    await sent(firsts.get("beta-books")!);
    const betaMail = fakes.agentmail.sent.find((s) => s.inboxId === "hello@beta-books.dev");
    check(
      betaMail?.text.includes("https://beta-books.dev/start"),
      "Beta's email, from Beta, with Beta's link",
    );
    ok("Cy unsubscribed from Acme only; Beta's approved email still went, from hello@beta-books.dev");

    console.log("E. nothing leaked, and the CEO sees both");
    for (const c of CLIENTS) {
      const mine = await db
        .select()
        .from(messages)
        .where(eq(messages.clientId, ids.get(c.slug)!));
      const other = CLIENTS.find((o) => o.slug !== c.slug)!;
      check(
        mine.every((m) => !m.body.includes(other.cta) && !m.body.includes(other.name)),
        `${c.name}'s emails never mention ${other.name}`,
      );
    }
    check(
      fakes.agentmail.sent.every(
        (s) => s.inboxId === "hello@acme-pay.dev" || s.inboxId === "hello@beta-books.dev",
      ),
      "no client email went from Outrun's inbox",
    );
    const [outrunP] = await db.select().from(prospects).where(eq(prospects.id, outrunDemo.prospectId));
    const outrunMsgs = await db.select().from(messages).where(eq(messages.clientId, OUTRUN_CLIENT_ID));
    check(outrunP && outrunMsgs.length === 0, "Outrun's prospect untouched, no Outrun email");
    const overview = await agencyOverview(db, new Date());
    const bySlug = new Map(overview.clients.map((o) => [o.slug, o]));
    check(
      bySlug.get("acme-pay")?.sent === 2 && bySlug.get("beta-books")?.sent === 1,
      `the CEO's view counts each client's sends (${bySlug.get("acme-pay")?.sent}, ${bySlug.get("beta-books")?.sent})`,
    );
    check(
      bySlug.get("acme-pay")!.crew.find((m) => m.role === "sdr")!.sessions >= 1,
      "the CEO sees which crew member ran",
    );
    ok("no draft, approval, inbox or unsubscribe crossed clients; Outrun untouched; the CEO sees both");

    console.log("F. the CEO learns from Acme's results, and the owner accepts its proposal");
    naive.script("ceo", [
      { tool: "client_insights", input: { clientId: acme } },
      {
        tool: "set_client_focus",
        input: (calls: { tool: string; result?: unknown }[]) => {
          const i = calls.find((x) => x.tool === "client_insights")?.result as {
            replies: number;
            contacted: number;
          };
          return { clientId: acme, dailyDraftLimit: 12, reason: `${i.replies} of ${i.contacted} replied` };
        },
      },
      {
        tool: "propose_profile_change",
        input: (calls: { tool: string; result?: unknown }[]) => {
          const i = calls.find((x) => x.tool === "client_insights")?.result as {
            byKeyword: { key: string; contacted: number; replied: number }[];
          };
          const k = i.byKeyword.find((r) => r.key === "invoicing")!;
          return {
            clientId: acme,
            changes: { addIncludeKeywords: ["accounts payable"], buyerRoles: ["CFO"] },
            evidence: `invoicing: ${k.replied} of ${k.contacted} replied, all from a CFO`,
          };
        },
      },
    ]);
    await startAgent("outrun", "ceo", { type: "system", id: "ceo-learns" });
    const proposal = await waitFor("the CEO's proposal", async () => {
      noFailures();
      const [p] = await proposalsFor(db, acme);
      return p;
    });
    const insight = naive.toolCalls.find((c) => c.tool === "client_insights")?.result as {
      sent: number;
      contacted: number;
      replies: number;
      interested: number;
    };
    check(
      insight.sent === 2 && insight.contacted === 1 && insight.replies === 1 && insight.interested === 1,
      `the CEO read Acme's numbers (${JSON.stringify(insight)})`,
    );
    check(proposal.status === "open" && proposal.by === "naive:ceo", "the proposal waits for the owner");
    check((await clientFocus(db, acme))?.dailyDraftLimit === 12, "Acme's focus is 12 first emails a day");
    await applyProfileProposal({ db, emit: rt.emit }, acme, proposal.proposalId, OWNER);
    const [acmeRow] = await db.select().from(clients).where(eq(clients.id, acme));
    const icp = (acmeRow!.profile as { icp: { includeKeywords: string[]; buyerRoles: string[] } }).icp;
    check(
      icp.includeKeywords.includes("accounts payable") && icp.buyerRoles.join() === "CFO",
      "the accepted change is in Acme's profile",
    );
    check(acmeRow!.profileConfirmedAt && acmeRow!.status === "active", "and the profile stays confirmed");
    const [betaRow] = await db.select().from(clients).where(eq(clients.id, beta));
    check(
      !(betaRow!.profile as { icp: { includeKeywords: string[] } }).icp.includeKeywords.includes(
        "accounts payable",
      ),
      "Beta's profile untouched",
    );
    ok("the CEO read Acme's insights, set its focus and proposed an ICP change; the owner accepted it");

    const [acmeVariantMail] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, firsts.get("acme-pay")!));
    check(acmeVariantMail!.variant === "A", "Acme's first email was written for variant A");
    const results = (await rt.registry.call(
      "experimenter",
      "experiment_results",
      {},
      await experimenter(),
    )) as {
      experiment: { variants: { key: string; sent: number; replies: number }[] };
    };
    const a = results.experiment.variants.find((v) => v.key === "A")!;
    check(a.sent === 1 && a.replies === 1, "variant A: one sent, one reply");
    await rt.registry.call(
      "experimenter",
      "end_experiment",
      { winner: "A", lesson: "Lead with the hours finance loses to manual matching." },
      await experimenter(),
    );
    const [lesson] = await db
      .select()
      .from(events)
      .where(and(eq(events.type, "ceo.lesson"), eq(events.entityId, acme)));
    check(
      (lesson?.payload as { tags?: string[] } | undefined)?.tags?.includes("experiment"),
      "the lesson reached the CEO's playbook",
    );
    const [betaVariants] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.clientId, beta), eq(messages.kind, "first")));
    check(betaVariants!.variant === null, "Beta runs no experiment, so its email has no variant");
    ok("Acme's experiment ran on fakes: variant A was sent and replied to, and its lesson was recorded");
    console.log("F2. the CEO checks for problems, predicts, learns, and is scored");
    naive.script("ceo", [
      { tool: "list_problems", input: {} },
      {
        tool: "make_prediction",
        input: {
          clientId: acme,
          decision: "focus 10 -> 12",
          metric: "replyRate",
          low: 0.5,
          high: 1,
          dueDays: 7,
        },
      },
      {
        tool: "record_lesson",
        input: {
          clientId: acme,
          lesson: "CFOs at invoicing firms reply",
          evidence: "invoicing: 1 of 1 replied",
        },
      },
    ]);
    await startAgent("outrun", "ceo", { type: "system", id: "ceo-brain" });
    await waitFor("the CEO's lesson", async () => {
      noFailures();
      // Acme's experiment recorded one already; this is the CEO's own.
      const [l] = await db
        .select()
        .from(events)
        .where(and(eq(events.type, "ceo.lesson"), eq(events.actor, "naive:ceo")));
      return l;
    });
    const problems = naive.toolCalls.find((c) => c.tool === "list_problems")?.result as {
      deadJobs: unknown[];
      health: { db: boolean };
    };
    check(
      problems.health.db && problems.deadJobs.length === 0,
      "list_problems: the database is up, no dead job",
    );
    // Move the prediction a week into the past, so Acme's sends and reply fall in its window and
    // it is due; then score it as the daily job would, twice.
    const weekAgo = new Date(Date.now() - 7 * 24 * 3_600_000);
    await db
      .update(events)
      .set({
        ts: weekAgo,
        payload: sql`jsonb_set(${events.payload}, '{dueAt}', to_jsonb(${new Date(Date.now() - 1000).toISOString()}::text))`,
      })
      .where(eq(events.type, "ceo.prediction"));
    const now = () => new Date();
    check((await scorePredictions({ db, emit: rt.emit, now })).scored === 1, "the due prediction is scored");
    check((await scorePredictions({ db, emit: rt.emit, now })).scored === 0, "and only once");
    const record = await trackRecord(db);
    check(
      record.made === 1 && record.scored === 1 && record.hits === 1 && record.recent[0]?.actual === 1,
      `Acme replied as predicted (${JSON.stringify(record.recent[0])})`,
    );
    await deps.enqueue({
      type: "score_predictions",
      payload: {},
      idempotencyKey: "e2e:score_predictions",
      traceId: randomUUID(),
    });
    await waitFor("the score_predictions job", async () => {
      const [d] = await db
        .select()
        .from(events)
        .where(and(eq(events.type, "job.done"), sql`${events.payload}->>'job' = 'score_predictions'`));
      return d;
    });
    check(
      (await db.select().from(events).where(eq(events.type, "ceo.prediction_scored"))).length === 1,
      "the job runs and scores nothing twice",
    );
    ok("the CEO listed problems, predicted Acme's reply rate, recorded a lesson, and was scored once");

    console.log("G. a third client hires the agency itself");
    const GAMMA: ClientSpec = {
      slug: "gamma-grid",
      name: "Gamma Grid",
      domain: "gamma-grid.dev",
      approver: "gus@gamma-grid.dev",
      keyword: "grid",
      pitch: "A free week of load forecasts for your grid.",
      cta: "https://gamma-grid.dev/trial",
      price: "$99/month",
    };
    // Its researcher, once provisioned, drafts the profile from its site.
    naive.script(`${GAMMA.slug}-researcher`, [
      { tool: "get_client_profile", input: {} },
      { tool: "save_client_profile", input: { profile: profileOf(GAMMA) } },
    ]);
    const publicDeps = {
      db,
      emit: rt.emit,
      stripe: fakes.stripe,
      appUrl: config.appUrl,
      scan: async () => {
        throw new Error("e2e: no scans here");
      },
      selfServe: {
        enqueue: deps.enqueue,
        sendTransactional: rt.integrations.sendTransactional,
        secret: config.keys.crewTokenSecret,
      },
    };
    const hireMeta = { protocol: "mcp" as const, callerIp: "203.0.113.50", requestId: randomUUID() };
    const hired = await callPublicTool(
      publicDeps,
      "hire_agency",
      { companyName: GAMMA.name, domain: GAMMA.domain, approverEmail: GAMMA.approver },
      hireMeta,
    );
    check(hired.created && hired.slug === GAMMA.slug, `${GAMMA.name} signed up as ${GAMMA.slug}`);
    ids.set(GAMMA.slug, hired.clientId);
    const again = await callPublicTool(
      publicDeps,
      "hire_agency",
      { companyName: GAMMA.name, domain: GAMMA.domain, approverEmail: GAMMA.approver },
      { ...hireMeta, requestId: randomUUID() },
    );
    check(!again.created && again.clientId === hired.clientId, "a repeat signup returns the same client");
    const [added] = await db
      .select()
      .from(events)
      .where(and(eq(events.type, "client.added"), eq(events.entityId, hired.clientId)));
    check(added?.actor === "web", "added by code (web), not by a person");
    check(
      fakes.agentmail.transactional.some(
        (m) => m.to === GAMMA.approver && m.text.includes(`${config.appUrl}/portal/auth/`),
      ),
      "the approver got a portal sign-in link",
    );
    ok(
      "Gamma Grid hired the agency over MCP with hire_agency; a repeat is idempotent; its approver got a portal link",
    );

    // Nothing starts until the approver proves they read Gamma's mail by signing in.
    const early = await db
      .select()
      .from(events)
      .where(and(eq(events.type, "client.crew_provisioned"), eq(events.entityId, hired.clientId)));
    check(early.length === 0, "no crew before the approver signs in");
    const linkMail = fakes.agentmail.transactional.find((m) => m.to === GAMMA.approver)!;
    const linkToken = /\/portal\/auth\/([^\s]+)/.exec(linkMail.text)![1]!;
    const signedIn = await redeemPortalLink({ db, secret: config.keys.crewTokenSecret }, linkToken);
    check(signedIn?.email === GAMMA.approver, "Gamma's approver signed in with the link");
    const startedCrews = await startVerifiedCrews(deps, signedIn!.email);
    check(startedCrews.length === 1 && startedCrews[0] === hired.clientId, "signing in started Gamma's crew");
    check((await startVerifiedCrews(deps, signedIn!.email)).length === 0, "a second sign-in starts nothing");

    const provisioned = await waitFor("Gamma's crew provisioned", async () => {
      const [e] = await db
        .select()
        .from(events)
        .where(and(eq(events.type, "client.crew_provisioned"), eq(events.entityId, hired.clientId)));
      return e;
    });
    check(provisioned.actor === "worker", "provisioned by the worker");
    const gammaAgents = naive.agents.filter((a) => a.name.startsWith(`${GAMMA.slug}-`));
    check(gammaAgents.length === 6, `six Gamma agents on Naive (${gammaAgents.length})`);
    check(
      naive.credentials.filter((c) => c.key.startsWith(`crew-${GAMMA.slug}-`)).length === 6,
      "six vault tokens for Gamma's crew MCP URLs",
    );
    ok("the worker created Gamma's six agents and vault tokens through the Naive API (fake)");

    await waitFor("Gamma's profile draft", async () => {
      noFailures();
      const [r] = await db.select().from(clients).where(eq(clients.id, hired.clientId));
      return r?.status === "awaiting_confirmation";
    });
    const [draft] = await db.select().from(clients).where(eq(clients.id, hired.clientId));
    check(!draft?.profileConfirmedAt, "not confirmed until the owner does");
    check(
      naive.toolCalls.some(
        (t) => t.tool === "save_client_profile" && naive.sessions.get(t.sessionId)?.clientSlug === GAMMA.slug,
      ),
      "Gamma's own researcher drafted it",
    );
    ok("Gamma's provisioned researcher drafted its profile; it waits for the owner");

    await confirmProfile(deps, hired.clientId, profileOf(GAMMA), OWNER);
    await waitFor("Gamma's DNS records", async () => {
      const [r] = await db.select().from(clients).where(eq(clients.id, hired.clientId));
      return r?.status === "email_setup" && r.dnsStatus === "pending" && r.dnsRecords.length > 0;
    });
    fakes.agentmail.addDns(GAMMA.domain);
    await startEmailSetup(deps, hired.clientId, new Date(Date.now() + 60_000));
    await waitFor("Gamma to go active", async () => {
      const [r] = await db.select().from(clients).where(eq(clients.id, hired.clientId));
      return r?.status === "active" && r.agentmailInboxId === `hello@${GAMMA.domain}`;
    });
    ok("the owner confirmed Gamma's profile; its domain verified and it is active with its own inbox");

    console.log("H. the CEO staffs Acme an account manager, who reports and answers in the portal");
    const ACME = CLIENTS[0]!;
    // Acme's six came from naive up; only the new role should be added at runtime.
    for (const m of clientCrew(config.appUrl, {
      slug: ACME.slug,
      name: ACME.name,
      roles: [...CORE_CLIENT_ROLES],
    }))
      if (!naive.agents.some((a) => a.name === m.name))
        await naive.createAgent(agentConfig(m), `naive-up:${m.name}`);
    const acmeBefore = naive.agents.filter((a) => a.name.startsWith(`${ACME.slug}-`)).map((a) => a.name);
    naive.script("ceo", [
      {
        tool: "staff_client",
        input: { clientId: acme, add: ["account_manager"], reason: "Acme's approver wants weekly numbers" },
      },
    ]);
    await startAgent("outrun", "ceo", { type: "system", id: "ceo-staffs" });
    const amName = `${ACME.slug}-account-manager`;
    await waitFor("Acme's account manager on Naive", async () => {
      noFailures();
      const [e] = await db
        .select()
        .from(events)
        .where(and(eq(events.type, "client.crew_provisioned"), eq(events.entityId, acme)));
      return e;
    });
    const acmeAfter = naive.agents.filter((a) => a.name.startsWith(`${ACME.slug}-`)).map((a) => a.name);
    const addedAgents = acmeAfter.filter((n) => !acmeBefore.includes(n));
    check(
      addedAgents.length === 1 && addedAgents[0] === amName,
      `the fake Naive got exactly ${amName} (${addedAgents.join(", ")})`,
    );
    ok("the CEO staffed Acme an account manager; the worker added exactly that agent");

    const note = "Two first emails went out and one prospect asked for a demo.";
    naive.script(amName, [
      { tool: "get_client_profile", input: {} },
      { tool: "client_weekly_report", input: { note } },
    ]);
    await startAgent(ACME.slug, "account_manager", { type: "system", id: "am-weekly" });
    const notice = await waitFor("Acme's report notice", async () => {
      noFailures();
      return fakes.agentmail.transactional.find(
        (m) => m.to === ACME.approver && m.subject.includes("weekly report"),
      );
    });
    check(
      notice.text.includes(`${config.appUrl}/portal/${ACME.slug}`) && !notice.text.includes(note),
      "the notice is the fixed template with a portal link, no agent text",
    );
    await assertPortalAccess(db, ACME.approver, acme);
    const report = await latestClientReport(db, acme);
    check(report?.report.note === note && report.report.sent === 2, "Acme's portal shows the report");
    ok("Acme's account manager saved the weekly report; the client got a fixed notice and sees it");

    naive.script(amName, [
      { tool: "client_questions", input: {} },
      {
        tool: "answer_client",
        input: (calls: { tool: string; result?: unknown }[]) => {
          const r = calls.find((x) => x.tool === "client_questions")?.result as {
            questions: { questionId: string }[];
          };
          return { questionId: r.questions[0]!.questionId, answer: `Book a demo at ${ACME.cta}.` };
        },
      },
    ]);
    const asked = await askClientQuestion(deps, acme, ACME.approver, "How do prospects book a call?");
    check(asked.routed === "account_manager", "the question went to Acme's account manager");
    const answered = await waitFor("the account manager's answer", async () => {
      noFailures();
      const [q] = await clientQuestions(db, acme);
      return q?.answer;
    });
    check(answered.text.includes(ACME.cta), "the portal shows the answer");
    ok("the client asked in the portal; its account manager answered there");

    const dead = await db.select().from(events).where(eq(events.type, "job.dead"));
    check(
      dead.length === 0,
      `no job dead-lettered (${dead.map((d) => JSON.stringify(d.payload)).join("; ")})`,
    );
    check(!failedCall(), "no crew tool call failed");
    ok("no job dead-lettered and no tool call failed along the way");
    passed = true;
  } catch (err) {
    // On a failure, the last of the ledger says what the worker was doing.
    if (rt) {
      const recent = await rt.db.db.select().from(events).orderBy(desc(events.ts)).limit(40);
      for (const e of recent.reverse())
        console.error(
          `  ${e.ts.toISOString().slice(11, 23)} ${e.actor} ${e.type} ${e.entityId} ${JSON.stringify(e.payload).slice(0, 160)}`,
        );
    }
    throw err;
  } finally {
    await worker?.stop().catch(() => {});
    await tmp.drop().catch(() => {});
  }
  console.log(passed ? "\ne2e:agency passed" : "\ne2e:agency FAILED");
  if (!passed) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
