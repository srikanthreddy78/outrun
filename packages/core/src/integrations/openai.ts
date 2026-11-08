/** OpenAI Responses API with strict JSON-schema output. The smart tier. */
import { LLM_TIMEOUT_MS } from "../constants";
import { postJson } from "./http";
import type { LlmProvider, LlmRequest, LlmResult } from "./types";

interface ResponsesReply {
  model: string;
  output_text?: string;
  output?: { type: string; content?: { type: string; text?: string }[] }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function createOpenAiProvider(apiKey: string, baseUrl = "https://api.openai.com/v1"): LlmProvider {
  return {
    name: "openai",
    async complete(req: LlmRequest): Promise<LlmResult> {
      const r = await postJson<ResponsesReply>(
        `${baseUrl}/responses`,
        {
          model: req.model,
          ...(req.system ? { instructions: req.system } : {}),
          input: req.input,
          store: false,
          text: {
            format: {
              type: "json_schema",
              name: req.jsonSchema.name,
              schema: req.jsonSchema.schema,
              strict: true,
            },
          },
        },
        {
          headers: { authorization: `Bearer ${apiKey}` },
          timeoutMs: LLM_TIMEOUT_MS,
          provider: "openai",
          ...(req.signal ? { signal: req.signal } : {}),
        },
      );
      const text =
        r.output_text ??
        r.output
          ?.flatMap((o) => o.content ?? [])
          .filter((c) => c.type === "output_text")
          .map((c) => c.text ?? "")
          .join("") ??
        "";
      return {
        text,
        model: r.model ?? req.model,
        inputTokens: r.usage?.input_tokens ?? 0,
        outputTokens: r.usage?.output_tokens ?? 0,
      };
    },
  };
}
