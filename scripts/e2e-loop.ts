/**
 * pnpm e2e:loop: walks the seeded demo prospect through every job on a fresh database,
 * checks its events, then forces a failure and checks it is dead-lettered.
 * Runs on fakes: no outside service is called.
 */
import { and, eq, events, inArray } from "@outrun/core/db";
import { loadConfig } from "@outrun/core";
import { seedDemo } from "@outrun/core/seed";
import { createTempDatabase } from "@outrun/core/testing/db";
import { LOOP_ORDER, startWorker } from "@outrun/worker";

const TIMEOUT_MS = 180_000;

async function waitFor<T>(what: string, fn: () => Promise<T | undefined>): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - start > TIMEOUT_MS) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main(): Promise<void> {
  const tmp = await createTempDatabase();
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: tmp.url,
    DATABASE_URL_UNPOOLED: tmp.url,
    OUTRUN_DEMO: "true",
  });
  let ok = false;
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  try {
    worker = await startWorker({
      config,
      schedules: false,
      real: false,
      retryDelaySeconds: 1,
      retryBackoff: false,
      pollingIntervalSeconds: 0.5,
    });
    const { prospectId } = await seedDemo(tmp.db);
    console.log(`seeded demo prospect ${prospectId}`);

    await worker!.queue.enqueue({
      type: LOOP_ORDER[0]!,
      payload: { prospectId, chain: "e2e" },
      idempotencyKey: `e2e:${LOOP_ORDER[0]}`,
      traceId: "e2e-loop",
    });
    const want = LOOP_ORDER.map((t) => `stub.${t}`);
    await waitFor("every stub to run", async () => {
      const rows = await tmp.db
        .select({ type: events.type })
        .from(events)
        .where(and(eq(events.entityId, prospectId), inArray(events.type, want)));
      const seen = new Set(rows.map((r) => r.type));
      return want.every((w) => seen.has(w)) ? true : undefined;
    });
    for (const t of LOOP_ORDER) console.log(`  ok  ${t}`);

    // Same key again: a no-op.
    const again = await worker!.queue.enqueue({
      type: LOOP_ORDER[0]!,
      payload: { prospectId, chain: "e2e" },
      idempotencyKey: `e2e:${LOOP_ORDER[0]}`,
      traceId: "e2e-loop",
    });
    if (again.jobId !== null) throw new Error("duplicate enqueue was not deduped");
    console.log("  ok  duplicate enqueue is a no-op");

    await worker!.queue.enqueue({
      type: "build_kit",
      payload: { prospectId, forceFail: true },
      idempotencyKey: "e2e:forced-failure",
      traceId: "e2e-dead",
    });
    await waitFor("the forced failure to be dead-lettered", async () => {
      const rows = await tmp.db
        .select({ payload: events.payload })
        .from(events)
        .where(and(eq(events.entityId, prospectId), eq(events.type, "job.dead")));
      return rows.some((r) => r.payload.job === "build_kit") ? true : undefined;
    });
    const failures = await tmp.db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.entityId, prospectId), eq(events.type, "job.failed")));
    console.log(`  ok  forced failure dead-lettered after ${failures.length} attempt(s)`);
    if (failures.length !== config.settings.jobMaxAttempts) {
      throw new Error(`expected ${config.settings.jobMaxAttempts} attempts, saw ${failures.length}`);
    }
    ok = true;
  } finally {
    await worker?.stop();
    await tmp.drop();
  }
  console.log(ok ? "e2e:loop passed" : "e2e:loop FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
