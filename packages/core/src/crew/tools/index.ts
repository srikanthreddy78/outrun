/**
 * Every crew tool, one file each. Each card that ships a tool adds it here:
 * SR-6 ping, pipeline_status · SR-8 create_checkout_link · SH-2..SH-8 · MT-2, MT-6.
 */
import type { ToolDef } from "../registry";
import { ping } from "./ping";
import { pipelineStatus, type FollowupsDue, type PipelineSettings } from "./pipeline_status";

export { ping, pipelineStatus };

export function allTools(opts: { settings: PipelineSettings; followupsDue?: FollowupsDue }): ToolDef[] {
  return [ping, pipelineStatus(opts.settings, opts.followupsDue)] as unknown as ToolDef[];
}
