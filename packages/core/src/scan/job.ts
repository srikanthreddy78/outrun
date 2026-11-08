import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { companies, prospects } from "../db/schema";
import type { JobHandler } from "../queue";
import { DbScanStore } from "./db-store";
import { ScanService } from "./service";

export function scanDomainHandler(db: Db): JobHandler {
  const service = new ScanService(
    new DbScanStore(db, async () => {
      throw new Error("scan_domain jobs cannot enqueue another scan_domain job");
    }),
  );
  return async (env) => {
    let domain = env.payload.domain;
    if (typeof domain !== "string" && typeof env.payload.prospectId === "string") {
      const [row] = await db
        .select({ domain: companies.domain })
        .from(prospects)
        .innerJoin(companies, eq(prospects.companyId, companies.id))
        .where(eq(prospects.id, env.payload.prospectId));
      domain = row?.domain;
    }
    if (typeof domain !== "string") throw new Error("scan_domain requires a domain or prospectId");
    await service.complete(domain);
  };
}
