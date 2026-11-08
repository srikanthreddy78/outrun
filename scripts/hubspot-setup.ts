/**
 * pnpm hubspot:setup: creates the custom properties sync_crm upserts on (SH-4): a unique
 * `outrun_id` on companies, contacts and deals, and `outrun_stage` on deals. It writes to the
 * team's HubSpot portal, so run it once, on the team's go. Existing properties are left alone.
 * The private app needs crm.objects.{companies,contacts,deals}.write and crm.schemas.*.write.
 */
import { config } from "../packages/core/src/config";

const BASE = "https://api.hubapi.com/crm/v3/properties";
const PROPS: Record<string, { name: string; label: string; unique: boolean }[]> = {
  companies: [{ name: "outrun_id", label: "Outrun id", unique: true }],
  contacts: [{ name: "outrun_id", label: "Outrun id", unique: true }],
  deals: [
    { name: "outrun_id", label: "Outrun id", unique: true },
    { name: "outrun_stage", label: "Outrun stage", unique: false },
  ],
};

async function main() {
  const token = config().keys.hubspot;
  if (!token) throw new Error("set HUBSPOT_ACCESS_TOKEN first");
  for (const [object, props] of Object.entries(PROPS)) {
    for (const p of props) {
      const res = await fetch(`${BASE}/${object}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          name: p.name,
          label: p.label,
          type: "string",
          fieldType: "text",
          groupName:
            object === "deals"
              ? "dealinformation"
              : object === "contacts"
                ? "contactinformation"
                : "companyinformation",
          hasUniqueValue: p.unique,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 409) console.log(`ok   ${object}.${p.name} already exists`);
      else if (res.ok) console.log(`ok   created ${object}.${p.name}`);
      else throw new Error(`${object}.${p.name}: HTTP ${res.status}`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
