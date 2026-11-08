import type { Config } from "@outrun/core";
import type { Integrations } from "@outrun/core/integrations";
import { logger } from "@outrun/core/log";
import type { MxLookup } from "@outrun/core/email/mx";
import type { Handlers } from "@outrun/core/queue";
import { createRuntime, type Runtime } from "@outrun/core/runtime";
import { checkStuckHandlers } from "./jobs/check_stuck";
import { ceoHandlers } from "./jobs/ceo";
import { clientEmailHandlers } from "./jobs/client_email";
import { sendEmailHandlers } from "./jobs/send_email";
import { triageHandlers } from "./jobs/triage";
import { prospectingHandlers } from "./jobs/prospecting";
import { provisionHandlers } from "./jobs/provision";
import { naiveHandlers } from "./jobs/naive";
import { auditHandlers } from "./jobs/audit";
import { growthHandlers } from "./jobs/growth";
import { stripeHandlers } from "./jobs/stripe";
import { stubHandlers } from "./stubs";

export interface Worker {
  runtime: Runtime;
  /** Shorthands kept for scripts. */
  queue: Runtime["queue"];
  db: Runtime["db"];
  stop(): Promise<void>;
}

export interface StartOptions {
  config: Config;
  /** Extra handlers, overriding stubs and real ones job by job. */
  handlers?: Handlers;
  /** false runs every job on its stub (pnpm e2e:loop). */
  real?: boolean;
  integrations?: Partial<Integrations>;
  mx?: MxLookup;
  sitePreflight?: (url: string) => Promise<unknown>;
  schedules?: boolean;
  retryDelaySeconds?: number;
  retryBackoff?: boolean;
  pollingIntervalSeconds?: number;
}

/** The real handlers merged so far. Each card adds its jobs here. */
export function realHandlers(rt: Runtime): Handlers {
  // Stripe owns start_audit because its payload carries the billing cycle for Growth renewals.
  return {
    ...naiveHandlers(rt),
    ...auditHandlers(rt),
    ...growthHandlers(rt),
    ...stripeHandlers(rt),
    ...checkStuckHandlers(rt),
    ...ceoHandlers(rt),
    ...clientEmailHandlers(rt),
    ...sendEmailHandlers(rt),
    ...triageHandlers(rt),
    ...prospectingHandlers(rt),
    ...provisionHandlers(rt),
  };
}

export async function startWorker(opts: StartOptions): Promise<Worker> {
  const tuning = {
    ...(opts.retryDelaySeconds !== undefined ? { retryDelaySeconds: opts.retryDelaySeconds } : {}),
    ...(opts.retryBackoff !== undefined ? { retryBackoff: opts.retryBackoff } : {}),
    ...(opts.pollingIntervalSeconds !== undefined
      ? { pollingIntervalSeconds: opts.pollingIntervalSeconds }
      : {}),
  };
  const runtime = await createRuntime(opts.config, {
    startQueue: false,
    queue: tuning,
    ...(opts.integrations ? { integrations: opts.integrations } : {}),
    ...(opts.mx ? { mx: opts.mx } : {}),
    ...(opts.sitePreflight ? { sitePreflight: opts.sitePreflight } : {}),
  });
  const queue = runtime.queue;
  await queue.start();
  const handlers: Handlers = {
    ...stubHandlers({ queue, emit: runtime.emit }),
    ...(opts.real === false ? {} : realHandlers(runtime)),
    ...opts.handlers,
  };
  await queue.work(handlers);
  if (opts.schedules ?? true) await queue.schedule();
  if (runtime.fakes.length) logger.warn({ fakes: runtime.fakes }, "running with fakes");
  logger.info({ demo: opts.config.settings.demo }, "worker ready");
  return {
    runtime,
    queue,
    db: runtime.db,
    stop: () => runtime.close(),
  };
}
