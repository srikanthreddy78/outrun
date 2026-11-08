import { downloadAsset, renderReportPage } from "@outrun/core/audit/pipeline";
import { getDeliveredReport } from "@outrun/core/report/delivery";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const rt = await getRuntime();
  const report = await getDeliveredReport(rt.db.db, token);
  if (!report) return new Response("Report not found", { status: 404, headers: { "cache-control": "no-store" } });
  return new Response(renderReportPage(report), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex, nofollow",
      "x-content-type-options": "nosniff",
    },
  });
}
