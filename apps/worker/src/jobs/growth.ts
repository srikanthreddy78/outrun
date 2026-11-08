import { desc, eq } from "@outrun/core/db";
import { orders, scans } from "@outrun/core/db";
import type { Runtime } from "@outrun/core/runtime";
import type { Handlers } from "@outrun/core/queue";
import { growthRescanDue } from "@outrun/core/scan/growth";

export function growthHandlers(rt: Pick<Runtime, "db" | "queue" | "emit">): Handlers {
  return {
    growth_rescan: async () => {
      const now = new Date();
      const growthOrders = await rt.db.db.select().from(orders).where(eq(orders.product, "growth"));
      for (const order of growthOrders) {
        const [latest] = await rt.db.db
          .select({ id: scans.id, at: scans.createdAt })
          .from(scans)
          .where(eq(scans.domain, order.domain))
          .orderBy(desc(scans.createdAt))
          .limit(1);
        if (!growthRescanDue(order, latest?.at ?? null, now)) continue;
        const anchor = latest?.id ?? order.deliveredAt!.toISOString();
        const queued = await rt.queue.enqueue({
          type: "scan_domain",
          payload: { domain: order.domain, growthOrderId: order.id },
          idempotencyKey: `growth-rescan:${order.id}:${anchor}`,
          traceId: `growth-rescan-${order.id}`,
        });
        if (queued.jobId)
          await rt.emit({
            actor: "worker",
            type: "growth.rescan_queued",
            entityType: "order",
            entityId: order.id,
            payload: { domain: order.domain, scanId: latest?.id ?? null },
          });
      }
    },
  };
}
