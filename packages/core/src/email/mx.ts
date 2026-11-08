/** SH-1: does a domain accept mail? Used before every outreach send. Cached for an hour. */
import { resolveMx } from "node:dns/promises";

const cache = new Map<string, { ok: boolean; at: number }>();
const TTL_MS = 3_600_000;

export type MxLookup = (domain: string) => Promise<boolean>;

export const hasMx: MxLookup = async (domain) => {
  const d = domain.toLowerCase();
  const hit = cache.get(d);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ok;
  let ok: boolean;
  try {
    ok = (await resolveMx(d)).some((r) => r.exchange && r.exchange !== ".");
  } catch (err) {
    const code = (err as { code?: string }).code;
    // No record or no domain is a clear no; anything else (a resolver timeout) is retryable.
    if (code === "ENOTFOUND" || code === "ENODATA") ok = false;
    else throw err;
  }
  cache.set(d, { ok, at: Date.now() });
  return ok;
};
