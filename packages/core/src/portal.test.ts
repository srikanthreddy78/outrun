import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientUsers, clients, messages } from "./db/schema";
import { FakeAgentMail } from "./fakes";
import {
  assertPortalAccess,
  clientMessageIds,
  portalClients,
  portalLinkToken,
  readPortalLink,
  readPortalSession,
  redeemPortalLink,
  requestPortalLink,
} from "./portal";
import { createTempDatabase, type TempDb } from "./testing/db";
import { OUTRUN_CLIENT_ID } from "./constants";

const SECRET = "portal-secret-test"; // gitleaks:allow
const now = new Date("2026-11-10T17:00:00Z");

describe("client portal sign-in and scope", () => {
  let t: TempDb;
  let am: FakeAgentMail;
  let acme: string;
  let beta: string;
  const deps = () => ({
    db: t.db,
    sendTransactional: am.sendTransactional,
    appUrl: "https://outrun.example",
    secret: SECRET,
    now: () => now,
  });

  beforeAll(async () => {
    t = await createTempDatabase();
    am = new FakeAgentMail();
    const [a] = await t.db
      .insert(clients)
      .values({ slug: "acme", name: "Acme", domain: "acme.dev" })
      .returning();
    const [b] = await t.db
      .insert(clients)
      .values({ slug: "beta", name: "Beta", domain: "beta.dev" })
      .returning();
    acme = a!.id;
    beta = b!.id;
    await t.db.insert(clientUsers).values({ clientId: acme, email: "ada@acme.dev" });
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("emails a link only to an approver, at most once per 10 minutes", async () => {
    expect(await requestPortalLink(deps(), "Ada@Acme.dev ")).toEqual({ sent: true });
    expect(await requestPortalLink(deps(), "ada@acme.dev")).toEqual({ sent: true });
    expect(await requestPortalLink(deps(), "eve@evil.dev")).toEqual({ sent: false });
    expect(am.transactional).toHaveLength(1);
    expect(am.transactional[0]!.to).toBe("ada@acme.dev");
    expect(am.transactional[0]!.text).toMatch(/https:\/\/outrun\.example\/portal\/auth\/[\w-]+\.[\w-]+/);
  });

  it("a link works once, expires, and can't be forged", async () => {
    const token = /\/portal\/auth\/(\S+)/.exec(am.transactional[0]!.text)![1]!;
    const first = await redeemPortalLink({ db: t.db, secret: SECRET, now: () => now }, token);
    expect(first?.email).toBe("ada@acme.dev");
    expect(readPortalSession(SECRET, first!.session, now)?.email).toBe("ada@acme.dev");
    expect(await redeemPortalLink({ db: t.db, secret: SECRET, now: () => now }, token)).toBeNull();

    const later = new Date(now.getTime() + 16 * 60_000);
    expect(readPortalLink(SECRET, portalLinkToken(SECRET, "ada@acme.dev", now), later)).toBeNull();
    expect(readPortalLink("other-secret", portalLinkToken(SECRET, "ada@acme.dev", now), now)).toBeNull();
    const [payload, sig] = portalLinkToken(SECRET, "ada@acme.dev", now).split(".");
    const forged = `${Buffer.from(JSON.stringify({ email: "eve@evil.dev", nonce: "n", exp: now.getTime() + 60_000 })).toString("base64url")}.${sig}`;
    expect(readPortalLink(SECRET, forged, now)).toBeNull();
    expect(payload).toBeTruthy();
    // A session token isn't a link, and a link isn't a session.
    expect(readPortalLink(SECRET, first!.session, now)).toBeNull();
    expect(readPortalSession(SECRET, token, now)).toBeNull();
  });

  it("an approver reaches only their own client's messages", async () => {
    expect((await portalClients(t.db, "ada@acme.dev")).map((c) => c.slug)).toEqual(["acme"]);
    await expect(assertPortalAccess(t.db, "ada@acme.dev", acme)).resolves.toBeUndefined();
    await expect(assertPortalAccess(t.db, "ada@acme.dev", beta)).rejects.toMatchObject({ code: "forbidden" });
    await expect(assertPortalAccess(t.db, "ada@acme.dev", OUTRUN_CLIENT_ID)).rejects.toMatchObject({
      code: "forbidden",
    });
    const [mA] = await t.db
      .insert(messages)
      .values({
        clientId: acme,
        direction: "outbound",
        kind: "first",
        status: "awaiting_approval",
        subject: "a",
        body: "a",
      })
      .returning();
    const [mB] = await t.db
      .insert(messages)
      .values({
        clientId: beta,
        direction: "outbound",
        kind: "first",
        status: "awaiting_approval",
        subject: "b",
        body: "b",
      })
      .returning();
    expect(await clientMessageIds(t.db, acme, [mA!.id, mB!.id])).toEqual([mA!.id]);
  });
});
