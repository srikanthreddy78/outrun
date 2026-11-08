import { createHash } from "node:crypto";
import { SCORE_RATE_LIMIT_PER_HOUR } from "../constants";
import { SCAN_VERSION, type PrivateSupplement, type ScanResult, type ScanSource } from "./contracts";
import { fullScan, normalizeDomain, quickScan, withPrivateSupplement } from "./scan";

export interface ScanStore {
  get(domain: string): Promise<ScanResult | undefined>;
  put(result: ScanResult): Promise<void>;
  enqueue(domain: string): Promise<void>;
  consumeRequest(ipHash: string, since: Date, at: Date, limit: number): Promise<boolean>;
}
export class MemoryScanStore implements ScanStore {
  scans = new Map<string, ScanResult>();
  queue = new Set<string>();
  requests: { ipHash: string; at: number }[] = [];
  async get(domain: string) {
    return this.scans.get(domain);
  }
  async put(result: ScanResult) {
    this.scans.set(result.domain, result);
  }
  async enqueue(domain: string) {
    this.queue.add(domain);
  }
  async consumeRequest(ipHash: string, since: Date, at: Date, limit: number) {
    if (
      this.requests.filter((entry) => entry.ipHash === ipHash && entry.at >= since.getTime()).length >= limit
    )
      return false;
    this.requests.push({ ipHash, at: at.getTime() });
    return true;
  }
}
export class RateLimitError extends Error {
  readonly code = "rate_limited";
  retryAfter = 3600;
}
export class ScanService {
  private store: ScanStore;
  private source?: ScanSource;
  private ipSalt: string;
  constructor(store: ScanStore, source?: ScanSource, ipSalt = "local-development") {
    this.store = store;
    this.source = source;
    this.ipSalt = ipSalt;
  }
  async request(domainInput: string, ip: string, supplement?: PrivateSupplement): Promise<ScanResult> {
    const domain = normalizeDomain(domainInput);
    const now = new Date();
    const hash = createHash("sha256").update(`${this.ipSalt}:${ip}`).digest("hex");
    if (
      !(await this.store.consumeRequest(
        hash,
        new Date(now.getTime() - 3600_000),
        now,
        SCORE_RATE_LIMIT_PER_HOUR,
      ))
    )
      throw new RateLimitError("Scan rate limit exceeded");
    const cached = await this.store.get(domain);
    if (
      cached?.version === SCAN_VERSION &&
      (cached.state === "complete"
        ? Boolean(cached.cachedUntil && Date.parse(cached.cachedUntil) > now.getTime())
        : Date.parse(cached.scannedAt) > now.getTime() - 5 * 60_000)
    ) {
      return supplement ? withPrivateSupplement(cached, supplement) : cached;
    }
    const partial = await quickScan(domain, this.source);
    await this.store.put(partial);
    await this.store.enqueue(domain);
    return supplement ? withPrivateSupplement(partial, supplement) : partial;
  }
  async complete(domainInput: string): Promise<ScanResult> {
    const domain = normalizeDomain(domainInput);
    const existing = await this.store.get(domain);
    if (
      existing?.state === "complete" &&
      existing.cachedUntil &&
      Date.parse(existing.cachedUntil) > Date.now()
    )
      return existing;
    const partial = existing?.state === "partial" ? existing : await quickScan(domain, this.source);
    const full = await fullScan(partial, this.source);
    await this.store.put(full);
    return full;
  }
}
