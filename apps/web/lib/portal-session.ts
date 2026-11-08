/** The signed-in client approver, from the portal cookie; null when there's none or it's expired. */
import { cookies } from "next/headers";
import { config } from "@outrun/core";
import { PORTAL_COOKIE, readPortalSession } from "@outrun/core/portal";

export async function portalEmail(): Promise<string | null> {
  const jar = await cookies();
  return (
    readPortalSession(config().keys.crewTokenSecret, jar.get(PORTAL_COOKIE)?.value, new Date())?.email ?? null
  );
}
