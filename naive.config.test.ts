/**
 * Fails when naive.config.ts drifts from the contracts: every agent has a budget, the two
 * sending tools are `ask`, each agent's tool list is exactly its contract list, and the
 * default is deny. Tool authority lives in two places (ADR 0008); this keeps them in step.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  AGENTS,
  BUILTIN_TOOLS,
  CREW_TOOLS,
  MCP_SERVER_NAME,
  qualified,
  toolsForAgent,
} from "./packages/core/contracts";
import { crewToken, crewTokenEnv, verifyCrewToken } from "./packages/core/src/crew/tokens";
import { BUDGETS, SCHEDULE, TEAM } from "./naive/crew";

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
  multiagent?: { type: string; agents: unknown[]; board?: boolean };
  schedules?: { cron: string; timezone: string; budget_micro_usd: number }[];
};
type Project = {
  name: string;
  agents: Agent[];
  skills: { slug: string; file: string }[];
  vaults: {
    name: string;
    identity: string;
    credentials: { kind: string; mcp_server_url: string; value: { from_env: string } }[];
  }[];
};

let project: Project;
beforeAll(async () => {
  process.env.APP_URL = APP_URL;
  project = (await import("./naive.config")).default as unknown as Project;
});
const agent = (name: string) => project.agents.find((a) => a.name === name)!;

describe("naive.config.ts", () => {
  it("declares exactly the six agents", () => {
    expect(project.agents.map((a) => a.name).sort()).toEqual([...AGENTS].sort());
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
    expect(daily).toBe(35);
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
    for (const name of AGENTS) {
      const got = Object.keys(agent(name).tools.configs).sort();
      const want = [...toolsForAgent(name).map(qualified), ...BUILTIN_TOOLS[name]].sort();
      expect(got).toEqual(want);
      for (const t of toolsForAgent(name)) {
        expect(agent(name).tools.configs[qualified(t)]?.permission).toBe(CREW_TOOLS[t].policy);
      }
    }
  });

  it("points each agent at its own crew MCP endpoint", () => {
    for (const a of project.agents) {
      expect(a.mcp_servers).toEqual([{ name: MCP_SERVER_NAME, url: `${APP_URL}/api/crew/mcp/${a.name}` }]);
    }
  });

  it("seals one bearer per agent in the vault, keyed by that agent's URL", () => {
    const creds = project.vaults[0]!.credentials;
    expect(creds).toHaveLength(AGENTS.length);
    for (const a of AGENTS) {
      expect(creds).toContainEqual(
        expect.objectContaining({
          kind: "static_bearer",
          mcp_server_url: `${APP_URL}/api/crew/mcp/${a}`,
          value: { from_env: crewTokenEnv(a) },
        }),
      );
    }
  });

  it("makes the orchestrator the coordinator of the planned-work members, with a board", () => {
    const o = agent("orchestrator");
    expect(o.multiagent?.type).toBe("coordinator");
    expect(o.multiagent?.board).toBe(true);
    expect(o.multiagent?.agents).toEqual(TEAM.map((name) => ({ type: "agent", name })));
    for (const a of project.agents.filter((x) => x.name !== "orchestrator"))
      expect(a.multiagent).toBeUndefined();
  });

  it("schedules only the orchestrator, weekdays at 09:00 Los Angeles", () => {
    expect(agent("orchestrator").schedules).toEqual([
      expect.objectContaining({ cron: SCHEDULE.cron, timezone: "America/Los_Angeles" }),
    ]);
    expect(SCHEDULE.cron).toBe("0 9 * * 1-5");
    for (const a of project.agents.filter((x) => x.name !== "orchestrator"))
      expect(a.schedules ?? []).toEqual([]);
  });

  it("gives every agent its own skill file", () => {
    for (const a of project.agents) expect(a.skills).toEqual([a.name]);
    expect(project.skills.map((s) => s.slug).sort()).toEqual([...AGENTS].sort());
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
