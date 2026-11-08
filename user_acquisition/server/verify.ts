/**
 * Checks that make a prospect's email "definitive" before it's saved: the address appears on the
 * page cited as its source, it's on the company's own domain (never a free-mail provider), and that
 * domain accepts mail. The source page is fetched here, by code, never trusted from the agent.
 */
import { lookup, resolveMx } from "node:dns/promises";
import { isIP } from "node:net";

const FREE_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
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
  "yandex.ru",
  "zoho.com",
  "qq.com",
  "163.com",
  "126.com",
  "hey.com",
  "fastmail.com",
]);

export class VerifyError extends Error {}

export function normalizeDomain(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const host = /^https?:\/\//.test(trimmed) ? new URL(trimmed).hostname : (trimmed.split("/")[0] ?? "");
  return host.replace(/^www\./, "").replace(/\.$/, "");
}

/** True when the email's domain is the company's domain or a subdomain of it, or the reverse. */
export function sameOrganization(emailDomain: string, companyDomain: string): boolean {
  return (
    emailDomain === companyDomain ||
    emailDomain.endsWith(`.${companyDomain}`) ||
    companyDomain.endsWith(`.${emailDomain}`)
  );
}

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  return (
    v6 === "::1" ||
    v6 === "::" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe80") ||
    v6.startsWith("::ffff:")
  );
}

async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new VerifyError("email_source_url is not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new VerifyError("email_source_url must be http(s)");
  if (url.port !== "" && url.port !== "80" && url.port !== "443")
    throw new VerifyError("email_source_url must use port 80 or 443");
  const addresses = await lookup(url.hostname, { all: true }).catch(() => []);
  if (addresses.length === 0) throw new VerifyError(`email_source_url host ${url.hostname} does not resolve`);
  if (addresses.some((a) => privateAddress(a.address)))
    throw new VerifyError("email_source_url must be a public site");
  return url;
}

/** Fetches a public page (at most 3 redirects, each re-checked; 6 s; 1.5 MB) and returns its text. */
async function fetchPublic(raw: string): Promise<string> {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop <= 3; hop += 1) {
    const response = await fetch(url, {
      redirect: "manual",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; OutreachVerifier/1.0)",
        accept: "text/html,text/plain,*/*",
      },
      signal: AbortSignal.timeout(6_000),
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      url = await assertPublicUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new VerifyError(`email_source_url answered HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (reader === undefined) return "";
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      size += next.value.byteLength;
      if (size > 1_500_000) break;
      chunks.push(next.value);
    }
    await reader.cancel().catch(() => {});
    return new TextDecoder().decode(Buffer.concat(chunks));
  }
  throw new VerifyError("email_source_url redirected too many times");
}

/** The page shows the address: plainly, in a mailto, or with the @ entity- or percent-encoded. */
function pageShows(page: string, email: string): boolean {
  const text = page.toLowerCase();
  const [local = "", domain = ""] = email.split("@");
  return [
    `${local}@${domain}`,
    `${local}&#64;${domain}`,
    `${local}&#x40;${domain}`,
    `${local}%40${domain}`,
  ].some((form) => text.includes(form));
}

export interface VerifiedEmail {
  email: string;
  domain: string;
  mxHost: string;
}

export async function verifyEmail(
  email: string,
  companyDomain: string,
  sourceUrl: string,
): Promise<VerifiedEmail> {
  const address = email.trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(address))
    throw new VerifyError(`${email} is not an email address`);
  const emailDomain = address.split("@")[1] ?? "";
  if (FREE_MAIL.has(emailDomain))
    throw new VerifyError(`${emailDomain} is a free-mail provider; only company addresses are kept`);
  const domain = normalizeDomain(companyDomain);
  if (!sameOrganization(emailDomain, domain)) {
    throw new VerifyError(`${address} is not on the company's domain ${domain}`);
  }

  const mx = await resolveMx(emailDomain).catch(() => []);
  const best = mx
    .filter((r) => r.exchange !== "" && r.exchange !== ".")
    .sort((a, b) => a.priority - b.priority)[0];
  if (best === undefined) throw new VerifyError(`${emailDomain} has no MX records, so it can't receive mail`);

  let page: string;
  try {
    page = await fetchPublic(sourceUrl);
  } catch (error) {
    if (error instanceof VerifyError) throw error;
    throw new VerifyError(`couldn't fetch email_source_url: ${(error as Error).message}`);
  }
  if (!pageShows(page, address)) {
    throw new VerifyError(
      `${address} does not appear in the HTML of ${sourceUrl}; cite a page that shows it, or find another address`,
    );
  }
  return { email: address, domain, mxHost: best.exchange };
}
