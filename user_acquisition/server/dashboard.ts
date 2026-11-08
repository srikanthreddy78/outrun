/**
 * The leads dashboard at `/`, the page Naive Studio opens for this app.
 *
 * Sign-in follows the platform's handoff: Studio mints a short-lived ticket (an HMAC of the app's
 * generated `DASHBOARD_TOKEN`), posts it to `/api/enter`, and that route sets an HttpOnly cookie.
 * `DASHBOARD_PASSWORD` (shown in the app's Access panel in Studio) opens the same door from any
 * browser. Neither secret is ever written into a page.
 *
 * Everything shown came from agents or the web, so every value is HTML-escaped.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.ts";

const COOKIE = "dashboard_session";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const TICKET_PREFIX = "vetta.app-entry.v1";

const sameSecret = (a: string, b: string): boolean =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

function ticketMatches(token: string, ticket: string, now: number): boolean {
  const [expiry, mac] = ticket.split(".");
  const expiresAt = Number(expiry);
  if (mac === undefined || !Number.isSafeInteger(expiresAt) || now >= expiresAt) return false;
  return sameSecret(
    createHmac("sha256", token).update(`${TICKET_PREFIX}:${expiresAt}`).digest("base64url"),
    mac,
  );
}

function cookieValues(header: string | undefined, name: string): string[] {
  const found: string[] = [];
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) found.push(part.slice(at + 1).trim());
  }
  return found;
}

export function signedIn(cookieHeader: string | undefined, token: string | undefined): boolean {
  if (!token) return false;
  let matched = false;
  for (const value of cookieValues(cookieHeader, COOKIE)) matched = sameSecret(value, token) || matched;
  return matched;
}

function field(body: string, name: string): string {
  try {
    const parsed = JSON.parse(body || "{}") as Record<string, unknown> | null;
    const value = parsed?.[name];
    if (value !== undefined && value !== null) return String(value);
  } catch {
    // Not JSON: a form.
  }
  return new URLSearchParams(body).get(name) ?? "";
}

export interface EnterResult {
  status: number;
  location: string;
  cookie: string | null;
}

/** `POST /api/enter`: a Studio ticket or the dashboard password, traded for the session cookie. */
export function enter(body: string, token: string | undefined, password: string | undefined): EnterResult {
  const denied: EnterResult = { status: 303, location: "/?entry=denied", cookie: null };
  if (!token) return denied;
  const typed = field(body, "password");
  if (typed !== "") {
    if (!password || !sameSecret(typed, password)) return denied;
  } else if (!ticketMatches(token, field(body, "ticket"), Date.now())) {
    return denied;
  }
  return {
    status: 303,
    location: "/",
    cookie: `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${COOKIE_MAX_AGE}`,
  };
}

const escape = (value: unknown): string =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const safeLink = (url: string | null, label: string): string => {
  if (url === null || !/^https?:\/\//i.test(url)) return escape(label);
  return `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(label)}</a>`;
};

const STYLE = `
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #1a1a1a; --muted: #6b6b6b; --line: #e4e4e4; --card: #f6f6f6; --accent: #2457d6;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #141414; --fg: #ececec; --muted: #9a9a9a; --line: #2c2c2c; --card: #1d1d1d; --accent: #7aa2ff; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, -apple-system, sans-serif; }
  main { max-width: 1200px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { color: var(--muted); margin: 0 0 20px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .stat { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  .stat b { display: block; font-size: 22px; }
  .stat span { color: var(--muted); font-size: 12px; }
  .wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; }
  table { border-collapse: collapse; width: 100%; min-width: 900px; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 12px; color: var(--muted); font-weight: 600; background: var(--card); position: sticky; top: 0; }
  tr:last-child td { border-bottom: 0; }
  td.why { color: var(--muted); max-width: 340px; }
  a { color: var(--accent); }
  .tag { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
  form.gate { max-width: 360px; margin: 18vh auto 0; display: grid; gap: 10px; }
  input, button { font: inherit; padding: 9px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--fg); }
  button { cursor: pointer; }
  .warn { color: #c0392b; }
  h2 { font-size: 15px; margin: 28px 0 10px; }
`;

const page = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;

export function gatePage(denied: boolean, studioUrl: string | null): string {
  return page(
    "Sign in",
    `<main>
<form class="gate" method="post" action="/api/enter">
  <h1>Outrun leads</h1>
  <p class="sub">Open this app from Naive Studio to sign in automatically, or enter the dashboard password from the app's Access panel in Studio.</p>
  ${denied ? `<p class="warn">That didn't work. Try again, or open the app from Studio.</p>` : ""}
  <input type="password" name="password" placeholder="Dashboard password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
  ${studioUrl === null ? "" : `<a href="${escape(studioUrl)}" target="_top">Open Naive Studio</a>`}
</form>
</main>`,
  );
}

interface LeadRow {
  company: string;
  domain: string;
  found_via: string;
  listing_url: string | null;
  why_fit: string;
  contact_email: string;
  contact_name: string | null;
  contact_role: string | null;
  email_source_url: string;
  verified_at: Date;
  suppressed: string | null;
  fit_score: number | null;
  fit_band: string | null;
}

interface SuppressionRow {
  email: string;
  reason: string;
  source: string;
  created_at: Date;
}

export async function leadsPage(db: Db): Promise<string> {
  const leads = await db.query<LeadRow>(
    `select p.company, p.domain, p.found_via, p.listing_url, p.why_fit, p.contact_email, p.contact_name,
            p.contact_role, p.email_source_url, p.verified_at, s.reason as suppressed,
            p.fit_score, p.fit_band
       from outrun_prospects p
       left join outrun_suppressions s on s.email = p.contact_email
      order by p.fit_score desc nulls last, p.verified_at desc`,
  );
  const suppressions = await db.query<SuppressionRow>(
    "select email, reason, source, created_at from outrun_suppressions order by created_at desc",
  );
  const sources = new Map<string, number>();
  for (const row of leads.rows) sources.set(row.found_via, (sources.get(row.found_via) ?? 0) + 1);
  const named = leads.rows.filter((row) => row.contact_name !== null).length;

  const rows = leads.rows
    .map(
      (row) => `<tr>
  <td>${row.fit_score === null ? "–" : `<b>${escape(row.fit_score)}</b><br><span class="tag">${escape(row.fit_band ?? "")}</span>`}</td>
  <td><b>${escape(row.company)}</b><br>${safeLink(`https://${row.domain}`, row.domain)}</td>
  <td>${escape(row.contact_email)}${row.suppressed === null ? "" : ` <span class="tag">${escape(row.suppressed)}</span>`}</td>
  <td>${escape(row.contact_name ?? "")}${row.contact_role === null ? "" : `<br><span class="tag">${escape(row.contact_role)}</span>`}</td>
  <td class="why">${escape(row.why_fit)}</td>
  <td>${safeLink(row.listing_url, row.found_via)}</td>
  <td>${safeLink(row.email_source_url, "page")}</td>
  <td>${escape(row.verified_at.toISOString().slice(0, 16).replace("T", " "))}</td>
</tr>`,
    )
    .join("\n");

  const suppressionRows = suppressions.rows
    .map(
      (row) =>
        `<tr><td>${escape(row.email)}</td><td>${escape(row.reason)}</td><td>${escape(row.source)}</td><td>${escape(row.created_at.toISOString().slice(0, 16).replace("T", " "))}</td></tr>`,
    )
    .join("\n");

  return page(
    "Outrun leads",
    `<main>
<h1>Outrun leads</h1>
<p class="sub">Companies the prospector saved. Every email was checked when saved: it appears on the linked page, it's on the company's own domain, and that domain receives mail.</p>
<div class="stats">
  <div class="stat"><b>${leads.rows.length}</b><span>leads</span></div>
  <div class="stat"><b>${named}</b><span>with a named contact</span></div>
  <div class="stat"><b>${sources.size}</b><span>sources</span></div>
  <div class="stat"><b>${suppressions.rows.length}</b><span>on the do-not-email list</span></div>
</div>
<div class="wrap">
<table>
  <thead><tr><th>Fit</th><th>Company</th><th>Email</th><th>Contact</th><th>Why they fit</th><th>Found via</th><th>Email source</th><th>Verified (UTC)</th></tr></thead>
  <tbody>
${rows || `<tr><td colspan="8">No leads yet.</td></tr>`}
  </tbody>
</table>
</div>
<h2>Do not email</h2>
<div class="wrap">
<table>
  <thead><tr><th>Email</th><th>Reason</th><th>Source</th><th>Since (UTC)</th></tr></thead>
  <tbody>
${suppressionRows || `<tr><td colspan="4">Nobody yet.</td></tr>`}
  </tbody>
</table>
</div>
</main>`,
  );
}
