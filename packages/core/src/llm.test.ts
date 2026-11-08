import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { BULK_MODEL, FALLBACK_MODEL } from "./constants";
import type { AppError } from "./errors";
import { createEmitter } from "./events";
import { FakeLlmProvider } from "./fakes/llm";
import { costOf, createLlm, spentTodayUsd, strictJsonSchema } from "./llm";
import { createTempDatabase, type TempDb } from "./testing/db";

const Triage = z.object({ label: z.enum(["interested", "question"]), confidence: z.number() });

describe("llm()", () => {
  let t: TempDb;
  let openai: FakeLlmProvider;
  let openrouter: FakeLlmProvider;
  beforeAll(async () => {
    t = await createTempDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    // Each test gets an empty ledger in this throwaway database.
    await t.db.execute(sql.raw("TRUNCATE events"));
    openai = new FakeLlmProvider("openai");
    openrouter = new FakeLlmProvider("openrouter");
  });
  const make = (budget: number | null = null) =>
    createLlm({
      providers: { openai, openrouter },
      db: t.db,
      emit: createEmitter(t.db),
      settings: { llmBudgetUsdDaily: budget, smartModel: "gpt-5.5" },
    });

  it("routes the smart tier to OpenAI with the smart model", async () => {
    openai.reply("triage", { label: "interested", confidence: 0.9 });
    const out = await make()({ tier: "smart", schema: Triage, input: "hi", purpose: "triage" });
    expect(out).toMatchObject({
      data: { label: "interested" },
      provider: "openai",
      model: "gpt-5.5",
      fellBack: false,
    });
    expect(openrouter.calls).toHaveLength(0);
    // 1000 in + 200 out at $5/$30 per M
    expect(out.costUsd).toBeCloseTo(0.011, 6);
  });

  it("routes the bulk tier to OpenRouter's bulk model", async () => {
    openrouter.reply("triage", { label: "question", confidence: 0.5 });
    const out = await make()({ tier: "bulk", schema: Triage, input: "hi", purpose: "triage" });
    expect(out.provider).toBe("openrouter");
    expect(openrouter.calls[0]?.model).toBe(BULK_MODEL);
  });

  it("falls back to OpenRouter when OpenAI fails", async () => {
    openai.reply("triage", new Error("503"));
    openrouter.reply("triage", { label: "question", confidence: 0.5 });
    const out = await make()({ tier: "smart", schema: Triage, input: "hi", purpose: "triage" });
    expect(out.fellBack).toBe(true);
    expect(openrouter.calls[0]?.model).toBe(FALLBACK_MODEL);
  });

  it("falls back when the output doesn't match the schema, and still records the spend", async () => {
    openai.reply("triage", { label: "spam", confidence: 1 });
    openrouter.reply("triage", { label: "question", confidence: 0.4 });
    const out = await make()({ tier: "smart", schema: Triage, input: "hi", purpose: "triage" });
    expect(out.fellBack).toBe(true);
    const rows = await t.db.execute<{ n: string }>(
      sql`select count(*)::text n from events where type = 'llm.call'`,
    );
    expect(Number(rows.rows[0]?.n)).toBe(2);
  });

  it("throws a retryable upstream_error when every route fails", async () => {
    openai.reply("triage", new Error("down"));
    openrouter.reply("triage", "not json");
    const err = (await make()({ tier: "smart", schema: Triage, input: "hi", purpose: "triage" }).catch(
      (e: unknown) => e,
    )) as AppError;
    expect(err.code).toBe("upstream_error");
    expect(err.retryable).toBe(true);
  });

  it("writes a cost event per call", async () => {
    openai.reply("triage", { label: "interested", confidence: 1 });
    await make()({
      tier: "smart",
      schema: Triage,
      input: "x",
      purpose: "triage",
      entity: { type: "message", id: "m1" },
    });
    const r = await t.db.execute<{ entity_id: string; cost_usd: string; payload: { provider: string } }>(
      sql`select entity_id, cost_usd, payload from events where type = 'llm.call'`,
    );
    expect(r.rows[0]).toMatchObject({ entity_id: "m1", payload: { provider: "openai" } });
    expect(Number(r.rows[0]?.cost_usd)).toBeGreaterThan(0);
  });

  it("stops with budget_exhausted once today's budget is spent", async () => {
    openai.reply("triage", { label: "interested", confidence: 1 });
    const llm = make(0.015);
    await llm({ tier: "smart", schema: Triage, input: "x", purpose: "triage" });
    await llm({ tier: "smart", schema: Triage, input: "x", purpose: "triage" });
    expect(await spentTodayUsd(t.db, new Date())).toBeCloseTo(0.022, 6);
    const err = (await llm({ tier: "smart", schema: Triage, input: "x", purpose: "triage" }).catch(
      (e: unknown) => e,
    )) as AppError;
    expect(err.code).toBe("budget_exhausted");
    expect(openai.calls).toHaveLength(2);
  });

  it("an unset budget is unlimited", async () => {
    openai.reply("triage", { label: "interested", confidence: 1 });
    const llm = make(null);
    for (let i = 0; i < 5; i++) await llm({ tier: "smart", schema: Triage, input: "x", purpose: "triage" });
    expect(openai.calls).toHaveLength(5);
  });
});

describe("helpers", () => {
  it("prefers the provider's own cost", () => {
    expect(costOf({ text: "", model: "x", inputTokens: 1, outputTokens: 1, costUsd: 0.42 })).toBe(0.42);
    expect(costOf({ text: "", model: "unknown-model", inputTokens: 1e6, outputTokens: 0 })).toBe(0);
  });

  it("emits strict JSON Schema", () => {
    const js = strictJsonSchema(z.object({ a: z.string(), b: z.object({ c: z.number() }) })) as {
      additionalProperties: boolean;
      required: string[];
      properties: { b: { additionalProperties: boolean } };
    };
    expect(js.additionalProperties).toBe(false);
    expect(js.required).toEqual(["a", "b"]);
    expect(js.properties.b.additionalProperties).toBe(false);
  });
});
