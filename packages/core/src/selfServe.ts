/**
 * Self-serve agency trials: a company hires the agency from /hire, or an outside agent calls
 * hire_agency over MCP or A2A. No payment and no person on our side to add it:
 *
 *   hireAgency → addClient (actor web) → provision_client_crew (its six agents on Naive)
 *              → its researcher drafts the profile → the OWNER confirms it on /dashboard/clients
 *
 * The approver gets a portal sign-in link straight away. Nothing is ever sent for the client
 * before the owner confirms its profile, and every email still waits for the approver.
 */
import { randomUUID } from "node:crypto";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { Domain, Email, slugify, type ClientStatus, type JobType } from "../contracts";
import { addClient } from "./clients";
import { OUTRUN_CLIENT_ID, SELF_SERVE_CALLER_LIMIT_PER_HOUR, SELF_SERVE_DAILY_CAP } from "./constants";
import type { Db } from "./db/client";
import { clients, events } from "./db/schema";
import { AppError } from "./errors";
import type { Emit } from "./events";
import type { SendTransactionalFn } from "./integrations/types";
import { requestPortalLink } from "./portal";

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

export const HireInput = z.object({
  companyName: z.string().trim().min(1).max(80),
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

  // A known domain returns the client as it is: no new approver, no new crew, no email.
  const existing = await byDomain(deps.db, input.domain);
  if (existing) return { ...existing, created: false, portalUrl };

  const since = (ms: number) => new Date(now.getTime() - ms);
  const [today] = await deps.db
    .select({ n: count() })
    .from(events)
    .where(and(eq(events.type, "client.signed_up"), gte(events.ts, since(86_400_000))));
  if (Number(today?.n ?? 0) >= SELF_SERVE_DAILY_CAP)
    throw new AppError(
      "rate_limited",
      "the agency has taken all the new clients it can today; try tomorrow",
      {
        retryAfterSeconds: 86_400,
      },
    );
  const [mine] = await deps.db
    .select({ n: count() })
    .from(events)
    .where(
      and(
        eq(events.type, "client.signed_up"),
        gte(events.ts, since(3_600_000)),
        sql`${events.payload}->>'caller' = ${via.caller}`,
      ),
    );
  if (Number(mine?.n ?? 0) >= SELF_SERVE_CALLER_LIMIT_PER_HOUR)
    throw new AppError("rate_limited", "one new client per caller per hour; try again later", {
      retryAfterSeconds: 3600,
    });

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
  await deps.enqueue({
    type: "provision_client_crew",
    payload: { clientId: c.id },
    idempotencyKey: `provision:${c.id}`,
    traceId: randomUUID(),
  });
  await requestPortalLink(
    {
      db: deps.db,
      sendTransactional: deps.sendTransactional,
      appUrl: deps.appUrl,
      secret: deps.secret,
      ...(deps.now ? { now: deps.now } : {}),
    },
    input.approverEmail,
  ).catch(() => ({ sent: false })); // The approver can ask again at /portal.
  return { clientId: c.id, slug: c.slug, status: c.status, created: true, portalUrl };
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
