/**
 * pnpm eval: replays evals/crew/*.yaml on the fake Naive client against the real tool
 * registry, a throwaway database and the real `ask`/`allow` policies. No credits, no network.
 *
 *   name: sdr's send is held for a person
 *   agent: sdr
 *   steps:                       # the tool calls the agent makes, in order
 *     - { tool: send_email, input: { draftId: "...", hash: "..." } }
 *   seed: demo                   # optional: the demo prospect and a scan (llms_txt fails, openapi passes)
 *   seed: agency                 # optional: active client ...a001 and client ...a002, paused by its owner
 *   decisions: [deny]            # answers to held (ask) calls, in order
 *   expect:
 *     calls:                     # what actually ran, in order
 *       - { tool: send_email, decision: deny }
 *     held: 0                    # pending calls left at the end
 *     stopReason: end_turn
 *     enqueued: [start_session]  # job types the tools enqueued (optional)
 *
 * In inputs, "$prospectId" is the seeded prospect, and "$draftId" / "$hash" come from the latest
 * passing check_draft. `result: {...}` on a call matches those fields of what it returned, and
 * `notEnqueued: [...]` lists job types that must not appear.
 * `ok: true` on a call means it returned a result; `error: <code>` means it failed with that code.
 * pnpm eval:crew runs the same files as real sessions in demo mode; it spends credits, ask first.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { AGENTS, CREW_TOOLS, type CrewToolName, type JobEnvelopeInput } from "@outrun/core/contracts";
import { ToolRegistry } from "@outrun/core/crew";
import { allTools } from "@outrun/core/crew/tools";
import { createEmitter } from "@outrun/core/events";
import { FakeNaiveClient } from "@outrun/core/fakes";
import { createTempDatabase, type TempDb } from "@outrun/core/testing/db";
import { clients, scans } from "@outrun/core/db";
import { setPaused } from "@outrun/core/clients";
import { DEMO_PLACEHOLDER, seedDemo } from "@outrun/core/seed";
import { loadConfig } from "@outrun/core";
import { OUTRUN_CLIENT_ID } from "@outrun/core/constants";

const ToolName = z.enum(Object.keys(CREW_TOOLS) as [CrewToolName, ...CrewToolName[]]);
const Scenario = z.object({
  name: z.string(),
  agent: z.enum(AGENTS),
  seed: z.enum(["demo", "agency"]).optional(),
  steps: z.array(z.object({ tool: ToolName, input: z.unknown().default({}) })).min(1),
  decisions: z.array(z.enum(["allow", "deny"])).default([]),
  expect: z.object({
    calls: z
      .array(
        z.object({
          tool: ToolName,
          ok: z.boolean().optional(),
          error: z.string().optional(),
          decision: z.enum(["allow", "deny"]).optional(),
          result: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .default([]),
    held: z.number().int().nonnegative().optional(),
    stopReason: z.string().optional(),
    enqueued: z.array(z.string()).optional(),
    notEnqueued: z.array(z.string()).optional(),
  }),
});
type Scenario = z.infer<typeof Scenario>;

/** The demo prospect and one scan, so outreach scenarios have checks to cite. */
async function seedScenario(db: TempDb["db"]) {
  const ids = await seedDemo(db);
  await db.insert(scans).values({
    domain: DEMO_PLACEHOLDER.domain,
    version: 1,
    scannerVersion: "eval",
    score: 40,
    checks: [
      {
        id: "llms-txt",
        label: "llms.txt",
        status: "fail",
        evidence: "404",
        weight: 10,
        category: "readiness",
      },
      {
        id: "openapi",
        label: "OpenAPI",
        status: "pass",
        evidence: "found",
        weight: 6,
        category: "readiness",
      },
    ],
  });
  return ids;
}

/** Two confirmed clients for CEO scenarios: one active, one its owner paused. */
async function seedAgency(db: TempDb["db"]) {
  const profile = {
    summary: "Invoicing software for small firms.",
    icp: {
      description: "Small accounting firms",
      includeKeywords: ["invoicing"],
      excludeKeywords: [],
      buyerRoles: ["CFO"],
      companySizes: [],
    },
    offer: { pitch: "A demo", callToActionUrl: "https://acme.example/demo", prices: [] },
  };
  const base = {
    status: "active" as const,
    dnsStatus: "verified" as const,
    profileConfirmedAt: new Date(),
    profile,
  };
  await db.insert(clients).values([
    {
      ...base,
      id: "0190f0f0-0000-7000-8000-00000000a001",
      slug: "acme",
      name: "Acme",
      domain: "acme.example",
    },
    {
      ...base,
      id: "0190f0f0-0000-7000-8000-00000000a002",
      slug: "beta",
      name: "Beta",
      domain: "beta.example",
    },
  ]);
  await setPaused(
    { db, emit: createEmitter(db) },
    "0190f0f0-0000-7000-8000-00000000a002",
    true,
    "user:owner",
  );
}

/** Replaces "$prospectId", "$draftId" and "$hash" when the step runs. */
function withRefs(input: unknown, prospectId: string | undefined): unknown {
  const text = JSON.stringify(input);
  if (!/"\$(prospectId|draftId|hash)"/.test(text)) return input;
  return (calls: { tool: string; result?: unknown }[]) => {
    const draft = [...calls]
      .reverse()
      .map((c) =>
        c.tool === "check_draft" ? (c.result as { ok?: boolean; draftId?: string; hash?: string }) : null,
      )
      .find((r) => r?.ok);
    const refs: Record<string, string | undefined> = {
      prospectId,
      draftId: draft?.draftId,
      hash: draft?.hash,
    };
    return JSON.parse(
      text.replace(/"\$(prospectId|draftId|hash)"/g, (_m, k: string) =>
        JSON.stringify(refs[k] ?? `missing-${k}`),
      ),
    );
  };
}

async function runScenario(s: Scenario): Promise<string[]> {
  const t = await createTempDatabase();
  try {
    const config = loadConfig({ ...process.env, OUTRUN_DEMO: "true" });
    const registry = new ToolRegistry(
      allTools({
        settings: config.settings,
        outreach: { appUrl: config.appUrl, settings: config.settings, mx: async () => true },
      }),
    );
    const seeded = s.seed === "demo" ? await seedScenario(t.db) : null;
    if (s.seed === "agency") await seedAgency(t.db);
    const enqueued: JobEnvelopeInput[] = [];
    const emit = createEmitter(t.db);
    const naive = new FakeNaiveClient({
      registry,
      ctx: (agent) => ({
        agent,
        requestId: "eval",
        clientId: OUTRUN_CLIENT_ID,
        db: t.db,
        now: () => new Date(),
        enqueue: async (job) => (enqueued.push(job), { jobId: null }),
        emit,
      }),
    });
    naive.script(
      s.agent,
      s.steps.map((st) => ({ tool: st.tool, input: withRefs(st.input, seeded?.prospectId) })),
    );
    const { sessionId } = await naive.startSession({
      agentId: naive.agentIdOf(s.agent),
      message: `eval: ${s.name}`,
      metadata: {},
      idempotencyKey: `eval:${s.name}`,
    });
    for (const decision of s.decisions) {
      const held = (await naive.getSession(sessionId)).pendingActions[0];
      if (!held) return [`decision ${decision} given but nothing is held`];
      await naive.confirmTool(sessionId, held.toolCallId, decision, "eval");
    }

    const problems: string[] = [];
    const calls = naive.toolCalls;
    if (calls.length !== s.expect.calls.length && s.expect.calls.length > 0) {
      problems.push(`expected ${s.expect.calls.length} calls, got ${calls.length}`);
    }
    s.expect.calls.forEach((want, i) => {
      const got = calls[i];
      if (!got) return problems.push(`call ${i + 1}: expected ${want.tool}, got nothing`);
      if (got.tool !== want.tool) problems.push(`call ${i + 1}: expected ${want.tool}, got ${got.tool}`);
      if (want.ok === true && got.error)
        problems.push(`call ${i + 1} ${got.tool}: failed with ${got.error.code}`);
      if (want.error && got.error?.code !== want.error)
        problems.push(
          `call ${i + 1} ${got.tool}: expected error ${want.error}, got ${got.error?.code ?? "success"}`,
        );
      if (want.result) {
        const res = (got.result ?? {}) as Record<string, unknown>;
        for (const [k, v] of Object.entries(want.result))
          if (JSON.stringify(res[k]) !== JSON.stringify(v))
            problems.push(
              `call ${i + 1} ${got.tool}: expected ${k}=${JSON.stringify(v)}, got ${JSON.stringify(res[k])}`,
            );
      }
      if (want.decision && got.decision !== want.decision)
        problems.push(
          `call ${i + 1} ${got.tool}: expected decision ${want.decision}, got ${got.decision ?? "none"}`,
        );
    });
    const session = await naive.getSession(sessionId);
    if (s.expect.held !== undefined && session.pendingActions.length !== s.expect.held)
      problems.push(`expected ${s.expect.held} held calls, got ${session.pendingActions.length}`);
    if (s.expect.stopReason && session.stopReason !== s.expect.stopReason)
      problems.push(`expected stop reason ${s.expect.stopReason}, got ${session.stopReason}`);
    if (s.expect.enqueued) {
      const types = enqueued.map((j) => j.type);
      for (const want of s.expect.enqueued)
        if (!types.includes(want as never)) problems.push(`expected a ${want} job`);
    }
    for (const no of s.expect.notEnqueued ?? [])
      if (enqueued.some((j) => j.type === no)) problems.push(`expected no ${no} job`);
    return problems;
  } finally {
    await t.drop();
  }
}

async function main(): Promise<void> {
  const dir = join(import.meta.dirname, "..", "evals", "crew");
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  if (files.length === 0) {
    console.error("no scenarios in evals/crew: the eval gate needs at least one");
    process.exit(1);
  }
  let failed = 0;
  for (const file of files.sort()) {
    let problems: string[];
    try {
      problems = await runScenario(Scenario.parse(parse(readFileSync(join(dir, file), "utf8"))));
    } catch (err) {
      problems = [(err as Error).message];
    }
    if (problems.length) {
      failed++;
      console.error(`FAIL ${file}\n  ${problems.join("\n  ")}`);
    } else console.log(`ok   ${file}`);
  }
  console.log(`${files.length} scenario file(s), ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
