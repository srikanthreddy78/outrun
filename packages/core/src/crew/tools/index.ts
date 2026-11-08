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
import { followupsDueCount, outreachTools, type OutreachDeps } from "./outreach";
import { prospectingTools, type ProspectingDeps } from "./prospecting";

export { createCheckoutLink, ping, pipelineStatus, planDay };

/** Stands in when no runtime is wired (scripts that only list tools); calling it says so. */
const noOrders: CheckoutDeps = {
  stripe: {
    createCheckout: async () => {
      throw new AppError("not_configured", "checkout is not wired in this process");
    },
    payWithSharedToken: async () => {
      throw new AppError("not_configured", "payments are not wired in this process");
    },
  },
  emit: async () => {},
  appUrl: "http://localhost:3000",
};

export function allTools(opts: {
  settings: PipelineSettings;
  followupsDue?: FollowupsDue;
  orders?: CheckoutDeps;
  audit?: { apify: ApifyClient; appUrl: string; preflight?: (url: string) => Promise<unknown> };
  /** SH-5/7/8: the sdr's and closer's tools; with them, pipeline_status counts real follow-ups. */
  outreach?: OutreachDeps;
  /** SH-2/3: the prospector's and researcher's tools. */
  prospecting?: ProspectingDeps;
}): ToolDef[] {
  const followupsDue = opts.followupsDue ?? (opts.outreach ? followupsDueCount : undefined);
  return [
    ping,
    pipelineStatus(opts.settings, followupsDue),
    planDay(opts.settings, followupsDue),
    scanDomainTool,
    ...(opts.audit ? auditTools(opts.audit.apify, opts.audit.appUrl, opts.audit.preflight) : []),
    createCheckoutLink(opts.orders ?? noOrders),
    ...(opts.outreach ? outreachTools(opts.outreach) : []),
    ...(opts.prospecting ? prospectingTools(opts.prospecting) : []),
  ] as unknown as ToolDef[];
}
