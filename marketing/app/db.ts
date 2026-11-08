/**
 * The studio's records in the app's own Postgres (`DATABASE_URL`, provided by Naive): the apps
 * Outrun markets for, their posts, the comments read off those posts, the suggestions made from
 * them, and the media produced. One pg.Client per request; a serverless instance holds no pool.
 */
import pg from "pg";

export type Db = pg.Client;

const SCHEMA = `
create table if not exists st_clients (
  id text primary key,
  name text not null,
  app_url text not null,
  host text not null unique,
  owner_email text,
  triage text,
  created_at timestamptz not null default now()
);
create table if not exists st_posts (
  id text primary key,
  client_id text not null references st_clients(id),
  platform text not null,
  content text,
  url text,
  status text not null,
  posted_at timestamptz,
  synced_at timestamptz not null default now()
);
create table if not exists st_comments (
  id text primary key,
  post_id text not null references st_posts(id),
  client_id text not null references st_clients(id),
  text text not null,
  posted_at timestamptz,
  fetched_at timestamptz not null default now(),
  insight_id integer
);
create table if not exists st_insights (
  id serial primary key,
  client_id text not null references st_clients(id),
  summary text not null,
  suggestions jsonb not null,
  comment_ids jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists st_test_inboxes (
  inbox_id text primary key,
  client_id text not null,
  created_at timestamptz not null default now()
);

create table if not exists st_media (
  file_id text primary key,
  client_id text not null references st_clients(id),
  kind text not null,
  title text not null,
  notes text,
  created_at timestamptz not null default now()
);
`;

let schemaReady = false;

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
    statement_timeout: 8_000,
  });
  await client.connect();
  if (!schemaReady) {
    await client.query(SCHEMA);
    schemaReady = true;
  }
  return client;
}

export interface Client {
  id: string;
  name: string;
  app_url: string;
  host: string;
  owner_email: string | null;
  triage: string | null;
  created_at: Date;
}

export const hostOf = (url: string): string => new URL(url).hostname.toLowerCase().replace(/^www\./, "");

export async function upsertClient(
  db: Db,
  c: { appUrl: string; name?: string; ownerEmail?: string },
): Promise<Client> {
  const host = hostOf(c.appUrl);
  const { rows } = await db.query<Client>(
    `insert into st_clients (id, name, app_url, host, owner_email)
     values ($1, $2, $3, $4, $5)
     on conflict (host) do update set
       name = coalesce(nullif($2, ''), st_clients.name),
       app_url = $3,
       owner_email = coalesce($5, st_clients.owner_email)
     returning *`,
    [`cl_${host}`, c.name ?? host, c.appUrl, host, c.ownerEmail ?? null],
  );
  return rows[0] as Client;
}

export async function listClients(db: Db): Promise<(Client & Record<string, number>)[]> {
  const { rows } = await db.query<Client & Record<string, number>>(
    `select c.*,
            (select count(*)::int from st_posts p where p.client_id = c.id) as posts,
            (select count(*)::int from st_comments m where m.client_id = c.id) as comments,
            (select count(*)::int from st_comments m where m.client_id = c.id and m.insight_id is null) as unread,
            (select count(*)::int from st_insights i where i.client_id = c.id) as insights,
            (select count(*)::int from st_media f where f.client_id = c.id) as media
       from st_clients c order by c.created_at`,
  );
  return rows;
}

export async function findClient(db: Db, ref: string): Promise<Client | null> {
  const { rows } = await db.query<Client>(
    "select * from st_clients where id = $1 or host = $1 or app_url = $1",
    [ref],
  );
  return rows[0] ?? null;
}

export async function saveTriage(db: Db, clientId: string, triage: string): Promise<void> {
  await db.query("update st_clients set triage = $2 where id = $1", [clientId, triage]);
}

export async function upsertPost(
  db: Db,
  p: {
    id: string;
    clientId: string;
    platform: string;
    content: string | null;
    url: string | null;
    status: string;
    postedAt: string | null;
  },
): Promise<void> {
  await db.query(
    `insert into st_posts (id, client_id, platform, content, url, status, posted_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (id) do update set status = $6, url = coalesce($5, st_posts.url), posted_at = coalesce($7, st_posts.posted_at), synced_at = now()`,
    [p.id, p.clientId, p.platform, p.content, p.url, p.status, p.postedAt],
  );
}

export async function postsFor(db: Db, clientId: string): Promise<Record<string, unknown>[]> {
  return (
    await db.query("select * from st_posts where client_id = $1 order by posted_at desc nulls last", [
      clientId,
    ])
  ).rows;
}

export async function insertComment(
  db: Db,
  c: { id: string; postId: string; clientId: string; text: string; postedAt: string | null },
): Promise<boolean> {
  const r = await db.query(
    `insert into st_comments (id, post_id, client_id, text, posted_at) values ($1, $2, $3, $4, $5)
     on conflict (id) do nothing`,
    [c.id, c.postId, c.clientId, c.text, c.postedAt],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function commentsFor(
  db: Db,
  clientId: string,
  onlyUnread = false,
): Promise<Record<string, unknown>[]> {
  return (
    await db.query(
      `select id, post_id, text, posted_at, insight_id from st_comments
        where client_id = $1 ${onlyUnread ? "and insight_id is null" : ""}
        order by posted_at desc nulls last limit 200`,
      [clientId],
    )
  ).rows;
}

export interface Suggestion {
  title: string;
  why: string;
  change: string;
  evidence: string[];
}

export async function saveInsight(
  db: Db,
  i: { clientId: string; summary: string; suggestions: Suggestion[]; commentIds: string[] },
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `insert into st_insights (client_id, summary, suggestions, comment_ids) values ($1, $2, $3, $4) returning id`,
    [i.clientId, i.summary, JSON.stringify(i.suggestions), JSON.stringify(i.commentIds)],
  );
  const id = rows[0]?.id ?? 0;
  if (i.commentIds.length > 0) {
    await db.query("update st_comments set insight_id = $1 where client_id = $2 and id = any($3)", [
      id,
      i.clientId,
      i.commentIds,
    ]);
  }
  return id;
}

export async function insightsFor(db: Db, clientId: string): Promise<Record<string, unknown>[]> {
  return (
    await db.query("select * from st_insights where client_id = $1 order by created_at desc", [clientId])
  ).rows;
}

export async function recordMedia(
  db: Db,
  m: { fileId: string; clientId: string; kind: string; title: string; notes: string | null },
): Promise<void> {
  await db.query(
    `insert into st_media (file_id, client_id, kind, title, notes) values ($1, $2, $3, $4, $5)
     on conflict (file_id) do update set kind = $3, title = $4, notes = $5`,
    [m.fileId, m.clientId, m.kind, m.title, m.notes],
  );
}

export async function mediaFor(db: Db, clientId: string): Promise<Record<string, unknown>[]> {
  return (await db.query("select * from st_media where client_id = $1 order by created_at desc", [clientId]))
    .rows;
}

export async function addTestInbox(db: Db, inboxId: string, clientId: string): Promise<void> {
  await db.query("insert into st_test_inboxes (inbox_id, client_id) values ($1, $2) on conflict do nothing", [
    inboxId,
    clientId,
  ]);
}

export async function testInboxFor(db: Db, clientId: string): Promise<string | null> {
  const r = await db.query(
    "select inbox_id from st_test_inboxes where client_id = $1 order by created_at desc limit 1",
    [clientId],
  );
  return (r.rows[0]?.["inbox_id"] as string | undefined) ?? null;
}
