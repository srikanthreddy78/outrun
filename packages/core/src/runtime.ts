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
import { createMonidEnrich } from "./integrations/enrich";
import { createHubSpotClient } from "./integrations/hubspot";
import { createMonidClient } from "./integrations/monid";
import { createDiscover } from "./sources";
import { createNaiveClient } from "./integrations/naive";
import { ApifyClient } from "./integrations/apify";
import { createStripeGateway } from "./integrations/stripe";
import { createAgentMailClient } from "./integrations/agentmail";
import { hasMx } from "./email/mx";
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
    apify: { key: "apify", make: (c) => new ApifyClient(c.keys.apify!, c.keys.apifyWebhookSecret!) },
    stripe: { key: "stripe", make: (c) => createStripeGateway(c.keys.stripe!) },
    discover: {
      key: null,
      // Public sources need no key; tests and demo mode get the fixtures, never the network.
      make: (c) => createDiscover({ demo: c.settings.demo || c.env === "test" }),
    },
    enrich: { key: "monid", make: (c) => createMonidEnrich(createMonidClient(c.keys.monid!)) },
    monid: { key: "monid", make: (c) => createMonidClient(c.keys.monid!) },
    hubspot: { key: "hubspot", make: (c) => createHubSpotClient(c.keys.hubspot!) },
    agentmail: {
      key: "agentmail",
      make: (c) => createAgentMailClient(c.keys.agentmail!, c.keys.agentmailInboxId!),
    },
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
      audit: { apify: integrations.apify, appUrl: config.appUrl },
      outreach: { appUrl: config.appUrl, settings: config.settings, mx: hasMx },
      prospecting: { settings: config.settings, enrich: integrations.enrich },
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
