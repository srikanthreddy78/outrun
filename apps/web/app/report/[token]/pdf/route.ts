import { getDeliveredReport } from "@outrun/core/report/delivery";
import { getRuntime } from "@/lib/runtime";
import { renderReportPdf } from "@/lib/report-pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const rt = await getRuntime();
  const report = await getDeliveredReport(rt.db.db, token);
  if (!report)
    return new Response("Report not found", { status: 404, headers: { "cache-control": "no-store" } });
  const bytes = await renderReportPdf(report);
  const filename = report.domain.replace(/[^a-zA-Z0-9.-]/g, "-") + "-audit.pdf";
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex, nofollow",
      "x-content-type-options": "nosniff",
    },
  });
}
