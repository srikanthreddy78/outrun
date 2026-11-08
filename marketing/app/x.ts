/**
 * Direct posting to X with the studio's own keys, for when Naive's social posting is refused:
 * OAuth 1.0a user-context signing, the v2 chunked media upload, posts and reply search. JSON and
 * multipart bodies are not part of the OAuth 1.0a signature base, only the query string is.
 */
import { createHmac, randomBytes } from "node:crypto";

const API = "https://api.x.com";
const CHUNK_BYTES = 4 * 1024 * 1024;
const REQUEST_MS = 15_000;
/** The whole upload and processing wait, leaving time to post inside a 60-second function. */
const MEDIA_DEADLINE_MS = 45_000;

export interface XKeys {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

export function xKeys(): XKeys | null {
  const apiKey = process.env["X_API_KEY"];
  const apiSecret = process.env["X_API_SECRET"];
  const accessToken = process.env["X_ACCESS_TOKEN"];
  const accessSecret = process.env["X_ACCESS_TOKEN_SECRET"];
  if (!apiKey || !apiSecret || !accessToken || !accessSecret) return null;
  return { apiKey, apiSecret, accessToken, accessSecret };
}

/** A refusal X actually answered with, as opposed to a request that never got an answer. */
export class XError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const pct = (v: string): string =>
  encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function oauthSignature(
  method: string,
  baseUrl: string,
  params: [string, string][],
  consumerSecret: string,
  tokenSecret: string,
): string {
  const normalized = params
    .map(([k, v]) => [pct(k), pct(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : 1) : ak < bk ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = `${method.toUpperCase()}&${pct(baseUrl)}&${pct(normalized)}`;
  return createHmac("sha1", `${pct(consumerSecret)}&${pct(tokenSecret)}`)
    .update(base)
    .digest("base64");
}

function oauthHeader(keys: XKeys, method: string, baseUrl: string, query: [string, string][]): string {
  const oauth: [string, string][] = [
    ["oauth_consumer_key", keys.apiKey],
    ["oauth_nonce", randomBytes(16).toString("hex")],
    ["oauth_signature_method", "HMAC-SHA1"],
    ["oauth_timestamp", String(Math.floor(Date.now() / 1000))],
    ["oauth_token", keys.accessToken],
    ["oauth_version", "1.0"],
  ];
  const signature = oauthSignature(method, baseUrl, [...oauth, ...query], keys.apiSecret, keys.accessSecret);
  return `OAuth ${[...oauth, ["oauth_signature", signature]].map(([k, v]) => `${pct(k ?? "")}="${pct(v ?? "")}"`).join(", ")}`;
}

interface XRequest {
  query?: Record<string, string>;
  json?: unknown;
  form?: FormData;
}

async function request<T>(keys: XKeys, method: string, path: string, o: XRequest = {}): Promise<T> {
  const query = Object.entries(o.query ?? {});
  const base = `${API}${path}`;
  const qs = query.map(([k, v]) => `${pct(k)}=${pct(v)}`).join("&");
  const r = await fetch(qs === "" ? base : `${base}?${qs}`, {
    method,
    headers: {
      authorization: oauthHeader(keys, method, base, query),
      accept: "application/json",
      ...(o.json === undefined ? {} : { "content-type": "application/json" }),
    },
    body: o.json === undefined ? (o.form ?? null) : JSON.stringify(o.json),
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  const text = await r.text();
  if (!r.ok) {
    let detail = text;
    try {
      const body = JSON.parse(text) as { detail?: string; title?: string };
      detail = body.detail ?? body.title ?? text;
    } catch {
      // not JSON
    }
    throw new XError(r.status, `X ${path} answered ${r.status}: ${detail.slice(0, 300)}`);
  }
  return (text === "" ? {} : JSON.parse(text)) as T;
}

const MEDIA: Record<string, { category: string; maxBytes: number }> = {
  "video/mp4": { category: "tweet_video", maxBytes: 50 * 1024 * 1024 },
  "image/gif": { category: "tweet_gif", maxBytes: 15 * 1024 * 1024 },
  "image/png": { category: "tweet_image", maxBytes: 5 * 1024 * 1024 },
  "image/jpeg": { category: "tweet_image", maxBytes: 5 * 1024 * 1024 },
  "image/webp": { category: "tweet_image", maxBytes: 5 * 1024 * 1024 },
};

export const mediaLimit = (contentType: string): number | null => MEDIA[contentType]?.maxBytes ?? null;

interface Processing {
  state?: string;
  check_after_secs?: number;
  error?: { message?: string };
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** initialize, append, finalize, then wait for processing if X asks for it. Returns the media id. */
export async function uploadMedia(keys: XKeys, bytes: Uint8Array, contentType: string): Promise<string> {
  const spec = MEDIA[contentType];
  if (spec === undefined) throw new Error(`X can't take a ${contentType} file`);
  const deadline = Date.now() + MEDIA_DEADLINE_MS;
  const init = await request<{ data: { id: string } }>(keys, "POST", "/2/media/upload/initialize", {
    json: { media_type: contentType, total_bytes: bytes.length, media_category: spec.category },
  });
  const id = init.data.id;
  for (let at = 0, segment = 0; at < bytes.length; at += CHUNK_BYTES, segment += 1) {
    const form = new FormData();
    form.append("segment_index", String(segment));
    form.append("media", new Blob([bytes.slice(at, at + CHUNK_BYTES)]), "media");
    await request(keys, "POST", `/2/media/upload/${id}/append`, { form });
  }
  const done = await request<{ data: { processing_info?: Processing } }>(
    keys,
    "POST",
    `/2/media/upload/${id}/finalize`,
  );
  let info = done.data.processing_info;
  while (info !== undefined && info.state !== "succeeded") {
    if (info.state === "failed")
      throw new Error(`X couldn't process the media: ${info.error?.message ?? ""}`);
    const wait = Math.max(1, info.check_after_secs ?? 1) * 1000;
    if (Date.now() + wait > deadline) throw new Error("X is still processing the media; nothing was posted");
    await sleep(wait);
    const status = await request<{ data: { processing_info?: Processing } }>(keys, "GET", "/2/media/upload", {
      query: { command: "STATUS", media_id: id },
    });
    info = status.data.processing_info;
  }
  return id;
}

export const tweetUrl = (id: string): string => `https://x.com/i/status/${id}`;

export async function createTweet(keys: XKeys, text: string, mediaIds: string[]): Promise<{ id: string }> {
  const r = await request<{ data: { id: string } }>(keys, "POST", "/2/tweets", {
    json: { text, ...(mediaIds.length === 0 ? {} : { media: { media_ids: mediaIds } }) },
  });
  return { id: r.data.id };
}

/** The replies in a tweet's conversation, read without asking X for any author fields. */
export async function searchReplies(
  keys: XKeys,
  tweetId: string,
): Promise<{ id: string; text: string; created_at?: string }[]> {
  const r = await request<{ data?: { id: string; text: string; created_at?: string }[] }>(
    keys,
    "GET",
    "/2/tweets/search/recent",
    { query: { query: `conversation_id:${tweetId}`, max_results: "100", "tweet.fields": "created_at" } },
  );
  return (r.data ?? []).filter((t) => t.id !== tweetId);
}

/** The tweet id in a status URL on x.com, or null if it's any other shape of URL. */
export function tweetIdFrom(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.port !== "")
    return null;
  if (parsed.hostname !== "x.com" && parsed.hostname !== "www.x.com") return null;
  return /^\/(?:i\/web|[A-Za-z0-9_]{1,15})\/status\/(\d{1,19})\/?$/.exec(parsed.pathname)?.[1] ?? null;
}
