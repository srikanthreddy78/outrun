/**
 * The demo prospect. In production it is a teammate's real domain and inbox, passed to
 * `pnpm db:seed` as flags; the defaults are a placeholder that can't receive mail. It lives in
 * the database (filed_reason "demo"), so demo mode reads the allowed inbox from there.
 */
import { eq } from "drizzle-orm";
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

/**
 * Upserts the demo company, contact and prospect, and flags the prospect `is_demo`, the only
 * flag demo mode trusts (agents can't set it). Refuses an inbox that belongs to another company.
 */
export async function seedDemo(
  db: Db,
  demo: DemoProspect = DEMO_PLACEHOLDER,
): Promise<{ companyId: string; contactId: string; prospectId: string }> {
  const domain = demo.domain.toLowerCase();
  const inbox = demo.inbox.toLowerCase();
  return db.transaction(async (tx) => {
    const [company] = await tx
      .insert(companies)
      .values({
        domain,
        name: demo.name,
        source: "fixture",
        kind: "prospect",
        summary: "Seeded demo prospect",
      })
      .onConflictDoUpdate({ target: companies.domain, set: { name: demo.name, kind: "prospect" } })
      .returning();
    const [existing] = await tx.select().from(contacts).where(eq(contacts.email, inbox));
    if (existing && existing.companyId !== company!.id) {
      throw new Error(`${inbox} already belongs to another company; pick a different demo inbox`);
    }
    const [contact] = await tx
      .insert(contacts)
      .values({
        companyId: company!.id,
        name: demo.contactName,
        role: "Founder",
        email: inbox,
        sourceUrl: `https://${domain}/about`,
      })
      .onConflictDoUpdate({ target: contacts.email, set: { name: demo.contactName } })
      .returning();
    const [prospect] = await tx
      .insert(prospects)
      .values({
        companyId: company!.id,
        contactId: contact!.id,
        filedReason: DEMO_FILED_REASON,
        isDemo: true,
      })
      .onConflictDoUpdate({
        target: prospects.companyId,
        set: { contactId: contact!.id, filedReason: DEMO_FILED_REASON, isDemo: true },
      })
      .returning();
    return { companyId: company!.id, contactId: contact!.id, prospectId: prospect!.id };
  });
}

/** The inboxes of every seeded demo prospect. */
export async function demoInboxes(db: Db): Promise<string[]> {
  const rows = await db
    .select({ email: contacts.email })
    .from(prospects)
    .innerJoin(contacts, eq(prospects.contactId, contacts.id))
    .where(eq(prospects.isDemo, true));
  return rows.map((r) => r.email.toLowerCase());
}
