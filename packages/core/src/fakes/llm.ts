import type { LlmProvider, LlmRequest, LlmResult } from "../integrations/types";

type Reply =
  Record<string, unknown> | string | Error | ((req: LlmRequest) => Record<string, unknown> | string | Error);

/** Scripted LLM provider. Replies are matched by the JSON schema name, then the `*` default. */
export class FakeLlmProvider implements LlmProvider {
  readonly calls: LlmRequest[] = [];
  constructor(
    readonly name: "openai" | "openrouter" | "fake" = "fake",
    private readonly replies: Record<string, Reply> = {},
    private readonly usage = {
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: undefined as number | undefined,
    },
  ) {}

  reply(schemaName: string, r: Reply): this {
    this.replies[schemaName] = r;
    return this;
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    this.calls.push(req);
    let r = this.replies[req.jsonSchema.name] ?? this.replies["*"];
    if (typeof r === "function") r = r(req);
    if (r === undefined)
      throw new Error(`FakeLlmProvider(${this.name}): no reply for ${req.jsonSchema.name}`);
    if (r instanceof Error) throw r;
    return {
      text: typeof r === "string" ? r : JSON.stringify(r),
      model: req.model,
      inputTokens: this.usage.inputTokens,
      outputTokens: this.usage.outputTokens,
      ...(this.usage.costUsd !== undefined ? { costUsd: this.usage.costUsd } : {}),
    };
  }
}
