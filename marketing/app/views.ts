/**
 * The internal dashboard: every app Outrun markets, and for each one its owner, posts, the
 * comments read, the suggestions made, the media produced and its video job, plus the latest
 * summary email and whether it has been sent. Sign-in is the Studio's entry ticket or the generated password.
 * Everything shown came from agents, X or the web, so every value is escaped.
 */
import { createHmac } from "node:crypto";
import type { VideoJob } from "./db.ts";
import { sameSecret } from "./mcp.ts";
import { summaryEmail } from "./summary.ts";

const COOKIE = "studio_session";

export function signedIn(cookieHeader: string | undefined, token: string | undefined): boolean {
  if (!token) return false;
  let matched = false;
  for (const part of (cookieHeader ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === COOKIE)
      matched = sameSecret(part.slice(at + 1).trim(), token) || matched;
  }
  return matched;
}

function field(body: string, name: string): string {
  try {
    const parsed = JSON.parse(body || "{}") as Record<string, unknown> | null;
    const value = parsed?.[name];
    if (value !== undefined && value !== null) return String(value);
  } catch {
    // a form
  }
  return new URLSearchParams(body).get(name) ?? "";
}

function ticketMatches(token: string, ticket: string, now: number): boolean {
  const [expiry, mac] = ticket.split(".");
  const expiresAt = Number(expiry);
  if (mac === undefined || !Number.isSafeInteger(expiresAt) || now >= expiresAt) return false;
  return sameSecret(
    createHmac("sha256", token).update(`vetta.app-entry.v1:${expiresAt}`).digest("base64url"),
    mac,
  );
}

export function enter(
  body: string,
  token?: string,
  password?: string,
): { location: string; cookie: string | null } {
  const denied = { location: "/?entry=denied", cookie: null };
  if (!token) return denied;
  const typed = field(body, "password");
  if (typed !== "") {
    if (!password || !sameSecret(typed, password)) return denied;
  } else if (!ticketMatches(token, field(body, "ticket"), Date.now())) {
    return denied;
  }
  return {
    location: "/",
    cookie: `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${30 * 24 * 3600}`,
  };
}

export const esc = (v: unknown): string =>
  String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const link = (url: unknown, label: unknown): string =>
  typeof url === "string" && /^https:\/\//.test(url)
    ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`
    : esc(label);

const when = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 16).replace("T", " ") : esc(v ?? "–");

const STYLE = `
  :root { color-scheme: light dark; --bg:#fbfaf8; --fg:#1d1b18; --muted:#6d675f; --line:#e6e1da; --card:#f3f0eb; --accent:#c2360e; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141312; --fg:#ece8e2; --muted:#9a948b; --line:#2d2a26; --card:#1c1a18; --accent:#ff6a3d; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 system-ui, sans-serif; }
  main { max-width:1100px; margin:0 auto; padding:24px 16px 56px; }
  h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:15px; margin:28px 0 10px; }
  .sub { color:var(--muted); margin:0 0 18px; }
  a { color:var(--accent); }
  .wrap { overflow-x:auto; border:1px solid var(--line); border-radius:10px; }
  table { border-collapse:collapse; width:100%; }
  th, td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-size:12px; color:var(--muted); background:var(--card); }
  tr:last-child td { border-bottom:0; }
  .tag { display:inline-block; font-size:11px; padding:1px 7px; border:1px solid var(--line); border-radius:999px; color:var(--muted); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin-bottom:10px; }
  pre { white-space:pre-wrap; font:13px/1.5 ui-monospace, monospace; margin:0; }
  details summary { cursor:pointer; color:var(--muted); }
  form.gate { max-width:340px; margin:18vh auto 0; display:grid; gap:10px; }
  input, button { font:inherit; padding:9px 12px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--fg); }
`;

export const page = (
  title: string,
  body: string,
): string => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;

export const gate = (denied: boolean): string =>
  page(
    "Sign in",
    `<form class="gate" method="post" action="/api/enter"><h1>Outrun studio</h1>
<p class="sub">Internal. Open this app from the Naive Studio to sign in, or use the password from its Access panel.</p>
${denied ? "<p>That didn't work.</p>" : ""}
<input type="password" name="password" placeholder="Dashboard password" required><button type="submit">Sign in</button></form>`,
  );

export function home(clients: Record<string, unknown>[]): string {
  const rows = clients
    .map(
      (
        c,
      ) => `<tr><td><a href="/c/${esc(c["id"])}">${esc(c["name"])}</a><br>${link(c["app_url"], c["host"])}</td>
<td>${esc(c["owner_email"] ?? "–")}</td><td>${esc(c["posts"])}</td><td>${esc(c["comments"])} <span class="tag">${esc(c["unread"])} new</span></td>
<td>${esc(c["insights"])}</td><td>${esc(c["media"])}</td><td><span class="tag">${esc(c["video_job"] ?? "–")}</span></td></tr>`,
    )
    .join("");
  return page(
    "Outrun studio",
    `<h1>Outrun studio</h1><p class="sub">Every app Outrun markets: posts, comments read, suggestions and media. Internal only.</p>
<div class="wrap"><table><thead><tr><th>App</th><th>Owner email</th><th>Posts</th><th>Comments</th><th>Suggestion sets</th><th>Media</th><th>Video job</th></tr></thead>
<tbody>${rows || `<tr><td colspan="7">No apps yet.</td></tr>`}</tbody></table></div>`,
  );
}

export function clientPage(data: {
  client: Record<string, unknown>;
  posts: Record<string, unknown>[];
  comments: Record<string, unknown>[];
  insights: Record<string, unknown>[];
  media: Record<string, unknown>[];
  job: VideoJob | null;
  events: Record<string, unknown>[];
  fileNames: Record<string, string>;
}): string {
  const { client, posts, comments, insights, media, job, events, fileNames } = data;
  const latest = insights[0];
  const suggestions = (i: Record<string, unknown>) =>
    (Array.isArray(i["suggestions"]) ? (i["suggestions"] as Record<string, unknown>[]) : [])
      .map(
        (
          s,
        ) => `<div class="card"><b>${esc(s["title"])}</b><br><span class="sub">${esc(s["why"])}</span><br>${esc(s["change"])}
<br><span class="tag">evidence: ${esc((Array.isArray(s["evidence"]) ? s["evidence"] : []).join(", "))}</span></div>`,
      )
      .join("");
  const draft = latest ? summaryEmail(client["name"], latest) : null;
  const email = draft
    ? `To: ${client["owner_email"] ?? "(no owner email yet)"}\nSubject: ${draft.subject}\n\n${draft.text}`
    : "No suggestions yet.";
  const emailState = latest?.["sent_at"]
    ? `sent ${when(latest["sent_at"])} to ${esc(latest["sent_to"])}`
    : "not sent";
  return page(
    String(client["name"]),
    `<p><a href="/">← All apps</a></p><h1>${esc(client["name"])}</h1>
<p class="sub">${link(client["app_url"], client["app_url"])} · owner email: ${esc(client["owner_email"] ?? "–")}</p>
<h2>Latest summary email (${emailState})</h2><div class="card"><pre>${esc(email)}</pre></div>
<h2>Suggestions</h2>${insights.map((i) => `<p class="sub">${when(i["created_at"])} · ${esc(i["summary"])}</p>${suggestions(i)}`).join("") || "<p class='sub'>None yet.</p>"}
<h2>Comments read</h2><div class="wrap"><table><thead><tr><th>When</th><th>Comment</th><th>Post</th><th>Used</th></tr></thead><tbody>
${comments.map((c) => `<tr><td>${when(c["posted_at"])}</td><td>${esc(c["text"])}</td><td>${esc(c["post_id"])}</td><td>${c["insight_id"] ? "yes" : "new"}</td></tr>`).join("") || `<tr><td colspan="4">No comments yet.</td></tr>`}
</tbody></table></div>
<h2>Posts</h2><div class="wrap"><table><thead><tr><th>When</th><th>Post</th><th>Status</th></tr></thead><tbody>
${posts.map((p) => `<tr><td>${when(p["posted_at"])}</td><td>${esc(p["content"])}<br>${link(p["url"], p["url"] ? "open on X" : "")}</td><td>${esc(p["status"])}</td></tr>`).join("") || `<tr><td colspan="3">No posts yet.</td></tr>`}
</tbody></table></div>
<h2>Media</h2><div class="wrap"><table><thead><tr><th>Kind</th><th>Title</th><th>File</th><th>Notes</th><th>Review</th></tr></thead><tbody>
${media.map((m) => `<tr><td><span class="tag">${esc(m["kind"])}</span></td><td>${esc(m["title"])}</td><td>${esc(fileNames[String(m["file_id"])] ?? m["file_id"])}</td><td>${esc(m["notes"] ?? "")}</td><td>${m["review"] ? `<span class="tag">${esc(m["review"])}</span> ${esc(m["review_notes"])}` : "–"}</td></tr>`).join("") || `<tr><td colspan="5">No media yet.</td></tr>`}
</tbody></table></div>
<h2>Video job</h2><div class="card"><span class="tag">${esc(job?.status ?? "no job")}</span> · revisions: ${esc(job?.revisions ?? 0)} · file: ${esc(job?.file_id ?? "–")} · posts as: ${esc(client["identity_id"] ?? "no identity set")}${job?.notes ? `<br>${esc(job.notes)}` : ""}</div>
<div class="wrap"><table><thead><tr><th>When</th><th>Event</th><th>Detail</th></tr></thead><tbody>
${events.map((e) => `<tr><td>${when(e["created_at"])}</td><td>${esc(e["kind"])}</td><td>${esc(e["detail"] ?? "")}</td></tr>`).join("") || `<tr><td colspan="3">No events yet.</td></tr>`}
</tbody></table></div>
<details><summary>Triage notes</summary><div class="card"><pre>${esc(client["triage"] ?? "None yet.")}</pre></div></details>`,
  );
}
