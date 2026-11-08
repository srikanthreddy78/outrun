import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, events } from "../db/schema";
import { createEmitter } from "../events";
import { createTempDatabase, type TempDb } from "../testing/db";
import { createDiscover, parseMcpRegistry, parseProductHuntFeed, parseYc, registrableDomain } from ".";
import { MCP_REGISTRY_URL } from "./mcpRegistry";
import { runRefreshSources } from "./refresh";

const fx = (f: string) => readFileSync(join(import.meta.dirname, "fixtures", f), "utf8");

describe("discovery sources (SH-2)", () => {
  it("registrableDomain keeps the company's domain and drops platforms", () => {
    expect(registrableDomain("https://api.acme.dev/mcp")).toBe("acme.dev");
    expect(registrableDomain("https://app.acme.co.uk/x")).toBe("acme.co.uk");
    expect(registrableDomain("https://acme.vercel.app")).toBeNull();
    expect(registrableDomain("https://github.com/acme/mcp")).toBeNull();
    expect(registrableDomain("http://localhost:3000")).toBeNull();
    expect(registrableDomain("http://10.0.0.1")).toBeNull();
    expect(registrableDomain(undefined)).toBeNull();
  });

  it("parses the MCP Registry, one company per domain", () => {
    const { companies: cs, next } = parseMcpRegistry(JSON.parse(fx("mcp-registry.json")));
    expect(next).toBeTruthy();
    const domains = cs.map((c) => c.domain);
    expect(new Set(domains).size).toBe(domains.length);
    expect(domains).toContain("mizan.ac");
    expect(domains).toContain("tandem.ac");
    expect(cs.every((c) => c.source === "mcp_registry" && c.sourceRef.includes("/"))).toBe(true);
  });

  it("parses YC companies, active ones only", () => {
    const list = JSON.parse(fx("yc-developer-tools.json")) as { status: string }[];
    const cs = parseYc(list as never);
    expect(cs.length).toBeGreaterThan(0);
    expect(cs.length).toBeLessThanOrEqual(list.filter((c) => c.status === "Active").length);
    expect(cs.every((c) => c.source === "yc" && c.sourceRef.startsWith("yc:"))).toBe(true);
  });

  it("parses the Product Hunt feed with each launch's redirect link", () => {
    const es = parseProductHuntFeed(fx("producthunt.xml"));
    expect(es).toHaveLength(5);
    expect(es[0]).toMatchObject({
      ref: "ph:1306522",
      name: "Capnot",
      summary: "Make Screen Demos Clear, Even on Mute",
    });
    expect(es[0]!.redirect).toMatch(/^https:\/\/www\.producthunt\.com\/r\/p\/1306522/);
  });

  it("discover() combines sources, survives one failing, and demo mode returns fixtures only", async () => {
    const calls: string[] = [];
    const discover = createDiscover({
      demo: false,
      get: async (url) => {
        calls.push(url);
        if (url.startsWith(MCP_REGISTRY_URL))
          return {
            url,
            status: 200,
            body: fx("mcp-registry.json").replace(/"nextCursor": "[^"]*"/, '"nextCursor": null'),
          };
        if (url.includes("yc-oss")) throw new Error("down");
        if (url.endsWith("/feed")) return { url, status: 200, body: fx("producthunt.xml") };
        return { url: "https://www.capnot.app/?ref=producthunt", status: 200, body: "" };
      },
    });
    const out = await discover({ limit: 100 });
    expect(out.some((c) => c.source === "mcp_registry")).toBe(true);
    expect(out.find((c) => c.source === "producthunt")).toMatchObject({ domain: "capnot.app" });
    const demo = await createDiscover({
      demo: true,
      get: async () => {
        throw new Error("no network in demo");
      },
    })({ limit: 5 });
    expect(demo.every((c) => c.source === "fixture")).toBe(true);
  });

  describe("refresh_sources", () => {
    let t: TempDb;
    beforeAll(async () => {
      t = await createTempDatabase();
    });
    afterAll(async () => {
      await t?.drop();
    });
    it("adds candidates once; a rerun adds nothing", async () => {
      const deps = {
        db: t.db,
        emit: createEmitter(t.db),
        discover: createDiscover({ demo: true }),
        settings: { discoveryDailyCap: 2 },
      };
      const first = await runRefreshSources(deps);
      expect(first.added).toBeGreaterThan(0);
      expect(await runRefreshSources(deps)).toEqual({ found: first.found, added: 0 });
      expect((await t.db.select().from(companies)).every((c) => c.kind === "candidate")).toBe(true);
      expect(await t.db.select().from(events)).toHaveLength(2);
    });
  });
});
