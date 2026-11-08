import { downloadAsset } from "@outrun/core/audit/pipeline";
import { getDeliveredReport } from "@outrun/core/report/delivery";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string; name: string }> },
): Promise<Response> {
  const { token, name } = await params;
  const rt = await getRuntime();
  const report = await getDeliveredReport(rt.db.db, token);
  if (!report) return new Response("Asset not found", { status: 404, headers: { "cache-control": "no-store" } });
  const asset = downloadAsset(report, name);
  return new Response(asset.body, {
    status: asset.status,
    headers: { ...asset.headers, "x-robots-tag": "noindex, nofollow" },
  });
}
