/**
 * Every crew tool, one file each. Each card that ships a tool adds it here:
 * SR-6 ping, pipeline_status, plan_day · SR-8 create_checkout_link · SH-2..SH-8 · MT-2, MT-6.
 */
import type { ToolDef } from "../registry";
import type { ApifyClient } from "../../integrations/types";
import { auditTools } from "./audit";
import { scanDomainTool } from "./scan_domain";
import { ping } from "./ping";
import { pipelineStatus, type FollowupsDue, type PipelineSettings } from "./pipeline_status";
import { planDay } from "./plan_day";
import { createCheckoutLink, type CheckoutDeps } from "./create_checkout_link";
import { AppError } from "../../errors";

export { createCheckoutLink, ping, pipelineStatus, planDay };

/** Stands in when no runtime is wired (scripts that only list tools); calling it says so. */
const noOrders: CheckoutDeps = {
  stripe: {
    createCheckout: async () => {
      throw new AppError("not_configured", "checkout is not wired in this process");
    },
  },
  emit: async () => {},
  appUrl: "http://localhost:3000",
};

export function allTools(opts: {
  settings: PipelineSettings;
  followupsDue?: FollowupsDue;
  orders?: CheckoutDeps;
  audit?: { apify: ApifyClient; appUrl: string };
}): ToolDef[] {
  return [
    ping,
    pipelineStatus(opts.settings, opts.followupsDue),
    planDay(opts.settings, opts.followupsDue),
    createCheckoutLink(opts.orders ?? noOrders),
    scanDomainTool,
    ...(opts.audit ? auditTools(opts.audit.apify, opts.audit.appUrl) : []),
  ] as unknown as ToolDef[];
}
