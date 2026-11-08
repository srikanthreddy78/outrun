import { defineTool } from "../registry";

export const ping = defineTool({
  name: "ping",
  handler: async (_input, ctx) => ({ ok: true as const, agent: ctx.agent, ts: ctx.now().toISOString() }),
});
