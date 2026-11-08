import { handleNaiveWebhook } from "@outrun/core/webhooks/naive";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const rt = await getRuntime();
  const reply = await handleNaiveWebhook({
    rawBody: await req.text(),
    headers: req.headers,
    secrets: [rt.config.keys.naiveWebhookSecret, rt.config.keys.naiveWebhookSecretPrevious],
    db: rt.db.db,
    queue: rt.queue,
  });
  return Response.json(reply.body, { status: reply.status });
}
