#!/usr/bin/env node
/* global process, console, fetch, AbortSignal */
/**
 * Deploys Outrun's core workflow entirely on Naive: the web app (apps/web with packages/core and
 * apps/worker vendored in) as a Naive fullstack app on Naive's Postgres, a ticker agent that runs
 * the worker on a schedule, and the crew from the root naive.config.ts, all pointed at the
 * hosted app. It's opt-in: nothing here runs without NAIVE_HOSTED=1, and the regular deployment
 * (docs/deploy.md: Vercel, Render, Neon) is unchanged.
 *
 *   NAIVE_HOSTED=1 node deploy/naive-hosted/deploy.mjs <command>
 *
 *   build            assemble .build/web (no network)
 *   up               build, then apply the outrun-hosted project (app + ticker) and wait for it
 *   admin <op> [json] call the hosted admin route: migrate | seed | tick | status | start
 *                    (start takes '{"agent":"sdr","prospectId":"…","message":"…"}')
 *   crew [--dry-run] apply the root crew (naive.config.ts) with APP_URL = the hosted app
 *   sync             run scripts/naive-sync.ts against the hosted app and keep the webhook secret
 *   all              up, migrate, seed, crew, sync, up again (webhook secret + ticker)
 *
 * The Naive key is NAIVE_HOSTED_API_KEY, or NAIVE_TWO_API_KEY from the root .env. Set
 * NAIVE_HOSTED_TEST_INBOX to let email reach one address (the AgentMail test inbox, sent with
 * AGENTMAIL_API_KEY); without it, email always goes to the fake. Generated secrets live in
 * deploy/naive-hosted/.state.json (git-ignored, 0600) and are never printed.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const BUILD = join(HERE, ".build", "web");
const STATE = join(HERE, ".state.json");
const CLI = join(ROOT, "node_modules", "@usenaive-sdk", "cli", "dist", "index.js");
const PROJECT_APP = "outrun-hosted";

if (process.env.NAIVE_HOSTED !== "1") {
  console.error(
    "Refusing: set NAIVE_HOSTED=1 to use the Naive-hosted deployment. The regular one is docs/deploy.md.",
  );
  process.exit(2);
}
if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));

const key = process.env.NAIVE_HOSTED_API_KEY || process.env.NAIVE_TWO_API_KEY;
if (!key)
  fail("Set NAIVE_HOSTED_API_KEY (or NAIVE_TWO_API_KEY in the root .env): the Naive account to deploy into.");
if (key === process.env.NAIVE_API_KEY && process.env.NAIVE_HOSTED_ALLOW_PRIMARY !== "1") {
  fail(
    "The hosted key is the same as NAIVE_API_KEY (the primary account). Refusing; use the second account's key.",
  );
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

// ---- state ------------------------------------------------------------------------------------

function loadState() {
  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  const secret = () => randomBytes(32).toString("base64url");
  state.crewTokenSecret ??= secret();
  state.adminToken ??= secret();
  state.authSecret ??= secret();
  if (process.env.NAIVE_HOSTED_TEST_INBOX)
    state.testInbox = process.env.NAIVE_HOSTED_TEST_INBOX.trim().toLowerCase();
  saveState(state);
  return state;
}

function saveState(state) {
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(STATE, 0o600);
}

// ---- Naive CLI and API ------------------------------------------------------------------------

/** The environment every Naive call gets: the hosted key, never the primary one. */
function naiveEnv(state, extra = {}) {
  const e = { ...process.env, NAIVE_API_KEY: key, ...extra };
  delete e.VETTA_API_KEY;
  if (state.appUrl) e.NAIVE_HOSTED_APP_URL = state.appUrl;
  return e;
}

function naive(state, args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? HERE,
    env: naiveEnv(state, opts.env),
    encoding: "utf8",
  });
  const out = (r.stdout ?? "").trim();
  try {
    return JSON.parse(out);
  } catch {
    if (opts.allowText) return out;
    throw new Error(`naive ${args.join(" ")} failed: ${(r.stderr || out).slice(0, 500)}`);
  }
}

/** Refuses any account but the one this deployment was first made in, and never the primary. */
function assertAccount(state) {
  const who = naive(state, ["whoami"]);
  const org = who.organization?.id;
  if (!org) fail("Could not read the hosted account's organization.");
  if (state.orgId && state.orgId !== org)
    fail(`The hosted key now points at ${org}, not ${state.orgId}. Refusing.`);
  if (process.env.NAIVE_API_KEY) {
    const r = spawnSync(process.execPath, [CLI, "whoami"], {
      env: { ...process.env, VETTA_API_KEY: "" },
      encoding: "utf8",
    });
    try {
      if (JSON.parse(r.stdout).organization?.id === org)
        fail("The hosted key is in the primary organization. Refusing.");
    } catch {
      /* primary key unreadable: nothing to compare */
    }
  }
  state.orgId = org;
  state.orgName = who.organization?.name;
  saveState(state);
  return org;
}

// ---- build --------------------------------------------------------------------------------------

const SKIP =
  /(^|\/)(node_modules|\.next|\.turbo|coverage)(\/|$)|\.test\.tsx?$|tsconfig\.tsbuildinfo$|next-env\.d\.ts$/;
const copy = (from, to) =>
  cpSync(from, to, {
    recursive: true,
    filter: (src) => !SKIP.test(relative(ROOT, src).split("\\").join("/")),
  });

function patch(file, from, to) {
  const text = readFileSync(file, "utf8");
  if (!text.includes(from))
    fail(`${relative(BUILD, file)} no longer contains the line deploy/naive-hosted patches; update it.`);
  writeFileSync(file, text.replace(from, to));
}

/** The exact installed version of a dependency, as resolved from one workspace package. */
function installedVersion(fromDir, name) {
  const dir = realpathSync(join(fromDir, "node_modules", ...name.split("/")));
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
}

function exportsToPaths(name, dir, exports) {
  const paths = {};
  for (const [sub, target] of Object.entries(exports)) {
    const spec = sub === "." ? name : `${name}/${sub.slice(2)}`;
    paths[spec] = [`./${dir}/${target.slice(2)}`];
  }
  return paths;
}

function build(state) {
  rmSync(BUILD, { recursive: true, force: true });
  mkdirSync(BUILD, { recursive: true });

  const web = join(ROOT, "apps", "web");
  const core = join(ROOT, "packages", "core");
  const worker = join(ROOT, "apps", "worker");
  copy(web, BUILD);
  rmSync(join(BUILD, "vercel.json"), { force: true });
  copy(core, join(BUILD, "vendor", "core"));
  copy(worker, join(BUILD, "vendor", "worker"));
  copy(join(HERE, "overlay"), BUILD);

  // Make the build self-contained. These edit the build's copies only, and each fails loudly if
  // the repo file it expects has changed shape.
  mkdirSync(join(BUILD, "vendor", "naive"), { recursive: true });
  cpSync(join(ROOT, "naive", "crew.ts"), join(BUILD, "vendor", "naive", "crew.ts"));
  patch(
    join(BUILD, "vendor", "naive", "crew.ts"),
    '} from "../packages/core/contracts";',
    '} from "@outrun/core/contracts";',
  );
  patch(
    join(BUILD, "lib", "dashboard-live.ts"),
    'from "../../../naive/crew";',
    'from "@/vendor/naive/crew";',
  );
  patch(
    join(BUILD, "vendor", "core", "src", "db", "migrate.ts"),
    'export const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));',
    "// Naive-hosted build: the SQL ships next to the server as vendor/core/drizzle.\nexport const MIGRATIONS_DIR = `${process.cwd()}/vendor/core/drizzle`;",
  );

  // Naive's Postgres pooler allows 15 clients in session mode, and every serverless instance holds
  // its own pools, so the build uses small pools that release idle connections quickly.
  patch(
    join(BUILD, "vendor", "core", "src", "db", "client.ts"),
    "const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 5 });",
    "const pool = new pg.Pool({ connectionString: url, max: Math.min(opts.max ?? 5, 2), idleTimeoutMillis: 2000 });",
  );
  patch(
    join(BUILD, "vendor", "core", "src", "queue.ts"),
    "max: opts.max ?? (producer ? 2 : 4),",
    "max: Math.min(opts.max ?? (producer ? 1 : 2), producer ? 1 : 2),",
  );

  // Only the build's copy of createIntegrations changes: rename it and append the wrapper.
  const integrations = join(BUILD, "vendor", "core", "src", "integrations", "index.ts");
  const source = readFileSync(integrations, "utf8");
  const marker = "export function createIntegrations(";
  if (!source.includes(marker))
    fail("packages/core/src/integrations/index.ts changed shape; update deploy/naive-hosted.");
  writeFileSync(
    integrations,
    `${source.replace(marker, "function createIntegrationsOriginal(")}\n${readFileSync(join(HERE, "integrations-wrapper.ts"), "utf8")}`,
  );

  const pkgs = {
    web: JSON.parse(readFileSync(join(web, "package.json"), "utf8")),
    core: JSON.parse(readFileSync(join(core, "package.json"), "utf8")),
    worker: JSON.parse(readFileSync(join(worker, "package.json"), "utf8")),
  };
  const deps = {};
  const add = (fromDir, list) => {
    for (const name of Object.keys(list ?? {})) {
      if (name.startsWith("@outrun/") || name === "tsx") continue;
      deps[name] ??= installedVersion(fromDir, name);
    }
  };
  add(web, pkgs.web.dependencies);
  add(core, pkgs.core.dependencies);
  add(worker, pkgs.worker.dependencies);
  const devDeps = {
    typescript: installedVersion(ROOT, "typescript"),
    "@types/node": installedVersion(ROOT, "@types/node"),
    "@types/react": installedVersion(web, "@types/react"),
    "@types/react-dom": installedVersion(web, "@types/react-dom"),
    "@types/pg": installedVersion(core, "@types/pg"),
  };
  writeFileSync(
    join(BUILD, "package.json"),
    `${JSON.stringify(
      {
        name: "outrun-hosted-web",
        private: true,
        type: "module",
        scripts: { build: "next build", start: "next start" },
        dependencies: deps,
        devDependencies: devDeps,
      },
      null,
      2,
    )}\n`,
  );
  for (const [dir, pkg] of [
    ["vendor/core", pkgs.core],
    ["vendor/worker", pkgs.worker],
  ]) {
    writeFileSync(
      join(BUILD, dir, "package.json"),
      `${JSON.stringify({ name: pkg.name, private: true, type: "module" }, null, 2)}\n`,
    );
  }

  const base = JSON.parse(readFileSync(join(ROOT, "tsconfig.base.json"), "utf8"));
  const webTs = JSON.parse(readFileSync(join(web, "tsconfig.json"), "utf8"));
  writeFileSync(
    join(BUILD, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          ...base.compilerOptions,
          ...webTs.compilerOptions,
          paths: {
            ...webTs.compilerOptions.paths,
            ...exportsToPaths("@outrun/core", "vendor/core", pkgs.core.exports),
            ...exportsToPaths("@outrun/worker", "vendor/worker", pkgs.worker.exports),
          },
        },
        include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
        exclude: ["node_modules"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(BUILD, "vercel.json"), `${JSON.stringify({ framework: "nextjs" }, null, 2)}\n`);

  // Naive redeploys only when the files change, so changed settings change a stamp file.
  const stamp = createHash("sha256")
    .update(
      JSON.stringify([
        state.appUrl,
        state.webhookSecret,
        state.testInbox,
        state.crewTokenSecret,
        state.adminToken,
      ]),
    )
    .digest("hex");
  mkdirSync(join(BUILD, "public"), { recursive: true });
  writeFileSync(join(BUILD, "public", ".naive-hosted-stamp.txt"), `${stamp}\n`);
  console.log(`built ${relative(ROOT, BUILD)} (${Object.keys(deps).length} dependencies)`);
}

// ---- apply --------------------------------------------------------------------------------------

function hostedEnv(state) {
  return {
    NAIVE_HOSTED_NAIVE_KEY: key,
    NAIVE_HOSTED_CREW_TOKEN_SECRET: state.crewTokenSecret,
    NAIVE_HOSTED_ADMIN_TOKEN: state.adminToken,
    NAIVE_HOSTED_AUTH_SECRET: state.authSecret,
    ...(state.webhookSecret ? { NAIVE_HOSTED_WEBHOOK_SECRET: state.webhookSecret } : {}),
    ...(state.testInbox
      ? {
          NAIVE_HOSTED_TEST_INBOX: state.testInbox,
          NAIVE_HOSTED_AGENTMAIL_KEY: process.env.AGENTMAIL_API_KEY ?? "",
        }
      : {}),
  };
}

function waitForDeploy(state, appId) {
  for (let i = 0; i < 90; i += 1) {
    const d = naive(state, ["app", "deployments", appId]).data?.[0];
    if (d && !["queued", "building"].includes(d.status)) {
      if (d.status !== "ready") fail(`deployment ${d.id} is ${d.status}: ${d.error ?? "no error given"}`);
      return d;
    }
    spawnSync("sleep", ["10"]);
  }
  fail("deployment did not finish in 15 minutes");
}

function up(state) {
  assertAccount(state);
  if (state.testInbox && !process.env.AGENTMAIL_API_KEY)
    fail("NAIVE_HOSTED_TEST_INBOX needs AGENTMAIL_API_KEY in the root .env.");
  build(state);
  const report = naive(state, ["up"], { env: hostedEnv(state) });
  for (const r of [...(report.apps ?? []), ...(report.agents ?? []), ...(report.schedules ?? [])]) {
    console.log(`  ${r.name}: ${r.action}${r.reason ? ` (${r.reason})` : ""}`);
  }
  const refused = [...(report.apps ?? []), ...(report.agents ?? [])].filter((r) => r.action === "refused");
  if (refused.length > 0) fail("naive up refused something; read the report above.");
  const app = naive(state, ["app", "list"]).data?.find((a) => a.name === PROJECT_APP);
  if (!app) fail("the outrun-hosted app wasn't created");
  state.appId = app.id;
  saveState(state);
  const deployment = waitForDeploy(state, app.id);
  const url = naive(state, ["app", "show", app.id]).url;
  if (url && state.appUrl !== url) {
    state.appUrl = url;
    saveState(state);
    console.log(`app URL is ${url}; applying again so APP_URL is set`);
    return up(state);
  }
  // The assembled copy has done its job; remove it so nothing in the repo (lint, search) sees it.
  rmSync(join(HERE, ".build"), { recursive: true, force: true });
  console.log(`ready: ${state.appUrl} (deployment ${deployment.id})`);
}

async function admin(state, op, extra = {}) {
  if (!state.appUrl) fail("No app URL yet; run `up` first.");
  const res = await fetch(`${state.appUrl}/api/hosted/admin`, {
    method: "POST",
    headers: { authorization: `Bearer ${state.adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ ...extra, op }),
    signal: AbortSignal.timeout(90_000),
  });
  const body = await res.text();
  console.log(`${op}: HTTP ${res.status}`);
  console.log(body.length > 4000 ? `${body.slice(0, 4000)}…` : body);
  if (!res.ok) process.exitCode = 1;
}

function rootScript(state, script, extraArgs = []) {
  assertAccount(state);
  if (!state.appUrl) fail("No app URL yet; run `up` first.");
  const r = spawnSync("pnpm", [script, ...extraArgs], {
    cwd: ROOT,
    stdio: "inherit",
    env: naiveEnv(state, {
      APP_URL: state.appUrl,
      CREW_TOKEN_SECRET: state.crewTokenSecret,
      ...(script === "naive:up" ? { OUTRUN_APPLY: "yes" } : {}),
    }),
  });
  if (r.status !== 0) process.exitCode = r.status ?? 1;
}

function sync(state) {
  rootScript(state, "naive:sync");
  const file = join(ROOT, ".naive", "webhook-secret");
  if (existsSync(file)) {
    state.webhookSecret = readFileSync(file, "utf8").trim();
    saveState(state);
    rmSync(file);
    console.log("webhook secret saved to the hosted state (not printed); run `up` to set it on the app");
  }
}

// ---- main ---------------------------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
const state = loadState();
switch (command) {
  case "build":
    build(state);
    break;
  case "up":
    up(state);
    break;
  case "admin":
    await admin(state, rest[0] ?? "status", rest[1] ? JSON.parse(rest[1]) : {});
    break;
  case "crew":
    rootScript(state, rest.includes("--dry-run") ? "naive:dry-run" : "naive:up");
    break;
  case "sync":
    sync(state);
    break;
  case "all":
    up(state);
    await admin(state, "migrate");
    await admin(state, "seed");
    rootScript(state, "naive:up");
    sync(state);
    up(state);
    await admin(state, "status");
    break;
  default:
    console.error(
      "usage: NAIVE_HOSTED=1 node deploy/naive-hosted/deploy.mjs build|up|admin <op>|crew [--dry-run]|sync|all",
    );
    process.exit(2);
}
