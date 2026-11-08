import { z } from "zod";
import { and, eq } from "@outrun/core/db";
import { auditCrawls, orders } from "@outrun/core/db";
import type { Runtime } from "@outrun/core/runtime";
import type { Handlers } from "@outrun/core/queue";
import { startSession } from "@outrun/core/sessions";
import { buildKit } from "@outrun/core/kit/build";
import { deliverReport } from "@outrun/core/report/delivery";
import { AppError } from "@outrun/core";

const OrderPayload = z.object({ orderId: z.uuid() });
const ApifyPayload = z.object({
  runId: z.string().min(1),
  status: z.enum(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"]),
  datasetId: z.string().nullable(),
  costUsd: z.number().finite().nonnegative().nullable(),
});

export function auditHandlers(
  rt: Pick<Runtime, "db" | "emit" | "integrations"> & Partial<Pick<Runtime, "llm" | "queue" | "config">>,
): Handlers {
  const db = rt.db.db;
  const session = { db, emit: rt.emit, naive: rt.integrations.naive };
  return {
    ...(rt.llm && rt.queue
      ? ({
          build_kit: async (env) => {
            const { orderId, reportId } = z
              .object({ orderId: z.uuid(), reportId: z.uuid() })
              .parse(env.payload);
            await buildKit(
              {
                db,
                llm: rt.llm!,
                discover: rt.integrations.discover,
                enqueue: rt.queue!.enqueue.bind(rt.queue),
                emit: rt.emit,
              },
              orderId,
              reportId,
            );
          },
        } satisfies Handlers)
      : {}),
    ...(rt.config
      ? ({
          deliver_report: async (env) => {
            const { orderId, reportId } = z
              .object({ orderId: z.uuid(), reportId: z.uuid() })
              .parse(env.payload);
            await deliverReport(
              {
                db,
                appUrl: rt.config!.appUrl,
                sendTransactional: rt.integrations.sendTransactional,
                hubspot: rt.integrations.hubspot,
                emit: rt.emit,
              },
              orderId,
              reportId,
            );
          },
        } satisfies Handlers)
      : {}),
    start_audit: async (env) => {
      const { orderId } = OrderPayload.parse(env.payload);
      const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
      if (!order || (order.product !== "auditKit" && order.product !== "growth"))
        throw new AppError("not_found", "paid order not found");
      if (order.state !== "paid" && order.state !== "auditing")
        throw new AppError("conflict", "order is not paid");
      if (order.state === "paid")
        await db.update(orders).set({ state: "auditing" }).where(eq(orders.id, orderId));
      await startSession(session, {
        agent: "auditor",
        entity: { type: "order", id: orderId },
        message: `Audit paid order ${orderId} for ${order.domain}. Begin with the saved public scan.`,
        idempotencyKey: `start_audit:${orderId}`,
      });
    },
    handle_apify_event: async (env) => {
      const event = ApifyPayload.parse(env.payload);
      const [crawl] = await db.select().from(auditCrawls).where(eq(auditCrawls.runId, event.runId));
      if (!crawl) throw new AppError("not_found", "crawl run not recorded", { retryable: true });
      const status = event.status === "SUCCEEDED" ? "succeeded" : "failed";
      if ((crawl.status === "succeeded" || crawl.status === "failed") && crawl.status !== status) return;
      if (status === "succeeded" && !event.datasetId && !crawl.datasetId)
        throw new AppError("bad_request", "successful crawl has no dataset");
      if (crawl.status !== status) {
        await db
          .update(auditCrawls)
          .set({
            status,
            datasetId: event.datasetId ?? crawl.datasetId,
            costUsd: event.costUsd === null ? crawl.costUsd : event.costUsd.toFixed(6),
            finishedAt: new Date(),
          })
          .where(eq(auditCrawls.orderId, crawl.orderId));
        await rt.emit({
          actor: "provider:apify",
          type: status === "succeeded" ? "crawl.finished" : "crawl.failed",
          entityType: "order",
          entityId: crawl.orderId,
          payload: { runId: event.runId, status: event.status },
          ...(event.costUsd !== null ? { costUsd: event.costUsd } : {}),
        });
      }
      if (status === "failed") {
        await db
          .update(orders)
          .set({ state: "failed" })
          .where(and(eq(orders.id, crawl.orderId), eq(orders.state, "auditing")));
        return;
      }
      await startSession(session, {
        agent: "auditor",
        entity: { type: "order", id: crawl.orderId },
        message: `Public crawl ${event.runId} is ready for order ${crawl.orderId}. Read its pages and save the audit.`,
        idempotencyKey: `crawl_ready:${event.runId}`,
      });
    },
  };
}
