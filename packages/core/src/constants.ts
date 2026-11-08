/**
 * Everything that isn't one of the six OUTRUN_* settings is a named constant here,
 * changed by PR. Prices and deliverables live here and in Stripe, never in prompts.
 */
import type { PaidProductKey, ProductKey } from "../contracts";

export const PRODUCTS = {
  freeScan: {
    key: "freeScan",
    name: "Free scan",
    priceUsd: 0,
    interval: "one_time",
    deliverables: ["Agent-readiness score", "Top 3 gaps"],
  },
  auditKit: {
    key: "auditKit",
    name: "Audit + Kit",
    priceUsd: 499,
    interval: "one_time",
    deliverables: [
      "Full agent-readiness audit",
      "llms.txt",
      "OpenAPI fixes",
      "server.json with publish steps",
      "Listing copy",
      "Quickstart",
      "Positioning and ICP",
      "50-prospect list with a 3-email sequence",
      "30-day plan",
    ],
  },
  growth: {
    key: "growth",
    name: "Growth Department",
    priceUsd: 1500,
    interval: "month",
    deliverables: ["Monthly outbound run", "Registry submissions", "Monthly re-scan and report"],
  },
} as const satisfies Record<
  ProductKey,
  {
    key: ProductKey;
    name: string;
    priceUsd: number;
    interval: "one_time" | "month";
    deliverables: readonly string[];
  }
>;

export const priceOf = (p: PaidProductKey): number => PRODUCTS[p].priceUsd;

/** Email */
export const SEND_WARMUP_START_PER_DAY = 10;
export const SEND_WARMUP_STEP_PER_DAY = 5;
export const FOLLOWUP_OFFSETS_DAYS = [3, 7] as const;
export const BOUNCE_PAUSE_RATE = 0.03;
export const BOUNCE_WINDOW_SENDS = 50;

/** Scans and crawls */
export const SCAN_CACHE_DAYS = 7;
export const SCAN_TIMEOUT_MS = 10_000;
export const AUDIT_MAX_PAGES = 50;
export const SCORE_RATE_LIMIT_PER_HOUR = 20;

/** safeFetch */
export const FETCH_TIMEOUT_MS = 10_000;
export const FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const FETCH_MAX_REDIRECTS = 5;

/** Queue */
export const JOB_RETRY_DELAY_SECONDS = 10;
export const JOB_RETRY_DELAY_MAX_SECONDS = 600;
export const JOB_EXPIRE_SECONDS = 15 * 60;
export const WORKER_CONCURRENCY = 4;
export const CRON_TZ = "America/Los_Angeles";
export const CRON = {
  refresh_sources: "0 6 * * *",
  check_stuck: "*/5 * * * *",
} as const;

/** Alerts (SR-10) */
export const STUCK_JOB_MINUTES = 15;
export const STUCK_ORDER_MINUTES = 60;
export const STUCK_APPROVAL_HOURS = 24;
export const LLM_BUDGET_ALERT_RATIO = 0.8;

/** In-app models. The smart model is OUTRUN_SMART_MODEL on OpenAI; bulk and fallback go through OpenRouter. */
export const BULK_MODEL = "openai/gpt-5.4-mini";
export const FALLBACK_MODEL = "openai/gpt-5.5";
export const LLM_TIMEOUT_MS = 60_000;
/**
 * USD per million tokens, from OpenRouter's model list on 2026-11-07 (it matches OpenAI's list
 * price). Used when a provider doesn't return the cost itself; OpenRouter does.
 */
export const MODEL_PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  "gpt-5.5": { input: 5, output: 30 },
  "openai/gpt-5.5": { input: 5, output: 30 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "openai/gpt-5.4-mini": { input: 0.75, output: 4.5 },
};

/** Webhooks */
export const WEBHOOK_TOLERANCE_SECONDS = 300;
