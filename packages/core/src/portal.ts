/**
 * The client portal's sign-in: a client approver asks for a link, we email it, it works once
 * for 15 minutes, and signing in sets a session cookie for 7 days. Both are HMACs keyed from
 * CREW_TOKEN_SECRET (separate derived keys), so nothing is stored but the used link's nonce.
 * Only addresses in client_users get a link, and the answer never says whether one was sent.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { OUTRUN_CLIENT_ID } from "./constants";
import type { Db } from "./db/client";
import { clientUsers, clients, events, messages } from "./db/schema";
import { AppError } from "./errors";
import type { SendTransactionalFn } from "./integrations/types";

export const PORTAL_LINK_MINUTES = 15;
export const PORTAL_SESSION_DAYS = 7;
export const PORTAL_COOKIE = "outrun_portal";

const key = (secret: string, purpose: string) =>
  createHmac("sha256", secret).update(`outrun-portal-${purpose}-v1`).digest();
const sign = (k: Buffer, payload: string) => createHmac("sha256", k).update(payload).digest("base64url");

function seal(secret: string | undefined, purpose: string, fields: Record<string, string | number>): string {
  if (!secret) throw new AppError("not_configured", "CREW_TOKEN_SECRET is needed for portal sign-in");
  const payload = Buffer.from(JSON.stringify(fields)).toString("base64url");
  return `${payload}.${sign(key(secret, purpose), payload)}`;
}

function open<T>(secret: string | undefined, purpose: string, token: string, now: Date): T | null {
  if (!secret) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const want = Buffer.from(sign(key(secret, purpose), payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const f = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T & { exp?: number };
    return typeof f.exp === "number" && f.exp > now.getTime() ? f : null;
  } catch {
    return null;
  }
}

export interface PortalLink {
  email: string;
  nonce: string;
  exp: number;
}
export interface PortalSession {
  email: string;
  exp: number;
}

export const portalLinkToken = (
  secret: string | undefined,
  email: string,
  now: Date,
  nonce = randomBytes(12).toString("base64url"),
) => seal(secret, "link", { email, nonce, exp: now.getTime() + PORTAL_LINK_MINUTES * 60_000 });
export const readPortalLink = (secret: string | undefined, token: string, now: Date) =>
  open<PortalLink>(secret, "link", token, now);
export const portalSessionToken = (secret: string | undefined, email: string, now: Date) =>
  seal(secret, "session", { email, exp: now.getTime() + PORTAL_SESSION_DAYS * 86_400_000 });
export const readPortalSession = (secret: string | undefined, token: string | undefined, now: Date) =>
  token ? open<PortalSession>(secret, "session", token, now) : null;

/** The clients this address approves for (never Outrun). */
export async function portalClients(db: Db, email: string) {
  return db
    .select({ id: clients.id, slug: clients.slug, name: clients.name, status: clients.status })
    .from(clientUsers)
    .innerJoin(clients, eq(clientUsers.clientId, clients.id))
    .where(and(eq(clientUsers.email, email.trim().toLowerCase()), eq(clientUsers.role, "approver")))
    .orderBy(asc(clients.name));
}

/** Throws unless `email` approves for `clientId`. */
export async function assertPortalAccess(db: Db, email: string, clientId: string): Promise<void> {
  if (clientId === OUTRUN_CLIENT_ID) throw new AppError("forbidden", "not a client");
  const mine = await portalClients(db, email);
  if (!mine.some((c) => c.id === clientId)) throw new AppError("forbidden", "not your client");
}

/**
 * Emails a sign-in link if the address approves for any client. One email per address per
 * 10 minutes (the idempotency key), and the caller shows the same answer either way.
 */
export async function requestPortalLink(
  deps: {
    db: Db;
    sendTransactional: SendTransactionalFn;
    appUrl: string;
    secret: string | undefined;
    now?: () => Date;
  },
  rawEmail: string,
): Promise<{ sent: boolean }> {
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { sent: false };
  const now = deps.now?.() ?? new Date();
  if ((await portalClients(deps.db, email)).length === 0) return { sent: false };
  const token = portalLinkToken(deps.secret, email, now);
  const slot = Math.floor(now.getTime() / 600_000);
  await deps.sendTransactional({
    to: email,
    subject: "Your sign-in link for the Outrun client portal",
    text: [
      "Sign in to review and approve your outreach emails:",
      `${deps.appUrl}/portal/auth/${token}`,
      "",
      `The link works once, for ${PORTAL_LINK_MINUTES} minutes. If you didn't ask for it, ignore this email.`,
    ].join("\n"),
    idempotencyKey: `portal-link:${email}:${slot}`,
  });
  return { sent: true };
}

/** Uses a link once; returns the session token to set, or null when it's invalid, expired or used. */
export async function redeemPortalLink(
  deps: { db: Db; secret: string | undefined; now?: () => Date },
  token: string,
): Promise<{ email: string; session: string } | null> {
  const now = deps.now?.() ?? new Date();
  const link = readPortalLink(deps.secret, token, now);
  if (!link) return null;
  if ((await portalClients(deps.db, link.email)).length === 0) return null;
  const used = await deps.db
    .insert(events)
    .values({
      actor: `client:${link.email}`,
      type: "portal.link_used",
      entityType: "system",
      entityId: `portal:${link.nonce}`,
      payload: {},
    })
    .onConflictDoNothing()
    .returning({ id: events.id });
  if (!used.length) return null;
  return { email: link.email, session: portalSessionToken(deps.secret, link.email, now) };
}

/** The ids among `ids` that are this client's messages; the rest are dropped. */
export async function clientMessageIds(db: Db, clientId: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(inArray(messages.id, ids), eq(messages.clientId, clientId)));
  return rows.map((r) => r.id);
}
