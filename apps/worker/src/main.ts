import { loadConfig } from "@outrun/core";
import { createDb } from "@outrun/core/db/client";
import { logger } from "@outrun/core/log";
import { scanDomainHandler } from "@outrun/core/scan/job";
import { startWorker } from "./worker";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.databaseUrlUnpooled) throw new Error("DATABASE_URL is required to start the worker");
  const scanDb = createDb(config.databaseUrlUnpooled);
  const worker = await startWorker({ config, handlers: { scan_domain: scanDomainHandler(scanDb.db) } });
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "worker stopping");
    await worker.stop();
    await scanDb.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "worker failed to start");
  process.exit(1);
});
