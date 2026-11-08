import { config } from "@outrun/core";
import { logger } from "@outrun/core/log";
import { acceptAgentMailEvent, verifySvix } from "@outrun/core/webhooks/agentmail";
import type { WebhookReply } from "@outrun/core/webhooks/naive";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 1_000_000;
const send = (r: WebhookReply) =>
  Response.json(r.body, { status: r.status, ...(r.headers ? { headers: r.headers } : {}) });

export async function POST(req: Request): Promise<Response> {
  // Svix signs the exact bytes, so read the raw body first.
  const rawBody = await req.text();
  if (rawBody.length > MAX_BYTES) return send({ status: 413, body: { error: "too large" } });
  let refused: WebhookReply | null;
  try {
    refused = verifySvix({ rawBody, headers: req.headers, secrets: [config().keys.agentmailWebhookSecret] });
  } catch (err) {
    logger.error({ err }, "agentmail webhook: config failed to load");
    return send({ status: 503, body: { error: "unavailable" }, headers: { "retry-after": "60" } });
  }
  if (refused) return send(refused);
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return send({ status: 400, body: { error: "bad json" } });
  }
  try {
    const rt = await getRuntime();
    return send(await acceptAgentMailEvent({ body, db: rt.db, queue: rt.queue, emit: rt.emit }));
  } catch (err) {
    // Svix retries a non-2xx with backoff, so a 503 is safe.
    logger.error({ err }, "agentmail webhook: accept failed");
    return send({ status: 503, body: { error: "unavailable" }, headers: { "retry-after": "30" } });
  }
}
