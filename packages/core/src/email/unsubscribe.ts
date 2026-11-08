/**
 * SH-6: one-click unsubscribe. The token is the contact id plus an HMAC, keyed from
 * CREW_TOKEN_SECRET, so a link can't be forged for someone else's address.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { OUTRUN_CLIENT_ID } from "../constants";
import type { Db } from "../db/client";
import { contacts, prospects } from "../db/schema";
import { AppError } from "../errors";
import type { Emit } from "../events";
import { suppress } from "./rules";

const keyFrom = (secret: string) => createHmac("sha256", secret).update("outrun-unsubscribe-v1").digest();
const mac = (secret: string, contactId: string) =>
  createHmac("sha256", keyFrom(secret)).update(contactId).digest().subarray(0, 16).toString("base64url");

/**
 * Outrun's tokens sign the contact id (as before clients existed); another client's sign
 * `<contactId>:<clientId>`, so an unsubscribe applies to the client whose email it came from.
 */
export function unsubscribeToken(
  secret: string | undefined,
  contactId: string,
  clientId: string = OUTRUN_CLIENT_ID,
): string {
  if (!secret) throw new AppError("not_configured", "CREW_TOKEN_SECRET is needed to sign unsubscribe links");
  const payload = clientId === OUTRUN_CLIENT_ID ? contactId : `${contactId}:${clientId}`;
  return `${Buffer.from(payload).toString("base64url")}.${mac(secret, payload)}`;
}

const UUID = /^[0-9a-f-]{36}$/;

/** The contact and client a token was signed for, or null when it's forged or malformed. */
export function readUnsubscribeToken(
  secret: string | undefined,
  token: string,
): { contactId: string; clientId: string } | null {
  if (!secret) return null;
  const [id64, sig] = token.split(".");
  if (!id64 || !sig) return null;
  const payload = Buffer.from(id64, "base64url").toString("utf8");
  const [contactId, clientId = OUTRUN_CLIENT_ID, extra] = payload.split(":");
  if (extra !== undefined || !contactId || !UUID.test(contactId) || !UUID.test(clientId)) return null;
  const want = Buffer.from(mac(secret, payload));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? { contactId, clientId } : null;
}

/** The List-Unsubscribe header value: the one-click URL (RFC 8058) and a mailto fallback. */
export function listUnsubscribe(appUrl: string, token: string, inbox: string | undefined): string {
  const url = `<${appUrl}/api/unsubscribe/${token}>`;
  return inbox ? `${url}, <mailto:${inbox}?subject=unsubscribe>` : url;
}

/**
 * The line appended to every outreach body. A client's email also names the sender and the
 * postal address commercial email must carry.
 */
export const unsubscribeLine = (
  appUrl: string,
  token: string,
  footer?: { senderName: string; company: string; postalAddress: string },
): string =>
  footer
    ? `\n\n--\n${footer.senderName}, ${footer.company} · ${footer.postalAddress}\nNot interested? Unsubscribe in one click: ${appUrl}/u/${token}`
    : `\n\n--\nNot interested? Unsubscribe in one click: ${appUrl}/u/${token}`;

/**
 * Unsubscribes a contact from one client's email: that client's suppression and prospect
 * stage. Outrun's (the default) also flags the contact, as before clients existed. Idempotent.
 */
export async function unsubscribeContact(
  deps: { db: Db; emit: Emit },
  contactId: string,
  via: "link" | "mailto" | "reply",
  clientId: string = OUTRUN_CLIENT_ID,
): Promise<boolean> {
  const [c] = await deps.db
    .select({ email: contacts.email })
    .from(contacts)
    .where(eq(contacts.id, contactId));
  if (!c) return false;
  const outrun = clientId === OUTRUN_CLIENT_ID;
  const added = await suppress(deps.db, c.email, "unsubscribe", outrun ? undefined : clientId);
  if (outrun) await deps.db.update(contacts).set({ suppressed: true }).where(eq(contacts.id, contactId));
  await deps.db
    .update(prospects)
    .set({ stage: "unsubscribed" })
    .where(and(eq(prospects.contactId, contactId), eq(prospects.clientId, clientId)));
  if (added) {
    await deps.emit({
      actor: "web",
      type: "email.unsubscribed",
      entityType: "contact",
      entityId: contactId,
      payload: { via, clientId },
    });
  }
  return true;
}
