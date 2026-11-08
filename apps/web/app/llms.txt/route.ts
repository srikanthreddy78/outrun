import { config } from "@outrun/core";
import { llmsTxt } from "@outrun/core/public/discovery";
import { discoveryHeaders } from "@/lib/public";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(llmsTxt(config().appUrl), {
    headers: discoveryHeaders("text/markdown; charset=utf-8"),
  });
}
