import { PRODUCTS } from "@outrun/core/constants";
import { getOrder } from "@outrun/core/orders";
import { notFound } from "next/navigation";
import { getRuntime } from "@/lib/runtime";

export const dynamic = "force-dynamic";

const STATE_TEXT: Record<string, string> = {
  pending: "Waiting for payment.",
  paid: "Paid. The audit starts in a moment.",
  auditing: "Paid. We're auditing the site now; the report link arrives by email.",
  delivered: "Delivered. The report link is in your email.",
  failed: "Something went wrong. We've been alerted and will email you.",
  canceled: "Checkout was canceled. Nothing was charged.",
  refunded: "Refunded.",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const order = await getOrder((await getRuntime()).db.db, id);
  if (!order) notFound();
  const product = PRODUCTS[order.product];
  return (
    <main
      style={{ maxWidth: 560, margin: "64px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}
    >
      <h1>
        {product.name} for {order.domain}
      </h1>
      <p>{STATE_TEXT[order.state] ?? order.state}</p>
      <p style={{ color: "#666" }}>
        Order {order.id} · ${Number(order.amountUsd)}
        {product.interval === "month" ? " a month" : ""}
      </p>
    </main>
  );
}
