/**
 * The six OUTRUN_* settings are the only env settings. Keys and URLs are read here too,
 * but they are credentials, not settings. A bad value fails boot.
 */
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .default("false")
  .transform((v) => v === "true" || v === "1");
const posInt = (def: number) => z.coerce.number().int().positive().default(def);
const optionalKey = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

export const Settings = z.object({
  /** Unset = unlimited. */
  OUTRUN_LLM_BUDGET_USD_DAILY: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === "") return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        ctx.addIssue({ code: "custom", message: "must be a non-negative number or unset" });
        return z.NEVER;
      }
      return n;
    }),
  OUTRUN_SEND_DAILY_CAP: posInt(30),
  OUTRUN_DISCOVERY_DAILY_CAP: posInt(200),
  OUTRUN_SMART_MODEL: z.string().min(1).default("gpt-5.5"),
  OUTRUN_JOB_MAX_ATTEMPTS: posInt(5).refine((n) => n <= 25, "at most 25"),
  OUTRUN_DEMO: bool,
});

const Env = Settings.extend({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url().optional(),
  DATABASE_URL_UNPOOLED: z.string().url().optional(),
  APP_URL: z.string().url().default("http://localhost:3000"),
  NAIVE_API_KEY: optionalKey,
  NAIVE_WEBHOOK_SECRET: optionalKey,
  NAIVE_WEBHOOK_SECRET_PREVIOUS: optionalKey,
  CREW_TOKEN_SECRET: optionalKey,
  OPENAI_API_KEY: optionalKey,
  OPENROUTER_API_KEY: optionalKey,
  STRIPE_SECRET_KEY: optionalKey,
  STRIPE_WEBHOOK_SECRET: optionalKey,
  STRIPE_WEBHOOK_SECRET_PREVIOUS: optionalKey,
  MONID_API_KEY: optionalKey,
  AGENTMAIL_API_KEY: optionalKey,
  AGENTMAIL_WEBHOOK_SECRET: optionalKey,
  HUBSPOT_ACCESS_TOKEN: optionalKey,
  APIFY_TOKEN: optionalKey,
  APIFY_WEBHOOK_SECRET: optionalKey,
});

export interface Config {
  env: "development" | "test" | "production";
  isProd: boolean;
  appUrl: string;
  databaseUrl: string | undefined;
  databaseUrlUnpooled: string | undefined;
  settings: {
    llmBudgetUsdDaily: number | null;
    sendDailyCap: number;
    discoveryDailyCap: number;
    smartModel: string;
    jobMaxAttempts: number;
    demo: boolean;
  };
  keys: {
    naive?: string;
    naiveWebhookSecret?: string;
    naiveWebhookSecretPrevious?: string;
    crewTokenSecret?: string;
    openai?: string;
    openrouter?: string;
    stripe?: string;
    stripeWebhookSecret?: string;
    stripeWebhookSecretPrevious?: string;
    monid?: string;
    agentmail?: string;
    agentmailWebhookSecret?: string;
    hubspot?: string;
    apify?: string;
    apifyWebhookSecret?: string;
  };
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const r = Env.safeParse(env);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`invalid configuration:\n  ${lines.join("\n  ")}`);
  }
  const e = r.data;
  if (e.OUTRUN_DEMO && e.STRIPE_SECRET_KEY && /^(sk|rk)_live_/.test(e.STRIPE_SECRET_KEY)) {
    throw new ConfigError(
      "invalid configuration:\n  STRIPE_SECRET_KEY: OUTRUN_DEMO needs a Stripe test-mode key",
    );
  }
  return {
    env: e.NODE_ENV,
    isProd: e.NODE_ENV === "production",
    appUrl: e.APP_URL.replace(/\/$/, ""),
    databaseUrl: e.DATABASE_URL,
    databaseUrlUnpooled: e.DATABASE_URL_UNPOOLED ?? e.DATABASE_URL,
    settings: {
      llmBudgetUsdDaily: e.OUTRUN_LLM_BUDGET_USD_DAILY,
      sendDailyCap: e.OUTRUN_SEND_DAILY_CAP,
      discoveryDailyCap: e.OUTRUN_DISCOVERY_DAILY_CAP,
      smartModel: e.OUTRUN_SMART_MODEL,
      jobMaxAttempts: e.OUTRUN_JOB_MAX_ATTEMPTS,
      demo: e.OUTRUN_DEMO,
    },
    keys: {
      naive: e.NAIVE_API_KEY,
      naiveWebhookSecret: e.NAIVE_WEBHOOK_SECRET,
      naiveWebhookSecretPrevious: e.NAIVE_WEBHOOK_SECRET_PREVIOUS,
      crewTokenSecret: e.CREW_TOKEN_SECRET,
      openai: e.OPENAI_API_KEY,
      openrouter: e.OPENROUTER_API_KEY,
      stripe: e.STRIPE_SECRET_KEY,
      stripeWebhookSecret: e.STRIPE_WEBHOOK_SECRET,
      stripeWebhookSecretPrevious: e.STRIPE_WEBHOOK_SECRET_PREVIOUS,
      monid: e.MONID_API_KEY,
      agentmail: e.AGENTMAIL_API_KEY,
      agentmailWebhookSecret: e.AGENTMAIL_WEBHOOK_SECRET,
      hubspot: e.HUBSPOT_ACCESS_TOKEN,
      apify: e.APIFY_TOKEN,
      apifyWebhookSecret: e.APIFY_WEBHOOK_SECRET,
    },
  };
}

let cached: Config | undefined;
/** The process config, loaded once. Tests call loadConfig() directly. */
export function config(): Config {
  cached ??= loadConfig();
  return cached;
}
