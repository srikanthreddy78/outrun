/** The demo prospect. SR-7 points it at a teammate's real domain and inbox via env. */
import { eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { companies, contacts, prospects } from "./db/schema";

export const DEMO = {
  domain: process.env.OUTRUN_DEMO_DOMAIN ?? "demo.outrun.dev",
  name: process.env.OUTRUN_DEMO_NAME ?? "Outrun Demo Co",
  contactName: process.env.OUTRUN_DEMO_CONTACT_NAME ?? "Demo Founder",
  contactEmail: process.env.OUTRUN_DEMO_INBOX ?? "demo@demo.outrun.dev",
} as const;

export async function seedDemo(
  db: Db,
): Promise<{ companyId: string; contactId: string; prospectId: string }> {
  return db.transaction(async (tx) => {
    await tx
      .insert(companies)
      .values({
        domain: DEMO.domain,
        name: DEMO.name,
        source: "fixture",
        kind: "prospect",
        summary: "Seeded demo prospect",
      })
      .onConflictDoNothing();
    const [company] = await tx.select().from(companies).where(eq(companies.domain, DEMO.domain));
    await tx
      .insert(contacts)
      .values({
        companyId: company!.id,
        name: DEMO.contactName,
        role: "Founder",
        email: DEMO.contactEmail,
        sourceUrl: `https://${DEMO.domain}/about`,
      })
      .onConflictDoNothing();
    const [contact] = await tx.select().from(contacts).where(eq(contacts.email, DEMO.contactEmail));
    await tx
      .insert(prospects)
      .values({ companyId: company!.id, contactId: contact!.id, filedReason: "demo" })
      .onConflictDoNothing();
    const [prospect] = await tx.select().from(prospects).where(eq(prospects.companyId, company!.id));
    return { companyId: company!.id, contactId: contact!.id, prospectId: prospect!.id };
  });
}
