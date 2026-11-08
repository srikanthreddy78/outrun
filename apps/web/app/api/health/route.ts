import { checkHealth } from "@outrun/core/health";
import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const rt = await getRuntime();
    const h = await checkHealth({ db: rt.db.db, demo: rt.config.settings.demo, fakes: rt.fakes });
    return Response.json(h, { status: h.ok ? 200 : 503, headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ ok: false, error: "runtime_unavailable" }, { status: 503 });
  }
}
