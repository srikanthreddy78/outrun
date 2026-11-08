import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_TOOLS } from "@outrun/core/contracts";
import { createEmitter } from "@outrun/core/events";
import { FakeStripe } from "@outrun/core/fakes";
import type { PublicDeps } from "@outrun/core/public/service";
import { createTempDatabase, type TempDb } from "@outrun/core/testing/db";
import { publicMcpHandler } from "./public";

async function rpc(res: Response): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    return JSON.parse(data.at(-1)!);
  }
  return JSON.parse(text);
}

describe("public MCP server", () => {
  let t: TempDb;
  let deps: PublicDeps;
  beforeAll(async () => {
    t = await createTempDatabase();
    deps = {
      db: t.db,
      emit: createEmitter(t.db),
      stripe: new FakeStripe(),
      appUrl: "https://outrun.example",
      scan: async () => {
        throw new Error("not used");
      },
    };
  });
  afterAll(async () => {
    await t?.drop();
  });

  const call = (body: unknown) =>
    publicMcpHandler(
      async () => deps,
      "203.0.113.30",
    )(
      new Request("https://outrun.example/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify(body),
      }),
    ).then(rpc);

  it("lists the five tools with input and output schemas, without auth", async () => {
    const r = await call({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const tools = (r.result?.tools ?? []) as {
      name: string;
      outputSchema?: unknown;
      annotations?: { readOnlyHint?: boolean };
    }[];
    expect(tools.map((x) => x.name).sort()).toEqual(Object.keys(PUBLIC_TOOLS).sort());
    for (const tool of tools) expect(tool.outputSchema).toBeTruthy();
    expect(tools.find((x) => x.name === "buy_audit")!.annotations?.readOnlyHint).toBe(false);
  });

  it("returns structured content, and the contract's error body on a bad call", async () => {
    const ok = await call({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "buy_audit",
        arguments: {
          domain: "acme.dev",
          package: "auditKit",
          contactEmail: "a@acme.dev",
          idempotencyKey: "mcp-acme-0001",
        },
      },
    });
    const sc = ok.result?.structuredContent as { orderId: string; checkoutUrl: string };
    expect(sc.checkoutUrl).toMatch(/^https:\/\//);
    const bad = await call({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_order_status", arguments: { orderId: "0192f4a8-0000-7000-8000-000000000000" } },
    });
    expect(bad.result?.isError).toBe(true);
    const text = (bad.result?.content as { text: string }[])[0]!.text;
    expect(JSON.parse(text)).toMatchObject({ error: { code: "not_found" } });
  });
});
