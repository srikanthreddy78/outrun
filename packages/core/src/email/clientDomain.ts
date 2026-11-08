/**
 * A client's own sending domain. client_email_setup registers it on AgentMail, stores the DNS
 * records for the client to add, and re-checks until AgentMail verifies it. Then it creates the
 * client's inbox (`<username>@<domain>`), and a client whose profile is confirmed goes active.
 * Every step is idempotent: AgentMail's client_id dedupes the domain and the inbox.
 */
import { eq } from "drizzle-orm";
import { OUTRUN_CLIENT_ID } from "../constants";
import type { Db } from "../db/client";
import { clients } from "../db/schema";
import { AppError } from "../errors";
import type { Emit } from "../events";
import type { AgentMailClient } from "../integrations/types";

/** How often to re-check DNS, and for how long before telling the owner it's stuck. */
export const DNS_RECHECK_MINUTES = 15;
export const DNS_GIVE_UP_HOURS = 72;
export const CLIENT_INBOX_USERNAME = "hello";

export interface DomainDeps {
  db: Db;
  emit: Emit;
  agentmail: Pick<AgentMailClient, "createDomain" | "getDomain" | "verifyDomain" | "createInbox">;
  enqueue: (job: {
    type: "client_email_setup";
    payload: Record<string, unknown>;
    idempotencyKey: string;
    traceId: string;
    runAfter?: string;
  }) => Promise<unknown>;
  now?: () => Date;
}

export type SetupOutcome =
  | { state: "verified"; inboxId: string; status: string }
  | { state: "pending"; recheckAt: string }
  | { state: "gave_up" }
  | { state: "failed"; reason: string };

export async function runClientEmailSetup(
  deps: DomainDeps,
  clientId: string,
  startedAt: string,
  traceId: string,
): Promise<SetupOutcome> {
  const now = deps.now?.() ?? new Date();
  const [c] = await deps.db.select().from(clients).where(eq(clients.id, clientId));
  if (!c || c.id === OUTRUN_CLIENT_ID) throw new AppError("not_found", "no such client");
  const domain = c.sendingDomain ?? c.domain;
  const awClient = `outrun-client-${c.id}`;

  let d = c.agentmailDomainId
    ? await deps.agentmail.getDomain(c.agentmailDomainId)
    : await deps.agentmail.createDomain(domain, awClient);
  if (!c.agentmailDomainId) {
    await deps.db
      .update(clients)
      .set({
        agentmailDomainId: d.domainId,
        sendingDomain: domain,
        dnsStatus: "pending",
        dnsRecords: d.records,
      })
      .where(eq(clients.id, c.id));
    await deps.emit({
      actor: "worker",
      type: "client.domain_registered",
      entityType: "client",
      entityId: c.id,
      payload: { domain, records: d.records.length },
    });
  }
  if (d.status !== "VERIFIED") {
    await deps.agentmail.verifyDomain(d.domainId);
    d = await deps.agentmail.getDomain(d.domainId);
  }
  if (d.status === "FAILED" || d.status === "INVALID") {
    await deps.db
      .update(clients)
      .set({ dnsStatus: "failed", dnsRecords: d.records })
      .where(eq(clients.id, c.id));
    await deps.emit({
      actor: "worker",
      type: "client.domain_failed",
      entityType: "client",
      entityId: c.id,
      payload: { status: d.status },
    });
    return { state: "failed", reason: d.status };
  }
  if (d.status !== "VERIFIED") {
    await deps.db
      .update(clients)
      .set({ dnsStatus: "pending", dnsRecords: d.records })
      .where(eq(clients.id, c.id));
    if (now.getTime() - new Date(startedAt).getTime() > DNS_GIVE_UP_HOURS * 3_600_000) {
      await deps.emit({
        actor: "worker",
        type: "client.domain_stuck",
        entityType: "client",
        entityId: c.id,
        payload: { hours: DNS_GIVE_UP_HOURS },
      });
      return { state: "gave_up" };
    }
    const recheckAt = new Date(now.getTime() + DNS_RECHECK_MINUTES * 60_000).toISOString();
    await deps.enqueue({
      type: "client_email_setup",
      payload: { clientId: c.id, startedAt },
      idempotencyKey: `client-email:${c.id}:${recheckAt.slice(0, 16)}`,
      traceId,
      runAfter: recheckAt,
    });
    return { state: "pending", recheckAt };
  }

  const sender = (c.profile as { sender?: { name?: string } }).sender;
  const { inboxId } = c.agentmailInboxId
    ? { inboxId: c.agentmailInboxId }
    : await deps.agentmail.createInbox({
        username: CLIENT_INBOX_USERNAME,
        domain,
        displayName: sender?.name ? `${sender.name} at ${c.name}` : c.name,
        clientId: awClient,
      });
  const status = c.status === "email_setup" && c.profileConfirmedAt ? "active" : c.status;
  await deps.db
    .update(clients)
    .set({ agentmailInboxId: inboxId, dnsStatus: "verified", dnsRecords: d.records, status })
    .where(eq(clients.id, c.id));
  await deps.emit({
    actor: "worker",
    type: "client.domain_verified",
    entityType: "client",
    entityId: c.id,
    payload: { domain, status },
  });
  return { state: "verified", inboxId, status };
}
