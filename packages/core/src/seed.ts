/**
 * The demo prospect. In production it is a teammate's real domain and inbox, passed to
 * `pnpm db:seed` as flags; the defaults are a placeholder that can't receive mail. It lives in
 * the database (filed_reason "demo"), so demo mode reads the allowed inbox from there.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { companies, contacts, prospects } from "./db/schema";

export interface DemoProspect {
  domain: string;
  name: string;
  contactName: string;
  inbox: string;
}

export const DEMO_PLACEHOLDER: DemoProspect = {
  domain: "demo.outrun.dev",
  name: "Outrun Demo Co",
  contactName: "Demo Founder",
  inbox: "demo@demo.outrun.dev",
};

export const DEMO_FILED_REASON = "demo";

export async function seedDemo(
  db: Db,
  demo: DemoProspect = DEMO_PLACEHOLDER,
): Promise<{ companyId: string; contactId: string; prospectId: string }> {
  const domain = demo.domain.toLowerCase();
  const inbox = demo.inbox.toLowerCase();
  return db.transaction(async (tx) => {
    await tx
      .insert(companies)
      .values({
        domain,
        name: demo.name,
        source: "fixture",
        kind: "prospect",
        summary: "Seeded demo prospect",
      })
      .onConflictDoNothing();
    const [company] = await tx.select().from(companies).where(eq(companies.domain, domain));
    await tx
      .insert(contacts)
      .values({
        companyId: company!.id,
        name: demo.contactName,
        role: "Founder",
        email: inbox,
        sourceUrl: `https://${domain}/about`,
      })
      .onConflictDoNothing();
    const [contact] = await tx.select().from(contacts).where(eq(contacts.email, inbox));
    await tx
      .insert(prospects)
      .values({ companyId: company!.id, contactId: contact!.id, filedReason: DEMO_FILED_REASON })
      .onConflictDoNothing();
    const [prospect] = await tx.select().from(prospects).where(eq(prospects.companyId, company!.id));
    return { companyId: company!.id, contactId: contact!.id, prospectId: prospect!.id };
  });
}

/** The inboxes of every seeded demo prospect. */
export async function demoInboxes(db: Db): Promise<string[]> {
  const rows = await db
    .select({ email: contacts.email })
    .from(prospects)
    .innerJoin(contacts, eq(prospects.contactId, contacts.id))
    .where(and(eq(prospects.filedReason, DEMO_FILED_REASON)));
  return rows.map((r) => r.email.toLowerCase());
}
