/**
 * SH-6: one-click unsubscribe. The token is the contact id plus an HMAC, keyed from
 * CREW_TOKEN_SECRET, so a link can't be forged for someone else's address.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { contacts, prospects } from "../db/schema";
import { AppError } from "../errors";
import type { Emit } from "../events";
import { suppress } from "./rules";

const keyFrom = (secret: string) => createHmac("sha256", secret).update("outrun-unsubscribe-v1").digest();
const mac = (secret: string, contactId: string) =>
  createHmac("sha256", keyFrom(secret)).update(contactId).digest().subarray(0, 16).toString("base64url");

export function unsubscribeToken(secret: string | undefined, contactId: string): string {
  if (!secret) throw new AppError("not_configured", "CREW_TOKEN_SECRET is needed to sign unsubscribe links");
  return `${Buffer.from(contactId).toString("base64url")}.${mac(secret, contactId)}`;
}

export function readUnsubscribeToken(secret: string | undefined, token: string): string | null {
  if (!secret) return null;
  const [id64, sig] = token.split(".");
  if (!id64 || !sig) return null;
  const contactId = Buffer.from(id64, "base64url").toString("utf8");
  if (!/^[0-9a-f-]{36}$/.test(contactId)) return null;
  const want = Buffer.from(mac(secret, contactId));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? contactId : null;
}

/** The List-Unsubscribe header value: the one-click URL (RFC 8058) and a mailto fallback. */
export function listUnsubscribe(appUrl: string, token: string, inbox: string | undefined): string {
  const url = `<${appUrl}/api/unsubscribe/${token}>`;
  return inbox ? `${url}, <mailto:${inbox}?subject=unsubscribe>` : url;
}

/** The line appended to every outreach body. */
export const unsubscribeLine = (appUrl: string, token: string): string =>
  `\n\n--\nNot interested? Unsubscribe in one click: ${appUrl}/u/${token}`;

/** Unsubscribes a contact: suppression, the contact flag and the prospect's stage. Idempotent. */
export async function unsubscribeContact(
  deps: { db: Db; emit: Emit },
  contactId: string,
  via: "link" | "mailto" | "reply",
): Promise<boolean> {
  const [c] = await deps.db
    .select({ email: contacts.email })
    .from(contacts)
    .where(eq(contacts.id, contactId));
  if (!c) return false;
  const added = await suppress(deps.db, c.email, "unsubscribe");
  await deps.db.update(contacts).set({ suppressed: true }).where(eq(contacts.id, contactId));
  await deps.db.update(prospects).set({ stage: "unsubscribed" }).where(eq(prospects.contactId, contactId));
  if (added) {
    await deps.emit({
      actor: "web",
      type: "email.unsubscribed",
      entityType: "contact",
      entityId: contactId,
      payload: { via },
    });
  }
  return true;
}
