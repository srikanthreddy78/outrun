/**
 * POST /api/webhooks/naive, framework-free. Verify the signature against the raw body, dedupe on
 * the envelope id, answer 2xx at once and leave the work to the handle_naive_event job. Naive
 * disables an endpoint after 10 failures, so anything past verification answers 200.
 */
import { NAIVE_SIGNATURE_HEADER, NAIVE_TIMESTAMP_HEADER, NaiveEnvelope } from "../../contracts";
import type { Db } from "../db/client";
import { recordWebhookOnce } from "../events";
import { logger } from "../log";
import type { Queue } from "../queue";
import { verifyNaiveSignature } from "./verify";

export interface WebhookReply {
  status: number;
  body: Record<string, unknown>;
}

export async function handleNaiveWebhook(opts: {
  rawBody: string;
  headers: { get(name: string): string | null };
  secrets: (string | undefined)[];
  db: Db;
  queue: Pick<Queue, "enqueue">;
  nowMs?: number;
}): Promise<WebhookReply> {
  const v = verifyNaiveSignature({
    rawBody: opts.rawBody,
    signatureHeader: opts.headers.get(NAIVE_SIGNATURE_HEADER),
    timestampHeader: opts.headers.get(NAIVE_TIMESTAMP_HEADER),
    secrets: opts.secrets,
    ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
  });
  if (!v.ok) {
    logger.warn({ reason: v.reason }, "naive webhook rejected");
    return { status: v.reason === "no_secret" ? 503 : 401, body: { error: v.reason } };
  }

  let json: unknown;
  try {
    json = JSON.parse(opts.rawBody);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  const env = NaiveEnvelope.safeParse(json);
  if (!env.success) return { status: 400, body: { error: "invalid_envelope" } };

  const first = await recordWebhookOnce(opts.db, "naive", env.data.id, { type: env.data.type });
  if (!first) return { status: 200, body: { ok: true, duplicate: true } };

  await opts.queue.enqueue({
    type: "handle_naive_event",
    payload: { envelope: env.data },
    idempotencyKey: `naive:${env.data.id}`,
    traceId: `naive-${env.data.id}`,
  });
  return { status: 200, body: { ok: true } };
}
