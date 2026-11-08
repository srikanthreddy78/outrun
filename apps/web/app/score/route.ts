import { normalizeDomain } from "@outrun/core/scan/scan";

export function GET(request: Request): Response {
  const domain = new URL(request.url).searchParams.get("domain") ?? "";
  try {
    const normalized = normalizeDomain(domain);
    return Response.redirect(new URL(`/score/${encodeURIComponent(normalized)}`, request.url), 303);
  } catch {
    return new Response("Enter a valid public domain.", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}
