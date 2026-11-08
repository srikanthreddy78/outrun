/**
 * llm(): the one wrapper for in-app model calls (ADR 0007). Agents never call it; jobs do
 * (reply triage, Kit writing). Smart tier: OpenAI, falling back to OpenRouter. Bulk tier:
 * OpenRouter, falling back to a second OpenRouter model. Every call writes an `llm.call`
 * event with its cost, and calls stop with `budget_exhausted` once OUTRUN_LLM_BUDGET_USD_DAILY
 * is spent.
 */
import { z } from "zod";
import type { Entity } from "../contracts";
import { BULK_MODEL, CRON_TZ, FALLBACK_MODEL, MODEL_PRICES_PER_MTOK } from "./constants";
import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "./db/client";
import { events } from "./db/schema";
import { AppError } from "./errors";
import type { Emit } from "./events";
import type { LlmProvider, LlmResult } from "./integrations/types";
import { logger } from "./log";
import { startOfDayIn } from "./time";

export type Tier = "smart" | "bulk";

export interface LlmCall<S extends z.ZodType> {
  tier: Tier;
  schema: S;
  input: string;
  system?: string;
  /** Short label for the ledger, e.g. `triage_reply`, `kit.llms_txt`. */
  purpose: string;
  entity?: Entity;
}

export interface LlmOutcome<T> {
  data: T;
  costUsd: number;
  model: string;
  provider: LlmProvider["name"];
  fellBack: boolean;
}

export interface LlmDeps {
  providers: { openai: LlmProvider; openrouter: LlmProvider };
  db: Db;
  emit: Emit;
  settings: { llmBudgetUsdDaily: number | null; smartModel: string };
  now?: () => Date;
}

export type Llm = <S extends z.ZodType>(call: LlmCall<S>) => Promise<LlmOutcome<z.output<S>>>;

export function costOf(r: LlmResult): number {
  if (typeof r.costUsd === "number") return r.costUsd;
  const p =
    MODEL_PRICES_PER_MTOK[r.model] ?? MODEL_PRICES_PER_MTOK[r.model.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
  if (!p) {
    logger.warn({ model: r.model }, "no price for model; recording zero cost");
    return 0;
  }
  return (r.inputTokens * p.input + r.outputTokens * p.output) / 1_000_000;
}

/** zod → JSON Schema in the strict form OpenAI and OpenRouter require. */
export function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" }) as Record<string, unknown>;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (n.type === "object" && n.properties && typeof n.properties === "object") {
      n.additionalProperties = false;
      n.required = Object.keys(n.properties as object);
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(walk);
      else walk(v);
    }
  };
  walk(js);
  delete js.$schema;
  return js;
}

export async function spentTodayUsd(db: Db, now: Date): Promise<number> {
  const since = startOfDayIn(CRON_TZ, now);
  const r = await db
    .select({ total: sql<string>`coalesce(sum(${events.costUsd}), 0)::text` })
    .from(events)
    .where(and(eq(events.type, "llm.call"), gte(events.ts, since)));
  return Number(r[0]?.total ?? 0);
}

export function createLlm(deps: LlmDeps): Llm {
  const now = deps.now ?? (() => new Date());
  return async function llm<S extends z.ZodType>(call: LlmCall<S>): Promise<LlmOutcome<z.output<S>>> {
    const entity = call.entity ?? { type: "system" as const, id: call.purpose };
    const budget = deps.settings.llmBudgetUsdDaily;
    if (budget !== null) {
      const spent = await spentTodayUsd(deps.db, now());
      if (spent >= budget) {
        await deps.emit({
          actor: "worker",
          type: "llm.budget_exhausted",
          entityType: entity.type,
          entityId: entity.id,
          payload: { purpose: call.purpose, spentUsd: spent, budgetUsd: budget },
        });
        throw new AppError("budget_exhausted", `in-app LLM budget of $${budget} for today is spent`);
      }
    }

    const routes: { provider: LlmProvider; model: string }[] =
      call.tier === "smart"
        ? [
            { provider: deps.providers.openai, model: deps.settings.smartModel },
            { provider: deps.providers.openrouter, model: FALLBACK_MODEL },
          ]
        : [
            { provider: deps.providers.openrouter, model: BULK_MODEL },
            { provider: deps.providers.openrouter, model: FALLBACK_MODEL },
          ];
    const jsonSchema = {
      name: call.purpose.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
      schema: strictJsonSchema(call.schema),
    };

    let lastError: unknown;
    for (const [i, route] of routes.entries()) {
      let result: LlmResult | undefined;
      try {
        result = await route.provider.complete({
          model: route.model,
          input: call.input,
          jsonSchema,
          ...(call.system ? { system: call.system } : {}),
        });
        const parsed = call.schema.safeParse(JSON.parse(result.text));
        const costUsd = costOf(result);
        await deps.emit({
          actor: "worker",
          type: "llm.call",
          entityType: entity.type,
          entityId: entity.id,
          costUsd,
          payload: {
            purpose: call.purpose,
            tier: call.tier,
            provider: route.provider.name,
            model: result.model,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            ok: parsed.success,
          },
        });
        if (!parsed.success)
          throw new AppError("upstream_error", `model output did not match ${jsonSchema.name}`);
        return {
          data: parsed.data,
          costUsd,
          model: result.model,
          provider: route.provider.name,
          fellBack: i > 0,
        };
      } catch (err) {
        lastError = err;
        // Unparseable JSON still cost tokens: record them before falling back.
        if (result && err instanceof SyntaxError) {
          await deps.emit({
            actor: "worker",
            type: "llm.call",
            entityType: entity.type,
            entityId: entity.id,
            costUsd: costOf(result),
            payload: {
              purpose: call.purpose,
              tier: call.tier,
              provider: route.provider.name,
              model: result.model,
              ok: false,
            },
          });
        }
        logger.warn(
          { provider: route.provider.name, model: route.model, err: (err as Error).message },
          "llm route failed",
        );
      }
    }
    throw new AppError("upstream_error", `all model routes failed for ${call.purpose}`, {
      retryable: true,
      cause: lastError,
    });
  };
}
