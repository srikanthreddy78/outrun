/**
 * The studio's records in the app's own Postgres (`DATABASE_URL`, provided by Naive): the apps
 * Outrun markets for, their posts, the comments read off those posts, the suggestions made from
 * them, the media produced, and each client's video job with its reviews and event trail. One
 * pg.Client per request; a serverless instance holds no pool.
 */
import { randomUUID } from "node:crypto";
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
alter table st_insights add column if not exists sent_at timestamptz;
alter table st_insights add column if not exists sent_to text;
create table if not exists st_meta (
  key text primary key,
  value text not null
);
create table if not exists st_post_ledger (
  id serial primary key,
  client_id text not null references st_clients(id),
  platform text not null default 'x',
  text text not null,
  file_id text not null default '',
  status text not null default 'queued',
  url text,
  created_at timestamptz not null default now(),
  posted_at timestamptz,
  unique (client_id, platform, text, file_id)
);
alter table st_post_ledger add column if not exists title text not null default '';
alter table st_post_ledger add column if not exists subreddit text not null default '';
alter table st_post_ledger drop constraint if exists st_post_ledger_client_id_platform_text_file_id_key;
create unique index if not exists st_post_ledger_key on st_post_ledger (client_id, platform, text, file_id, subreddit);
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

alter table st_clients add column if not exists identity_id text;
create unique index if not exists st_clients_identity_id on st_clients (identity_id) where identity_id is not null;
create table if not exists st_video_jobs (
  client_id text primary key references st_clients(id),
  status text not null default 'queued',
  claim text,
  attempts integer not null default 0,
  revisions integer not null default 0,
  file_id text,
  notes text,
  claimed_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists st_reviews (
  file_id text primary key references st_media(file_id),
  client_id text not null references st_clients(id),
  verdict text not null check (verdict in ('approved', 'changes')),
  notes text not null,
  created_at timestamptz not null default now()
);
create table if not exists st_events (
  id bigserial primary key,
  client_id text not null references st_clients(id),
  kind text not null,
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists st_events_client on st_events (client_id, id desc);
with added as (
  insert into st_video_jobs (client_id) select id from st_clients on conflict do nothing returning client_id
)
insert into st_events (client_id, kind, detail) select client_id, 'job_queued', 'existing client' from added;
create table if not exists st_direct_posts (
  key text primary key,
  client_id text not null references st_clients(id),
  status text not null,
  tweet_id text,
  url text,
  claimed_at timestamptz not null default now(),
  replies_read_at timestamptz,
  created_at timestamptz not null default now()
);
`;

/** A review can ask for changes this many times over before a person has to step in. */
const MAX_REVISIONS = 2;
/** How many sessions may die holding one stage of a job before it's marked failed. */
const MAX_ATTEMPTS = 3;
const VIDEO_LEASE = "3 hours";
const REVIEW_LEASE = "1 hour";
/** An upload that dies leaves its claim this long; nothing has been posted, so it can run again. */
const DIRECT_UPLOAD_LEASE = "10 minutes";
/** A little under the listener's four hours, so its next run always finds the post due. */
const REPLY_READ_EVERY = "3 hours 30 minutes";
/** X's recent search only reaches back this far. */
const REPLY_WINDOW = "7 days";
const TRACKED_LIMIT = 20;

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
  identity_id: string | null;
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
            (select count(*)::int from st_media f where f.client_id = c.id) as media,
            (select j.status from st_video_jobs j where j.client_id = c.id) as video_job
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
  return (
    await db.query(
      `select m.*, r.verdict as review, r.notes as review_notes, r.created_at as reviewed_at
         from st_media m left join st_reviews r on r.file_id = m.file_id
        where m.client_id = $1 order by m.created_at desc`,
      [clientId],
    )
  ).rows;
}

export async function oneMedia(db: Db, fileId: string): Promise<{ client_id: string; kind: string } | null> {
  const { rows } = await db.query<{ client_id: string; kind: string }>(
    "select client_id, kind from st_media where file_id = $1",
    [fileId],
  );
  return rows[0] ?? null;
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

export async function latestInsight(db: Db, clientId: string): Promise<Record<string, unknown> | null> {
  const { rows } = await db.query(
    "select * from st_insights where client_id = $1 order by created_at desc, id desc limit 1",
    [clientId],
  );
  return rows[0] ?? null;
}

/** Marks an insight as sending; false when it already went, so a summary can't go out twice. */
export async function claimInsight(db: Db, insightId: number, to: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "update st_insights set sent_at = now(), sent_to = $2 where id = $1 and sent_at is null",
    [insightId, to],
  );
  return rowCount === 1;
}

export async function releaseInsight(db: Db, insightId: number): Promise<void> {
  await db.query("update st_insights set sent_at = null, sent_to = null where id = $1", [insightId]);
}

export async function getMeta(db: Db, key: string): Promise<string | null> {
  const { rows } = await db.query<{ value: string }>("select value from st_meta where key = $1", [key]);
  return rows[0]?.value ?? null;
}

export async function setMeta(db: Db, key: string, value: string): Promise<void> {
  await db.query(
    "insert into st_meta (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value",
    [key, value],
  );
}

export interface VideoJob {
  client_id: string;
  status: string;
  claim: string | null;
  attempts: number;
  revisions: number;
  file_id: string | null;
  notes: string | null;
  claimed_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
}

export interface ClaimedJob extends VideoJob {
  name: string;
  host: string;
  app_url: string;
  review_notes: string | null;
}

/** Queues the client's one video job; a client that already has one is left as it is. */
export async function enqueueVideoJob(db: Db, clientId: string): Promise<void> {
  await db.query(
    `with added as (
       insert into st_video_jobs (client_id) values ($1) on conflict do nothing returning client_id
     )
     insert into st_events (client_id, kind) select client_id, 'job_queued' from added`,
    [clientId],
  );
}

/** Fails jobs whose stage keeps being abandoned, so a broken job stops being picked up. */
async function failAbandoned(db: Db, stage: string, lease: string): Promise<void> {
  const why = `abandoned ${MAX_ATTEMPTS} times while ${stage}`;
  await db.query(
    `with gone as (
       update st_video_jobs set status = 'failed', notes = $3::text, finished_at = now(), updated_at = now()
        where status = $1::text and claimed_at < now() - $2::interval and attempts >= $4::int
        returning client_id
     )
     insert into st_events (client_id, kind, detail) select client_id, 'job_failed', $3::text from gone`,
    [stage, lease, why, MAX_ATTEMPTS],
  );
}

/**
 * Atomically moves the oldest ready job into `stage`. `skip locked` plus the one update means two
 * callers can never be handed the same job; a job whose lease ran out can be claimed again.
 */
async function claimNext(
  db: Db,
  o: { ready: string[]; stage: string; lease: string; event: string },
): Promise<ClaimedJob | null> {
  await failAbandoned(db, o.stage, o.lease);
  const { rows } = await db.query<ClaimedJob>(
    `with picked as (
       select client_id from st_video_jobs
        where status = any($1::text[])
           or (status = $2::text and claimed_at < now() - $3::interval and attempts < $4::int)
        order by updated_at, client_id
        limit 1
        for update skip locked
     ), taken as (
       update st_video_jobs j set
         revisions = j.revisions + (j.status = 'changes')::int,
         status = $2::text, claim = $5::text, claimed_at = now(), attempts = j.attempts + 1, updated_at = now()
         from picked where j.client_id = picked.client_id
       returning j.*
     ), logged as (
       insert into st_events (client_id, kind, detail)
       select client_id, $6::text, 'attempt ' || attempts from taken
     )
     select t.*, c.name, c.host, c.app_url, r.notes as review_notes
       from taken t
       join st_clients c on c.id = t.client_id
       left join lateral (
         select notes from st_reviews x where x.client_id = t.client_id order by x.created_at desc limit 1
       ) r on true`,
    [o.ready, o.stage, o.lease, MAX_ATTEMPTS, randomUUID(), o.event],
  );
  return rows[0] ?? null;
}

export const claimVideoJob = (db: Db): Promise<ClaimedJob | null> =>
  claimNext(db, {
    ready: ["queued", "changes"],
    stage: "claimed",
    lease: VIDEO_LEASE,
    event: "job_claimed",
  });

export const claimReviewJob = (db: Db): Promise<ClaimedJob | null> =>
  claimNext(db, { ready: ["review"], stage: "reviewing", lease: REVIEW_LEASE, event: "review_claimed" });

export async function videoJob(db: Db, clientId: string): Promise<VideoJob | null> {
  const { rows } = await db.query<VideoJob>("select * from st_video_jobs where client_id = $1", [clientId]);
  return rows[0] ?? null;
}

/** Closes the producer's claim: to review with a file, or to failed without one. Null if the claim isn't live. */
export async function finishVideoJob(
  db: Db,
  f: { clientId: string; claim: string; fileId: string | null; notes: string | null },
): Promise<string | null> {
  const { rows } = await db.query<{ status: string }>(
    `with done as (
       update st_video_jobs set
         status = case when $3::text is null then 'failed' else 'review' end,
         file_id = coalesce($3::text, file_id),
         notes = $4::text,
         finished_at = case when $3::text is null then now() end,
         attempts = 0, updated_at = now()
        where client_id = $1::text and status = 'claimed' and claim = $2::text
        returning client_id, status
     ), logged as (
       insert into st_events (client_id, kind, detail)
       select client_id, case when status = 'failed' then 'job_failed' else 'video_saved' end,
              coalesce($3::text, $4::text) from done
     )
     select status from done`,
    [f.clientId, f.claim, f.fileId, f.notes],
  );
  return rows[0]?.status ?? null;
}

export async function reviewFor(
  db: Db,
  fileId: string,
): Promise<{ client_id: string; verdict: string } | null> {
  const { rows } = await db.query<{ client_id: string; verdict: string }>(
    "select client_id, verdict from st_reviews where file_id = $1",
    [fileId],
  );
  return rows[0] ?? null;
}

/** Records the one verdict on a file under review and moves the job on. Null if it isn't under review. */
export async function saveReview(
  db: Db,
  r: { clientId: string; fileId: string; verdict: string; notes: string },
): Promise<string | null> {
  const { rows } = await db.query<{ status: string }>(
    `with done as (
       update st_video_jobs set
         status = case when $3::text = 'approved' then 'approved'
                       when revisions >= $5::int then 'needs_person' else 'changes' end,
         finished_at = case when $3::text = 'approved' or revisions >= $5::int then now() end,
         attempts = 0, updated_at = now()
        where client_id = $1::text and status = 'reviewing' and file_id = $2::text
        returning client_id, status
     ), saved as (
       insert into st_reviews (file_id, client_id, verdict, notes)
       select $2::text, client_id, $3::text, $4::text from done
     ), logged as (
       insert into st_events (client_id, kind, detail)
       select client_id, case status when 'approved' then 'review_approved'
                                     when 'changes' then 'review_changes' else 'needs_person' end,
              $2::text from done
     )
     select status from done`,
    [r.clientId, r.fileId, r.verdict, r.notes, MAX_REVISIONS],
  );
  return rows[0]?.status ?? null;
}

/** Binds the client to its identity. Unique per client: throws pg's 23505 if another client holds it. */
export async function setClientIdentity(db: Db, clientId: string, identityId: string): Promise<void> {
  await db.query(
    `with changed as (update st_clients set identity_id = $2::text where id = $1::text returning id)
     insert into st_events (client_id, kind, detail) select id, 'identity_set', $2::text from changed`,
    [clientId, identityId],
  );
}

export async function eventsFor(db: Db, clientId: string): Promise<Record<string, unknown>[]> {
  return (
    await db.query(
      "select kind, detail, created_at from st_events where client_id = $1 order by id desc limit 50",
      [clientId],
    )
  ).rows;
}

/** Registers a live tweet Naive didn't post. Null when another app already has it. */
export async function trackPost(
  db: Db,
  t: { id: string; clientId: string; url: string; content: string | null },
): Promise<{ created: boolean } | null> {
  const { rows } = await db.query<{ created: boolean }>(
    `with tracked as (
       insert into st_posts (id, client_id, platform, content, url, status)
       values ($1::text, $2::text, 'x', $3::text, $4::text, 'posted')
       on conflict (id) do update set content = coalesce(excluded.content, st_posts.content)
         where st_posts.client_id = excluded.client_id
       returning (xmax = 0) as created
     ), logged as (
       insert into st_events (client_id, kind, detail)
       select $2::text, 'post_tracked', $4::text from tracked where created
     )
     select created from tracked`,
    [t.id, t.clientId, t.content, t.url],
  );
  return rows[0] ?? null;
}

export async function postById(db: Db, id: string): Promise<{ id: string; client_id: string } | null> {
  const { rows } = await db.query<{ id: string; client_id: string }>(
    "select id, client_id from st_posts where id = $1",
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Live X posts with no Naive post behind them, newest first. Direct posts the studio reads itself
 * with its X keys are left out, so nobody pays to read the same replies twice.
 */
export async function trackedPosts(db: Db, readsDirectPosts: boolean): Promise<Record<string, unknown>[]> {
  return (
    await db.query(
      `select p.id, substr(p.id, 3) as tweet_id, p.url, p.client_id as client, c.name
         from st_posts p join st_clients c on c.id = p.client_id
        where p.platform = 'x' and p.status = 'posted' and p.id like 'x\\_%'
          and not ($1::boolean and exists (select 1 from st_direct_posts d where d.tweet_id = substr(p.id, 3)))
          and not exists (
            select 1 from st_posts n
             where n.id not like 'x\\_%' and substring(n.url from '/status/([0-9]+)') = substr(p.id, 3)
          )
        order by p.synced_at desc, p.id
        limit $2::int`,
      [readsDirectPosts, TRACKED_LIMIT],
    )
  ).rows;
}

export interface DirectPost {
  key: string;
  client_id: string;
  status: string;
  tweet_id: string | null;
  url: string | null;
}

/** True if this call may post. False while another call holds it or it has already gone out. */
export async function claimDirectPost(db: Db, key: string, clientId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `insert into st_direct_posts (key, client_id, status) values ($1, $2, 'uploading')
     on conflict (key) do update set status = 'uploading', claimed_at = now()
       where st_direct_posts.status = 'failed'
          or (st_direct_posts.status = 'uploading' and st_direct_posts.claimed_at < now() - $3::interval)`,
    [key, clientId, DIRECT_UPLOAD_LEASE],
  );
  return rowCount === 1;
}

export async function directPost(db: Db, key: string): Promise<DirectPost | null> {
  const { rows } = await db.query<DirectPost>("select * from st_direct_posts where key = $1", [key]);
  return rows[0] ?? null;
}

/** Set just before the tweet request: from here on, the post may exist even if we never hear back. */
export async function markDirectSending(db: Db, key: string): Promise<void> {
  await db.query("update st_direct_posts set status = 'sending' where key = $1", [key]);
}

export async function logEvent(db: Db, clientId: string, kind: string, detail: string): Promise<void> {
  await db.query("insert into st_events (client_id, kind, detail) values ($1, $2, $3)", [
    clientId,
    kind,
    detail,
  ]);
}

/** X definitely has no such post, so the same call may be tried again. */
export async function failDirectPost(db: Db, key: string, clientId: string, why: string): Promise<void> {
  await db.query("update st_direct_posts set status = 'failed' where key = $1", [key]);
  await logEvent(db, clientId, "direct_failed", why.slice(0, 500));
}

export async function recordDirectPost(
  db: Db,
  p: { key: string; tweetId: string; url: string; text: string },
): Promise<void> {
  await db.query(
    `with done as (
       update st_direct_posts set status = 'posted', tweet_id = $2::text, url = $3::text
        where key = $1::text returning client_id
     ), post as (
       insert into st_posts (id, client_id, platform, content, url, status, posted_at)
       select 'x_' || $2::text, client_id, 'x', $4::text, $3::text, 'posted', now() from done
       on conflict (id) do update set status = 'posted', url = excluded.url
     )
     insert into st_events (client_id, kind, detail) select client_id, 'direct_posted', $3::text from done`,
    [p.key, p.tweetId, p.url, p.text],
  );
}

/** Direct posts whose replies are due another read. */
export async function directPostsDue(
  db: Db,
): Promise<{ key: string; client_id: string; tweet_id: string }[]> {
  const { rows } = await db.query<{ key: string; client_id: string; tweet_id: string }>(
    `select key, client_id, tweet_id from st_direct_posts
      where status = 'posted' and created_at > now() - $1::interval
        and (replies_read_at is null or replies_read_at < now() - $2::interval)`,
    [REPLY_WINDOW, REPLY_READ_EVERY],
  );
  return rows;
}

export async function markRepliesRead(db: Db, key: string): Promise<void> {
  await db.query("update st_direct_posts set replies_read_at = now() where key = $1", [key]);
}

/** Records a post to be made by hand. Queuing the same post again changes nothing. */
export async function queueLedgerPost(
  db: Db,
  e: { clientId: string; platform: string; text: string; fileId: string; title: string; subreddit: string },
): Promise<{ id: number; created: boolean }> {
  const { rows } = await db.query<{ id: number; created: boolean }>(
    `insert into st_post_ledger (client_id, platform, text, file_id, title, subreddit) values ($1, $2, $3, $4, $5, $6)
     on conflict (client_id, platform, text, file_id, subreddit) do update set title = excluded.title
     returning id, (xmax = 0) as created`,
    [e.clientId, e.platform, e.text, e.fileId, e.title, e.subreddit],
  );
  const row = rows[0];
  if (!row) throw new Error("the ledger did not return a row");
  return row;
}

export async function ledgerPosts(
  db: Db,
  filter: { clientId?: string; status?: string } = {},
): Promise<Record<string, unknown>[]> {
  return (
    await db.query(
      `select l.*, c.name as app_name, c.host from st_post_ledger l join st_clients c on c.id = l.client_id
        where ($1::text is null or l.client_id = $1) and ($2::text is null or l.status = $2)
        order by l.id`,
      [filter.clientId ?? null, filter.status ?? null],
    )
  ).rows;
}

export async function ledgerEntry(
  db: Db,
  id: number,
): Promise<{ client_id: string; platform: string; text: string; status: string } | null> {
  const { rows } = await db.query<{ client_id: string; platform: string; text: string; status: string }>(
    "select client_id, platform, text, status from st_post_ledger where id = $1",
    [id],
  );
  return rows[0] ?? null;
}

export async function markLedgerPosted(db: Db, id: number, url: string): Promise<void> {
  await db.query(
    "update st_post_ledger set status = 'posted', url = $2, posted_at = now() where id = $1 and status = 'queued'",
    [id, url],
  );
}
