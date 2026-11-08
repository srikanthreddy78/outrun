import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { FETCH_MAX_BYTES, FETCH_MAX_REDIRECTS, FETCH_TIMEOUT_MS } from "./constants";

const blocked = new BlockList();
for (const [address, prefix, family] of [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["64:ff9b:1::", 48, "ipv6"],
  ["100::", 64, "ipv6"],
  ["2001::", 32, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
  ["2002::", 16, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
] as const)
  blocked.addSubnet(address, prefix, family);

export class UnsafeUrlError extends Error {}
export class ResponseLimitError extends Error {}
export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;
export type SafeResponse = { url: string; status: number; headers: Record<string, string>; body: string };
export type SafeFetchOptions = {
  resolver?: Resolver;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  transport?: (url: URL, pinnedAddress: string) => Promise<SafeResponse>;
  signal?: AbortSignal;
};

export function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (!family || blocked.check(address, family === 4 ? "ipv4" : "ipv6")) return false;
  if (family === 6) return /^[23][0-9a-f]/i.test(address.replace(/^\[/, ""));
  return true;
}

export function validatePublicUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UnsafeUrlError("Invalid URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && url.port !== (url.protocol === "https:" ? "443" : "80"))
  ) {
    throw new UnsafeUrlError("Only public HTTP(S) on ports 80/443 is allowed");
  }
  if (
    !url.hostname ||
    url.hostname.endsWith(".") ||
    url.hostname.includes("%") ||
    url.hostname.startsWith("[")
  )
    throw new UnsafeUrlError("Invalid host");
  if (isIP(url.hostname) && !isPublicIp(url.hostname)) throw new UnsafeUrlError("Private address");
  return url;
}

const defaultResolver: Resolver = async (hostname) => {
  const entries = await dnsLookup(hostname, { all: true, verbatim: true });
  return entries.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
};

async function oneRequest(url: URL, options: SafeFetchOptions): Promise<SafeResponse> {
  const entries = isIP(url.hostname)
    ? [{ address: url.hostname, family: isIP(url.hostname) as 4 | 6 }]
    : await Promise.race([
        (options.resolver ?? defaultResolver)(url.hostname),
        new Promise<never>((_, reject) => {
          if (options.signal?.aborted) reject(options.signal.reason);
          else
            options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
        }),
      ]);
  const pinned = entries[0];
  if (
    !pinned ||
    entries.some((entry) => !isPublicIp(entry.address) || entry.family !== isIP(entry.address))
  ) {
    throw new UnsafeUrlError("DNS returned a non-public address");
  }
  const maxBytes = options.maxBytes ?? FETCH_MAX_BYTES;
  if (options.transport) return options.transport(url, pinned.address);
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  return await new Promise((resolve, reject) => {
    const req = transport(
      url,
      {
        method: "GET",
        timeout: options.timeoutMs ?? FETCH_TIMEOUT_MS,
        signal: options.signal,
        headers: {
          "User-Agent": "Outrun-Readiness-Scanner/1.0",
          Accept: "text/html,text/plain,application/json,application/xml,*/*;q=0.1",
        },
        lookup: (_host, _opts, cb) => cb(null, pinned.address, pinned.family),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new ResponseLimitError("Response exceeds size limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const headers = Object.fromEntries(
            Object.entries(response.headers).map(([key, value]) => [
              key,
              Array.isArray(value) ? value.join(", ") : (value ?? ""),
            ]),
          );
          resolve({
            url: url.toString(),
            status: response.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Fetch timeout")));
    req.on("error", reject);
    req.end();
  });
}

export async function safeFetch(input: string, options: SafeFetchOptions = {}): Promise<SafeResponse> {
  let url = validatePublicUrl(input);
  const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS);
  const bounded = { ...options, signal };
  for (let redirects = 0; ; redirects++) {
    if (signal.aborted) throw signal.reason;
    const response = await oneRequest(url, bounded);
    if (Buffer.byteLength(response.body) > (options.maxBytes ?? FETCH_MAX_BYTES))
      throw new ResponseLimitError("Response exceeds size limit");
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirects >= (options.maxRedirects ?? FETCH_MAX_REDIRECTS))
      throw new UnsafeUrlError("Too many redirects");
    const location = response.headers.location;
    if (!location) return response;
    url = validatePublicUrl(new URL(location, url).toString());
  }
}
