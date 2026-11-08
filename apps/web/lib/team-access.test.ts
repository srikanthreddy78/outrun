import { describe, expect, it } from "vitest";
import { dashboardAccess, verifiedAllowedGithubEmail } from "./team-access";

const response = (emails: unknown, status = 200) =>
  new Response(JSON.stringify(emails), { status, headers: { "content-type": "application/json" } });

describe("dashboard team access", () => {
  it("requires an allowlisted, verified primary GitHub email", async () => {
    const fetcher = async () =>
      response([
        { email: "fake@example.com", primary: true, verified: false },
        { email: "team@example.com", primary: true, verified: true },
      ]);
    expect(await verifiedAllowedGithubEmail("token", "TEAM@example.com", fetcher as typeof fetch)).toBe(
      "team@example.com",
    );
    expect(
      await verifiedAllowedGithubEmail("token", "other@example.com", fetcher as typeof fetch),
    ).toBeNull();
    expect(
      await verifiedAllowedGithubEmail(undefined, "team@example.com", fetcher as typeof fetch),
    ).toBeNull();
    expect(dashboardAccess("team@example.com", "team@example.com")).toBe(true);
    expect(dashboardAccess(null, "team@example.com")).toBe(false);
    expect(dashboardAccess("team@example.com", "")).toBe(false);
  });

  it("fails closed on GitHub errors and missing verification", async () => {
    expect(
      await verifiedAllowedGithubEmail("token", "team@example.com", (async () =>
        response([{ email: "team@example.com", primary: true, verified: false }])) as typeof fetch),
    ).toBeNull();
    expect(
      await verifiedAllowedGithubEmail("token", "team@example.com", (async () =>
        response({}, 403)) as typeof fetch),
    ).toBeNull();
    expect(
      await verifiedAllowedGithubEmail("token", "team@example.com", (async () => {
        throw new Error("offline");
      }) as typeof fetch),
    ).toBeNull();
  });
});
