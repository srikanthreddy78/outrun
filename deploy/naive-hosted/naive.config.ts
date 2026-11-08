/**
 * The Naive-hosted web app and its ticker, a separate Naive project (`outrun-hosted`) from the
 * crew in the root naive.config.ts. Only deploy/naive-hosted/deploy.mjs applies this, with
 * NAIVE_HOSTED=1; the regular deployment (Vercel, Render, Neon) never reads it.
 *
 * Values arrive through the environment that deploy.mjs sets from its local state; nothing secret
 * is written here.
 */
import { defineProject } from "@usenaive-sdk/blueprints";

const env = process.env;
const appUrl = env["NAIVE_HOSTED_APP_URL"] || undefined;
const testInbox = env["NAIVE_HOSTED_TEST_INBOX"] || undefined;
const has = (name: string): boolean => Boolean(env[name]);

const appEnv = {
  // Not `from_env: "NAIVE_API_KEY"`: that name makes `naive up` mint a read-only key instead.
  NAIVE_API_KEY: { from_env: "NAIVE_HOSTED_NAIVE_KEY" },
  CREW_TOKEN_SECRET: { from_env: "NAIVE_HOSTED_CREW_TOKEN_SECRET" },
  NAIVE_HOSTED_ADMIN_TOKEN: { from_env: "NAIVE_HOSTED_ADMIN_TOKEN" },
  AUTH_SECRET: { from_env: "NAIVE_HOSTED_AUTH_SECRET" },
  OUTRUN_DEMO: "true",
  ...(appUrl === undefined ? {} : { APP_URL: appUrl }),
  ...(has("NAIVE_HOSTED_WEBHOOK_SECRET")
    ? { NAIVE_WEBHOOK_SECRET: { from_env: "NAIVE_HOSTED_WEBHOOK_SECRET" } }
    : {}),
  ...(testInbox === undefined
    ? {}
    : {
        NAIVE_HOSTED_TEST_INBOX: testInbox,
        AGENTMAIL_API_KEY: { from_env: "NAIVE_HOSTED_AGENTMAIL_KEY" },
        AGENTMAIL_INBOX_ID: testInbox,
      }),
};

const ticker = {
  name: "hosted-ticker",
  role: "Worker clock",
  description:
    "Runs the Outrun worker on a schedule by calling outrun-hosted.tick, since Naive apps have no always-on process.",
  model: "openai/gpt-oss-120b",
  budget: { cap_micro_usd: 1_000_000, max_task_micro_usd: 100_000, period: "day" as const },
  handoffs: false as const,
  metadata: { pin: 3 },
  tools: {
    default_config: { permission: "deny" as const },
    configs: {
      "outrun-hosted.tick": { enabled: true, permission: "allow" as const },
      board_read: { enabled: true, permission: "allow" as const },
      board_write: { enabled: true, permission: "allow" as const },
    },
  },
  system:
    "You are the worker clock for Outrun's hosted app. Call outrun-hosted.tick exactly once, then reply with one line: the job counts it returned. Do nothing else.",
  schedules: [
    {
      cron: "*/5 * * * *",
      timezone: "America/Los_Angeles",
      summary: "Worker tick",
      input: "Tick now: call outrun-hosted.tick once and report the job counts.",
      budget_micro_usd: 100_000,
    },
  ],
};

export default defineProject({
  name: "outrun-hosted",
  description: "Outrun's web app and worker clock hosted on Naive (deploy/naive-hosted).",
  apps: [
    {
      name: "outrun-hosted",
      type: "fullstack",
      description: "apps/web with packages/core and apps/worker vendored in, on Naive's Postgres.",
      deploy_dir: ".build/web",
      mcp: "/api/hosted/mcp",
      env: appEnv,
    },
  ],
  // The ticker needs the app's MCP tool, which exists once the app has a URL.
  agents: appUrl === undefined ? [] : [ticker],
});
