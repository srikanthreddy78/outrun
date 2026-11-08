import { loadConfig } from "@outrun/core";
import { logger } from "@outrun/core/log";
import { startWorker } from "./worker";

async function main(): Promise<void> {
  const config = loadConfig();
  const worker = await startWorker({ config });
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "worker stopping");
    await worker.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "worker failed to start");
  process.exit(1);
});
