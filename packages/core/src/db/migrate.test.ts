import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { TABLES, clients, companies, events, prospects } from "./schema";
import { OUTRUN_CLIENT_ID } from "../constants";
import { createTempDatabase, type TempDb } from "../testing/db";

describe("migrations", () => {
  let t: TempDb;
  beforeAll(async () => {
    t = await createTempDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("creates the application tables on a fresh database", async () => {
    const r = await t.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    );
    const names = r.rows.map((x) => x.table_name);
    for (const name of TABLES) expect(names).toContain(name);
    expect(TABLES).toHaveLength(13);
  });

  it("mints UUIDv7 ids and enforces one prospect per company", async () => {
    const [c] = await t.db.insert(companies).values({ domain: "acme.dev", source: "fixture" }).returning();
    expect(c?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    await t.db.insert(prospects).values({ companyId: c!.id });
    await expect(t.db.insert(prospects).values({ companyId: c!.id })).rejects.toThrow();
  });

  it("makes Outrun client #0, and lets two clients prospect the same company", async () => {
    const [outrun] = await t.db.select().from(clients);
    expect(outrun).toMatchObject({ id: OUTRUN_CLIENT_ID, slug: "outrun", status: "active" });
    const [c] = await t.db.insert(companies).values({ domain: "shared.dev", source: "fixture" }).returning();
    const [p] = await t.db.insert(prospects).values({ companyId: c!.id }).returning();
    expect(p!.clientId).toBe(OUTRUN_CLIENT_ID);
    const [b] = await t.db
      .insert(clients)
      .values({ slug: "beta", name: "Beta", domain: "beta.dev" })
      .returning();
    await t.db.insert(prospects).values({ companyId: c!.id, clientId: b!.id });
    await expect(t.db.insert(prospects).values({ companyId: c!.id, clientId: b!.id })).rejects.toThrow();
  });

  it("dedupes webhook deliveries in the events ledger", async () => {
    const row = {
      actor: "provider:stripe",
      type: "webhook.received",
      entityType: "system",
      entityId: "stripe:evt_1",
    };
    await t.db.insert(events).values(row);
    await expect(t.db.insert(events).values(row)).rejects.toThrow();
    await t.db.insert(events).values({ ...row, type: "job.done" });
    await t.db.insert(events).values({ ...row, type: "job.done" });
  });
});
