/**
 * SH-6: the rules every outreach send passes, in one place so the send tool, the send job,
 * pipeline_status and the alerts all agree.
 *
 *   effectiveSendCap  warmup: 10 a day on the first sending day, +5 a day after, up to OUTRUN_SEND_DAILY_CAP
 *   sendPause         paused when bounces pass BOUNCE_PAUSE_RATE of the last BOUNCE_WINDOW_SENDS sends,
 *                     or on any complaint since the last `email.resumed` (pnpm email:resume)
 *   isSuppressed      the address or its domain is on the suppression list
 *
 * Each client of the agency sends from its own domain, so warm-up, caps and the pause are per
 * client (Outrun's by default). Suppressions: an unsubscribe is from one client; a hard bounce,
 * a complaint or a manual entry (client_id null) is about the address and applies to everyone.
 */
import { and, asc, count, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import {
  OUTRUN_CLIENT_ID,
  BOUNCE_PAUSE_RATE,
  BOUNCE_WINDOW_SENDS,
  CRON_TZ,
  SEND_WARMUP_START_PER_DAY,
  SEND_WARMUP_STEP_PER_DAY,
} from "../constants";
import type { Db } from "../db/client";
import { events, messages, suppressions } from "../db/schema";
import { startOfDayIn } from "../time";

const OUTREACH = ["first", "followup", "reply"] as const;

export async function effectiveSendCap(
  db: Db,
  cap: number,
  now: Date,
  clientId: string = OUTRUN_CLIENT_ID,
): Promise<number> {
  const [first] = await db
    .select({ at: messages.sentAt })
    .from(messages)
    .where(
      and(
        eq(messages.clientId, clientId),
        eq(messages.direction, "outbound"),
        inArray(messages.kind, OUTREACH),
        sql`${messages.sentAt} is not null`,
      ),
    )
    .orderBy(asc(messages.sentAt))
    .limit(1);
  if (!first?.at) return Math.min(cap, SEND_WARMUP_START_PER_DAY);
  const days = Math.max(
    0,
    Math.floor(
      (startOfDayIn(CRON_TZ, now).getTime() - startOfDayIn(CRON_TZ, first.at).getTime()) / 86_400_000,
    ),
  );
  return Math.min(cap, SEND_WARMUP_START_PER_DAY + SEND_WARMUP_STEP_PER_DAY * days);
}

/** Outreach sent today (in CRON_TZ), plus what's approved or sending and about to go. */
export async function sentToday(db: Db, now: Date, clientId: string = OUTRUN_CLIENT_ID): Promise<number> {
  const since = startOfDayIn(CRON_TZ, now);
  const [r] = await db
    .select({ n: count() })
    .from(messages)
    .where(
      and(
        eq(messages.clientId, clientId),
        eq(messages.direction, "outbound"),
        inArray(messages.kind, OUTREACH),
        or(
          and(eq(messages.status, "sent"), gte(messages.sentAt, since)),
          inArray(messages.status, ["approved", "sending"]),
        ),
      ),
    );
  return Number(r?.n ?? 0);
}

export interface PauseState {
  paused: boolean;
  reason: "bounces" | "complaint" | null;
  bounceRate: number;
  window: number;
}

/**
 * One client's pause. Outrun's resume is any `email.resumed` event without a client (the ones
 * before clients existed); another client's is one whose entity is that client.
 */
export async function sendPause(db: Db, clientId: string = OUTRUN_CLIENT_ID): Promise<PauseState> {
  const outrun = clientId === OUTRUN_CLIENT_ID;
  const [resumed] = await db
    .select({ ts: events.ts })
    .from(events)
    .where(
      and(
        eq(events.type, "email.resumed"),
        outrun
          ? sql`${events.entityType} <> 'client'`
          : and(eq(events.entityType, "client"), eq(events.entityId, clientId)),
      ),
    )
    .orderBy(desc(events.ts))
    .limit(1);
  const since = resumed?.ts ?? new Date(0);

  const sent = await db
    .select({ to: messages.toEmail })
    .from(messages)
    .where(
      and(
        eq(messages.clientId, clientId),
        eq(messages.direction, "outbound"),
        eq(messages.status, "sent"),
        inArray(messages.kind, OUTREACH),
        gte(messages.sentAt, since),
      ),
    )
    .orderBy(desc(messages.sentAt))
    .limit(BOUNCE_WINDOW_SENDS);
  const to = sent.map((s) => s.to?.toLowerCase()).filter((v): v is string => !!v);
  // A complaint pauses the client whose email drew it; Outrun's also counts any complaint, as before.
  const [complaint] = await db
    .select({ n: count() })
    .from(suppressions)
    .where(
      and(
        eq(suppressions.reason, "complaint"),
        gte(suppressions.createdAt, since),
        ...(outrun ? [] : [to.length ? inArray(suppressions.value, to) : sql`false`]),
      ),
    );
  let rate = 0;
  if (to.length >= 10) {
    const [b] = await db
      .select({ n: count() })
      .from(suppressions)
      .where(and(inArray(suppressions.value, to), eq(suppressions.reason, "hard_bounce")));
    rate = Number(b?.n ?? 0) / to.length;
  }
  if (Number(complaint?.n ?? 0) > 0)
    return { paused: true, reason: "complaint", bounceRate: rate, window: to.length };
  if (rate > BOUNCE_PAUSE_RATE)
    return { paused: true, reason: "bounces", bounceRate: rate, window: to.length };
  return { paused: false, reason: null, bounceRate: rate, window: to.length };
}

/** Suppressed for everyone (client_id null), or for this client. */
export async function isSuppressed(
  db: Db,
  email: string,
  clientId: string = OUTRUN_CLIENT_ID,
): Promise<boolean> {
  const e = email.trim().toLowerCase();
  const domain = e.split("@")[1] ?? "";
  const [hit] = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(
      and(
        inArray(suppressions.value, domain ? [e, domain] : [e]),
        or(sql`${suppressions.clientId} is null`, eq(suppressions.clientId, clientId)),
      ),
    )
    .limit(1);
  return !!hit;
}

/**
 * Adds an address to the suppression list (idempotent). Reasons: unsubscribe, hard_bounce,
 * complaint, manual. With `clientId` it applies to that client only (unsubscribes).
 */
export async function suppress(db: Db, email: string, reason: string, clientId?: string): Promise<boolean> {
  const rows = await db
    .insert(suppressions)
    .values({ value: email.trim().toLowerCase(), kind: "email", reason, ...(clientId ? { clientId } : {}) })
    .onConflictDoNothing()
    .returning({ id: suppressions.id });
  return rows.length > 0;
}
