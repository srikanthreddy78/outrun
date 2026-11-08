import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { orders, scans, sql } from "@outrun/core/db";
import { createEmitter } from "@outrun/core/events";
import { Queue } from "@outrun/core/queue";
import { createTempDatabase, TEST_DB_URL, type TempDb } from "../../../../packages/core/src/testing/db";
import { growthHandlers } from "./growth";

describe.skipIf(!TEST_DB_URL)("Growth rescan database flow", () => {
  let temp: TempDb;
  let queue: Queue;

  beforeAll(async () => {
    temp = await createTempDatabase();
    queue = new Queue({ connectionString: temp.url, maxAttempts: 2, emit: createEmitter(temp.db) });
    await queue.start();
  });
  afterAll(async () => {
    await queue?.stop();
    await temp?.drop();
  });

  it("queues only due delivered Growth orders and deduplicates a repeated tick", async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    await temp.db.insert(orders).values([
      {
        domain: "due.example.com",
        contactEmail: "buyer@due.example.com",
        product: "growth",
        state: "delivered",
        amountUsd: "1500.00",
        deliveredAt: old,
      },
      {
        domain: "recent.example.com",
        contactEmail: "buyer@recent.example.com",
        product: "growth",
        state: "delivered",
        amountUsd: "1500.00",
        deliveredAt: recent,
      },
      {
        domain: "oneoff.example.com",
        contactEmail: "buyer@oneoff.example.com",
        product: "auditKit",
        state: "delivered",
        amountUsd: "499.00",
        deliveredAt: old,
      },
      {
        domain: "unfinished.example.com",
        contactEmail: "buyer@unfinished.example.com",
        product: "growth",
        state: "auditing",
        amountUsd: "1500.00",
      },
    ]);
    await temp.db.insert(scans).values({
      domain: "recent.example.com",
      version: 1,
      scannerVersion: "fixture",
      score: 80,
      checks: [],
      createdAt: recent,
    });

    const handler = growthHandlers({ db: temp, queue, emit: createEmitter(temp.db) }).growth_rescan!;
    await handler({} as never, {} as never);
    await handler({} as never, {} as never);

    const jobs = await temp.db.execute<{ domain: string }>(
      sql`select data->'payload'->>'domain' as domain from pgboss.job where name = 'scan_domain'`,
    );
    expect(jobs.rows.map((row) => row.domain)).toEqual(["due.example.com"]);
  });
});
