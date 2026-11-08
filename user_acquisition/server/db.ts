/**
 * The app database Naive provisions for a fullstack app (`DATABASE_URL`). One `pg.Client` per
 * request, never a pool: a serverless instance is frozen between requests, so a pooled
 * connection would leak a backend.
 */
import pg from "pg";

export type Db = pg.Client;

/** Tables from before the company was named Outrun are renamed in place, so their rows carry over. */
const SCHEMA = `
do $$
declare t text;
begin
  foreach t in array array['suppressions', 'unsubscribe_tokens', 'outbound', 'prospects', 'inbound'] loop
    if to_regclass('aga_' || t) is not null and to_regclass('outrun_' || t) is null then
      execute format('alter table %I rename to %I', 'aga_' || t, 'outrun_' || t);
    end if;
  end loop;
end $$;
create table if not exists outrun_suppressions (
  email text primary key,
  reason text not null,
  source text not null,
  note text,
  created_at timestamptz not null default now()
);
create table if not exists outrun_unsubscribe_tokens (
  token text primary key,
  email text not null unique,
  created_at timestamptz not null default now()
);
create table if not exists outrun_outbound (
  id text primary key,
  to_email text not null,
  subject text not null,
  prepared_at timestamptz not null default now()
);
create table if not exists outrun_prospects (
  domain text primary key,
  company text not null,
  found_via text not null,
  listing_url text,
  why_fit text not null,
  contact_email text not null,
  contact_name text,
  contact_role text,
  email_source_url text not null,
  mx_host text not null,
  verified_at timestamptz not null default now()
);
alter table outrun_prospects add column if not exists enrichment jsonb;
alter table outrun_prospects add column if not exists fit_score integer;
alter table outrun_prospects add column if not exists fit_band text;
alter table outrun_prospects add column if not exists fit_parts jsonb;
alter table outrun_prospects add column if not exists crm_contact_id text;
alter table outrun_prospects add column if not exists crm_fit_score integer;
alter table outrun_prospects add column if not exists crm_synced_at timestamptz;
create table if not exists outrun_inbound (
  message_id text primary key,
  from_email text,
  kind text not null,
  summary text,
  handled_at timestamptz not null default now()
);
`;

let schemaReady = false;

/**
 * The platform hands `...?sslmode=require`, which libpq reads as "encrypt, don't verify the chain";
 * node-postgres only reads it that way when asked to.
 */
function libpqCompat(url: string): string {
  const parsed = new URL(url);
  if (parsed.searchParams.has("sslmode")) parsed.searchParams.set("uselibpqcompat", "true");
  return parsed.toString();
}

export async function openDb(): Promise<Db> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is unset: the app database is not provisioned yet");
  const client = new pg.Client({
    connectionString: libpqCompat(url),
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
  });
  await client.connect();
  if (!schemaReady) {
    await client.query(SCHEMA);
    schemaReady = true;
  }
  return client;
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export interface Suppression {
  email: string;
  reason: string;
  source: string;
  createdAt: string;
}

export async function findSuppression(db: Db, email: string): Promise<Suppression | null> {
  const { rows } = await db.query<{ email: string; reason: string; source: string; created_at: Date }>(
    "select email, reason, source, created_at from outrun_suppressions where email = $1",
    [normalizeEmail(email)],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : { email: row.email, reason: row.reason, source: row.source, createdAt: row.created_at.toISOString() };
}

/** Idempotent: the first reason recorded for an address is the one kept. */
export async function addSuppression(
  db: Db,
  entry: { email: string; reason: string; source: string; note?: string },
): Promise<{ created: boolean }> {
  const result = await db.query(
    `insert into outrun_suppressions (email, reason, source, note) values ($1, $2, $3, $4)
     on conflict (email) do nothing`,
    [normalizeEmail(entry.email), entry.reason, entry.source, entry.note ?? null],
  );
  return { created: (result.rowCount ?? 0) > 0 };
}

export async function saveUnsubscribeToken(db: Db, token: string, email: string): Promise<void> {
  await db.query(
    "insert into outrun_unsubscribe_tokens (token, email) values ($1, $2) on conflict (email) do nothing",
    [token, normalizeEmail(email)],
  );
}

export async function emailForToken(db: Db, token: string): Promise<string | null> {
  const { rows } = await db.query<{ email: string }>(
    "select email from outrun_unsubscribe_tokens where token = $1",
    [token],
  );
  return rows[0]?.email ?? null;
}

export interface Prospect {
  domain: string;
  company: string;
  foundVia: string;
  listingUrl: string | null;
  whyFit: string;
  contactEmail: string;
  contactName: string | null;
  contactRole: string | null;
  emailSourceUrl: string;
  mxHost: string;
}

/** One row per company domain; a second save of the same domain keeps the first. */
export async function saveProspect(db: Db, p: Prospect): Promise<{ created: boolean }> {
  const result = await db.query(
    `insert into outrun_prospects
       (domain, company, found_via, listing_url, why_fit, contact_email, contact_name, contact_role, email_source_url, mx_host)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (domain) do nothing`,
    [
      p.domain,
      p.company,
      p.foundVia,
      p.listingUrl,
      p.whyFit,
      normalizeEmail(p.contactEmail),
      p.contactName,
      p.contactRole,
      p.emailSourceUrl,
      p.mxHost,
    ],
  );
  return { created: (result.rowCount ?? 0) > 0 };
}

export async function listProspects(
  db: Db,
): Promise<{ domain: string; company: string; contact_email: string }[]> {
  const { rows } = await db.query<{ domain: string; company: string; contact_email: string }>(
    "select domain, company, contact_email from outrun_prospects order by verified_at",
  );
  return rows;
}

/** Every email the crew prepared for sending, keyed by a hash of recipient, subject and final body. */
export async function recordPrepared(
  db: Db,
  prepared: { id: string; to: string; subject: string },
): Promise<void> {
  await db.query(
    "insert into outrun_outbound (id, to_email, subject) values ($1, $2, $3) on conflict (id) do nothing",
    [prepared.id, normalizeEmail(prepared.to), prepared.subject],
  );
}

/** Returns false when this message was already handled, so the wake and the sweep never double-act. */
export async function recordInbound(
  db: Db,
  inbound: { messageId: string; from: string | null; kind: string; summary: string | null },
): Promise<{ firstTime: boolean }> {
  const result = await db.query(
    `insert into outrun_inbound (message_id, from_email, kind, summary) values ($1, $2, $3, $4)
     on conflict (message_id) do nothing`,
    [
      inbound.messageId,
      inbound.from === null ? null : normalizeEmail(inbound.from),
      inbound.kind,
      inbound.summary,
    ],
  );
  return { firstTime: (result.rowCount ?? 0) > 0 };
}
