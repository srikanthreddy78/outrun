import { describe, expect, it } from "vitest";
import { parseHomepage, parseProfile, socialPlatformOf, type Enrichment } from "./enrich.ts";
import { scoreFit, type FitInput } from "./fit.ts";
import { sqlLiteral } from "./naive-api.ts";

const NOW = new Date("2026-11-08T00:00:00Z");

function enrichment(overrides: Partial<Enrichment> = {}): Enrichment {
  return {
    version: 1,
    enrichedAt: NOW.toISOString(),
    costMicroUsd: 0,
    homepage: { found: true, title: null, description: null, foundingDate: null },
    profile: {
      found: false,
      hqCountry: null,
      foundedYear: null,
      fundingStage: null,
      totalFundingUsd: null,
      revenueEstimate: null,
      gtmMotions: [],
      customerSegments: [],
    },
    socials: {},
    ...overrides,
  };
}

function input(overrides: Partial<FitInput> = {}): FitInput {
  return {
    company: "Acme",
    domain: "acme.example",
    whyFit: "Acme ships a habit tracker.",
    contactEmail: "hello@acme.example",
    contactName: null,
    contactRole: null,
    enrichment: enrichment(),
    ...overrides,
  };
}

const points = (score: ReturnType<typeof scoreFit>, signal: string): number | undefined =>
  score.parts.find((part) => part.signal === signal)?.points;

describe("scoreFit", () => {
  it("scores an early, self-serve, agent-native startup with a named founder as strong", () => {
    const fit = scoreFit(
      input({
        whyFit: "Ships an MCP server for coding agents.",
        contactEmail: "jane@acme.example",
        contactName: "Jane Doe",
        contactRole: "founder",
        enrichment: enrichment({
          homepage: {
            found: true,
            title: "Acme",
            description: "Start free, no credit card.",
            foundingDate: null,
          },
        }),
      }),
      NOW,
    );
    // 20 self-serve + 20 early + 5 audience unclear + 15 agent-native + 10 social gap + 15 founder.
    expect(fit.score).toBe(85);
    expect(fit.band).toBe("strong");
    expect(points(fit, "contact")).toBe(15);
    expect(points(fit, "social_gap")).toBe(10);
  });

  it("penalizes an established company and a sales inbox", () => {
    const fit = scoreFit(
      input({
        contactEmail: "sales@big.example",
        enrichment: enrichment({
          profile: {
            found: true,
            hqCountry: "USA",
            foundedYear: 2012,
            fundingStage: "Series D",
            totalFundingUsd: 400_000_000,
            revenueEstimate: "$100M-$500M",
            gtmMotions: ["Enterprise Field Sales"],
            customerSegments: ["Enterprise Organizations"],
          },
        }),
      }),
      NOW,
    );
    expect(points(fit, "size")).toBe(-15);
    expect(points(fit, "contact")).toBe(0);
    expect(points(fit, "audience")).toBe(0);
    expect(fit.band).toBe("weak");
  });

  it("subtracts for an EU or UK company, by profile HQ or country domain", () => {
    expect(points(scoreFit(input({ domain: "shop.be" }), NOW), "region")).toBe(-20);
    const byHq = scoreFit(
      input({
        enrichment: enrichment({ profile: { ...enrichment().profile, found: true, hqCountry: "FRA" } }),
      }),
      NOW,
    );
    expect(points(byHq, "region")).toBe(-20);
    expect(points(scoreFit(input(), NOW), "region")).toBeUndefined();
  });

  it("gives no social-gap points to a company already on TikTok or Instagram", () => {
    const fit = scoreFit(
      input({ enrichment: enrichment({ socials: { tiktok: "https://tiktok.com/@acme" } }) }),
      NOW,
    );
    expect(points(fit, "social_gap")).toBe(0);
  });

  it("keeps the score within 0 to 100 and every part explained", () => {
    const fit = scoreFit(input({ contactEmail: "acme@gmail.com", domain: "acme.de" }), NOW);
    expect(fit.score).toBeGreaterThanOrEqual(0);
    expect(fit.score).toBeLessThanOrEqual(100);
    expect(fit.parts.every((part) => part.reason.length > 0)).toBe(true);
  });
});

describe("enrichment parsing", () => {
  it("reads title, founding date and social profiles from homepage JSON-LD", () => {
    const parsed = parseHomepage({
      title: "Acme",
      json_ld: [
        {
          "@graph": [
            {
              "@type": "Organization",
              foundingDate: "2025-03",
              sameAs: ["https://x.com/acme", "https://www.instagram.com/acme"],
            },
          ],
        },
      ],
    });
    expect(parsed.homepage.title).toBe("Acme");
    expect(parsed.homepage.foundingDate).toBe("2025-03");
    expect(parsed.socials).toEqual({ x: "https://x.com/acme", instagram: "https://www.instagram.com/acme" });
  });

  it("reads HQ, funding and segments from a company profile", () => {
    const parsed = parseProfile({
      data: {
        firmographic: { founded_year: 2024 },
        location: { hq: { country: "USA" } },
        funding_detail: { funding_overview: { funding_stage: "Seed", total_funding_usd: 2_000_000 } },
        business_model: { gtm_motion: [{ type: "Product Led Growth" }] },
        customer_profile: { segment: [{ title: "Developers" }] },
        digital_presence: {
          social_media_profiles: [{ platform: "tiktok", url: "https://www.tiktok.com/@acme" }],
        },
      },
    });
    expect(parsed.profile).toMatchObject({ hqCountry: "USA", foundedYear: 2024, fundingStage: "Seed" });
    expect(parsed.profile.gtmMotions).toEqual(["Product Led Growth"]);
    expect(parsed.socials.tiktok).toBe("https://www.tiktok.com/@acme");
  });

  it("maps profile URLs to platforms by host only", () => {
    expect(socialPlatformOf("https://www.tiktok.com/@a")).toBe("tiktok");
    expect(socialPlatformOf("https://twitter.com/a")).toBe("x");
    expect(socialPlatformOf("https://tiktok.com.evil.example/a")).toBeNull();
    expect(socialPlatformOf("not a url")).toBeNull();
  });
});

describe("sqlLiteral", () => {
  it("dollar-quotes text so quotes and injection attempts stay data", () => {
    expect(sqlLiteral("it's")).toBe("$q$it's$q$");
    expect(sqlLiteral("x$q$; drop table t; --")).toBe("$qq$x$q$; drop table t; --$qq$");
    expect(sqlLiteral(null)).toBe("null");
    expect(sqlLiteral(3)).toBe("3");
    expect(sqlLiteral({ a: 1 })).toBe('$q${"a":1}$q$');
  });
});
