/**
 * The real Stripe gateway (SR-8). Prices are found by lookup key, which `pnpm stripe:sync`
 * creates from PRODUCTS, so no price id or amount lives in code or env.
 */
import Stripe from "stripe";
import type { PaidProductKey } from "../../contracts";
import { PRODUCTS } from "../constants";
import { AppError } from "../errors";
import type { StripeGateway } from "./types";

export const STRIPE_API_VERSION = "2025-10-29.clover" as const;
/** Shared Payment Tokens are a preview API; this version is from Stripe's SPT seller docs. */
export const STRIPE_SPT_API_VERSION = "2026-09-30.preview";
export const priceLookupKey = (p: PaidProductKey): string => `outrun_${p}`;

export function stripeSdk(key: string): Stripe {
  return new Stripe(key, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 2, timeout: 20_000 });
}

/** Maps a Stripe SDK error onto our codes, keeping only its type and code (no request or response body). */
export function stripeError(err: unknown): AppError {
  const e = err as { type?: string; code?: string; statusCode?: number };
  const what = `stripe ${e.type ?? "error"}${e.code ? ` (${e.code})` : ""}`;
  if (e.type === "StripeRateLimitError" || e.statusCode === 429)
    return new AppError("rate_limited", what, { cause: err });
  if (e.type === "StripeConnectionError" || (e.statusCode ?? 0) >= 500)
    return new AppError("upstream_error", what, { cause: err });
  if (e.type === "StripeAuthenticationError") return new AppError("not_configured", what, { cause: err });
  if (e.type === "StripeIdempotencyError") return new AppError("conflict", what, { cause: err });
  if (e.type === "StripeCardError") return new AppError("bad_request", what, { cause: err });
  return new AppError("upstream_error", what, { cause: err, retryable: false });
}

export function createStripeGateway(key: string): StripeGateway {
  const stripe = stripeSdk(key);
  const priceIds = new Map<PaidProductKey, string>();

  async function priceFor(product: PaidProductKey): Promise<string> {
    const hit = priceIds.get(product);
    if (hit) return hit;
    const list = await stripe.prices.list({ lookup_keys: [priceLookupKey(product)], active: true, limit: 1 });
    const price = list.data[0];
    if (!price) {
      throw new AppError(
        "not_configured",
        `no Stripe price ${priceLookupKey(product)}; run pnpm stripe:sync`,
      );
    }
    if (price.unit_amount !== Math.round(PRODUCTS[product].priceUsd * 100)) {
      throw new AppError(
        "not_configured",
        `Stripe price ${priceLookupKey(product)} differs from PRODUCTS; run pnpm stripe:sync`,
      );
    }
    priceIds.set(product, price.id);
    return price.id;
  }

  return {
    async createCheckout(req) {
      try {
        const price = await priceFor(req.product);
        const subscription = PRODUCTS[req.product].interval === "month";
        const metadata = { orderId: req.orderId, product: req.product };
        const session = await stripe.checkout.sessions.create(
          {
            mode: subscription ? "subscription" : "payment",
            line_items: [{ price, quantity: 1 }],
            customer_email: req.customerEmail,
            client_reference_id: req.orderId,
            success_url: req.successUrl,
            cancel_url: req.cancelUrl,
            metadata,
            ...(subscription ? { subscription_data: { metadata } } : { payment_intent_data: { metadata } }),
          },
          { idempotencyKey: req.idempotencyKey },
        );
        if (!session.url) throw new AppError("upstream_error", "stripe returned a session without a url");
        return { checkoutId: session.id, url: session.url };
      } catch (err) {
        throw err instanceof AppError ? err : stripeError(err);
      }
    },

    async payWithSharedToken(req) {
      const spec = PRODUCTS[req.product];
      if (spec.interval !== "one_time")
        throw new AppError("bad_request", "a subscription is paid through Checkout");
      try {
        // The SDK has no types for the preview parameter, so this is a raw request on the same client.
        const res = await stripe.rawRequest(
          "POST",
          "/v1/payment_intents",
          {
            amount: Math.round(spec.priceUsd * 100),
            currency: "usd",
            confirm: true,
            payment_method_data: { shared_payment_granted_token: req.token },
            metadata: { orderId: req.orderId, product: req.product },
            description: `Outrun ${spec.name}`,
          },
          { apiVersion: STRIPE_SPT_API_VERSION, idempotencyKey: req.idempotencyKey },
        );
        const pi = res as unknown as { id?: string; status?: string };
        if (!pi.id) throw new AppError("upstream_error", "stripe returned a payment intent without an id");
        return { paymentIntentId: pi.id, status: pi.status ?? "unknown" };
      } catch (err) {
        throw err instanceof AppError ? err : stripeError(err);
      }
    },
  };
}
