import { writeFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { Report } from "@outrun/core/audit/pipeline";
import { renderReportPdf } from "./report-pdf";

describe("report PDF", () => {
  it("renders a long delivered audit across pages", async () => {
    const report: Report = {
      orderId: "order1",
      domain: "example.com",
      offer: "auditKit",
      token: "token",
      deliveredAt: "2026-11-07T00:00:00Z",
      totalCostUsd: 1,
      audit: {
        orderId: "order1",
        domain: "example.com",
        crawlRunId: "run1",
        summary:
          "The public site has useful product information, but agents need clearer API examples and structured metadata.",
        findings: Array.from({ length: 18 }, (_, index) => ({
          id: `f${index + 1}`,
          title: `Improve documentation area ${index + 1}`,
          detail:
            "The current page explains the product but does not include a complete request and response example. Add a small, tested example with authentication details and expected errors.",
          evidence: { sourceUrl: `https://example.com/docs/long/path/${index + 1}` },
        })),
      },
      assets: ["llms.txt", "server.json", "quickstart.md", "prospects.json"].map((name) => ({
        name,
        content: "sample",
        mediaType: name.endsWith(".json") ? "application/json" : "text/markdown",
      })),
    };
    const bytes = await renderReportPdf(report);
    const parsed = await PDFDocument.load(bytes);
    expect(parsed.getPageCount()).toBeGreaterThan(1);
    expect(parsed.getTitle()).toBe("example.com audit");
    if (process.env.PDF_SAMPLE_PATH) writeFileSync(process.env.PDF_SAMPLE_PATH, bytes);
  });
});
