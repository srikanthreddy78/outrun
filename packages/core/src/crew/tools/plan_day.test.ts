import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  JobEnvelope,
  type JobEnvelopeInput,
  type ProspectStage,
  StartSessionInput,
} from "../../../contracts";
import { companies, prospects } from "../../db/schema";
import { DEMO_FILED_REASON } from "../../seed";
import { createTempDatabase, type TempDb } from "../../testing/db";
import { ToolRegistry } from "../registry";
import type { ToolContext } from "../types";
import { planDay } from "./plan_day";

// 10:00 on Friday 2026-11-06 in Los Angeles (CRON_TZ).
const NOW = new Date("2026-11-06T18:00:00Z");
const DAY = "2026-11-06";

describe("plan_day", () => {
  let t: TempDb;
  let jobs: JobEnvelopeInput[];
  beforeAll(async () => {
    t = await createTempDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    jobs = [];
    await t.db.delete(prospects);
    await t.db.delete(companies);
  });

  const ctx = (): ToolContext => ({
    agent: "orchestrator",
    requestId: "req-plan",
    db: t.db,
    now: () => NOW,
    enqueue: async (job) => {
      jobs.push(job);
      return { jobId: null };
    },
    emit: async () => {},
  });

  let n = 0;
  async function seed(stage: ProspectStage | "candidate", filedReason = "fits"): Promise<string> {
    n++;
    const [c] = await t.db
      .insert(companies)
      .values({
        domain: `co${n}.dev`,
        name: `Co ${n}`,
        source: "fixture",
        kind: stage === "candidate" ? "candidate" : "prospect",
      })
      .returning();
    if (stage === "candidate") return c!.id;
    const [p] = await t.db
      .insert(prospects)
      .values({
        companyId: c!.id,
        stage,
        filedReason,
        // created before today so the discovery cap is untouched
        createdAt: new Date("2026-11-01T12:00:00Z"),
      })
      .returning();
    return p!.id;
  }

  const run = (
    settings = { sendDailyCap: 30, discoveryDailyCap: 200, demo: false },
    input: unknown = {},
    followups = 0,
  ) =>
    new ToolRegistry([planDay(settings, async () => followups)]).call(
      "orchestrator",
      "plan_day",
      input,
      ctx(),
    );

  it("enqueues one session per prospect for the right agent, with day keys and ids-only messages", async () => {
    const filed = [await seed("filed"), await seed("filed")];
    const researched = await seed("researched");
    await seed("drafted");
    await seed("contacted");
    await seed("candidate");

    const out = (await run()) as { enqueued: { agent: string; prospectId: string | null }[] };

    expect(out.enqueued).toEqual([
      { agent: "researcher", prospectId: filed[0] },
      { agent: "researcher", prospectId: filed[1] },
      { agent: "sdr", prospectId: researched },
      { agent: "prospector", prospectId: null },
    ]);
    expect(jobs.map((j) => j.idempotencyKey)).toEqual([
      `plan:${DAY}:researcher:${filed[0]}`,
      `plan:${DAY}:researcher:${filed[1]}`,
      `plan:${DAY}:sdr:${researched}`,
      `plan:${DAY}:prospector:discovery`,
    ]);
    for (const j of jobs) {
      const env = JobEnvelope.parse(j);
      expect(env.type).toBe("start_session");
      expect(env.traceId).toBe("req-plan");
      const p = env.payload as { agent: string; message: string; entity: { type: string; id: string } };
      // the worker passes the payload to startSession, which refuses email addresses
      expect(() => StartSessionInput.parse({ ...p, idempotencyKey: env.idempotencyKey })).not.toThrow();
      expect(p.message).not.toMatch(/@/);
    }
    expect((jobs[0]!.payload as { entity: unknown }).entity).toEqual({ type: "prospect", id: filed[0] });
    expect((jobs[3]!.payload as { message: string }).message).toMatch(/up to 1 prospects/);
  });

  it("plans each prospect once even when run twice the same day", async () => {
    await seed("filed");
    await run();
    await run();
    const keys = jobs.map((j) => j.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  it("keeps sdr sessions within the send cap, follow-ups first", async () => {
    for (let i = 0; i < 4; i++) await seed("researched");
    const out = (await run({ sendDailyCap: 3, discoveryDailyCap: 200, demo: false }, {}, 1)) as {
      enqueued: { agent: string; prospectId: string | null }[];
      capsLeft: { send: number };
    };
    expect(out.capsLeft.send).toBe(3);
    expect(out.enqueued.filter((e) => e.agent === "sdr")).toHaveLength(3);
    expect(out.enqueued[0]).toEqual({ agent: "sdr", prospectId: null });
    expect(jobs[0]!.idempotencyKey).toBe(`plan:${DAY}:sdr:followups`);
  });

  it("starts no sdr sessions when the send cap is spent, and no prospector without discovery cap", async () => {
    await seed("researched");
    await seed("candidate");
    const out = (await run({ sendDailyCap: 0, discoveryDailyCap: 0, demo: false })) as {
      enqueued: unknown[];
    };
    expect(out.enqueued).toEqual([]);
    expect(jobs).toEqual([]);
  });

  it("honours limitPerAgent and refuses a large one", async () => {
    for (let i = 0; i < 3; i++) await seed("filed");
    const out = (await run(undefined, { limitPerAgent: 2 })) as { enqueued: unknown[] };
    expect(out.enqueued).toHaveLength(2);
    await expect(run(undefined, { limitPerAgent: 500 })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("in demo mode plans only the seeded demo prospect and skips discovery", async () => {
    await seed("filed");
    const demo = await seed("filed", DEMO_FILED_REASON);
    await seed("candidate");
    const out = (await run({ sendDailyCap: 30, discoveryDailyCap: 200, demo: true })) as {
      enqueued: unknown[];
    };
    expect(out.enqueued).toEqual([{ agent: "researcher", prospectId: demo }]);
  });
});
