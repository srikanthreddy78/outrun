import { renderScoreMarkdown, renderScorePage, scoreApi } from "@outrun/core/scan/http";
import type { ScanResult } from "@outrun/core/scan/contracts";
import { requesterIp, scanService } from "../../../lib/scan-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ domain: string }> },
): Promise<Response> {
  const service = scanService();
  if (!service)
    return new Response("Scan storage is unavailable.", { status: 503, headers: { "retry-after": "60" } });
  const { domain } = await params;
  const result = await scoreApi(service, domain, requesterIp(request));
  if (result.status !== 200)
    return new Response(result.body, { status: result.status, headers: result.headers });
  const scan = JSON.parse(result.body) as ScanResult;
  const markdown =
    new URL(request.url).searchParams.get("format") === "md" ||
    request.headers.get("accept")?.includes("text/markdown");
  return new Response(markdown ? renderScoreMarkdown(scan) : renderScorePage(scan), {
    headers: {
      "content-type": markdown ? "text/markdown; charset=utf-8" : "text/html; charset=utf-8",
      "cache-control": "no-store",
      link: `</score/${encodeURIComponent(scan.domain)}?format=md>; rel="alternate"; type="text/markdown"`,
    },
  });
}
