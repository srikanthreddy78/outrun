import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { SELF_SERVE_DAILY_CAP } from "./constants";
import { clientUsers, clients, events } from "./db/schema";
import { createEmitter } from "./events";
import { FakeStripe } from "./fakes";
import type { TransactionalEmail } from "./integrations/types";
import { callPublicTool, type PublicDeps } from "./public/service";
import { hireAgency, type SelfServeDeps } from "./selfServe";
import { createTempDatabase, type TempDb } from "./testing/db";

const APP = "https://outrun.example";
const SECRET = "test-crew-secret-0123456789abcdef"; // gitleaks:allow (throwaway test value)

describe("self-serve agency signups", () => {
  let t: TempDb;
  let jobs: { type: string; payload: Record<string, unknown>; idempotencyKey: string }[];
  let mail: TransactionalEmail[];
  const deps = (): SelfServeDeps => ({
    db: t.db,
    emit: createEmitter(t.db),
    enqueue: async (j) => {
      jobs.push(j);
      return { jobId: "j" };
    },
    sendTransactional: async (m) => {
      mail.push(m);
      return { providerId: `m${mail.length}` };
    },
    appUrl: APP,
    secret: SECRET,
  });
  const via = (caller: string) => ({ channel: "web" as const, caller });
  beforeAll(async () => {
    t = await createTempDatabase();
  });
  beforeEach(async () => {
    jobs = [];
    mail = [];
    // Each test starts with today's quota unused.
    await t.db.delete(events).where(eq(events.type, "client.signed_up"));
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("adds a draft client as code, not a person, provisions its crew and emails the approver", async () => {
    const out = await hireAgency(
      deps(),
      { companyName: "Gamma Grid", domain: "Gamma-Grid.dev", approverEmail: "Gus@gamma-grid.dev" },
      via("c1"),
    );
    expect(out).toMatchObject({
      slug: "gamma-grid",
      status: "draft",
      created: true,
      portalUrl: `${APP}/portal`,
    });
    const [added] = await t.db.select().from(events).where(eq(events.type, "client.added"));
    expect(added!.actor).toBe("web");
    expect(added!.actor.startsWith("user:")).toBe(false);
    const [signed] = await t.db.select().from(events).where(eq(events.type, "client.signed_up"));
    expect(signed).toMatchObject({
      actor: "web",
      entityId: out.clientId,
      payload: { via: "web", caller: "c1" },
    });
    expect(jobs).toEqual([
      expect.objectContaining({
        type: "provision_client_crew",
        payload: { clientId: out.clientId },
        idempotencyKey: `provision:${out.clientId}`,
      }),
    ]);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.to).toBe("gus@gamma-grid.dev");
    expect(mail[0]!.text).toContain(`${APP}/portal/auth/`);
    expect(await t.db.select().from(clientUsers).where(eq(clientUsers.clientId, out.clientId))).toMatchObject(
      [{ email: "gus@gamma-grid.dev", role: "approver" }],
    );
    // Never auto-confirmed.
    const [c] = await t.db.select().from(clients).where(eq(clients.id, out.clientId));
    expect(c!.profileConfirmedAt).toBeNull();
  });

  it("is idempotent on the domain: the same client, no new approver, job or email", async () => {
    const first = await hireAgency(
      deps(),
      { companyName: "Delta Desk", domain: "delta-desk.dev", approverEmail: "dee@delta-desk.dev" },
      via("c2"),
    );
    jobs = [];
    mail = [];
    const again = await hireAgency(
      deps(),
      { companyName: "Someone Else", domain: "delta-desk.dev", approverEmail: "eve@delta-desk.dev" },
      via("c3"),
    );
    expect(again).toMatchObject({ clientId: first.clientId, slug: "delta-desk", created: false });
    expect(jobs).toEqual([]);
    expect(mail).toEqual([]);
    const approvers = await t.db.select().from(clientUsers).where(eq(clientUsers.clientId, first.clientId));
    expect(approvers.map((a) => a.email)).toEqual(["dee@delta-desk.dev"]);
  });

  it(`refuses the ${SELF_SERVE_DAILY_CAP + 1}th new client in a day, but still answers known domains`, async () => {
    for (let i = 0; i < SELF_SERVE_DAILY_CAP; i++)
      await hireAgency(
        deps(),
        { companyName: `Cap Co ${i}`, domain: `cap-${i}.dev`, approverEmail: `a@cap-${i}.dev` },
        via(`cap-caller-${i}`),
      );
    await expect(
      hireAgency(
        deps(),
        { companyName: "Late Co", domain: "late.dev", approverEmail: "a@late.dev" },
        via("late"),
      ),
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect(await t.db.select().from(clients).where(eq(clients.domain, "late.dev"))).toEqual([]);
    const known = await hireAgency(
      deps(),
      { companyName: "Cap Co 0", domain: "cap-0.dev", approverEmail: "a@cap-0.dev" },
      via("late"),
    );
    expect(known.created).toBe(false);
  });

  it("limits one caller to one new client an hour", async () => {
    await hireAgency(
      deps(),
      { companyName: "One Co", domain: "one.dev", approverEmail: "a@one.dev" },
      via("same"),
    );
    await expect(
      hireAgency(
        deps(),
        { companyName: "Two Co", domain: "two.dev", approverEmail: "a@two.dev" },
        via("same"),
      ),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("validates the domain and the approver", async () => {
    const bad = (input: Record<string, string>) =>
      expect(hireAgency(deps(), input, via("v"))).rejects.toMatchObject({ code: "bad_request" });
    await bad({ companyName: "X", domain: "not a domain", approverEmail: "a@x.dev" });
    await bad({ companyName: "X", domain: "http://x.dev/path", approverEmail: "a@x.dev" });
    await bad({ companyName: "X", domain: "localhost", approverEmail: "a@localhost" });
    await bad({ companyName: "X", domain: "x.dev", approverEmail: "a@gmail.com" });
    await bad({ companyName: "Us", domain: "outrun.example", approverEmail: "a@outrun.example" });
  });

  it("takes the domain's slug when the name's is taken", async () => {
    await hireAgency(
      deps(),
      { companyName: "Nova", domain: "nova.dev", approverEmail: "a@nova.dev" },
      via("n1"),
    );
    const other = await hireAgency(
      deps(),
      { companyName: "Nova", domain: "nova.io", approverEmail: "a@nova.io" },
      via("n2"),
    );
    expect(other).toMatchObject({ slug: "nova-io", created: true });
  });

  it("is the public hire_agency tool on MCP and A2A", async () => {
    const d = deps();
    const pub: PublicDeps = {
      db: t.db,
      emit: d.emit,
      stripe: new FakeStripe(),
      appUrl: APP,
      scan: async () => {
        throw new Error("not used");
      },
      selfServe: { enqueue: d.enqueue, sendTransactional: d.sendTransactional, secret: SECRET },
    };
    const meta = { protocol: "a2a" as const, callerIp: "198.51.100.40", requestId: "r1" };
    const input = { companyName: "Omega Ops", domain: "omega-ops.dev", approverEmail: "ola@omega-ops.dev" };
    const out = await callPublicTool(pub, "hire_agency", input, meta);
    expect(out).toMatchObject({ slug: "omega-ops", status: "draft", created: true });
    expect(jobs.map((j) => j.type)).toEqual(["provision_client_crew"]);
    const [signed] = await t.db.select().from(events).where(eq(events.entityId, out.clientId));
    expect(signed).toBeTruthy();
    const ev = await t.db.select().from(events).where(eq(events.type, "client.signed_up"));
    expect(ev.find((e) => e.entityId === out.clientId)!.payload).toMatchObject({ via: "a2a" });
    expect((await callPublicTool(pub, "hire_agency", input, meta)).created).toBe(false);
    await expect(
      callPublicTool(pub, "hire_agency", { ...input, domain: "nope" }, meta),
    ).rejects.toMatchObject({ code: "bad_request" });
    const { selfServe: _unused, ...bare } = pub;
    await expect(callPublicTool(bare, "hire_agency", input, meta)).rejects.toMatchObject({
      code: "not_configured",
    });
  });
});
