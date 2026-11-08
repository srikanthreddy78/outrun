/** RFC 8058 one-click unsubscribe (List-Unsubscribe-Post) and the /u/[token] page's form. POST only. */
import { config } from "@outrun/core";
import { readUnsubscribeToken, unsubscribeContact } from "@outrun/core/email/unsubscribe";
import { logger } from "@outrun/core/log";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  const contactId = readUnsubscribeToken(config().keys.crewTokenSecret, token);
  if (!contactId) return new Response("This unsubscribe link isn't valid.", { status: 404 });
  try {
    const rt = await getRuntime();
    await unsubscribeContact({ db: rt.db.db, emit: rt.emit }, contactId, "link");
  } catch (err) {
    logger.error({ err }, "unsubscribe failed");
    return new Response("Something went wrong; please try again.", { status: 503 });
  }
  // The page's form posts here; send the person back to a confirmation.
  if ((req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) {
    const form = await req.formData().catch(() => null);
    if (form?.get("from") === "page") return Response.redirect(new URL(`/u/${token}?done=1`, req.url), 303);
  }
  return new Response("You're unsubscribed.", { status: 200 });
}
