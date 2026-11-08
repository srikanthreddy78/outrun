/**
 * SH-4: sync_crm mirrors one prospect to HubSpot: its company, contact, deal and stage, and each
 * sent or received email once (a `crm.email_logged` event per message). Postgres stays the source
 * of truth; nothing is ever read back from HubSpot.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { companies, contacts, events, messages, prospects } from "../db/schema";
import type { Emit } from "../events";
import type { HubSpotClient } from "../integrations/types";

export async function runSyncCrm(
  deps: { db: Db; emit: Emit; hubspot: HubSpotClient },
  prospectId: string,
): Promise<{ synced: boolean; emailsLogged: number }> {
  const [r] = await deps.db
    .select({ p: prospects, co: companies, c: contacts })
    .from(prospects)
    .innerJoin(companies, eq(prospects.companyId, companies.id))
    .leftJoin(contacts, eq(prospects.contactId, contacts.id))
    .where(eq(prospects.id, prospectId));
  if (!r) return { synced: false, emailsLogged: 0 };

  const company = await deps.hubspot.upsertCompany({
    outrunId: r.co.id,
    domain: r.co.domain,
    name: r.co.name || r.co.domain,
  });
  if (r.c)
    await deps.hubspot.upsertContact({
      outrunId: r.c.id,
      email: r.c.email,
      name: r.c.name,
      companyId: company.id,
    });
  const deal = await deps.hubspot.upsertDeal({
    outrunId: r.p.id,
    name: `${r.co.name || r.co.domain}: Outrun`,
    stage: r.p.stage,
    companyId: company.id,
  });

  const mail = await deps.db
    .select()
    .from(messages)
    .where(and(eq(messages.prospectId, prospectId), inArray(messages.status, ["sent", "received"])))
    .orderBy(asc(messages.createdAt));
  const logged = new Set(
    mail.length
      ? (
          await deps.db
            .select({ id: events.entityId })
            .from(events)
            .where(
              and(
                eq(events.type, "crm.email_logged"),
                inArray(
                  events.entityId,
                  mail.map((m) => m.id),
                ),
              ),
            )
        ).map((e) => e.id)
      : [],
  );
  let emailsLogged = 0;
  for (const m of mail) {
    if (logged.has(m.id)) continue;
    await deps.hubspot.logEmail({
      outrunId: m.id,
      dealId: deal.id,
      subject: m.subject,
      body: m.body,
      direction: m.direction === "inbound" ? "inbound" : "outbound",
      at: (m.sentAt ?? m.createdAt).toISOString(),
    });
    await deps.emit({
      actor: "worker",
      type: "crm.email_logged",
      entityType: "message",
      entityId: m.id,
      payload: { dealId: deal.id },
    });
    emailsLogged++;
  }
  await deps.emit({
    actor: "worker",
    type: "crm.synced",
    entityType: "prospect",
    entityId: prospectId,
    payload: { companyId: company.id, dealId: deal.id, stage: r.p.stage, emailsLogged },
  });
  return { synced: true, emailsLogged };
}
