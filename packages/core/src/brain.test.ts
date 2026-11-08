import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { JobEnvelopeInput } from "../contracts";
import {
  icpSimilarity,
  isoWeek,
  makePrediction,
  pauseClient,
  readPlaybook,
  recordLesson,
  resumeClient,
  saveBoardMemo,
  scorePredictions,
  trackRecord,
} from "./brain";
import { autonomyReport } from "./autonomy";
import { setPaused } from "./clients";
import { OUTRUN_CLIENT_ID } from "./constants";
import { clients, companies, events, messages, prospects } from "./db/schema";
import { createEmitter } from "./events";
import { deadLetterName, Queue } from "./queue";
import { replayDeadJob } from "./replay";
import { createTempDatabase, type TempDb } from "./testing/db";

const DAY = 86_400_000;
const icp = (includeKeywords: string[], buyerRoles: string[]) => ({
  icp: { description: "x", includeKeywords, excludeKeywords: [], buyerRoles, companySizes: [] },
});

describe("the CEO's brain", () => {
  let t: TempDb;
  let q: Queue;
  let a: string;
  let b: string;
  let c: string;
  const emit = () => createEmitter(t.db);

  beforeAll(async () => {
    t = await createTempDatabase();
    q = new Queue({ connectionString: t.url, maxAttempts: 3, emit: createEmitter(t.db) });
    await q.start(); // queues only, no handlers: replays stay waiting
    const rows = await t.db
      .insert(clients)
      .values([
        {
          slug: "acme",
          name: "Acme",
          domain: "acme.example",
          status: "active",
          profileConfirmedAt: new Date(),
          dnsStatus: "verified",
          profile: icp(["invoicing", "payroll"], ["CFO"]),
        },
        {
          slug: "beta",
          name: "Beta",
          domain: "beta.example",
          status: "active",
          profileConfirmedAt: new Date(),
          dnsStatus: "verified",
          profile: icp(["Invoicing", "payroll"], ["cfo", "controller"]),
        },
        {
          slug: "gamma",
          name: "Gamma",
          domain: "gamma.example",
          status: "active",
          profileConfirmedAt: new Date(),
          dnsStatus: "verified",
          profile: icp(["gaming"], ["CTO"]),
        },
      ])
      .returning();
    [a, b, c] = rows.map((r) => r.id) as [string, string, string];
  });
  afterAll(async () => {
    await q?.stop();
    await t?.drop();
  });

  describe("playbook", () => {
    it("scores similarity by keyword and buyer-role overlap, case-insensitively", () => {
      const pa = icp(["invoicing", "payroll"], ["CFO"]);
      expect(icpSimilarity(pa, icp(["Invoicing", "payroll"], ["cfo", "controller"]))).toBe(0.75);
      expect(icpSimilarity(pa, icp(["gaming"], ["CTO"]))).toBe(0);
      expect(icpSimilarity(pa, pa)).toBe(1);
      expect(icpSimilarity(pa, null)).toBe(0);
    });

    it("a new client starts from the agency's lessons and its most similar clients'", async () => {
      const deps = { db: t.db, emit: emit() };
      await recordLesson(
        deps,
        { clientId: null, lesson: "Short subjects win", evidence: "3 of 4 replied", tags: ["Subject"] },
        "naive:ceo",
      );
      await recordLesson(
        deps,
        { clientId: b, lesson: "CFOs reply", evidence: "CFO: 4 of 7 replied", tags: [] },
        "naive:ceo",
      );
      await recordLesson(
        deps,
        { clientId: c, lesson: "CTOs ignore us", evidence: "0 of 9", tags: [] },
        "naive:ceo",
      );
      await emit()({
        actor: "worker",
        type: "experiment.ended",
        entityType: "client",
        entityId: b,
        payload: { lesson: "Question subjects beat statements", winner: "B" },
      });

      const p = await readPlaybook(t.db, a);
      expect(p.own).toEqual([]);
      expect(p.agency.map((l) => [l.lesson, l.tags])).toEqual([["Short subjects win", ["subject"]]]);
      expect(p.similar.map((s) => [s.slug, s.similarity, s.lessons.map((l) => l.lesson)])).toEqual([
        ["beta", 0.75, ["CFOs reply"]],
      ]);
      expect(p.experiments).toMatchObject([
        { clientId: b, lesson: "Question subjects beat statements", winner: "B" },
      ]);

      const own = await readPlaybook(t.db, b);
      expect(own.own.map((l) => l.lesson)).toEqual(["CFOs reply"]);
      expect(own.similar.map((s) => s.slug)).toEqual([]);
    });

    it("works with no experiments and no lessons at all", async () => {
      const [d] = await t.db
        .insert(clients)
        .values({ slug: "delta", name: "Delta", domain: "delta.example", status: "draft" })
        .returning();
      const p = await readPlaybook(t.db, d!.id);
      expect(p.own).toEqual([]);
      expect(p.similar).toEqual([]);
    });
  });

  describe("predictions", () => {
    it("scores each due prediction once, with the actual over [made, dueAt]", async () => {
      const t0 = new Date();
      const deps = { db: t.db, emit: emit(), now: () => t0 };
      // Four first emails inside the window, one reply; a fifth after the due date doesn't count.
      const cos = await t.db
        .insert(companies)
        .values([1, 2, 3, 4, 5].map((i) => ({ domain: `lead${i}.example`, source: "fixture" as const })))
        .returning();
      const ps = await t.db
        .insert(prospects)
        .values(cos.map((co) => ({ clientId: a, companyId: co.id, stage: "contacted" as const })))
        .returning();
      await t.db.insert(messages).values([
        ...ps.slice(0, 4).map((p) => ({
          clientId: a,
          prospectId: p.id,
          direction: "outbound" as const,
          kind: "first" as const,
          status: "sent" as const,
          sentAt: new Date(t0.getTime() + DAY),
        })),
        {
          clientId: a,
          prospectId: ps[4]!.id,
          direction: "outbound" as const,
          kind: "first" as const,
          status: "sent" as const,
          sentAt: new Date(t0.getTime() + 9 * DAY),
        },
        {
          clientId: a,
          prospectId: ps[0]!.id,
          direction: "inbound" as const,
          kind: "inbound" as const,
          status: "received" as const,
          createdAt: new Date(t0.getTime() + 2 * DAY),
        },
      ]);
      const base = { clientId: a, decision: "focus 10 → 15", dueDays: 7 };
      const hit = await makePrediction(
        deps,
        { ...base, metric: "replyRate", low: 0.2, high: 0.3 },
        "naive:ceo",
      );
      await makePrediction(deps, { ...base, metric: "replyRate", low: 0.05, high: 0.1 }, "naive:ceo");
      await makePrediction(deps, { ...base, metric: "sent", low: 4, high: 4 }, "naive:ceo");
      await makePrediction(deps, { ...base, metric: "wins", low: 0, high: 0, dueDays: 20 }, "naive:ceo");
      expect(hit.dueAt).toBe(new Date(t0.getTime() + 7 * DAY).toISOString());

      // Not due yet: nothing scored.
      expect(await scorePredictions({ ...deps, now: () => new Date(t0.getTime() + 6 * DAY) })).toEqual({
        scored: 0,
      });
      const later = { ...deps, now: () => new Date(t0.getTime() + 10 * DAY) };
      expect(await scorePredictions(later)).toEqual({ scored: 3 });
      expect(await scorePredictions(later)).toEqual({ scored: 0 });

      const scored = await t.db.select().from(events).where(eq(events.type, "ceo.prediction_scored"));
      expect(scored).toHaveLength(3);
      const [one] = scored.filter((e) => e.payload.predictionId === hit.predictionId);
      expect(one!.payload).toMatchObject({ actual: 0.25, hit: true });

      const r = await trackRecord(t.db);
      expect(r).toMatchObject({ made: 4, scored: 3, hits: 2, hitRate: 0.667 });
      expect(r.recent).toHaveLength(4);
      expect(r.recent.find((x) => x.metric === "wins")).toMatchObject({ actual: null, hit: null });
      expect(r.recent.find((x) => x.metric === "sent")).toMatchObject({ actual: 4, hit: true });

      // The public feed shows the numbers, never the decision's free text.
      const pub = await autonomyReport(t.db, { since: new Date(t0.getTime() - DAY), redact: true });
      const said = pub.decisions.map((d) => d.summary);
      expect(said).toContain("CEO predicted reply rate 20–30% for Acme");
      expect(said.some((x) => x.includes("focus 10"))).toBe(false);
      expect(said.some((x) => /scored: reply rate 20–30% predicted, 25% actual, a hit/.test(x))).toBe(true);
      const priv = await autonomyReport(t.db, { since: new Date(t0.getTime() - DAY) });
      expect(priv.decisions.some((d) => d.summary.includes("focus 10"))).toBe(true);
    });
  });

  describe("self-healing", () => {
    it("replays a dead job at most 3 times, never while the last replay is pending, never a live job", async () => {
      const env: JobEnvelopeInput = {
        type: "scan_domain",
        payload: { domain: "x.example" },
        idempotencyKey: "scan:x",
        traceId: "t",
      };
      const deadId = await q.boss.send(deadLetterName("scan_domain"), env);
      await emit()({
        actor: "worker",
        type: "job.dead",
        entityType: "system",
        entityId: "scan_domain",
        payload: { job: "scan_domain", jobId: deadId },
      });
      const deps = { db: t.db, emit: emit(), enqueue: (j: JobEnvelopeInput) => q.enqueue(j) };
      const failLast = () =>
        t.db.execute(
          sql`update pgboss.job set state = 'failed' where name = 'scan_domain' and state = 'created'`,
        );

      expect(
        await replayDeadJob(deps, { jobId: "0190f0f0-0000-7000-8000-000000000000" }, "naive:ceo"),
      ).toEqual({
        ok: false,
        reason: "no dead job with that id",
      });
      expect(await replayDeadJob(deps, { jobId: deadId! }, "naive:ceo")).toMatchObject({
        ok: true,
        replays: 1,
      });
      expect(await replayDeadJob(deps, { jobId: deadId! }, "naive:ceo")).toMatchObject({
        ok: false,
        reason: expect.stringContaining("still queued"),
      });
      await failLast();
      expect(await replayDeadJob(deps, { jobId: deadId! }, "naive:ceo")).toMatchObject({
        ok: true,
        replays: 2,
      });
      await failLast();
      expect(await replayDeadJob(deps, { jobId: deadId! }, "naive:ceo")).toMatchObject({
        ok: true,
        replays: 3,
      });
      await failLast();
      expect(await replayDeadJob(deps, { jobId: deadId! }, "naive:ceo")).toMatchObject({
        ok: false,
        reason: expect.stringContaining("3 times"),
      });
      const replayed = await t.db
        .select()
        .from(events)
        .where(and(eq(events.type, "job.replayed"), eq(events.entityId, deadId!)));
      expect(replayed.map((e) => e.actor)).toEqual(["naive:ceo", "naive:ceo", "naive:ceo"]);

      // A type that isn't replayable is refused.
      const sendId = await q.boss.send(deadLetterName("send_email"), { ...env, type: "send_email" });
      await emit()({
        actor: "worker",
        type: "job.dead",
        entityType: "system",
        entityId: "send_email",
        payload: { job: "send_email", jobId: sendId },
      });
      expect(await replayDeadJob(deps, { jobId: sendId! }, "naive:ceo")).toMatchObject({
        ok: false,
        reason: expect.stringContaining("aren't replayable"),
      });
    });

    it("resumes only its own pauses: never the owner's, an automatic one, or Outrun", async () => {
      const deps = { db: t.db, emit: emit() };
      await setPaused(deps, c, true, "user:owner@x.dev");
      expect(await resumeClient(deps, { clientId: c, reason: "fixed" }, "naive:ceo")).toEqual({
        ok: false,
        reason: expect.stringContaining("the owner paused this client"),
      });
      // Pausing over the owner's pause would make it the CEO's: refused too.
      expect(await pauseClient(deps, { clientId: c, reason: "x" }, "naive:ceo")).toMatchObject({ ok: false });
      expect((await t.db.select().from(clients).where(eq(clients.id, c)))[0]!.status).toBe("paused");

      await setPaused(deps, b, true, "worker");
      expect(await resumeClient(deps, { clientId: b, reason: "fixed" }, "naive:ceo")).toEqual({
        ok: false,
        reason: expect.stringContaining("paused automatically"),
      });

      const [e] = await t.db
        .insert(clients)
        .values({
          slug: "eps",
          name: "Eps",
          domain: "eps.example",
          status: "active",
          profileConfirmedAt: new Date(),
          dnsStatus: "verified",
        })
        .returning();
      expect(
        await pauseClient(deps, { clientId: e!.id, reason: "5 of 5 sessions failed" }, "naive:ceo"),
      ).toEqual({
        ok: true,
        status: "paused",
      });
      expect(await resumeClient(deps, { clientId: e!.id, reason: "sessions fixed" }, "naive:ceo")).toEqual({
        ok: true,
        status: "active",
      });
      expect(await resumeClient(deps, { clientId: e!.id, reason: "again" }, "naive:ceo")).toMatchObject({
        ok: false,
      });
      expect(await pauseClient(deps, { clientId: OUTRUN_CLIENT_ID, reason: "x" }, "naive:ceo")).toMatchObject(
        {
          ok: false,
        },
      );
      expect(
        await resumeClient(deps, { clientId: OUTRUN_CLIENT_ID, reason: "x" }, "naive:ceo"),
      ).toMatchObject({
        ok: false,
      });
    });
  });

  describe("board memo", () => {
    it("ISO weeks follow the agency's calendar", () => {
      expect(isoWeek(new Date("2026-01-01T20:00:00Z"))).toBe("2026-W01");
      expect(isoWeek(new Date("2024-12-30T20:00:00Z"))).toBe("2025-W01");
      expect(isoWeek(new Date("2026-11-09T17:00:00Z"))).toBe("2026-W46");
    });

    it("is saved once per ISO week and enqueues one email", async () => {
      const jobs: JobEnvelopeInput[] = [];
      let now = new Date("2026-11-09T17:00:00Z");
      const deps = {
        db: t.db,
        emit: emit(),
        now: () => now,
        enqueue: async (j: JobEnvelopeInput) => (jobs.push(j), { jobId: "j" }),
      };
      const memo = { kpis: "sent 40, replies 5", decisions: "raised Acme to 15", asks: "confirm Beta" };
      expect(await saveBoardMemo(deps, memo, "naive:ceo")).toEqual({
        saved: true,
        week: "2026-W46",
        reason: null,
      });
      now = new Date("2026-11-13T17:00:00Z");
      expect(await saveBoardMemo(deps, memo, "naive:ceo")).toMatchObject({ saved: false, week: "2026-W46" });
      now = new Date("2026-11-16T17:00:00Z");
      expect(await saveBoardMemo(deps, memo, "naive:ceo")).toMatchObject({ saved: true, week: "2026-W47" });
      expect(jobs.map((j) => [j.type, j.idempotencyKey, j.payload])).toEqual([
        ["send_ceo_brief", "ceo:memo:2026-W46", { kind: "board_memo", week: "2026-W46" }],
        ["send_ceo_brief", "ceo:memo:2026-W47", { kind: "board_memo", week: "2026-W47" }],
      ]);
    });
  });
});
