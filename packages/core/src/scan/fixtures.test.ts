import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { READINESS_CHECKS, type ScanSource } from "./contracts";
import { fullScan, quickScan } from "./scan";

const pages: Record<string, { status: number; body: string; headers?: Record<string, string> }> = {
  "/": {
    status: 200,
    body: `<html><head><link rel="alternate" type="text/markdown" href="/index.md"><script type="application/ld+json">{"offers":{"price":499}}</script></head><body><h1>Automate customer support with reliable agents</h1><p>Our platform helps teams answer customer questions, publish documentation, and launch dependable workflows every day.</p><a href="/signup">Get started</a></body></html>`,
  },
  "/llms.txt": { status: 200, body: "# Product\nDocumentation" },
  "/sitemap.xml": { status: 200, body: "<urlset></urlset>" },
  "/robots.txt": { status: 200, body: "User-agent: GPTBot\nAllow: /" },
  "/openapi.json": { status: 200, body: '{"openapi":"3.1.0"}' },
  "/.well-known/agent.json": { status: 200, body: '{"name":"Product"}' },
  "/docs": {
    status: 200,
    body: "<html><body>Documentation with useful examples for developers and agents.</body></html>",
  },
  "/nonexistent-outrun-readiness-check": { status: 404, body: "Not found" },
  "/mcp": {
    status: 200,
    body: "event: message\n\ndata: {}\n\n",
    headers: { "content-type": "text/event-stream", "mcp-session-id": "fixture" },
  },
  "/signup": { status: 200, body: '<form method="post"><input></form>' },
};

function fixture(overrides: typeof pages = {}): ScanSource {
  return async (url) => {
    const path = new URL(url).pathname;
    const page = overrides[path] ?? pages[path] ?? { status: 404, body: "Not found" };
    return { url, status: page.status, body: page.body, headers: page.headers ?? {} };
  };
}

async function scan(source: ScanSource) {
  return fullScan(await quickScan("example.com", source), source);
}

describe("local readiness fixture site", () => {
  it("covers all fourteen checks and completes a full scan within ten seconds", async () => {
    const start = performance.now();
    const result = await scan(fixture());
    expect(performance.now() - start).toBeLessThan(10_000);
    expect(
      result.checks
        .filter((check) => check.category === "readiness")
        .map((check) => check.id)
        .sort(),
    ).toEqual(READINESS_CHECKS.map(([id]) => id).sort());
    for (const check of result.checks.filter((check) => check.category === "readiness")) {
      expect(check.evidence).toBeTruthy();
      expect(check.status).toBe(["rate-limit", "mcp-registry"].includes(check.id) ? "unknown" : "pass");
    }
  });

  it.each([
    ["ssr-answer", "/", { status: 200, body: "<html>short</html>" }],
    ["markdown", "/", { status: 200, body: pages["/"]!.body.replace(/<link[^>]+>/, "") }],
    ["llms-txt", "/llms.txt", { status: 404, body: "Not found" }],
    ["ai-robots", "/robots.txt", { status: 200, body: "User-agent: ExampleBot" }],
    ["sitemap", "/sitemap.xml", { status: 404, body: "Not found" }],
    ["json-ld", "/", { status: 200, body: pages["/"]!.body.replace(/<script[^>]+>[\s\S]*?<\/script>/, "") }],
    ["honest-404", "/nonexistent-outrun-readiness-check", { status: 200, body: "Soft 404" }],
    ["mcp", "/mcp", { status: 404, body: "Not found" }],
    ["well-known", "/.well-known/agent.json", { status: 404, body: "Not found" }],
    ["openapi", "/openapi.json", { status: 404, body: "Not found" }],
    [
      "machine-pricing",
      "/",
      { status: 200, body: pages["/"]!.body.replace(/<script[^>]+>[\s\S]*?<\/script>/, "") },
    ],
    ["docs", "/docs", { status: 404, body: "Not found" }],
  ] as const)("detects missing %s on a local fixture", async (id, path, replacement) => {
    const result = await scan(fixture({ [path]: replacement }));
    expect(result.checks.find((check) => check.id === id)?.status).toBe("fail");
  });

  it("keeps rate-limit and registry checks unknown because the public scan does not trigger 429s or query the registry", async () => {
    const result = await scan(fixture());
    expect(result.checks.find((check) => check.id === "rate-limit")?.status).toBe("unknown");
    expect(result.checks.find((check) => check.id === "mcp-registry")?.status).toBe("unknown");
  });
});
