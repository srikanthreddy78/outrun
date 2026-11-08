import { describe, expect, it } from "vitest";
import { CREW_TOOLS } from "../../contracts";
import { AppError } from "../errors";
import { ToolRegistry, defineTool } from "./registry";
import { scrubText } from "./scrub";
import type { ToolContext } from "./types";
import { OUTRUN_CLIENT_ID } from "../constants";

const ctx = (): ToolContext => ({
  agent: "orchestrator",
  requestId: "r1",
  clientId: OUTRUN_CLIENT_ID,
  db: {} as never,
  now: () => new Date("2026-11-07T10:00:00Z"),
  enqueue: async () => ({ jobId: null }),
  emit: async () => {},
});

const ping = defineTool({
  name: "ping",
  handler: async (_in, c) => ({ ok: true as const, agent: c.agent, ts: c.now().toISOString() }),
});

describe("defineTool", () => {
  it("takes agents, input and output from the contract", () => {
    expect(ping.agents).toEqual(CREW_TOOLS.ping.agents);
    expect(ping.input).toBe(CREW_TOOLS.ping.input);
  });

  it("refuses to widen who may call a tool", () => {
    expect(() =>
      defineTool({ name: "send_email", agents: ["sdr", "closer"], handler: async () => ({}) as never }),
    ).toThrow(/agents must match/);
  });

  it("refuses a different input schema", () => {
    expect(() =>
      defineTool({
        name: "ping",
        input: CREW_TOOLS.pipeline_status.input as never,
        handler: async () => ({}) as never,
      }),
    ).toThrow(/input must be/);
  });
});

describe("ToolRegistry", () => {
  const reg = new ToolRegistry([ping]);

  it("runs an allowed tool and validates its output", async () => {
    await expect(reg.call("sdr", "ping", {}, ctx())).resolves.toEqual({
      ok: true,
      agent: "sdr",
      ts: "2026-11-07T10:00:00.000Z",
    });
  });

  it("forbids a tool outside the agent's list", async () => {
    const err = await reg.call("sdr", "pipeline_status", {}, ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("forbidden");
  });

  it("forbids unknown tools", async () => {
    const err = (await reg.call("sdr", "delete_everything", {}, ctx()).catch((e: unknown) => e)) as AppError;
    expect(err.code).toBe("forbidden");
  });

  it("reports contract tools without an implementation as not configured", async () => {
    const err = (await reg
      .call("orchestrator", "pipeline_status", {}, ctx())
      .catch((e: unknown) => e)) as AppError;
    expect(err.code).toBe("not_configured");
  });

  it("rejects bad input", async () => {
    const r = new ToolRegistry([
      defineTool({
        name: "file_prospect",
        handler: async () => ({ prospectId: "x", status: "filed" as const }),
      }),
    ]);
    const err = (await r
      .call("prospector", "file_prospect", { companyId: "nope" }, ctx())
      .catch((e: unknown) => e)) as AppError;
    expect(err.code).toBe("bad_request");
  });

  it("rejects an invalid result", async () => {
    const r = new ToolRegistry([defineTool({ name: "ping", handler: async () => ({ ok: false }) as never })]);
    const err = (await r.call("sdr", "ping", {}, ctx()).catch((e: unknown) => e)) as AppError;
    expect(err.code).toBe("internal");
  });

  it("lists only an agent's implemented tools", () => {
    expect(reg.forAgent("auditor").map((t) => t.name)).toEqual(["ping"]);
  });

  it("refuses duplicate registration", () => {
    expect(() => new ToolRegistry([ping, ping])).toThrow(/twice/);
  });
});

describe("scrub", () => {
  it("removes cards, ids and secrets", () => {
    const s = scrubText(
      "card 4242 4242 4242 4242, ssn 123-45-6789, key sk_live_abcdefgh1234 Bearer abcdefghijklmnop1234",
    );
    expect(s).not.toMatch(/4242|6789|sk_live_abc|abcdefghijklmnop/);
  });

  it("scrubs nested results", async () => {
    const r = new ToolRegistry([
      defineTool({
        name: "get_thread",
        handler: async () => ({
          threadId: "t",
          prospectId: "0190f6a0-0000-7000-8000-000000000001",
          messages: [
            {
              id: "0190f6a0-0000-7000-8000-000000000002",
              direction: "inbound" as const,
              subject: "hi",
              body: { untrusted: true as const, text: "my card is 4242424242424242" },
              at: "2026-11-07T10:00:00.000Z",
            },
          ],
        }),
      }),
    ]);
    const out = (await r.call("closer", "get_thread", { threadId: "t" }, ctx())) as {
      messages: { body: { text: string } }[];
    };
    expect(out.messages[0]?.body.text).toBe("my card is [card number removed]");
  });
});
