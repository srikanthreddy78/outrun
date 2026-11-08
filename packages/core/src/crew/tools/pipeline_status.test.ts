import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { messages } from "../../db/schema";
import { createTempDatabase, type TempDb } from "../../testing/db";
import { ToolRegistry } from "../registry";
import type { ToolContext } from "../types";
import { pipelineStatus } from "./pipeline_status";

const NOW = new Date("2026-11-06T18:00:00Z"); // 10:00 in Los Angeles
const YESTERDAY = new Date("2026-11-05T18:00:00Z");

describe("pipeline_status send cap", () => {
  let t: TempDb;
  beforeAll(async () => {
    t = await createTempDatabase();
    const base = { direction: "outbound" as const, kind: "first" as const, subject: "s", body: "b" };
    await t.db.insert(messages).values([
      // Sent yesterday but touched today (a bounce update): not today's send.
      { ...base, status: "sent", sentAt: YESTERDAY, updatedAt: NOW },
      // Sent today.
      { ...base, status: "sent", sentAt: NOW },
      // Approved earlier, going out now: it uses today's cap.
      { ...base, status: "approved", updatedAt: YESTERDAY },
      // Waiting on a person: not counted against the cap.
      { ...base, status: "awaiting_approval" },
    ]);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("counts sends by sent time plus what's approved, not by last update", async () => {
    const ctx = {
      agent: "orchestrator",
      requestId: "r",
      db: t.db,
      now: () => NOW,
      enqueue: async () => ({ jobId: null }),
      emit: async () => {},
    } as ToolContext;
    const out = (await new ToolRegistry([
      pipelineStatus({ sendDailyCap: 30, discoveryDailyCap: 200, demo: false }),
    ]).call("orchestrator", "pipeline_status", {}, ctx)) as {
      capsLeft: { send: number };
      approvalsWaiting: number;
    };
    // Warmup (SH-6): the first send was yesterday, so today allows 10 + 5 = 15; two count against it.
    expect(out.capsLeft.send).toBe(13);
    expect(out.approvalsWaiting).toBe(1);
  });
});
