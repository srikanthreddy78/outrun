import { config } from "@outrun/core";
import { logger } from "@outrun/core/log";
import { acceptNaiveDelivery, verifyNaiveDelivery, type WebhookReply } from "@outrun/core/webhooks/naive";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const send = (r: WebhookReply) =>
  Response.json(r.body, { status: r.status, ...(r.headers ? { headers: r.headers } : {}) });

export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text();
  let reply: WebhookReply | null;
  try {
    const keys = config().keys;
    reply = verifyNaiveDelivery({
      rawBody,
      headers: req.headers,
      secrets: [keys.naiveWebhookSecret, keys.naiveWebhookSecretPrevious],
    });
  } catch (err) {
    logger.error({ err }, "naive webhook: config failed to load");
    return send({ status: 503, body: { error: "unavailable" }, headers: { "retry-after": "60" } });
  }
  if (reply) return send(reply);
  try {
    const rt = await getRuntime();
    return send(await acceptNaiveDelivery({ rawBody, db: rt.db, queue: rt.queue }));
  } catch (err) {
    // Not ours to drop: 503 so Naive redelivers once we're healthy.
    logger.error({ err }, "naive webhook: accept failed");
    return send({ status: 503, body: { error: "unavailable" }, headers: { "retry-after": "30" } });
  }
}
