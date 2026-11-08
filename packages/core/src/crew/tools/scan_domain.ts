import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { SCAN_CACHE_DAYS } from "../../constants";
import { scans } from "../../db/schema";
import { defineTool } from "../registry";

const storedChecks = z.array(
  z.object({
    id: z.string(),
    label: z.string(),
    status: z.enum(["pass", "fail", "unknown", "gated"]),
    evidence: z.string(),
  }),
);

function checksFromStored(value: unknown) {
  const parsed = storedChecks.safeParse(value);
  return parsed.success
    ? parsed.data.map(({ id, label, status, evidence }) => ({
        id,
        title: label,
        status,
        evidence,
      }))
    : null;
}

export const scanDomainTool = defineTool({
  name: "scan_domain",
  handler: async ({ domain }, ctx) => {
    const [latest] = await ctx.db
      .select({ id: scans.id, score: scans.score, checks: scans.checks, createdAt: scans.createdAt })
      .from(scans)
      .where(eq(scans.domain, domain))
      .orderBy(desc(scans.createdAt))
      .limit(1);
    if (latest && Date.now() - latest.createdAt.getTime() < SCAN_CACHE_DAYS * 86_400_000)
      return {
        scanId: latest.id,
        status: "cached" as const,
        score: latest.score,
        checks: checksFromStored(latest.checks),
      };
    await ctx.enqueue({
      type: "scan_domain",
      payload: { domain },
      idempotencyKey: `scan:${domain}:${new Date().toISOString().slice(0, 10)}`,
      traceId: randomUUID(),
    });
    return {
      scanId: latest?.id ?? null,
      status: "queued" as const,
      score: latest?.score ?? null,
      checks: checksFromStored(latest?.checks),
    };
  },
});
