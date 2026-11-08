/**
 * The crew tool registry. `contracts/crew.ts` says which agents may call a tool and its
 * input and output; a tool file here says what it does. Our server enforces both:
 * an agent can only reach its own tools, inputs and outputs are validated, and results
 * are scrubbed. No tool may move money, set a price or delete data.
 */
import type { z } from "zod";
import {
  type AgentName,
  CREW_TOOLS,
  type CrewToolName,
  type ToolInput,
  type ToolOutput,
  toolsForMember,
} from "../../contracts";
import { OUTRUN_CLIENT_ID } from "../constants";
import { AppError } from "../errors";
import { scrubDeep } from "./scrub";
import type { ToolContext } from "./types";

export interface ToolDef<N extends CrewToolName = CrewToolName> {
  name: N;
  agents: readonly AgentName[];
  input: (typeof CREW_TOOLS)[N]["input"];
  output: (typeof CREW_TOOLS)[N]["output"];
  description: string;
  handler: (input: ToolInput<N>, ctx: ToolContext) => Promise<ToolOutput<N>>;
}

/**
 * Define a crew tool. `agents`, `input` and `output` default to the contract's and, when
 * given, must be exactly the contract's: tool files cannot widen who may call them.
 */
export function defineTool<N extends CrewToolName>(def: {
  name: N;
  agents?: readonly AgentName[];
  input?: (typeof CREW_TOOLS)[N]["input"];
  output?: (typeof CREW_TOOLS)[N]["output"];
  handler: ToolDef<N>["handler"];
}): ToolDef<N> {
  const contract = CREW_TOOLS[def.name];
  if (!contract) throw new Error(`unknown crew tool ${String(def.name)}`);
  const agents = def.agents ?? contract.agents;
  const same =
    agents.length === contract.agents.length && agents.every((a) => contract.agents.includes(a as never));
  if (!same) throw new Error(`tool ${def.name}: agents must match contracts/crew.ts`);
  if (def.input && def.input !== contract.input)
    throw new Error(`tool ${def.name}: input must be the contract's`);
  if (def.output && def.output !== contract.output)
    throw new Error(`tool ${def.name}: output must be the contract's`);
  return {
    name: def.name,
    agents,
    input: contract.input,
    output: contract.output,
    description: contract.description,
    handler: def.handler,
  };
}

export class ToolRegistry {
  private readonly tools = new Map<CrewToolName, ToolDef>();

  constructor(defs: readonly ToolDef<never>[] | readonly ToolDef[] = []) {
    for (const d of defs) this.register(d as unknown as ToolDef);
  }

  register(def: ToolDef): this {
    if (this.tools.has(def.name)) throw new Error(`tool ${def.name} registered twice`);
    this.tools.set(def.name, def);
    return this;
  }

  has(name: CrewToolName): boolean {
    return this.tools.has(name);
  }

  /** The tools this crew member may call that have an implementation. */
  forAgent(agent: AgentName, clientId: string = OUTRUN_CLIENT_ID): ToolDef[] {
    return toolsForMember(agent, clientId === OUTRUN_CLIENT_ID)
      .map((n) => this.tools.get(n))
      .filter((d): d is ToolDef => d !== undefined);
  }

  async call(agent: AgentName, name: string, rawInput: unknown, ctx: ToolContext): Promise<unknown> {
    const allowed = toolsForMember(agent, ctx.clientId === OUTRUN_CLIENT_ID) as string[];
    if (!allowed.includes(name)) throw new AppError("forbidden", `tool ${name} is not available to ${agent}`);
    const def = this.tools.get(name as CrewToolName);
    if (!def) throw new AppError("not_configured", `tool ${name} is not implemented yet`);

    const parsed = (def.input as z.ZodType).safeParse(rawInput ?? {});
    if (!parsed.success) throw new AppError("bad_request", `invalid input: ${summarize(parsed.error)}`);

    const result = await def.handler(parsed.data as never, { ...ctx, agent });
    const out = (def.output as z.ZodType).safeParse(result);
    if (!out.success) throw new AppError("internal", `tool ${name} returned an invalid result`);
    return scrubDeep(out.data);
  }
}

function summarize(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
