/**
 * Webhook signature checks (ported from caseloop's signatures.py). Each verifier reads the raw
 * body, compares in constant time, and accepts a rotated secret.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { WEBHOOK_TOLERANCE_SECONDS } from "../constants";

export type VerifyResult = { ok: true } | { ok: false; reason: "missing" | "stale" | "bad_signature" | "no_secret" };

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Naive: `Vetta-Signature: v1=<hex>[,v1=<hex>]` is HMAC-SHA256 over `<Vetta-Timestamp>.<raw body>`,
 * timestamp in unix seconds, rejected when more than 300 s old. During a rotation Naive signs with
 * both secrets, and we also keep the previous secret configured; any match passes.
 */
export function verifyNaiveSignature(opts: {
  rawBody: string;
  signatureHeader: string | null;
  timestampHeader: string | null;
  secrets: (string | undefined)[];
  nowMs?: number;
  toleranceSeconds?: number;
}): VerifyResult {
  const secrets = opts.secrets.filter((s): s is string => !!s);
  if (secrets.length === 0) return { ok: false, reason: "no_secret" };
  if (!opts.signatureHeader || !opts.timestampHeader) return { ok: false, reason: "missing" };
  const ts = Number(opts.timestampHeader);
  if (!Number.isFinite(ts)) return { ok: false, reason: "missing" };
  const now = (opts.nowMs ?? Date.now()) / 1000;
  if (Math.abs(now - ts) > (opts.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS)) return { ok: false, reason: "stale" };
  const presented = opts.signatureHeader
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.startsWith("v1="))
    .map((p) => p.slice(3));
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret).update(`${opts.timestampHeader}.${opts.rawBody}`).digest("hex");
    if (presented.some((p) => safeEqualHex(p, expected))) return { ok: true };
  }
  return { ok: false, reason: "bad_signature" };
}

/** For tests and fixtures: the header a sender would put on this body. */
export function signNaive(secret: string, rawBody: string, timestamp: number): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}
