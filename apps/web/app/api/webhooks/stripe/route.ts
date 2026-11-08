import { config } from "@outrun/core";
import { logger } from "@outrun/core/log";
import type { WebhookReply } from "@outrun/core/webhooks/naive";
import { acceptStripeEvent, verifyStripeDelivery } from "@outrun/core/webhooks/stripe";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const send = (r: WebhookReply) =>
  Response.json(r.body, { status: r.status, ...(r.headers ? { headers: r.headers } : {}) });

export async function POST(req: Request): Promise<Response> {
  // The signature covers the exact bytes, so read the raw body before anything parses it.
  const rawBody = await req.text();
  let verified: ReturnType<typeof verifyStripeDelivery>;
  try {
    const keys = config().keys;
    verified = verifyStripeDelivery({
      rawBody,
      headers: req.headers,
      secrets: [keys.stripeWebhookSecret, keys.stripeWebhookSecretPrevious],
    });
  } catch (err) {
    logger.error({ err }, "stripe webhook: config failed to load");
    return send({ status: 503, body: { error: "unavailable" }, headers: { "retry-after": "60" } });
  }
  if ("reply" in verified) return send(verified.reply);
  try {
    const rt = await getRuntime();
    return send(await acceptStripeEvent({ event: verified.event, db: rt.db, queue: rt.queue }));
  } catch (err) {
    // Stripe retries a non-2xx for three days, so a 503 here is safe.
    logger.error({ err }, "stripe webhook: accept failed");
    return send({ status: 503, body: { error: "unavailable" }, headers: { "retry-after": "30" } });
  }
}
