import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobEnvelopeInput } from "../../contracts";
import { createTempDatabase, type TempDb } from "../testing/db";
import { handleNaiveWebhook } from "./naive";
import { signNaive, verifyNaiveSignature } from "./verify";

const SECRET = "whsec_current_test";
const OLD = "whsec_previous_test";
const NOW = 1_794_100_000_000;

const envelope = (id: string) =>
  JSON.stringify({ id, type: "session.idle", created_at: "2026-11-07T10:00:00Z", data: { session_id: "ses_1", stop_reason: "awaiting_approval" } });

const headers = (sig: string, ts: number) => {
  const h = new Map([
    ["vetta-signature", sig],
    ["vetta-timestamp", String(ts)],
  ]);
  return { get: (n: string) => h.get(n.toLowerCase()) ?? null };
};

describe("verifyNaiveSignature", () => {
  const body = envelope("evt_v");
  const ts = NOW / 1000;
  const base = { rawBody: body, timestampHeader: String(ts), nowMs: NOW };

  it("accepts a valid signature", () => {
    expect(verifyNaiveSignature({ ...base, signatureHeader: signNaive(SECRET, body, ts), secrets: [SECRET] })).toEqual({ ok: true });
  });

  it("rejects a stale timestamp", () => {
    const old = ts - 301;
    const r = verifyNaiveSignature({ ...base, timestampHeader: String(old), signatureHeader: signNaive(SECRET, body, old), secrets: [SECRET] });
    expect(r).toEqual({ ok: false, reason: "stale" });
  });

  it("rejects the wrong secret", () => {
    const r = verifyNaiveSignature({ ...base, signatureHeader: signNaive("nope", body, ts), secrets: [SECRET] });
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered body", () => {
    const r = verifyNaiveSignature({ ...base, rawBody: body + " ", signatureHeader: signNaive(SECRET, body, ts), secrets: [SECRET] });
    expect(r.ok).toBe(false);
  });

  it("accepts either signature during a rotation, and our previous secret", () => {
    const both = `${signNaive(OLD, body, ts)},${signNaive(SECRET, body, ts)}`;
    expect(verifyNaiveSignature({ ...base, signatureHeader: both, secrets: [SECRET] }).ok).toBe(true);
    expect(verifyNaiveSignature({ ...base, signatureHeader: signNaive(OLD, body, ts), secrets: [SECRET, OLD] }).ok).toBe(true);
  });

  it("refuses without a configured secret or headers", () => {
    expect(verifyNaiveSignature({ ...base, signatureHeader: "v1=00", secrets: [undefined] })).toEqual({ ok: false, reason: "no_secret" });
    expect(verifyNaiveSignature({ ...base, signatureHeader: null, secrets: [SECRET] })).toEqual({ ok: false, reason: "missing" });
  });
});

describe("handleNaiveWebhook", () => {
  let t: TempDb;
  const enqueued: JobEnvelopeInput[] = [];
  const queue = { enqueue: async (j: JobEnvelopeInput) => (enqueued.push(j), { jobId: "j" }) };
  beforeAll(async () => {
    t = await createTempDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });

  const send = (body: string, sig: string, ts = NOW / 1000, secrets: (string | undefined)[] = [SECRET]) =>
    handleNaiveWebhook({ rawBody: body, headers: headers(sig, ts), secrets, db: t.db, queue, nowMs: NOW });

  it("answers 200 and enqueues handle_naive_event once for a valid delivery", async () => {
    const body = envelope("evt_ok");
    const r = await send(body, signNaive(SECRET, body, NOW / 1000));
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(enqueued.at(-1)).toMatchObject({ type: "handle_naive_event", idempotencyKey: "naive:evt_ok" });
  });

  it("dedupes a redelivery on the envelope id", async () => {
    const body = envelope("evt_dup");
    const sig = signNaive(SECRET, body, NOW / 1000);
    const before = enqueued.length;
    expect((await send(body, sig)).status).toBe(200);
    const again = await send(body, sig);
    expect(again).toEqual({ status: 200, body: { ok: true, duplicate: true } });
    expect(enqueued.length).toBe(before + 1);
  });

  it("rejects stale and wrong-secret deliveries with 401 and enqueues nothing", async () => {
    const body = envelope("evt_bad");
    const before = enqueued.length;
    const stale = NOW / 1000 - 600;
    expect((await send(body, signNaive(SECRET, body, stale), stale)).status).toBe(401);
    expect((await send(body, signNaive("wrong", body, NOW / 1000))).status).toBe(401);
    expect(enqueued.length).toBe(before);
  });

  it("accepts a delivery signed with the rotated secret", async () => {
    const body = envelope("evt_rot");
    const r = await send(body, signNaive(OLD, body, NOW / 1000), NOW / 1000, [SECRET, OLD]);
    expect(r.status).toBe(200);
  });

  it("answers 503 when no secret is configured, so Naive retries", async () => {
    const body = envelope("evt_nosecret");
    expect((await send(body, signNaive(SECRET, body, NOW / 1000), NOW / 1000, [undefined])).status).toBe(503);
  });

  it("rejects a malformed envelope", async () => {
    const body = JSON.stringify({ hello: "world" });
    expect((await send(body, signNaive(SECRET, body, NOW / 1000))).status).toBe(400);
  });
});
