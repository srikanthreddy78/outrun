import { handleApifyWebhook } from "@outrun/core/webhooks/apify";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const rt = await getRuntime();
  const reply = await handleApifyWebhook({
    rawBody: await req.text(),
    header: req.headers.get("x-outrun-apify-secret"),
    secret: rt.config.keys.apifyWebhookSecret,
    db: rt.db,
    queue: rt.queue,
  });
  return Response.json(reply.body, { status: reply.status });
}
