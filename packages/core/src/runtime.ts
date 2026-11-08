/**
 * One wiring for the web app and the worker: config, database, ledger, queue, integrations,
 * llm() and the crew tool registry. Tests build it with fakes.
 */
import type { Config } from "./config";
import { allTools } from "./crew/tools";
import { ToolRegistry } from "./crew/registry";
import { createDb, type DbHandle } from "./db/client";
import { createEmitter, type Emit } from "./events";
import { createIntegrations } from "./integrations";
import { createNaiveClient } from "./integrations/naive";
import { createStripeGateway } from "./integrations/stripe";
import type { Integrations } from "./integrations/types";
import { createLlm, type Llm } from "./llm";
import { Queue, type QueueOptions } from "./queue";

export interface Runtime {
  config: Config;
  db: DbHandle;
  emit: Emit;
  queue: Queue;
  integrations: Integrations;
  registry: ToolRegistry;
  llm: Llm;
  fakes: string[];
  close(): Promise<void>;
}

export interface RuntimeOptions {
  /** Replace any integration (tests pass fakes). */
  integrations?: Partial<Integrations>;
  /** Start pg-boss so enqueue works. The worker also registers handlers. */
  startQueue?: boolean;
  poolMax?: number;
  /** "producer" for the web app: enqueue only (see Queue). */
  queueRole?: "worker" | "producer";
  /** Retry and polling timing; tests shorten it. */
  queue?: Pick<QueueOptions, "retryDelaySeconds" | "retryBackoff" | "pollingIntervalSeconds">;
}

export async function createRuntime(config: Config, opts: RuntimeOptions = {}): Promise<Runtime> {
  const url = config.databaseUrl ?? config.databaseUrlUnpooled;
  if (!url) throw new Error("DATABASE_URL is required");
  const db = createDb(url, { max: opts.poolMax ?? 5 });
  const emit = createEmitter(db.db);
  const selected = createIntegrations(config, {
    naive: { key: "naive", make: (c) => createNaiveClient(c.keys.naive!) },
    stripe: { key: "stripe", make: (c) => createStripeGateway(c.keys.stripe!) },
  });
  const integrations: Integrations = { ...selected.integrations, ...opts.integrations };
  const queue = new Queue({
    connectionString: config.databaseUrlUnpooled ?? url,
    maxAttempts: config.settings.jobMaxAttempts,
    emit,
    role: opts.queueRole ?? "worker",
    ...opts.queue,
  });
  if (opts.startQueue ?? true) await queue.start();
  const registry = new ToolRegistry(
    allTools({
      settings: config.settings,
      orders: { stripe: integrations.stripe, emit, appUrl: config.appUrl },
    }),
  );
  const llm = createLlm({ providers: integrations.llm, db: db.db, emit, settings: config.settings });
  return {
    config,
    db,
    emit,
    queue,
    integrations,
    registry,
    llm,
    fakes: selected.fakes.filter((f) => !(f in (opts.integrations ?? {}))),
    async close() {
      await queue.stop();
      await db.close();
    },
  };
}
