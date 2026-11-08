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

export { ping, pipelineStatus, planDay };

export function allTools(opts: {
  settings: PipelineSettings;
  followupsDue?: FollowupsDue;
  audit?: { apify: ApifyClient; appUrl: string };
}): ToolDef[] {
  return [
    ping,
    pipelineStatus(opts.settings, opts.followupsDue),
    planDay(opts.settings, opts.followupsDue),
    scanDomainTool,
    ...(opts.audit ? auditTools(opts.audit.apify, opts.audit.appUrl) : []),
  ] as unknown as ToolDef[];
}
