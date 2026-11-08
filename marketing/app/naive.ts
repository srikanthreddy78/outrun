/**
 * The Naive reads the studio makes, with the read-only key Naive mints for this app
 * (agents:read, sessions:read, files:read): the X posts made as the Outrun identity, and their
 * comments. The studio never posts, sends or deletes anything on Naive.
 */
import { hostOf, insertComment, listClients, upsertPost, type Db } from "./db.ts";

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
 * Pulls the identity's posts, files each under the client whose app URL it mentions, then reads
 * the comments on each X post. Safe to run any number of times.
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
  return { posts, newComments, unmatched, commentErrors };
}

/** File names for the media rows, for the dashboard. */
export async function fileNames(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const page = await get<{ data: { id: string; name?: string; filename?: string }[] }>(
    `/v1/files?ids=${encodeURIComponent(ids.join(","))}&limit=100`,
  ).catch(() => ({ data: [] as { id: string; name?: string; filename?: string }[] }));
  return Object.fromEntries(page.data.map((f) => [f.id, f.name ?? f.filename ?? f.id]));
}
