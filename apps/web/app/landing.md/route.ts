import { renderLandingMarkdown } from "@outrun/core/scan/http";

export function GET(): Response {
  return new Response(renderLandingMarkdown(), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
