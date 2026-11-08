import { scoreApi } from "@outrun/core/scan/http";
import { requesterIp, scanService } from "../../../lib/scan-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const service = await scanService();
  if (!service)
    return Response.json(
      { error: "scan_store_unavailable" },
      { status: 503, headers: { "retry-after": "60" } },
    );
  const domain = new URL(request.url).searchParams.get("domain") ?? "";
  const result = await scoreApi(service, domain, requesterIp(request));
  return new Response(result.body, { status: result.status, headers: result.headers });
}
