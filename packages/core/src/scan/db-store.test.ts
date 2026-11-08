import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { scans } from "../db/schema";
import { createTempDatabase, TEST_DB_URL, type TempDb } from "../testing/db";
import { DbScanStore } from "./db-store";
import { SCAN_VERSION, type ScanResult } from "./contracts";

describe.skipIf(!TEST_DB_URL)("persistent public scans", () => {
  let temp: TempDb;
  let store: DbScanStore;
  const queued: string[] = [];

  beforeAll(async () => {
    temp = await createTempDatabase();
    store = new DbScanStore(temp.db, async (domain) => {
      queued.push(domain);
    });
  });
  afterAll(async () => {
    await temp?.drop();
  });

  it("stores a complete public result, preserves its journey, and dedupes the scan row", async () => {
    const now = new Date();
    const result: ScanResult = {
      version: SCAN_VERSION,
      domain: "example.com",
      state: "complete",
      scannedAt: now.toISOString(),
      cachedUntil: new Date(now.getTime() + 7 * 24 * 60 * 60_000).toISOString(),
      checks: [],
      scores: {
        siteReadiness: { value: 80, assessedWeight: 10, totalWeight: 10 },
        marketingCoverage: { value: 50, assessedWeight: 10, totalWeight: 10 },
      },
      topActions: [],
      journey: { urls: ["https://example.com/signup"], outcome: "signup-wall" },
      reportUrl: "/score/example.com",
    };
    await store.put(result);
    await store.put(result);
    expect(await store.get("example.com")).toEqual(result);
    expect(await temp.db.select().from(scans).where(eq(scans.domain, "example.com"))).toHaveLength(1);
    await expect(
      store.put({
        ...result,
        scores: {
          ...result.scores,
          marketingEffectiveness: {
            source: "agent-supplied",
            period: { startDate: "2026-10-01", endDate: "2026-10-31" },
          },
        },
      }),
    ).rejects.toThrow("Private supplement");
  });

  it("limits concurrent requests and queues one domain", async () => {
    const now = new Date();
    const accepted = await Promise.all([
      store.consumeRequest("hash", new Date(now.getTime() - 3600_000), now, 1),
      store.consumeRequest("hash", new Date(now.getTime() - 3600_000), now, 1),
    ]);
    expect(accepted.sort()).toEqual([false, true]);
    await store.enqueue("example.com");
    expect(queued).toEqual(["example.com"]);
  });
});
