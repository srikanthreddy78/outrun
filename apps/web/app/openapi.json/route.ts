import { config } from "@outrun/core";
import { openApi } from "@outrun/core/public/discovery";
import { discoveryHeaders } from "@/lib/public";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(JSON.stringify(openApi(config().appUrl), null, 2), {
    headers: discoveryHeaders("application/json"),
  });
}
