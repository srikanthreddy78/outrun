import { config } from "@outrun/core";
import { createDb } from "@outrun/core/db/client";
import { createEmitter } from "@outrun/core/events";
import { Queue } from "@outrun/core/queue";
import { DbScanStore } from "@outrun/core/scan/db-store";
import { MemoryScanStore, ScanService } from "@outrun/core/scan/service";

type LocalScan = { store: MemoryScanStore; service: ScanService };
const globalScan = globalThis as typeof globalThis & {
  __outrunLocalScan?: LocalScan;
  __outrunDbScan?: Promise<ScanService | null>;
};

export async function scanService(): Promise<ScanService | null> {
  const cfg = config();
  if (cfg.databaseUrlUnpooled) {
    globalScan.__outrunDbScan ??= createPersistentScan(cfg.databaseUrlUnpooled, cfg.settings.jobMaxAttempts);
    return globalScan.__outrunDbScan;
  }
  // Process memory is a local-development fixture, never a production cache.
  if (cfg.isProd) return null;
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

async function createPersistentScan(url: string, maxAttempts: number): Promise<ScanService | null> {
  const secret = process.env.AUTH_SECRET || config().keys.crewTokenSecret;
  if (!secret) return null;
  const db = createDb(url);
  const queue = new Queue({ connectionString: url, maxAttempts, emit: createEmitter(db.db) });
  try {
    await queue.start();
    const store = new DbScanStore(db.db, async (domain, idempotencyKey, traceId) => {
      await queue.enqueue({ type: "scan_domain", payload: { domain }, idempotencyKey, traceId });
    });
    return new ScanService(store, undefined, secret);
  } catch {
    await queue.stop().catch(() => {});
    await db.close().catch(() => {});
    return null;
  }
}

export function requesterIp(request: Request): string {
  return (
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "local"
  );
}
