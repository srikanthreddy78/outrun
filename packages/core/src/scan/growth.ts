const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** A Growth order becomes due 30 days after delivery or its latest public scan. */
export function growthRescanDue(
  order: { product: string; state: string; deliveredAt: Date | null },
  latestScanAt: Date | null,
  now: Date,
): boolean {
  if (order.product !== "growth" || order.state !== "delivered" || !order.deliveredAt) return false;
  const anchor = latestScanAt && latestScanAt > order.deliveredAt ? latestScanAt : order.deliveredAt;
  return now.getTime() - anchor.getTime() >= MONTH_MS;
}
