import { describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { eq } from "drizzle-orm";
import { orders, reports } from "../db/schema";
import { createEmitter } from "../events";
import { createFakeDiscover } from "../fakes";
import type { Llm } from "../llm";
import { createTempDatabase, TEST_DB_URL } from "../testing/db";
import { buildKit, validateKitAsset } from "./build";

const audit = {
  summary: "Docs lack examples",
  crawlRunId: "run1",
  findings: [
    {
      id: "f1",
      title: "Missing examples",
      detail: "No API example on the docs page",
      evidence: { sourceUrl: "https://example.com/docs" },
    },
  ],
};

describe("Kit asset validation", () => {
  it("has 50 sourced fake prospects for a local Kit run", async () => {
    const prospects = await createFakeDiscover()({ limit: 50 });
    expect(prospects).toHaveLength(50);
    expect(new Set(prospects.map((prospect) => prospect.domain)).size).toBe(50);
  });
  it("accepts evidence-backed llms.txt and MCP server metadata", () => {
    expect(() =>
      validateKitAsset("llms.txt", "# Example\nAPI examples are missing [f1]", audit),
    ).not.toThrow();
    expect(() =>
      validateKitAsset(
        "server.json",
        JSON.stringify({
          name: "com.example/server",
          description: "Docs need examples [f1]",
          version: "1.0.0",
          remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
        }),
        audit,
      ),
    ).not.toThrow();
  });

  it("rejects unsupported citations and invalid server metadata", () => {
    expect(() => validateKitAsset("llms.txt", "# Example\nInvented claim [f2]", audit)).toThrow();
    expect(() =>
      validateKitAsset("quickstart.md", "# Quickstart\nFix docs [f1]\nUnsupported claim", audit),
    ).toThrow();
    expect(() =>
      validateKitAsset(
        "server.json",
        JSON.stringify({
          name: "example",
          description: "Claim [f1]",
          version: "1.0.0",
          remotes: [{ type: "streamable-http", url: "http://localhost:3000/mcp" }],
        }),
        audit,
      ),
    ).toThrow();
  });
});

describe.skipIf(!TEST_DB_URL)("Kit job", () => {
  it("builds eight cited assets, adds 50 sourced prospects, and resumes without paying twice", async () => {
    const temp = await createTempDatabase();
    try {
      const orderId = uuidv7();
      const reportId = uuidv7();
      await temp.db.insert(orders).values({
        id: orderId,
        domain: "example.com",
        contactEmail: "buyer@example.com",
        product: "auditKit",
        state: "auditing",
        amountUsd: "499.00",
      });
      await temp.db.insert(reports).values({
        id: reportId,
        orderId,
        accessToken: "test-token",
        audit,
      });
      let calls = 0;
      const llm: Llm = async (call) => {
        calls++;
        const content =
          call.purpose === "kit.server_json"
            ? JSON.stringify({
                name: "com.example/server",
                description: "Fix docs [f1]",
                version: "1.0.0",
                remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }],
              })
            : "# Draft\nFix the documentation [f1]";
        return {
          data: call.schema.parse({ content }),
          costUsd: 0.1,
          model: "fake",
          provider: "fake",
          fellBack: false,
        };
      };
      const enqueued: string[] = [];
      const deps = {
        db: temp.db,
        llm,
        discover: async () =>
          Array.from({ length: 50 }, (_, i) => ({
            domain: `prospect${i}.example`,
            name: `Prospect ${i}`,
            source: "fixture" as const,
            sourceRef: `fixture:${i}`,
            summary: "API company",
          })),
        enqueue: async (job: { type: string }) => {
          enqueued.push(job.type);
          return { jobId: "job" };
        },
        emit: createEmitter(temp.db),
      };
      await buildKit(deps, orderId, reportId);
      await buildKit(deps, orderId, reportId);
      const [stored] = await temp.db.select().from(reports).where(eq(reports.id, reportId));
      const kit = stored!.kit as { assets: { name: string }[]; costUsd: number; completedAt: string };
      expect(kit.assets).toHaveLength(9);
      expect(kit.costUsd).toBeCloseTo(0.8);
      expect(kit.completedAt).toBeTruthy();
      expect(calls).toBe(8);
      expect(enqueued).toEqual(["deliver_report", "deliver_report"]);
    } finally {
      await temp.drop();
    }
  });
});
