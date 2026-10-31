import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractJson, MissingApiKeyError, OpenRouterDetector, strictJsonSchema, type ModelInfo } from "./llm";

const capable = async (): Promise<ModelInfo> => ({ structured: true, json: true, reasoning: true, maxOutput: null });

type Call = { url: string; body: Record<string, unknown> };

function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const next = responses.shift()!;
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ok = (content: unknown, cost = 0.01) =>
  Response.json({
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, cost },
  });

const answers = { answers: [{ id: "m1", entity: "p1", confidence: 0.9, why: "addressed as son" }] };
const input = {
  candidates: [{ id: "p1", name: "Steve Smith", role: "son" }],
  items: [{ id: "m1", document: "a.pdf", page: 1, context: "«Mr. Smith»", candidateIds: ["p1"] }],
};

describe("OpenRouterDetector", () => {
  it("sends a strict JSON schema, reasoning effort, and per-stage models", async () => {
    const { impl, calls } = fakeFetch([ok(answers)]);
    const llm = new OpenRouterDetector({ apiKey: "k", model: "anthropic/claude-opus-5.5", models: { resolve: "google/gemini-3.8-flash" }, fetch: impl, modelInfo: capable });
    expect(await llm.disambiguate(input)).toEqual(answers.answers);
    const body = calls[0].body as { model: string; response_format: { json_schema: { strict: boolean } }; reasoning: unknown; messages: { content: unknown }[] };
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(body.model).toBe("google/gemini-3.8-flash");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.reasoning).toEqual({ effort: "medium" });
    // Prompt caching markers only go to Anthropic models.
    expect(typeof body.messages[0].content).toBe("string");
    expect(llm.usage()).toEqual({ inputTokens: 100, outputTokens: 20, calls: 1, costUsd: 0.01 });
  });

  it("marks the system prompt cacheable for Anthropic models", async () => {
    const { impl, calls } = fakeFetch([ok({ findings: [] })]);
    await new OpenRouterDetector({ apiKey: "k", model: "anthropic/claude-sonnet-5.5", fetch: impl, modelInfo: capable }).scan({ policy: "p", known: [], blocks: [] });
    expect((calls[0].body.messages as { content: { cache_control: unknown }[] }[])[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("retries rate limits and malformed output, then succeeds", async () => {
    const { impl, calls } = fakeFetch([
      Response.json({ error: { message: "rate limited" } }, { status: 429 }),
      Response.json({ choices: [{ finish_reason: "stop", message: { content: "not json" } }] }),
      ok(answers),
    ]);
    const llm = new OpenRouterDetector({ apiKey: "k", fetch: impl, modelInfo: capable });
    expect(await llm.disambiguate(input)).toEqual(answers.answers);
    expect(calls).toHaveLength(3);
  }, 20_000);

  it("fails fast on a bad key", async () => {
    const { impl } = fakeFetch([Response.json({ error: { message: "No auth" } }, { status: 401 })]);
    await expect(new OpenRouterDetector({ apiKey: "bad", fetch: impl, modelInfo: capable }).disambiguate(input)).rejects.toBeInstanceOf(MissingApiKeyError);
  });

  it("puts the schema in the prompt for models without structured output", async () => {
    const { impl, calls } = fakeFetch([
      Response.json({ choices: [{ finish_reason: "stop", message: { content: "Here you go:\n```json\n" + JSON.stringify(answers) + "\n```" } }] }),
    ]);
    const llm = new OpenRouterDetector({
      apiKey: "k",
      model: "acme/small:free",
      fetch: impl,
      modelInfo: async () => ({ structured: false, json: true, reasoning: false, maxOutput: 8192 }),
    });
    expect(await llm.disambiguate(input)).toEqual(answers.answers);
    const body = calls[0].body as { max_tokens: number; response_format: unknown; reasoning?: unknown; messages: { content: string }[] };
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.reasoning).toBeUndefined();
    expect(body.max_tokens).toBe(8192);
    expect(body.messages[0].content).toContain("JSON Schema");
    expect(llm.concurrency).toBe(4);
  });

  it("requires a key", () => {
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    expect(() => new OpenRouterDetector()).toThrow(MissingApiKeyError);
    if (saved) process.env.OPENROUTER_API_KEY = saved;
  });
});

describe("extractJson", () => {
  it("finds the object inside prose or fences", () => {
    expect(extractJson('Sure! {"a": 1} Hope that helps.')).toBe('{"a": 1}');
    expect(extractJson('```json\n{"a": 1}\n```')).toBe('{"a": 1}');
  });
});

describe("strictJsonSchema", () => {
  it("closes every object and requires every property", () => {
    const schema = strictJsonSchema(z.object({ a: z.string(), b: z.object({ c: z.number().nullable() }) }));
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["a", "b"],
      properties: { b: { additionalProperties: false, required: ["c"] } },
    });
    expect(schema).not.toHaveProperty("$schema");
  });
});
