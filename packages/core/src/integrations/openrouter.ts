/** OpenRouter chat completions with JSON-schema output. The bulk tier and the fallback. */
import { LLM_TIMEOUT_MS } from "../constants";
import { postJson } from "./http";
import type { LlmProvider, LlmRequest, LlmResult } from "./types";

interface ChatReply {
  model: string;
  choices: { message: { content: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

export function createOpenRouterProvider(
  apiKey: string,
  appUrl: string,
  baseUrl = "https://openrouter.ai/api/v1",
): LlmProvider {
  return {
    name: "openrouter",
    async complete(req: LlmRequest): Promise<LlmResult> {
      const messages = [
        ...(req.system ? [{ role: "system", content: req.system }] : []),
        { role: "user", content: req.input },
      ];
      const r = await postJson<ChatReply>(
        `${baseUrl}/chat/completions`,
        {
          model: req.model,
          messages,
          response_format: {
            type: "json_schema",
            json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: true },
          },
          usage: { include: true },
        },
        {
          headers: { authorization: `Bearer ${apiKey}`, "http-referer": appUrl, "x-title": "Outrun" },
          timeoutMs: LLM_TIMEOUT_MS,
          provider: "openrouter",
          ...(req.signal ? { signal: req.signal } : {}),
        },
      );
      return {
        text: r.choices[0]?.message.content ?? "",
        model: r.model ?? req.model,
        inputTokens: r.usage?.prompt_tokens ?? 0,
        outputTokens: r.usage?.completion_tokens ?? 0,
        ...(typeof r.usage?.cost === "number" ? { costUsd: r.usage.cost } : {}),
      };
    },
  };
}
