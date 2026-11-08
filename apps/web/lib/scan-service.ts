import { MemoryScanStore, ScanService } from "@outrun/core/scan/service";

type LocalScan = { store: MemoryScanStore; service: ScanService };
const globalScan = globalThis as typeof globalThis & { __outrunLocalScan?: LocalScan };

export function scanService(): ScanService | null {
  // The production adapter is installed with SR-2/SR-3. Process memory cannot
  // enforce a seven-day cache or per-IP rate limits across server instances.
  if (process.env.NODE_ENV === "production") return null;
  if (!globalScan.__outrunLocalScan) {
    const store = new MemoryScanStore();
    const service = new ScanService(store, undefined, "local-scan");
    store.enqueue = async (domain) => {
      store.queue.add(domain);
      setImmediate(() => {
        void service.complete(domain).catch(() => {
          store.queue.delete(domain);
        });
      });
    };
    globalScan.__outrunLocalScan = { store, service };
  }
  return globalScan.__outrunLocalScan.service;
}

export function requesterIp(request: Request): string {
  return (
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "local"
  );
}
