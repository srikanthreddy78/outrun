/**
 * POST /api/webhooks/naive, framework-free. Verify the signature against the raw body first
 * (config only, no database), then record the delivery and enqueue handle_naive_event in one
 * transaction, so a failed enqueue rolls the dedupe row back and Naive's redelivery is processed.
 * Naive disables an endpoint after 10 failures, so anything verified answers 2xx.
 */
import { NAIVE_SIGNATURE_HEADER, NAIVE_TIMESTAMP_HEADER, NaiveEnvelope } from "../../contracts";
import { transaction, type DbHandle } from "../db/client";
import { recordWebhookOnce } from "../events";
import { logger } from "../log";
import type { Queue } from "../queue";
import { verifyNaiveSignature } from "./verify";

export interface WebhookReply {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

type Headers = { get(name: string): string | null };

/** Step 1, before any runtime exists. Returns a reply to send, or null when verified. */
export function verifyNaiveDelivery(opts: {
  rawBody: string;
  headers: Headers;
  secrets: (string | undefined)[];
  nowMs?: number;
}): WebhookReply | null {
  const v = verifyNaiveSignature({
    rawBody: opts.rawBody,
    signatureHeader: opts.headers.get(NAIVE_SIGNATURE_HEADER),
    timestampHeader: opts.headers.get(NAIVE_TIMESTAMP_HEADER),
    secrets: opts.secrets,
    ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
  });
  if (v.ok) return null;
  logger.warn({ reason: v.reason }, "naive webhook rejected");
  return v.reason === "no_secret"
    ? { status: 503, body: { error: v.reason }, headers: { "retry-after": "60" } }
    : { status: 401, body: { error: v.reason } };
}

/** Step 2, for a verified body. */
export async function acceptNaiveDelivery(opts: {
  rawBody: string;
  db: Pick<DbHandle, "pool">;
  queue: Pick<Queue, "enqueue">;
}): Promise<WebhookReply> {
  let json: unknown;
  try {
    json = JSON.parse(opts.rawBody);
  } catch {
    logger.warn("naive webhook: verified body is not JSON; ignored");
    return { status: 200, body: { ok: true, ignored: "invalid_json" } };
  }
  const env = NaiveEnvelope.safeParse(json);
  if (!env.success) {
    logger.warn("naive webhook: verified body is not an envelope; ignored");
    return { status: 200, body: { ok: true, ignored: "invalid_envelope" } };
  }
  const id = env.data.id;
  const first = await transaction(opts.db, async (tx) => {
    const isNew = await recordWebhookOnce(tx.db, "naive", id, { type: env.data.type });
    if (!isNew) return false;
    await opts.queue.enqueue(
      {
        type: "handle_naive_event",
        payload: { envelope: env.data },
        idempotencyKey: `naive:${id}`,
        traceId: `naive-${id}`,
      },
      { tx },
    );
    return true;
  });
  return first ? { status: 200, body: { ok: true } } : { status: 200, body: { ok: true, duplicate: true } };
}

/** Both steps, for tests and callers that already hold a runtime. */
export async function handleNaiveWebhook(opts: {
  rawBody: string;
  headers: Headers;
  secrets: (string | undefined)[];
  db: Pick<DbHandle, "pool">;
  queue: Pick<Queue, "enqueue">;
  nowMs?: number;
}): Promise<WebhookReply> {
  return verifyNaiveDelivery(opts) ?? acceptNaiveDelivery(opts);
}
