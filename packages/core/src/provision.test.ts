import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { SCHEDULE, agentConfig, clientCrew } from "../../../naive/crew";
import { CLIENT_ROLES } from "../contracts";
import { addClient } from "./clients";
import { crewToken } from "./crew/tokens";
import { clients, events } from "./db/schema";
import { createEmitter } from "./events";
import { FakeNaiveClient } from "./fakes";
import { provisionClientCrew, type ProvisionDeps } from "./provision";
import { createTempDatabase, type TempDb } from "./testing/db";

const APP = "https://outrun.example";
const SECRET = "test-crew-secret-0123456789abcdef"; // gitleaks:allow (throwaway test value)

describe("provision_client_crew", () => {
  let t: TempDb;
  let jobs: { type: string; payload: Record<string, unknown>; idempotencyKey: string }[];
  const deps = (naive: FakeNaiveClient | null, over: Partial<ProvisionDeps> = {}): ProvisionDeps => ({
    db: t.db,
    emit: createEmitter(t.db),
    enqueue: async (j) => {
      jobs.push(j);
      return { jobId: "j" };
    },
    naive,
    appUrl: APP,
    secret: SECRET,
    ...over,
  });
  const newClient = (name: string, domain: string) =>
    addClient(deps(null), { name, domain, approverEmails: [`a@${domain}`] }, "web");
  const eventsOf = async (clientId: string, type: string) =>
    (await t.db.select().from(events).where(eq(events.entityId, clientId))).filter((e) => e.type === type);

  beforeAll(async () => {
    t = await createTempDatabase();
    jobs = [];
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("creates six agents, their vault tokens and the crew's schedules, then starts profiling", async () => {
    const naive = new FakeNaiveClient();
    const c = await newClient("Gamma Grid", "gamma-grid.dev");
    const out = await provisionClientCrew(deps(naive), c.id);
    const names = CLIENT_ROLES.map((r) => `gamma-grid-${r}`);
    expect(out).toMatchObject({ status: "provisioned", agents: names, created: names, credentials: 6 });

    // The same body naive.config.ts declares for the agent.
    const crew = clientCrew(APP, { slug: "gamma-grid", name: "Gamma Grid" });
    expect(naive.agents.map(({ id: _id, ...body }) => body)).toEqual(crew.map(agentConfig));
    expect(naive.agents[0]).toMatchObject({
      model: expect.any(String),
      budget: { period: "day" },
      mcp_servers: [{ name: "outrun", url: `${APP}/api/crew/mcp/gamma-grid/${CLIENT_ROLES[0]}` }],
      tools: { default_config: { permission: "deny" } },
    });
    expect(naive.credentials).toHaveLength(6);
    for (const m of crew) {
      const cred = naive.credentials.find((x) => x.key === `crew-${m.name}`)!;
      expect(cred).toMatchObject({
        kind: "static_bearer",
        vaultId: "vlt_fake_outrun-crew",
        mcp_server_url: m.mcpUrl,
      });
      expect(cred.value).toBe(crewToken(SECRET, m.role, "gamma-grid"));
    }
    // Client crews have no schedule of their own (the CEO kicks them), so no deployment is made.
    expect(naive.deployments).toHaveLength(crew.filter((m) => m.schedule).length);
    // Every POST carried an idempotency key; no token value reached the call log.
    for (const call of naive.calls.filter((x) => x.method.startsWith("create")))
      expect(String(call.args.at(-1))).toMatch(new RegExp(`^provision:${c.id}:`));
    expect(JSON.stringify(naive.calls)).not.toContain(crewToken(SECRET, "sdr", "gamma-grid"));

    const [ev] = await eventsOf(c.id, "client.crew_provisioned");
    expect(ev).toMatchObject({ actor: "worker", payload: { agents: names } });
    expect(JSON.stringify(ev!.payload)).not.toContain(crewToken(SECRET, "sdr", "gamma-grid"));
    const [row] = await t.db.select().from(clients).where(eq(clients.id, c.id));
    expect(row!.status).toBe("profiling");
    expect(jobs.at(-1)).toMatchObject({
      type: "start_session",
      payload: { agent: "researcher", clientId: c.id },
    });

    // Agents made this way start sessions by name.
    const id = await naive.resolveAgentId("gamma-grid-researcher");
    expect(naive.agents.some((a) => a.id === id)).toBe(true);
    await expect(
      naive.startSession({ agentId: id, message: "hi", metadata: {}, idempotencyKey: "k1" }),
    ).resolves.toMatchObject({ sessionId: expect.any(String) });

    // A second run creates nothing new.
    const before = { a: naive.agents.length, c: naive.credentials.length, d: naive.deployments.length };
    const again = await provisionClientCrew(deps(naive), c.id);
    expect(again).toMatchObject({ status: "provisioned", created: [], credentials: 0, deployments: 0 });
    expect({ a: naive.agents.length, c: naive.credentials.length, d: naive.deployments.length }).toEqual(
      before,
    );
  });

  it("deploys the orchestrator's schedule once, when the crew has one", async () => {
    const naive = new FakeNaiveClient();
    const c = await newClient("Sched Co", "sched-co.dev");
    const withSchedule: typeof clientCrew = (app, client) =>
      clientCrew(app, client).map((m) => (m.role === "orchestrator" ? { ...m, schedule: SCHEDULE } : m));
    await provisionClientCrew(deps(naive, { crew: withSchedule }), c.id);
    const orch = naive.agents.find((a) => a.name === "sched-co-orchestrator")!;
    expect(naive.deployments).toEqual([
      {
        id: expect.any(String),
        agent_id: orch.id,
        cron: SCHEDULE.cron,
        timezone: SCHEDULE.timezone,
        input_template: SCHEDULE.input,
        budget_micro_usd: SCHEDULE.budget_micro_usd,
      },
    ]);
    await provisionClientCrew(deps(naive, { crew: withSchedule }), c.id);
    expect(naive.deployments).toHaveLength(1);
    expect(naive.agents).toHaveLength(6);
    expect(naive.credentials).toHaveLength(6);
  });

  it("treats a 409 as already made", async () => {
    const naive = new FakeNaiveClient();
    const c = await newClient("Race Co", "race-co.dev");
    // naive up made the researcher first, under another key.
    const crew = clientCrew(APP, { slug: c.slug, name: c.name });
    await naive.createAgent(agentConfig(crew.find((m) => m.role === "researcher")!), "naive-up");
    const listAgents = naive.listAgents.bind(naive);
    let first = true;
    naive.listAgents = async () => {
      // The first listing misses it, as if it landed in between.
      if (first) {
        first = false;
        return (await listAgents()).filter((a) => !a.name.endsWith("-researcher"));
      }
      return listAgents();
    };
    const out = await provisionClientCrew(deps(naive), c.id);
    expect(out).toMatchObject({ status: "provisioned" });
    expect(naive.agents).toHaveLength(6);
  });

  it("is pending, not failed, without a key, a secret, the scopes or the vault", async () => {
    const c = await newClient("Pend Co", "pend-co.dev");
    expect(await provisionClientCrew(deps(null), c.id)).toEqual({
      status: "pending",
      reason: "NAIVE_API_KEY is not set",
    });
    const [ev] = await eventsOf(c.id, "client.crew_pending");
    expect(ev).toMatchObject({ actor: "worker", payload: { reason: "NAIVE_API_KEY is not set" } });

    expect(await provisionClientCrew(deps(new FakeNaiveClient(), { secret: undefined }), c.id)).toMatchObject(
      {
        status: "pending",
      },
    );

    const scoped = new FakeNaiveClient();
    scoped.provisionStatus = { status: 403, code: "insufficient_scope" };
    expect(await provisionClientCrew(deps(scoped), c.id)).toMatchObject({
      status: "pending",
      reason: expect.stringContaining("403"),
    });
    const unauth = new FakeNaiveClient();
    unauth.provisionStatus = { status: 401, code: "unauthorized" };
    expect(await provisionClientCrew(deps(unauth), c.id)).toMatchObject({ status: "pending" });

    const noVault = new FakeNaiveClient();
    noVault.vaults.length = 0;
    expect(await provisionClientCrew(deps(noVault), c.id)).toMatchObject({
      status: "pending",
      reason: expect.stringContaining("vault"),
    });
    // Nothing moved past draft, and profiling never started.
    const [row] = await t.db.select().from(clients).where(eq(clients.id, c.id));
    expect(row!.status).toBe("draft");
  });

  it("retries other upstream errors", async () => {
    const naive = new FakeNaiveClient();
    naive.provisionStatus = { status: 503, code: "unavailable" };
    const c = await newClient("Down Co", "down-co.dev");
    await expect(provisionClientCrew(deps(naive), c.id)).rejects.toMatchObject({ code: "upstream_error" });
  });
});
