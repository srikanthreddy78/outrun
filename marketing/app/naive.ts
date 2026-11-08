/**
 * The Naive reads the studio makes, with the read-only key Naive mints for this app
 * (agents:read, sessions:read, files:read): the X posts made as the Outrun identity, and their
 * comments. The studio never posts, sends or deletes anything on Naive.
 */
import {
  directPostsDue,
  hostOf,
  insertComment,
  listClients,
  markRepliesRead,
  upsertPost,
  type Db,
} from "./db.ts";
import { searchReplies, xKeys } from "./x.ts";

const BASE = (process.env["NAIVE_API_URL"] ?? "https://api.vetta.sh").replace(/\/+$/, "");

async function get<T>(path: string): Promise<T> {
  const key = process.env["NAIVE_API_KEY"];
  if (!key) throw new Error("NAIVE_API_KEY is not set on the app");
  const r = await fetch(`${BASE}${path}`, {
    headers: { authorization: `Bearer ${key}`, "vetta-version": "2026-09-30", accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) throw new Error(`Naive ${path.split("?")[0]} answered ${r.status}`);
  return (await r.json()) as T;
}

interface NaivePost {
  id: string;
  status: string;
  content: string | null;
  platforms: string[];
  url: string | null;
  posted_at: string | null;
}

interface NaiveComment {
  id: string;
  posted_at: string | null;
  data: unknown;
}

/** The comment's words only; who wrote it (handle, name, avatar) is never kept. */
export function commentText(data: unknown): string | null {
  const record = data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
  for (const key of ["text", "content", "message", "body", "comment"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim().slice(0, 2000);
  }
  return typeof data === "string" && data.trim() !== "" ? data.trim().slice(0, 2000) : null;
}

/**
 * A reply's words for storing: no reply-to prefix, and any other handle in it masked, so a person's
 * handle never gets into the records. Null if nothing is left.
 */
export function replyText(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const words = (commentText(text) ?? "")
    .replace(/^(?:@\w{1,15}[\s,]*)+/, "")
    .replace(/(?<![\w@.])@\w{1,15}\b/g, "@user")
    .trim();
  return words === "" ? null : words;
}

/** Stores one reply under its post. True if it's new; the same reply is never stored twice. */
export async function storeReply(
  db: Db,
  r: { id: string; postId: string; clientId: string; text: unknown; postedAt: unknown },
): Promise<boolean | null> {
  const words = replyText(r.text);
  if (words === null) return null;
  const when = typeof r.postedAt === "string" ? new Date(r.postedAt) : null;
  return insertComment(db, {
    id: `x_${r.id}`,
    postId: r.postId,
    clientId: r.clientId,
    text: words,
    postedAt: when !== null && !Number.isNaN(when.getTime()) ? when.toISOString() : null,
  });
}

/** Reads replies on posts made directly with the X keys, skipping any read recently. */
async function syncDirectReplies(db: Db, errors: string[]): Promise<number> {
  const keys = xKeys();
  if (keys === null) return 0;
  let added = 0;
  for (const post of await directPostsDue(db)) {
    try {
      for (const reply of await searchReplies(keys, post.tweet_id)) {
        const isNew = await storeReply(db, {
          id: reply.id,
          postId: `x_${post.tweet_id}`,
          clientId: post.client_id,
          text: reply.text,
          postedAt: reply.created_at,
        });
        if (isNew === true) added += 1;
      }
      await markRepliesRead(db, post.key);
    } catch (error) {
      errors.push(`x_${post.tweet_id}: ${error instanceof Error ? error.message : "failed"}`);
    }
  }
  return added;
}

/**
 * Pulls the identity's posts, files each under the client whose app URL it mentions, then reads
 * the comments on each X post, and the replies on posts made directly. Safe to run any number of times.
 */
export async function syncX(
  db: Db,
): Promise<{ posts: number; newComments: number; unmatched: number; commentErrors: string[] }> {
  const identity = process.env["OUTRUN_IDENTITY_ID"];
  if (!identity) throw new Error("OUTRUN_IDENTITY_ID is not set on the app");
  const clients = await listClients(db);
  const page = await get<{ data: NaivePost[] }>(
    `/v1/posts?identity_id=${encodeURIComponent(identity)}&limit=100`,
  );
  let posts = 0;
  let newComments = 0;
  let unmatched = 0;
  const commentErrors: string[] = [];
  for (const post of page.data) {
    if (!post.platforms.includes("x")) continue;
    const text = (post.content ?? "").toLowerCase();
    const client = clients.find((c) => text.includes(c.host) || text.includes(hostOf(c.app_url)));
    if (!client) {
      unmatched += 1;
      continue;
    }
    await upsertPost(db, {
      id: post.id,
      clientId: client.id,
      platform: "x",
      content: post.content,
      url: post.url,
      status: post.status,
      postedAt: post.posted_at,
    });
    posts += 1;
    if (post.status !== "posted") continue;
    const comments = await get<{ data: NaiveComment[] }>(
      `/v1/identities/${encodeURIComponent(identity)}/social/posts/${encodeURIComponent(post.id)}/comments?limit=100`,
    ).catch((error: unknown) => {
      commentErrors.push(`${post.id}: ${error instanceof Error ? error.message : "failed"}`);
      return { data: [] as NaiveComment[] };
    });
    for (const comment of comments.data) {
      const words = commentText(comment.data);
      if (words === null) continue;
      if (
        await insertComment(db, {
          id: comment.id,
          postId: post.id,
          clientId: client.id,
          text: words,
          postedAt: comment.posted_at,
        })
      ) {
        newComments += 1;
      }
    }
  }
  newComments += await syncDirectReplies(db, commentErrors);
  return { posts, newComments, unmatched, commentErrors };
}

interface NaiveFile {
  content_type: string;
  size_bytes: number;
}

/** A published file's bytes and type, refused before downloading if `limit` says it's too large. */
export async function downloadFile(
  id: string,
  limit: (contentType: string) => number | null,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const path = `/v1/files/${encodeURIComponent(id)}`;
  const file = await get<NaiveFile>(path);
  const contentType = file.content_type.split(";")[0]?.trim().toLowerCase() ?? "";
  const max = limit(contentType);
  if (max === null) throw new Error(`X can't take a ${contentType} file`);
  if (file.size_bytes > max) throw new Error(`the file is ${file.size_bytes} bytes; X's limit is ${max}`);
  const r = await fetch(`${BASE}${path}?download=true`, {
    headers: { authorization: `Bearer ${process.env["NAIVE_API_KEY"] ?? ""}`, "vetta-version": "2026-09-30" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Naive ${path} answered ${r.status}`);
  return { bytes: new Uint8Array(await r.arrayBuffer()), contentType };
}

/** File names for the media rows, for the dashboard. */
export async function fileNames(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const page = await get<{ data: { id: string; name?: string; filename?: string }[] }>(
    `/v1/files?ids=${encodeURIComponent(ids.join(","))}&limit=100`,
  ).catch(() => ({ data: [] as { id: string; name?: string; filename?: string }[] }));
  return Object.fromEntries(page.data.map((f) => [f.id, f.name ?? f.filename ?? f.id]));
}
