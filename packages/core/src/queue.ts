/**
 * pg-boss on Neon for every deterministic job (ADR 0001). One queue per job type, each with
 * retries with backoff and a dead-letter queue. `enqueue` joins the caller's transaction and
 * is idempotent on the envelope's key: the job id is derived from it, so a second enqueue of
 * the same key is a no-op while the first job is kept (JOB_KEEP_DAYS after it finishes). A
 * non-retryable AppError or a payload that fails its schema skips the retries and dead-letters.
 */
import { createHash, randomUUID } from "node:crypto";
import { PgBoss, type Job } from "pg-boss";
import { JOB_TYPES, JobEnvelope, type JobEnvelopeInput, type JobType } from "../contracts";
import type { TxScope } from "./db/client";
import { ZodError } from "zod";
import { AppError } from "./errors";
import type { Emit } from "./events";
import { logger } from "./log";
import {
  CRON,
  CRON_TZ,
  JOB_EXPIRE_SECONDS,
  JOB_KEEP_DAYS,
  JOB_RETRY_DELAY_MAX_SECONDS,
  JOB_RETRY_DELAY_SECONDS,
  WORKER_CONCURRENCY,
} from "./constants";

export const deadLetterName = (type: JobType) => `${type}__dead`;

/** A stable UUID (v8 layout) from an idempotency key, so pg-boss rejects duplicate ids. */
export function jobIdFor(type: JobType, idempotencyKey: string): string {
  const h = createHash("sha256").update(`${type}\u0000${idempotencyKey}`).digest("hex");
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type JobHandler = (env: JobEnvelope, meta: { jobId: string; attempt: number }) => Promise<void>;
export type Handlers = Partial<Record<JobType, JobHandler>>;

export interface QueueOptions {
  connectionString: string;
  maxAttempts: number;
  emit: Emit;
  /** Tests run with short retry delays. */
  retryDelaySeconds?: number;
  retryBackoff?: boolean;
  pollingIntervalSeconds?: number;
  schedules?: boolean;
  /**
   * "producer" only enqueues: no maintenance, no cron clock, no migrations and no queue
   * creation (the worker owns those). The web app runs as a producer.
   */
  role?: "worker" | "producer";
  /** pg-boss's own pool size. */
  max?: number;
}

export class Queue {
  readonly boss: PgBoss;
  private started = false;

  constructor(private readonly opts: QueueOptions) {
    const producer = opts.role === "producer";
    this.boss = new PgBoss({
      connectionString: opts.connectionString,
      max: opts.max ?? (producer ? 2 : 4),
      ...(producer ? { supervise: false, schedule: false, migrate: false } : {}),
    });
    this.boss.on("error", (err: unknown) => logger.error({ err }, "pg-boss error"));
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.boss.start();
    if (this.opts.role !== "producer") {
      const keep = JOB_KEEP_DAYS * 24 * 3600;
      for (const type of JOB_TYPES) {
        const dead = { retentionSeconds: 14 * 24 * 3600, deleteAfterSeconds: keep };
        await this.boss.createQueue(deadLetterName(type), dead);
        await this.boss.updateQueue(deadLetterName(type), dead);
        const backoff = this.opts.retryBackoff ?? true;
        const opts = {
          retryLimit: Math.max(0, this.opts.maxAttempts - 1),
          retryDelay: this.opts.retryDelaySeconds ?? JOB_RETRY_DELAY_SECONDS,
          retryBackoff: backoff,
          expireInSeconds: JOB_EXPIRE_SECONDS,
          deleteAfterSeconds: keep,
        };
        await this.boss.createQueue(type, {
          ...opts,
          ...(backoff ? { retryDelayMax: JOB_RETRY_DELAY_MAX_SECONDS } : {}),
          deadLetter: deadLetterName(type),
        });
        // createQueue leaves an existing queue as it was; apply changed settings too.
        await this.boss.updateQueue(type, {
          ...opts,
          retryDelayMax: backoff ? JOB_RETRY_DELAY_MAX_SECONDS : null,
          deadLetter: deadLetterName(type),
        });
      }
    }
    this.started = true;
  }

  async schedule(): Promise<void> {
    for (const [type, cron] of Object.entries(CRON) as [JobType, string][]) {
      await this.boss.schedule(type, cron, cronEnvelopeData(type), { tz: CRON_TZ });
    }
  }

  /** Enqueue a job. With `tx`, the insert commits or rolls back with the caller's writes. */
  async enqueue(input: JobEnvelopeInput, opts: { tx?: TxScope } = {}): Promise<{ jobId: string | null }> {
    const env = JobEnvelope.parse(input);
    const id = jobIdFor(env.type, env.idempotencyKey);
    const db = opts.tx
      ? {
          executeSql: async (text: string, values?: unknown[]) => {
            const r = await opts.tx!.client.query(text, values as unknown[]);
            return { rows: r.rows };
          },
        }
      : undefined;
    const jobId = await this.boss.send(env.type, env, {
      id,
      ...(env.runAfter ? { startAfter: new Date(env.runAfter) } : {}),
      ...(db ? { db } : {}),
    });
    return { jobId };
  }

  /** Register handlers; every outcome lands in the events ledger. */
  async work(handlers: Handlers, concurrency = WORKER_CONCURRENCY): Promise<void> {
    const emit = this.opts.emit;
    const pollingIntervalSeconds = this.opts.pollingIntervalSeconds ?? 2;
    for (const type of JOB_TYPES) {
      const handler = handlers[type];
      if (!handler) continue;
      await this.boss.work<JobEnvelope>(
        type,
        { localConcurrency: concurrency, batchSize: 1, pollingIntervalSeconds, includeMetadata: true },
        async (jobs) => {
          for (const job of jobs as (Job<JobEnvelope> & { retryCount?: number })[]) {
            const attempt = (job.retryCount ?? 0) + 1;
            let entity: ReturnType<typeof entityOf> = { entityType: "job", entityId: job.id };
            try {
              const parsed = JobEnvelope.parse(job.data);
              // Cron fires carry one fixed key; give each fire its own so derived keys differ.
              const env = parsed.idempotencyKey.startsWith("cron:")
                ? { ...parsed, idempotencyKey: `${parsed.idempotencyKey}:${job.id}` }
                : parsed;
              entity = entityOf(env);
              await handler(env, { jobId: job.id, attempt });
              await emit({
                actor: "worker",
                type: "job.done",
                ...entity,
                payload: { job: type, jobId: job.id, attempt },
              });
            } catch (err) {
              const terminal = isTerminal(err);
              await emit({
                actor: "worker",
                type: "job.failed",
                ...entity,
                payload: { job: type, jobId: job.id, attempt, terminal, ...errorSummary(err) },
              }).catch(() => {});
              if (!terminal) throw err;
              // Retrying can't help: straight to the dead-letter queue, then finish this job.
              await this.boss.send(deadLetterName(type), job.data as object);
            }
          }
        },
      );
      await this.boss.work<JobEnvelope>(
        deadLetterName(type),
        { batchSize: 1, pollingIntervalSeconds },
        async (jobs) => {
          for (const job of jobs) {
            const env = JobEnvelope.safeParse(job.data);
            const entity = env.success
              ? entityOf(env.data)
              : { entityType: "job" as const, entityId: job.id };
            await emit({
              actor: "worker",
              type: "job.dead",
              ...entity,
              payload: { job: type, jobId: job.id },
            });
            logger.error({ job: type, jobId: job.id }, "job dead-lettered");
          }
        },
      );
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.boss.stop({ graceful: true, timeout: 5000 });
    this.started = false;
  }
}

/** Errors that no retry can fix: a non-retryable AppError, or a payload that fails its schema. */
function isTerminal(err: unknown): boolean {
  if (err instanceof AppError) return !err.retryable;
  return err instanceof ZodError;
}

function errorSummary(err: unknown): { code: string; error: string } {
  if (err instanceof AppError) return { code: err.code, error: err.message.slice(0, 300) };
  if (err instanceof ZodError) return { code: "bad_request", error: "payload failed validation" };
  return { code: "internal", error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
}

function entityOf(env: JobEnvelope): {
  entityType: "job" | "prospect" | "order" | "message" | "agent_session" | "system";
  entityId: string;
} {
  const p = env.payload as Record<string, unknown>;
  for (const [key, type] of [
    ["prospectId", "prospect"],
    ["orderId", "order"],
    ["messageId", "message"],
    ["agentSessionId", "agent_session"],
  ] as const) {
    if (typeof p[key] === "string") return { entityType: type, entityId: p[key] as string };
  }
  return { entityType: "system", entityId: env.type };
}

function cronEnvelopeData(type: JobType): JobEnvelope {
  return JobEnvelope.parse({ type, payload: {}, idempotencyKey: `cron:${type}`, traceId: `cron-${type}` });
}

export const newTraceId = (): string => randomUUID();
