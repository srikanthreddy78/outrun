/**
 * pnpm stripe:sync [--live] [--dry-run]
 *
 * Makes Stripe match PRODUCTS: one Product per paid product (found by metadata.outrun_key) and
 * one active Price per product under the lookup key the gateway reads (outrun_<key>). A price
 * whose amount or interval changed is replaced: the new price takes over the lookup key and the
 * old one is archived. Refuses a live key unless --live is passed.
 */
import type Stripe from "stripe";
import type { PaidProductKey } from "../packages/core/contracts";
import { PRODUCTS } from "../packages/core/src/constants";
import { priceLookupKey, stripeSdk } from "../packages/core/src/integrations/stripe";

const PAID: PaidProductKey[] = ["auditKit", "growth"];

async function main() {
  const live = process.argv.includes("--live");
  const dry = process.argv.includes("--dry-run");
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  const isLiveKey = /^(sk|rk)_live_/.test(key);
  if (isLiveKey && !live) throw new Error("this is a live key; pass --live to sync live mode");
  if (!isLiveKey && live) throw new Error("--live was passed with a test key");
  const stripe = stripeSdk(key);

  for (const k of PAID) {
    const spec = PRODUCTS[k];
    const amount = Math.round(spec.priceUsd * 100);
    const recurring = spec.interval === "month" ? { interval: "month" as const } : undefined;
    const name = `Outrun ${spec.name}`;
    const description = spec.deliverables.join(" · ");

    const found = await stripe.products.search({ query: `metadata['outrun_key']:'${k}'`, limit: 1 });
    let product: Stripe.Product | undefined = found.data[0];
    if (!product) {
      console.log(`create product ${name}`);
      if (!dry) {
        product = await stripe.products.create(
          { name, description, metadata: { outrun_key: k } },
          { idempotencyKey: `outrun-product-${k}` },
        );
      }
    } else if (product.name !== name || product.description !== description || !product.active) {
      console.log(`update product ${name}`);
      if (!dry) product = await stripe.products.update(product.id, { name, description, active: true });
    }

    const [current] = (await stripe.prices.list({ lookup_keys: [priceLookupKey(k)], limit: 1 })).data;
    const productId = product?.id;
    const same = (p: Stripe.Price) =>
      p.active &&
      p.unit_amount === amount &&
      p.currency === "usd" &&
      (p.recurring?.interval ?? null) === (recurring?.interval ?? null) &&
      (typeof p.product === "string" ? p.product : p.product.id) === productId;
    const label = `${priceLookupKey(k)} = $${spec.priceUsd}${recurring ? "/mo" : ""}`;
    if (current && same(current)) {
      console.log(`ok     ${label}`);
      continue;
    }
    console.log(`price  ${label}${current ? " (replacing the old price)" : ""}`);
    if (dry || !productId) continue;
    await stripe.prices.create({
      product: productId,
      currency: "usd",
      unit_amount: amount,
      ...(recurring ? { recurring } : {}),
      lookup_key: priceLookupKey(k),
      transfer_lookup_key: true,
      metadata: { outrun_key: k },
    });
    if (current) await stripe.prices.update(current.id, { active: false });
  }
  console.log(dry ? "dry run: nothing changed" : "Stripe matches PRODUCTS");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
