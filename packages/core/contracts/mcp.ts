/** The five tools on the public MCP server (/api/mcp) that customers' agents call. */
import { z } from "zod";
import { Domain, Email, Id, IsoDateTime } from "./common";
import { OrderState, PaidProductKey } from "./domain";
import { ScoreResponse } from "./api";
import { ClientSlug, ClientStatus } from "./clients";

export const PUBLIC_TOOLS = {
  get_readiness_score: {
    description: "Agent-readiness score and checks for a domain.",
    input: z.object({ domain: Domain }),
    output: ScoreResponse,
  },
  get_quote: {
    description: "Price and deliverables for a package for a domain.",
    input: z.object({ domain: Domain, package: PaidProductKey }),
    output: z.object({
      domain: Domain,
      package: PaidProductKey,
      priceUsd: z.number(),
      interval: z.enum(["one_time", "month"]),
      deliverables: z.array(z.string()),
    }),
  },
  buy_audit: {
    description:
      "Creates an order and returns a Stripe Checkout URL. Idempotent on idempotencyKey. An agent holding a Stripe Shared Payment Token for this seller may pass it to pay an Audit + Kit without a browser; checkoutUrl is then the order's status page.",
    input: z.object({
      domain: Domain,
      package: PaidProductKey,
      contactEmail: Email,
      idempotencyKey: z.string().min(8).max(200),
      /** SR-12: a Stripe Shared Payment Token (spt_…) granted to us. Ignored, with Checkout returned, while agent payments are off or for Growth. */
      sharedPaymentToken: z
        .string()
        .regex(/^spt_[A-Za-z0-9_]{4,200}$/)
        .optional(),
    }),
    output: z.object({ orderId: Id, checkoutUrl: z.url() }),
  },
  get_order_status: {
    description: "State of an order, and the report link once delivered.",
    input: z.object({ orderId: Id }),
    output: z.object({
      orderId: Id,
      state: OrderState,
      reportUrl: z.url().nullable(),
      updatedAt: IsoDateTime,
    }),
  },
  hire_agency: {
    description:
      "Hire Outrun's agency to run outbound marketing for a company: a free trial, no payment. The company gets its own crew of six agents, which drafts its profile from its site; Outrun's owner confirms the profile before anything is sent, and the approver gets a portal link to approve every email. Idempotent on the domain; the approver's email must be at that domain.",
    input: z.object({
      companyName: z.string().trim().min(1).max(80),
      domain: Domain,
      approverEmail: Email,
    }),
    output: z.object({
      clientId: Id,
      slug: ClientSlug,
      status: ClientStatus,
      /** false when the domain was already a client: nothing new was created. */
      created: z.boolean(),
      portalUrl: z.url(),
    }),
  },
} as const;
export type PublicToolName = keyof typeof PUBLIC_TOOLS;
