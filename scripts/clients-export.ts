/**
 * pnpm clients:export: writes .naive/clients.json (slug, name and staffed roles of every client but Outrun)
 * from the database, for naive.config.ts and scripts/naive-up.ts. Paused clients stay listed:
 * dropping one would make `naive up` delete its agents; a paused crew is refused at its MCP URL.
 * Self-serve clients (/hire, hire_agency) are listed like any other: when provision_client_crew
 * ends in client.crew_pending, this plus naive up gives them their crew.
 * Read-only on the database; no secrets in the file. Then preview with pnpm naive:up --dry-run.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { asc, ne } from "@outrun/core/db/query";
import { loadConfig } from "../packages/core/src/config";
import { OUTRUN_CLIENT_ID } from "../packages/core/src/constants";
import { createDb } from "../packages/core/src/db/client";
import { clients } from "../packages/core/src/db/schema";
import { CLIENTS_FILE, staffedRoles } from "../naive/crew";

const config = loadConfig();
if (!config.databaseUrl) throw new Error("set DATABASE_URL");
const db = createDb(config.databaseUrl, { max: 1 });
try {
  const rows = await db.db
    .select({ slug: clients.slug, name: clients.name, status: clients.status, roles: clients.crewRoles })
    .from(clients)
    .where(ne(clients.id, OUTRUN_CLIENT_ID))
    .orderBy(asc(clients.createdAt));
  mkdirSync(".naive", { recursive: true });
  writeFileSync(
    CLIENTS_FILE,
    `${JSON.stringify(
      rows.map(({ slug, name, roles }) => ({ slug, name, roles: staffedRoles(roles) })),
      null,
      2,
    )}\n`,
  );
  console.log(`${CLIENTS_FILE}: ${rows.length} client crew(s), plus Outrun's crew and the CEO`);
  for (const r of rows)
    console.log(
      `  ${r.slug.padEnd(24)} ${r.status.padEnd(22)} ${r.name} (${staffedRoles(r.roles).length} agents)`,
    );
} finally {
  await db.close();
}
