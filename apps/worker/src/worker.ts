import { createDb, type DbHandle } from "@outrun/core/db";
import { createEmitter } from "@outrun/core/events";
import type { Config } from "@outrun/core";
import { Queue, type Handlers } from "@outrun/core/queue";
import { logger } from "@outrun/core/log";
import { stubHandlers } from "./stubs";

export interface Worker {
  db: DbHandle;
  queue: Queue;
  stop(): Promise<void>;
}

export interface StartOptions {
  config: Config;
  /** Real handlers override stubs, job by job. */
  handlers?: Handlers;
  schedules?: boolean;
  retryDelaySeconds?: number;
  retryBackoff?: boolean;
  pollingIntervalSeconds?: number;
}

export async function startWorker(opts: StartOptions): Promise<Worker> {
  const url = opts.config.databaseUrlUnpooled;
  if (!url) throw new Error("DATABASE_URL is required to start the worker");
  const db = createDb(url);
  const emit = createEmitter(db.db);
  const queue = new Queue({
    connectionString: url,
    maxAttempts: opts.config.settings.jobMaxAttempts,
    emit,
    ...(opts.retryDelaySeconds !== undefined ? { retryDelaySeconds: opts.retryDelaySeconds } : {}),
    ...(opts.retryBackoff !== undefined ? { retryBackoff: opts.retryBackoff } : {}),
    ...(opts.pollingIntervalSeconds !== undefined
      ? { pollingIntervalSeconds: opts.pollingIntervalSeconds }
      : {}),
  });
  await queue.start();
  await queue.work({ ...stubHandlers({ queue, emit }), ...opts.handlers });
  if (opts.schedules ?? true) await queue.schedule();
  logger.info({ demo: opts.config.settings.demo }, "worker ready");
  return {
    db,
    queue,
    async stop() {
      await queue.stop();
      await db.close();
    },
  };
}
