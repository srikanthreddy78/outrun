/**
 * Onboarding a client of the agency: the owner adds a name and domain, `naive up` gives the
 * client its crew, its researcher drafts the profile from the client's own site, and the owner
 * confirms it. Only then does the CEO start the client's days.
 *
 *   draft → (crew on Naive) profiling → awaiting_confirmation → email_setup → active ⇄ paused
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { ClientProfile, NewClient, slugify, type ClientStatus } from "../contracts";
import { OUTRUN_CLIENT_ID } from "./constants";
import type { Db } from "./db/client";
import { clientUsers, clients } from "./db/schema";
import { AppError } from "./errors";
import type { Emit } from "./events";

export interface ClientDeps {
  db: Db;
  emit: Emit;
  enqueue: (job: {
    type: "start_session" | "client_email_setup";
    payload: Record<string, unknown>;
    idempotencyKey: string;
    traceId: string;
  }) => Promise<unknown>;
}

function pgUnique(err: unknown): string | null {
  const e =
    (err as { cause?: { code?: string; constraint?: string } }).cause ??
    (err as { code?: string; constraint?: string });
  return e?.code === "23505" ? (e.constraint ?? "unique") : null;
}

/** Adds a client (status draft) and its approvers. Its crew exists after clients:export and naive up. */
export async function addClient(deps: ClientDeps, raw: unknown, actor: string) {
  const input = NewClient.parse(raw);
  const slug = input.slug ?? slugify(input.name);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length < 2 || slug === "outrun")
    throw new AppError("bad_request", "pick a slug: lowercase letters, digits and hyphens");
  let c: typeof clients.$inferSelect | undefined;
  try {
    [c] = await deps.db.insert(clients).values({ slug, name: input.name, domain: input.domain }).returning();
  } catch (err) {
    const which = pgUnique(err);
    if (which === "clients_slug_uq") throw new AppError("conflict", `a client with slug ${slug} exists`);
    if (which === "clients_domain_uq") throw new AppError("conflict", `${input.domain} is already a client`);
    throw err;
  }
  if (input.approverEmails.length)
    await deps.db
      .insert(clientUsers)
      .values(input.approverEmails.map((email) => ({ clientId: c!.id, email })))
      .onConflictDoNothing();
  await deps.emit({
    actor: actor as never,
    type: "client.added",
    entityType: "client",
    entityId: c!.id,
    payload: { slug },
  });
  return c!;
}

/**
 * After `naive up` created the client's crew: start its researcher on the profile. Keyed per
 * client, so a second click doesn't start a second session.
 */
export async function startProfiling(deps: ClientDeps, clientId: string, actor: string) {
  const [c] = await deps.db.select().from(clients).where(eq(clients.id, clientId));
  if (!c || c.id === OUTRUN_CLIENT_ID) throw new AppError("not_found", "no such client");
  if (c.status !== "draft" && c.status !== "profiling")
    throw new AppError("conflict", `the client is ${c.status}; its profile is already drafted`);
  await deps.db.update(clients).set({ status: "profiling" }).where(eq(clients.id, c.id));
  await deps.enqueue({
    type: "start_session",
    payload: {
      agent: "researcher",
      clientId: c.id,
      entity: { type: "client", id: c.id },
      message:
        "Onboarding: draft your client's profile. Call outrun.get_client_profile, read the client's own site with web_fetch (home, product, pricing, about), then outrun.save_client_profile once with the pages you used as sources, and stop.",
    },
    idempotencyKey: `onboard:${c.id}:profile`,
    traceId: randomUUID(),
  });
  await deps.emit({
    actor: actor as never,
    type: "client.profiling",
    entityType: "client",
    entityId: c.id,
    payload: {},
  });
}

/** save_client_profile: the researcher's draft. It never confirms; a confirmed profile is kept. */
export async function saveDraftProfile(
  deps: Pick<ClientDeps, "db" | "emit">,
  clientId: string,
  raw: unknown,
  actor: string,
) {
  const profile = ClientProfile.parse(raw);
  const [c] = await deps.db.select().from(clients).where(eq(clients.id, clientId));
  if (!c || c.id === OUTRUN_CLIENT_ID)
    throw new AppError("forbidden", "Outrun's profile isn't drafted by an agent");
  const ownHost = (u: string) => {
    const h = new URL(u).hostname;
    return h === c.domain || h.endsWith(`.${c.domain}`);
  };
  if (!profile.sources.some(ownHost))
    throw new AppError("bad_request", `cite at least one page on ${c.domain} in sources`);
  if (
    !ownHost(profile.offer.callToActionUrl) &&
    !profile.allowedLinkHosts.includes(new URL(profile.offer.callToActionUrl).hostname)
  )
    throw new AppError(
      "bad_request",
      "the call to action must be on the client's domain or an allowed link host",
    );
  if (c.profileConfirmedAt) return { status: c.status };
  const [u] = await deps.db
    .update(clients)
    .set({ profile, status: "awaiting_confirmation" })
    .where(
      and(eq(clients.id, c.id), inArray(clients.status, ["draft", "profiling", "awaiting_confirmation"])),
    )
    .returning({ status: clients.status });
  await deps.emit({
    actor: actor as never,
    type: "client.profile_drafted",
    entityType: "client",
    entityId: c.id,
    payload: {},
  });
  return { status: (u?.status ?? c.status) as ClientStatus };
}

/**
 * The owner confirms the profile, optionally edited. The client then needs its sending domain
 * (email_setup) before it goes active.
 */
export async function confirmProfile(deps: ClientDeps, clientId: string, raw: unknown, actor: string) {
  const profile = ClientProfile.parse(raw);
  const [c] = await deps.db.select().from(clients).where(eq(clients.id, clientId));
  if (!c || c.id === OUTRUN_CLIENT_ID) throw new AppError("not_found", "no such client");
  if (c.status === "paused") throw new AppError("conflict", "resume the client first");
  const status: ClientStatus = c.dnsStatus === "verified" ? "active" : "email_setup";
  await deps.db
    .update(clients)
    .set({
      profile,
      profileConfirmedAt: new Date(),
      confirmedBy: actor,
      status: c.status === "active" ? "active" : status,
    })
    .where(eq(clients.id, c.id));
  await deps.emit({
    actor: actor as never,
    type: "client.profile_confirmed",
    entityType: "client",
    entityId: c.id,
    payload: {},
  });
  if (c.dnsStatus !== "verified") await startEmailSetup(deps, c.id);
  return { status: c.status === "active" ? ("active" as const) : status };
}

/** Starts (or restarts) the client's sending-domain setup; one job per client per minute. */
export async function startEmailSetup(
  deps: Pick<ClientDeps, "enqueue">,
  clientId: string,
  at: Date = new Date(),
) {
  await deps.enqueue({
    type: "client_email_setup",
    payload: { clientId, startedAt: at.toISOString() },
    idempotencyKey: `client-email:${clientId}:start:${at.toISOString().slice(0, 16)}`,
    traceId: randomUUID(),
  });
}

/** Pause stops the crew at its MCP URL and the CEO's kick; resume puts it back where it was. */
export async function setPaused(
  deps: Pick<ClientDeps, "db" | "emit">,
  clientId: string,
  paused: boolean,
  actor: string,
) {
  const [c] = await deps.db.select().from(clients).where(eq(clients.id, clientId));
  if (!c || c.id === OUTRUN_CLIENT_ID) throw new AppError("not_found", "no such client");
  const resumed: ClientStatus = !c.profileConfirmedAt
    ? c.profile && Object.keys(c.profile).length
      ? "awaiting_confirmation"
      : "draft"
    : c.dnsStatus === "verified"
      ? "active"
      : "email_setup";
  const status: ClientStatus = paused ? "paused" : resumed;
  await deps.db.update(clients).set({ status }).where(eq(clients.id, c.id));
  await deps.emit({
    actor: actor as never,
    type: paused ? "client.paused" : "client.resumed",
    entityType: "client",
    entityId: c.id,
    payload: { status },
  });
  return { status };
}

/** A client's name, domain and confirmed profile; null for Outrun or before the owner confirms. */
export async function confirmedClient(db: Db, clientId: string) {
  if (clientId === OUTRUN_CLIENT_ID) return null;
  const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!c?.profileConfirmedAt) return null;
  const profile = ClientProfile.safeParse(c.profile);
  return profile.success ? { id: c.id, name: c.name, domain: c.domain, profile: profile.data } : null;
}
