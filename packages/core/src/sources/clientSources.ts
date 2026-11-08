/**
 * refresh_client_sources: finds companies matching one client's confirmed ICP with Hunter's
 * company search on Monid (hunterio:/discover, listed at $0 a call), and lists them for that
 * client's prospector. Companies stay shared facts; the match is a client_candidates row, so a
 * rerun adds nothing. Hunter's text is untrusted data.
 * https://hunter.io/api-documentation#discover
 */
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { ClientProfile } from "../../contracts";
import { OUTRUN_CLIENT_ID } from "../constants";
import type { Db } from "../db/client";
import { clientCandidates, clients, companies } from "../db/schema";
import { AppError } from "../errors";
import type { Emit } from "../events";
import type { MonidClient } from "../integrations/types";
import { clean, registrableDomain } from "./common";

export const HUNTER_DISCOVER = "hunterio:/discover";
/** Candidates asked for per run, as a multiple of the daily filing cap; kept small on purpose. */
export const CLIENT_CANDIDATES_PER_FILED = 3;
/** Don't search again while this many of the client's candidates are still waiting. */
export const CLIENT_CANDIDATES_ENOUGH = 20;

/** Hunter's search body from the client's ICP: any include keyword, none of the excludes. */
export function hunterQuery(profile: ClientProfile, limit: number): Record<string, unknown> {
  const icp = profile.icp;
  return {
    keywords: {
      include: icp.includeKeywords.slice(0, 10),
      ...(icp.excludeKeywords.length ? { exclude: icp.excludeKeywords.slice(0, 10) } : {}),
      match: "any",
    },
    ...(icp.companySizes.length ? { headcount: icp.companySizes } : {}),
    limit: Math.max(1, Math.min(100, limit)),
  };
}

export interface HunterCompany {
  domain: string;
  name: string;
}

/** The companies in a Hunter discover answer; anything malformed is skipped. */
export function parseHunterDiscover(data: unknown): HunterCompany[] {
  const rows = (data as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return [];
  const out: HunterCompany[] = [];
  for (const r of rows) {
    const domain = registrableDomain((r as { domain?: unknown })?.domain as string | undefined);
    if (!domain) continue;
    const org = (r as { organization?: unknown }).organization;
    out.push({ domain, name: clean(typeof org === "string" ? org : domain, 120) });
  }
  return out;
}

export interface ClientSourceDeps {
  db: Db;
  emit: Emit;
  monid: Pick<MonidClient, "run">;
  settings: { discoveryDailyCap: number; demo: boolean };
}

export async function runRefreshClientSources(
  deps: ClientSourceDeps,
  clientId: string,
): Promise<{ found: number; added: number; costUsd: number; skipped?: string }> {
  if (clientId === OUTRUN_CLIENT_ID)
    throw new AppError("bad_request", "Outrun's sources are refresh_sources");
  const [c] = await deps.db.select().from(clients).where(eq(clients.id, clientId));
  if (!c) throw new AppError("not_found", "no such client");
  const skip = (skipped: string) => ({ found: 0, added: 0, costUsd: 0, skipped });
  if (deps.settings.demo) return skip("demo mode");
  if (c.status !== "active" || !c.profileConfirmedAt) return skip(`the client is ${c.status}`);
  const profile = ClientProfile.parse(c.profile);

  const out = await deps.monid.run(
    HUNTER_DISCOVER,
    hunterQuery(profile, Math.max(1, deps.settings.discoveryDailyCap) * CLIENT_CANDIDATES_PER_FILED),
  );
  const found = parseHunterDiscover(out.data).filter(
    (f) => f.domain !== c.domain && !profile.allowedLinkHosts.includes(f.domain),
  );
  let added = 0;
  if (found.length) {
    await deps.db
      .insert(companies)
      .values(found.map((f) => ({ domain: f.domain, name: f.name, source: "hunter" as const, summary: "" })))
      .onConflictDoNothing({ target: companies.domain });
    const rows = await deps.db
      .select({ id: companies.id })
      .from(companies)
      .where(
        inArray(
          companies.domain,
          found.map((f) => f.domain),
        ),
      );
    const reason = `Matched ${profile.icp.includeKeywords.slice(0, 5).join(", ")} on Hunter`;
    const inserted = await deps.db
      .insert(clientCandidates)
      .values(rows.map((r) => ({ clientId: c.id, companyId: r.id, source: "hunter" as const, reason })))
      .onConflictDoNothing()
      .returning({ id: clientCandidates.id });
    added = inserted.length;
  }
  await deps.emit({
    actor: "worker",
    type: "client.sources_refreshed",
    entityType: "client",
    entityId: c.id,
    payload: { found: found.length, added, costUsd: out.costUsd, endpoint: HUNTER_DISCOVER },
  });
  return { found: found.length, added, costUsd: out.costUsd };
}

/** How many of a client's candidates aren't its prospects yet. */
export async function clientCandidatesWaiting(db: Db, clientId: string): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(clientCandidates)
    .where(and(eq(clientCandidates.clientId, clientId), notProspectOf(clientId)));
  return Number(r?.n ?? 0);
}

/** The candidate isn't already this client's prospect. */
export const notProspectOf = (clientId: string) =>
  sql`not exists (select 1 from prospects p where p.client_id = ${clientId} and p.company_id = ${clientCandidates.companyId})`;
