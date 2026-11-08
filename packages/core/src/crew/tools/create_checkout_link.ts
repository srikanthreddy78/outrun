/**
 * outrun.create_checkout_link (closer, SR-8): a Stripe Checkout link at the listed price for a
 * prospect. The closer names the prospect and the product, never a price or an email address;
 * the order is created once per prospect and product, so asking twice returns the same link.
 */
import { eq } from "drizzle-orm";
import { priceOf } from "../../constants";
import { companies, contacts, prospects } from "../../db/schema";
import { AppError } from "../../errors";
import type { Emit } from "../../events";
import type { StripeGateway } from "../../integrations/types";
import { checkoutFor, createOrder } from "../../orders";
import { defineTool } from "../registry";

export interface CheckoutDeps {
  stripe: StripeGateway;
  emit: Emit;
  appUrl: string;
}

export function createCheckoutLink(deps: CheckoutDeps) {
  return defineTool({
    name: "create_checkout_link",
    handler: async (input, ctx) => {
      const [row] = await ctx.db
        .select({ domain: companies.domain, email: contacts.email, suppressed: contacts.suppressed })
        .from(prospects)
        .innerJoin(companies, eq(companies.id, prospects.companyId))
        .leftJoin(contacts, eq(contacts.id, prospects.contactId))
        .where(eq(prospects.id, input.prospectId));
      if (!row) throw new AppError("not_found", `prospect ${input.prospectId} not found`);
      if (!row.email) throw new AppError("bad_request", "the prospect has no contact to bill");
      if (row.suppressed) throw new AppError("suppressed", "the prospect's contact is suppressed");
      const orderDeps = { db: ctx.db, emit: deps.emit };
      const order = await createOrder(orderDeps, {
        domain: row.domain,
        product: input.product,
        contactEmail: row.email,
        prospectId: input.prospectId,
        idempotencyKey: `closer:${input.prospectId}:${input.product}`,
        actor: `naive:${ctx.agent}`,
      });
      const { url } = await checkoutFor({ ...orderDeps, stripe: deps.stripe, appUrl: deps.appUrl }, order);
      return { orderId: order.id, checkoutUrl: url, priceUsd: priceOf(input.product) };
    },
  });
}
