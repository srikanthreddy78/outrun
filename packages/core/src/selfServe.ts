/**
 * Self-serve agency trials: a company hires the agency from /hire, or an outside agent calls
 * hire_agency over MCP or A2A. No payment and no person on our side to add it:
 *
 *   hireAgency → addClient (actor web) → the approver signs in from the emailed link
 *              → provision_client_crew (its six agents on Naive) → its researcher drafts the
 *              profile → the OWNER confirms it on /dashboard/clients
 *
 * The approver gets a portal sign-in link straight away. Nothing is ever sent for the client
 * before the owner confirms its profile, and every email still waits for the approver.
 */
import { randomUUID } from "node:crypto";
import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { Domain, Email, slugify, type ClientStatus, type JobType } from "../contracts";
import { addClient } from "./clients";
import { OUTRUN_CLIENT_ID, SELF_SERVE_CALLER_LIMIT_PER_HOUR, SELF_SERVE_DAILY_CAP } from "./constants";
import type { Db } from "./db/client";
import { clientUsers, clients, events } from "./db/schema";
import { AppError } from "./errors";
import type { Emit } from "./events";
import type { SendTransactionalFn } from "./integrations/types";
import { portalClients, requestPortalLink } from "./portal";

export interface SelfServeDeps {
  db: Db;
  emit: Emit;
  enqueue: (job: {
    type: JobType;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    traceId: string;
  }) => Promise<unknown>;
  sendTransactional: SendTransactionalFn;
  appUrl: string;
  /** CREW_TOKEN_SECRET, for the portal link. */
  secret: string | undefined;
  now?: () => Date;
}

/** Mail and hosting domains many people share: an inbox there proves nothing about a company. */
const SHARED_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "yandex.com",
  "zoho.com",
  "fastmail.com",
  "hey.com",
  "tutanota.com",
  "qq.com",
  "163.com",
]);
const SHARED_HOSTS = [
  "vercel.app",
  "netlify.app",
  "github.io",
  "herokuapp.com",
  "pages.dev",
  "web.app",
  "firebaseapp.com",
  "onrender.com",
  "fly.dev",
  "workers.dev",
  "glitch.me",
  "replit.app",
];
export const isSharedDomain = (domain: string) =>
  SHARED_DOMAINS.has(domain) || SHARED_HOSTS.some((h) => domain === h || domain.endsWith(`.${h}`));

export const HireInput = z.object({
  // Plain names only: this text reaches the crew's system prompts and the owner's dashboard.
  companyName: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[\p{L}\p{N} .,&'()+-]+$/u, "letters, numbers and simple punctuation only"),
  domain: Domain,
  approverEmail: Email,
});
export type HireInput = z.infer<typeof HireInput>;

export interface HireVia {
  /** Where the signup came from; the ledger actor is always `web` (code, not a person). */
  channel: "web" | "mcp" | "a2a";
  /** The hashed caller (IP), for the per-caller limit. */
  caller: string;
}

export interface HireResult {
  clientId: string;
  slug: string;
  status: ClientStatus;
  created: boolean;
  portalUrl: string;
}

const ownDomain = (email: string, domain: string) => {
  const host = email.split("@")[1] ?? "";
  return host === domain || host.endsWith(`.${domain}`);
};

/** Validates, dedupes on the domain, applies the caps, adds the client and starts its crew. */
export async function hireAgency(deps: SelfServeDeps, raw: unknown, via: HireVia): Promise<HireResult> {
  const parsed = HireInput.safeParse(raw);
  if (!parsed.success)
    throw new AppError(
      "bad_request",
      parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "),
    );
  const input = parsed.data;
  const now = deps.now?.() ?? new Date();
  const portalUrl = `${deps.appUrl.replace(/\/$/, "")}/portal`;
  const ours = new URL(deps.appUrl).hostname.replace(/^www\./, "");
  if (input.domain === ours || input.domain.endsWith(`.${ours}`))
    throw new AppError("bad_request", "that's Outrun's own domain");
  if (!ownDomain(input.approverEmail, input.domain))
    throw new AppError("bad_request", `the approver's email must be at ${input.domain}`);
  if (isSharedDomain(input.domain))
    throw new AppError("bad_request", "use your company's own domain, not a shared mail or hosting one");

  const since = (ms: number) => new Date(now.getTime() - ms);
  const existing = await byDomain(deps.db, input.domain);
  if (existing) {
    // A self-serve signup nobody has verified yet doesn't own the domain: another approver at
    // that domain may claim it, and whoever signs in first starts the crew.
    if (await unverifiedSignup(deps.db, existing.clientId)) {
      const [known] = await deps.db
        .select({ id: clientUsers.id })
        .from(clientUsers)
        .where(and(eq(clientUsers.clientId, existing.clientId), eq(clientUsers.email, input.approverEmail)));
      if (!known) await callerLimit(deps.db, via.caller, since(3_600_000));
      const added = known
        ? []
        : await deps.db
            .insert(clientUsers)
            .values({ clientId: existing.clientId, email: input.approverEmail })
            .onConflictDoNothing()
            .returning({ id: clientUsers.id });
      if (added[0]) {
        await deps.emit({
          actor: "web",
          type: "client.claimed",
          entityType: "client",
          entityId: existing.clientId,
          payload: { via: via.channel, caller: via.caller },
        });
        await sendLink(deps, input.approverEmail);
      }
    }
    return { ...existing, created: false, portalUrl };
  }

  // Signups that were never verified stop counting after an hour, so junk can't fill the day.
  const [today] = await deps.db
    .select({ n: count() })
    .from(events)
    .where(
      and(
        eq(events.type, "client.signed_up"),
        gte(events.ts, since(86_400_000)),
        sql`(${events.ts} >= ${since(3_600_000).toISOString()} or exists (select 1 from events v
          where v.type = 'client.approver_verified' and v.entity_type = 'client' and v.entity_id = ${events.entityId}))`,
      ),
    );
  if (Number(today?.n ?? 0) >= SELF_SERVE_DAILY_CAP)
    throw new AppError(
      "rate_limited",
      "the agency has taken all the new clients it can today; try tomorrow",
      {
        retryAfterSeconds: 86_400,
      },
    );
  await callerLimit(deps.db, via.caller, since(3_600_000));

  const c = await add(deps, input);
  if (!c) {
    // Lost a race on the domain: the other signup created it.
    const again = await byDomain(deps.db, input.domain);
    if (!again) throw new AppError("conflict", `${input.domain} could not be added`);
    return { ...again, created: false, portalUrl };
  }
  await deps.emit({
    actor: "web",
    type: "client.signed_up",
    entityType: "client",
    entityId: c.id,
    payload: { slug: c.slug, via: via.channel, caller: via.caller },
  });
  // The crew starts only once the approver signs in from that email (startVerifiedCrews), so
  // a signup for a domain the caller doesn't control costs nothing and reaches no one else.
  await sendLink(deps, input.approverEmail);
  return { clientId: c.id, slug: c.slug, status: c.status, created: true, portalUrl };
}

/** The approver's sign-in link; they can ask again at /portal if it fails. */
async function sendLink(deps: SelfServeDeps, email: string) {
  await requestPortalLink(
    {
      db: deps.db,
      sendTransactional: deps.sendTransactional,
      appUrl: deps.appUrl,
      secret: deps.secret,
      ...(deps.now ? { now: deps.now } : {}),
    },
    email,
  ).catch(() => ({ sent: false }));
}

/** One new signup or claim per caller per hour. */
async function callerLimit(db: Db, caller: string, since: Date) {
  const [mine] = await db
    .select({ n: count() })
    .from(events)
    .where(
      and(
        inArray(events.type, ["client.signed_up", "client.claimed"]),
        gte(events.ts, since),
        sql`${events.payload}->>'caller' = ${caller}`,
      ),
    );
  if (Number(mine?.n ?? 0) >= SELF_SERVE_CALLER_LIMIT_PER_HOUR)
    throw new AppError("rate_limited", "one new client per caller per hour; try again later", {
      retryAfterSeconds: 3600,
    });
}

/** A self-serve client whose approver hasn't signed in yet. */
async function unverifiedSignup(db: Db, clientId: string): Promise<boolean> {
  const marks = await db
    .select({ type: events.type })
    .from(events)
    .where(
      and(
        eq(events.entityType, "client"),
        eq(events.entityId, clientId),
        inArray(events.type, ["client.signed_up", "client.approver_verified"]),
      ),
    );
  const types = new Set(marks.map((m) => m.type));
  return types.has("client.signed_up") && !types.has("client.approver_verified");
}

async function byDomain(db: Db, domain: string) {
  const [c] = await db
    .select({ clientId: clients.id, slug: clients.slug, status: clients.status })
    .from(clients)
    .where(eq(clients.domain, domain));
  return c && c.clientId !== OUTRUN_CLIENT_ID ? c : null;
}

/** addClient under the name's slug, or the domain's when the name's is taken; null if the domain is. */
async function add(deps: SelfServeDeps, input: HireInput) {
  const fromName = slugify(input.companyName);
  const fromDomain = slugify(input.domain.replace(/\./g, "-"));
  const slugs = [
    ...new Set([fromName, fromDomain, `${fromDomain.slice(0, 33)}-${randomUUID().slice(0, 6)}`]),
  ];
  for (const slug of slugs) {
    if (slug.length < 2 || slug === "outrun") continue;
    try {
      return await addClient(
        deps,
        { name: input.companyName, domain: input.domain, slug, approverEmails: [input.approverEmail] },
        "web",
      );
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== "conflict") throw err;
      if (err.message.includes("already a client")) return null;
    }
  }
  throw new AppError("conflict", "no free slug for that company name");
}

/**
 * Called when an approver signs in with an emailed link, which proves they read mail at the
 * client's domain. Each self-serve client of theirs whose crew hasn't started gets it now.
 * Idempotent: the job key and provisioning both skip what already exists.
 */
export async function startVerifiedCrews(
  deps: Pick<SelfServeDeps, "db" | "emit" | "enqueue">,
  email: string,
): Promise<string[]> {
  const started: string[] = [];
  for (const c of await portalClients(deps.db, email)) {
    const marks = await deps.db
      .select({ type: events.type })
      .from(events)
      .where(
        and(
          eq(events.entityType, "client"),
          eq(events.entityId, c.id),
          sql`${events.type} in ('client.signed_up', 'client.approver_verified')`,
        ),
      );
    const types = new Set(marks.map((m) => m.type));
    if (!types.has("client.signed_up") || types.has("client.approver_verified")) continue;
    // No more than the day's cap of new crews, however many signups verify.
    const [started24h] = await deps.db
      .select({ n: count() })
      .from(events)
      .where(
        and(eq(events.type, "client.approver_verified"), gte(events.ts, new Date(Date.now() - 86_400_000))),
      );
    if (Number(started24h?.n ?? 0) >= SELF_SERVE_DAILY_CAP) continue;
    await deps.emit({
      actor: `client:${email.trim().toLowerCase()}`,
      type: "client.approver_verified",
      entityType: "client",
      entityId: c.id,
      payload: { slug: c.slug },
    });
    await deps.enqueue({
      type: "provision_client_crew",
      payload: { clientId: c.id },
      idempotencyKey: `provision:${c.id}`,
      traceId: randomUUID(),
    });
    started.push(c.id);
  }
  return started;
}
