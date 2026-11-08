import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppError } from "../errors";
import { createOpenAiProvider } from "./openai";
import { createOpenRouterProvider } from "./openrouter";

const schema = {
  name: "t",
  schema: {
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a"],
    additionalProperties: false,
  },
};
const stub = (status: number, body: unknown) => {
  const fn = vi.fn(
    async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
};
afterEach(() => vi.unstubAllGlobals());

describe("OpenAI provider", () => {
  it("sends a strict json_schema Responses request and reads usage", async () => {
    const f = stub(200, {
      model: "gpt-5.5",
      output_text: '{"a":"x"}',
      usage: { input_tokens: 10, output_tokens: 3 },
    });
    const r = await createOpenAiProvider("key").complete({
      model: "gpt-5.5",
      system: "be terse",
      input: "hi",
      jsonSchema: schema,
    });
    expect(r).toEqual({ text: '{"a":"x"}', model: "gpt-5.5", inputTokens: 10, outputTokens: 3 });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: "gpt-5.5",
      instructions: "be terse",
      store: false,
      text: { format: { type: "json_schema", strict: true } },
    });
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer key");
  });

  it("maps 429 to a retryable rate_limited error and 400 to a terminal one", async () => {
    stub(429, {});
    const a = (await createOpenAiProvider("k")
      .complete({ model: "m", input: "i", jsonSchema: schema })
      .catch((e: unknown) => e)) as AppError;
    expect([a.code, a.retryable]).toEqual(["rate_limited", true]);
    stub(400, { error: "bad" });
    const b = (await createOpenAiProvider("k")
      .complete({ model: "m", input: "i", jsonSchema: schema })
      .catch((e: unknown) => e)) as AppError;
    expect([b.code, b.retryable]).toEqual(["upstream_error", false]);
  });
});

describe("OpenRouter provider", () => {
  it("asks for usage and returns the provider's cost", async () => {
    const f = stub(200, {
      model: "openai/gpt-5.4-mini",
      choices: [{ message: { content: '{"a":"y"}' } }],
      usage: { prompt_tokens: 5, completion_tokens: 2, cost: 0.0001 },
    });
    const r = await createOpenRouterProvider("k", "https://outrun.example").complete({
      model: "openai/gpt-5.4-mini",
      input: "i",
      jsonSchema: schema,
    });
    expect(r).toEqual({
      text: '{"a":"y"}',
      model: "openai/gpt-5.4-mini",
      inputTokens: 5,
      outputTokens: 2,
      costUsd: 0.0001,
    });
    const body = JSON.parse(String(f.mock.calls[0]![1].body));
    expect(body).toMatchObject({ usage: { include: true }, response_format: { type: "json_schema" } });
  });
});
