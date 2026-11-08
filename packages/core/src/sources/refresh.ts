/**
 * SH-2: refresh_sources, daily. Adds new candidates from discover() to `companies`; a domain
 * already there (candidate or prospect) is left alone, so a rerun adds nothing.
 */
import type { Db } from "../db/client";
import { companies } from "../db/schema";
import type { Emit } from "../events";
import type { DiscoverFn } from "../integrations/types";

/** Candidates pulled per run, as a multiple of the daily filing cap: the prospector picks among them. */
export const CANDIDATES_PER_FILED = 5;

export async function runRefreshSources(deps: {
  db: Db;
  emit: Emit;
  discover: DiscoverFn;
  settings: { discoveryDailyCap: number };
}): Promise<{ found: number; added: number }> {
  const found = await deps.discover({
    limit: Math.max(1, deps.settings.discoveryDailyCap) * CANDIDATES_PER_FILED,
  });
  let added = 0;
  for (const c of found) {
    const row = await deps.db
      .insert(companies)
      .values({
        domain: c.domain,
        name: c.name,
        source: c.source,
        sourceRef: c.sourceRef,
        summary: c.summary.slice(0, 500),
        kind: "candidate",
      })
      .onConflictDoNothing({ target: companies.domain })
      .returning({ id: companies.id });
    if (row[0]) added++;
  }
  const bySource: Record<string, number> = {};
  for (const c of found) bySource[c.source] = (bySource[c.source] ?? 0) + 1;
  await deps.emit({
    actor: "worker",
    type: "sources.refreshed",
    entityType: "system",
    entityId: "sources",
    payload: { found: found.length, added, bySource },
  });
  return { found: found.length, added };
}
