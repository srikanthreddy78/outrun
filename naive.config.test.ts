/**
 * Fails when naive.config.ts drifts from the contracts: every agent has a budget, the two
 * sending tools are `ask`, each agent's tool list is exactly its contract list, and the
 * default is deny. Tool authority lives in two places (ADR 0008); this keeps them in step.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORE_CLIENT_ROLES,
  OPTIONAL_CLIENT_ROLES,
  OUTRUN_AGENTS,
  BUILTIN_TOOLS,
  CLIENT_ROLES,
  CREW_TOOLS,
  MCP_SERVER_NAME,
  qualified,
  toolsForMember,
} from "./packages/core/contracts";
import { parseNaiveAgentName } from "./packages/core/src/crew/identity";
import { crewToken, crewTokenEnv, verifyCrewToken } from "./packages/core/src/crew/tokens";
import { BUDGETS, CEO_SCHEDULE, CLIENT_BUDGETS, SCHEDULE, loadClientCrews } from "./naive/crew";

const APP_URL = "https://outrun.example";

type Agent = {
  name: string;
  model: string;
  budget: { cap_micro_usd: number; max_task_micro_usd: number; period: string };
  tools: {
    default_config: { permission: string };
    configs: Record<string, { enabled: boolean; permission: string }>;
  };
  mcp_servers: { name: string; url: string }[];
  skills: string[];
  identity: string;
  multiagent?: unknown;
  handoffs?: unknown;
  schedules?: { cron: string; timezone: string; budget_micro_usd: number }[];
};
type Project = {
  name: string;
  agents: Agent[];
  skills: { slug: string; file: string }[];
  vaults: {
    name: string;
    identity?: string;
    credentials: { kind: string; mcp_server_url: string; value: { from_env: string } }[];
  }[];
};

/** Two clients besides Outrun, as pnpm clients:export would write them; the CEO staffed Blue Sky an account manager. */
const CLIENTS = [
  { slug: "acme", name: "Acme Analytics", roles: [...CORE_CLIENT_ROLES] },
  { slug: "blue-sky", name: "Blue Sky Labs", roles: [...CORE_CLIENT_ROLES, "account_manager"] },
];

let project: Project;
beforeAll(async () => {
  process.env.APP_URL = APP_URL;
  const dir = mkdtempSync(join(tmpdir(), "outrun-clients-"));
  process.env.NAIVE_CLIENTS_FILE = join(dir, "clients.json");
  writeFileSync(process.env.NAIVE_CLIENTS_FILE, JSON.stringify(CLIENTS));
  project = (await import("./naive.config")).default as unknown as Project;
});
const agent = (name: string) => project.agents.find((a) => a.name === name)!;
const member = (a: Agent) => parseNaiveAgentName(a.name) ?? { agent: "ceo" as const, clientSlug: "outrun" };
const pathOf = (a: Agent) => {
  const m = member(a);
  return m.clientSlug === "outrun" ? m.agent : `${m.clientSlug}/${m.agent}`;
};

describe("naive.config.ts", () => {
  it("declares the CEO, Outrun's six, and each client's staffed roles", () => {
    const names = project.agents.map((a) => a.name).sort();
    expect(names).toHaveLength(OUTRUN_AGENTS.length + 6 + 7);
    const want = [
      ...OUTRUN_AGENTS,
      ...CLIENTS.flatMap((c) => c.roles.map((r) => `${c.slug}-${r.replace(/_/g, "-")}`)),
    ].sort();
    expect(names).toEqual(want);
    expect(names).not.toContain("acme-ceo");
    expect(names).not.toContain("acme-account-manager");
    expect(agent("blue-sky-account-manager").tools.default_config.permission).toBe("deny");
  });

  it("tells each client's agents who they work for", () => {
    expect((agent("acme-sdr") as unknown as { system: string }).system).toContain("Acme Analytics's crew");
    expect((agent("ceo") as unknown as { system: string }).system).toContain("CEO of the Outrun agency");
  });

  it("gives every agent a budget, as planned", () => {
    for (const a of project.agents) {
      expect(a.budget.cap_micro_usd).toBeGreaterThan(0);
      expect(a.budget.max_task_micro_usd).toBeGreaterThan(0);
      expect(a.budget.max_task_micro_usd).toBeLessThanOrEqual(a.budget.cap_micro_usd);
    }
    expect(agent("sdr").budget).toEqual({
      cap_micro_usd: 5_000_000,
      max_task_micro_usd: 1_000_000,
      period: "day",
    });
    expect(agent("auditor").budget).toEqual({
      cap_micro_usd: 10_000_000,
      max_task_micro_usd: 3_000_000,
      period: "day",
    });
    const daily = Object.values(BUDGETS).reduce((s, b) => s + b.cap_micro_usd, 0) / 1e6;
    expect(daily).toBe(38);
    expect(agent("acme-sdr").budget).toEqual(CLIENT_BUDGETS.sdr);
    const perClient = CORE_CLIENT_ROLES.reduce((s, r) => s + CLIENT_BUDGETS[r].cap_micro_usd, 0) / 1e6;
    expect(perClient).toBe(13.5);
    for (const r of OPTIONAL_CLIENT_ROLES) expect(CLIENT_BUDGETS[r].cap_micro_usd / 1e6).toBe(2);
  });

  it("denies by default", () => {
    for (const a of project.agents) expect(a.tools.default_config.permission).toBe("deny");
  });

  it("makes both sending tools ask, for exactly the agents that send", () => {
    expect(agent("sdr").tools.configs["outrun.send_email"]?.permission).toBe("ask");
    expect(agent("closer").tools.configs["outrun.reply_email"]?.permission).toBe("ask");
    for (const a of project.agents) {
      for (const [name, c] of Object.entries(a.tools.configs)) {
        if (/send_email|reply_email/.test(name)) expect(c.permission).toBe("ask");
        else expect(c.permission).not.toBe("ask");
      }
    }
  });

  it("gives each agent exactly its contract tools and built-ins, nothing else", () => {
    for (const a of project.agents) {
      const m = member(a);
      const tools = toolsForMember(m.agent, m.clientSlug === "outrun");
      const got = Object.keys(a.tools.configs).sort();
      expect(got).toEqual([...tools.map(qualified), ...BUILTIN_TOOLS[m.agent]].sort());
      for (const t of tools) expect(a.tools.configs[qualified(t)]?.permission).toBe(CREW_TOOLS[t].policy);
    }
    // Other clients don't sell Outrun's products through Outrun's Stripe.
    expect(agent("closer").tools.configs["outrun.create_checkout_link"]).toBeDefined();
    expect(agent("acme-closer").tools.configs["outrun.create_checkout_link"]).toBeUndefined();
  });

  it("points each agent at its own crew MCP endpoint", () => {
    for (const a of project.agents)
      expect(a.mcp_servers).toEqual([{ name: MCP_SERVER_NAME, url: `${APP_URL}/api/crew/mcp/${pathOf(a)}` }]);
    expect(agent("blue-sky-closer").mcp_servers[0]!.url).toBe(`${APP_URL}/api/crew/mcp/blue-sky/closer`);
  });

  it("seals one bearer per agent in the vault, keyed by that agent's URL", () => {
    const creds = project.vaults[0]!.credentials;
    expect(creds).toHaveLength(project.agents.length);
    expect(new Set(creds.map((c) => c.value.from_env)).size).toBe(creds.length);
    for (const a of project.agents) {
      const m = member(a);
      expect(creds).toContainEqual(
        expect.objectContaining({
          kind: "static_bearer",
          mcp_server_url: `${APP_URL}/api/crew/mcp/${pathOf(a)}`,
          value: { from_env: crewTokenEnv(m.agent, m.clientSlug) },
        }),
      );
    }
  });

  it("builds no team: no multiagent roster, no handoffs, no team built-ins", () => {
    for (const a of project.agents) {
      expect(a.multiagent).toBeUndefined();
      expect(a.handoffs).toBe(false);
      for (const t of ["board_read", "board_write", "send_to_agent", "wait_for_agents", "list_agents"])
        expect(a.tools.configs[t]).toBeUndefined();
    }
    expect(agent("orchestrator").tools.configs["outrun.plan_day"]?.permission).toBe("allow");
  });

  it("keeps the crew vault org-wide, not bound to the persona", () => {
    expect(project.vaults[0]!.identity).toBeUndefined();
  });

  it("schedules the CEO at 08:30 and Outrun's orchestrator at 09:00; the CEO starts the other clients", () => {
    expect(agent("ceo").schedules).toEqual([
      expect.objectContaining({ cron: CEO_SCHEDULE.cron, timezone: "America/Los_Angeles" }),
    ]);
    expect(CEO_SCHEDULE.cron).toBe("30 8 * * 1-5");
    expect(agent("orchestrator").schedules).toEqual([
      expect.objectContaining({ cron: SCHEDULE.cron, timezone: "America/Los_Angeles" }),
    ]);
    expect(SCHEDULE.cron).toBe("0 9 * * 1-5");
    for (const a of project.agents.filter((x) => !["orchestrator", "ceo"].includes(x.name)))
      expect(a.schedules ?? []).toEqual([]);
  });

  it("gives Outrun's crew and the CEO their own skills, and every client crew the agency set", () => {
    for (const a of project.agents) {
      const m = member(a);
      expect(a.skills).toEqual([
        m.clientSlug === "outrun" ? m.agent : `agency-${m.agent.replace(/_/g, "-")}`,
      ]);
    }
    expect(project.skills.map((s) => s.slug).sort()).toEqual(
      [...OUTRUN_AGENTS, ...CLIENT_ROLES.map((r) => `agency-${r.replace(/_/g, "-")}`)].sort(),
    );
  });

  it("refuses a bad clients file", () => {
    const dir = mkdtempSync(join(tmpdir(), "outrun-clients-bad-"));
    const f = (body: unknown) => {
      const p = join(dir, `${Math.random()}.json`);
      writeFileSync(p, JSON.stringify(body));
      return p;
    };
    expect(loadClientCrews(join(dir, "missing.json"))).toEqual([]);
    expect(() => loadClientCrews(f([{ slug: "outrun", name: "x" }]))).toThrow(/bad client slug/);
    expect(() => loadClientCrews(f([{ slug: "Has Space", name: "x" }]))).toThrow(/bad client slug/);
    expect(() => loadClientCrews(f([{ slug: "a", name: "" }]))).toThrow(/needs a name/);
    expect(() =>
      loadClientCrews(
        f([
          { slug: "a", name: "A" },
          { slug: "a", name: "B" },
        ]),
      ),
    ).toThrow(/twice/);
  });
});

describe("crew tokens", () => {
  it("are per agent and verified in constant time", () => {
    const s = "secret";
    expect(crewToken(s, "sdr")).not.toBe(crewToken(s, "closer"));
    expect(verifyCrewToken(s, "sdr", crewToken(s, "sdr"))).toBe(true);
    expect(verifyCrewToken(s, "sdr", crewToken(s, "closer"))).toBe(false);
    expect(verifyCrewToken(s, "sdr", "")).toBe(false);
    expect(verifyCrewToken("other", "sdr", crewToken(s, "sdr"))).toBe(false);
  });
});
