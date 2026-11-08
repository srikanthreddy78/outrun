import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { events, scans } from "../db/schema";
import { SCAN_VERSION, type ScanResult } from "./contracts";
import type { ScanStore } from "./service";

/** Shared Postgres store. Only public scan results are written here. */
export class DbScanStore implements ScanStore {
  constructor(
    private readonly db: Db,
    private readonly enqueueJob: (domain: string, idempotencyKey: string, traceId: string) => Promise<void>,
  ) {}

  async get(domain: string): Promise<ScanResult | undefined> {
    const [row] = await this.db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.type, "scan.completed"), eq(events.entityId, domain)))
      .orderBy(desc(events.ts))
      .limit(1);
    const result = row?.payload.result as ScanResult | undefined;
    return result?.version === SCAN_VERSION && result.domain === domain && result.state === "complete"
      ? result
      : undefined;
  }

  async put(result: ScanResult): Promise<void> {
    if (result.state !== "complete") return;
    if (
      result.scores.marketingEffectiveness ||
      result.checks.some((check) => check.id === "campaign-tracking")
    )
      throw new Error("Private supplement cannot enter public scan storage");
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${result.domain}))`);
      const [priorEvent] = await tx
        .select({ payload: events.payload })
        .from(events)
        .where(and(eq(events.type, "scan.completed"), eq(events.entityId, result.domain)))
        .orderBy(desc(events.ts))
        .limit(1);
      const prior = priorEvent?.payload.result as ScanResult | undefined;
      if (prior?.version === SCAN_VERSION && prior.cachedUntil && Date.parse(prior.cachedUntil) > Date.now())
        return;
      const [latest] = await tx
        .select({ version: scans.version })
        .from(scans)
        .where(eq(scans.domain, result.domain))
        .orderBy(desc(scans.version))
        .limit(1);
      if (result.scores.siteReadiness.value !== null)
        await tx.insert(scans).values({
          domain: result.domain,
          version: (latest?.version ?? 0) + 1,
          scannerVersion: String(SCAN_VERSION),
          score: result.scores.siteReadiness.value,
          checks: result.checks,
        });
      await tx.insert(events).values({
        actor: "worker",
        type: "scan.completed",
        entityType: "system",
        entityId: result.domain,
        payload: { result },
      });
    });
  }

  async enqueue(domain: string): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    await this.enqueueJob(domain, `scan:${domain}:${day}`, randomUUID());
  }

  async consumeRequest(ipHash: string, since: Date, at: Date, limit: number): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ipHash}))`);
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(events)
        .where(and(eq(events.type, "scan.requested"), eq(events.entityId, ipHash), gte(events.ts, since)));
      if ((row?.count ?? 0) >= limit) return false;
      await tx.insert(events).values({
        actor: "web",
        type: "scan.requested",
        entityType: "system",
        entityId: ipHash,
        ts: at,
        payload: {},
      });
      return true;
    });
  }
}
