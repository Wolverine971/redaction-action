import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_MODELS, extractJson, MissingApiKeyError, OpenRouterDetector, strictJsonSchema, type ModelInfo } from "./llm";

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
    const llm = new OpenRouterDetector({ apiKey: "k", model: "nvidia/nemotron-3.5-super-vl:free", models: { resolve: "google/gemini-3.8-flash" }, fetch: impl, modelInfo: capable });
    expect(await llm.disambiguate(input)).toEqual(answers.answers);
    const body = calls[0].body as { model: string; response_format: { json_schema: { strict: boolean } }; reasoning: unknown; messages: { content: unknown }[] };
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(body.model).toBe("google/gemini-3.8-flash");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.reasoning).toEqual({ effort: "medium" });
    // Prompt caching markers only go to Claude models.
    expect(typeof body.messages[0].content).toBe("string");
    expect(llm.usage()).toEqual({ inputTokens: 100, outputTokens: 20, calls: 1, costUsd: 0.01, models: { "google/gemini-3.8-flash": 1 } });
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

  it("falls back when a model is gone, and skips it for the rest of the run", async () => {
    const gone = () => Response.json({ error: { message: "acme/old:free is not a valid model ID", code: 400 } }, { status: 400 });
    const { impl, calls } = fakeFetch([gone(), ok(answers), ok(answers)]);
    const llm = new OpenRouterDetector({ apiKey: "k", model: "acme/old:free, acme/new:free", fetch: impl, modelInfo: capable });
    expect(await llm.disambiguate(input)).toEqual(answers.answers);
    expect(await llm.disambiguate(input)).toEqual(answers.answers);
    expect(calls.map((c) => c.body.model)).toEqual(["acme/old:free", "acme/new:free", "acme/new:free"]);
    expect(llm.model).toBe("acme/old:free");
    expect(llm.usage().models).toEqual({ "acme/new:free": 2 });
    expect(llm.notices()).toEqual([expect.stringContaining("acme/old:free is no longer on OpenRouter")]);
  });

  it("skips a free model that has started charging, without calling it", async () => {
    const { impl, calls } = fakeFetch([ok(answers)]);
    const llm = new OpenRouterDetector({
      apiKey: "k",
      model: ["acme/a:free", "acme/b:free"],
      fetch: impl,
      modelInfo: async (m) => ({ structured: true, json: true, reasoning: false, maxOutput: null, paid: m === "acme/a:free" }),
    });
    expect(await llm.disambiguate(input)).toEqual(answers.answers);
    expect(calls.map((c) => c.body.model)).toEqual(["acme/b:free"]);
    expect(llm.notices()).toEqual([expect.stringContaining("acme/a:free has started charging")]);
  });

  it("falls back after a model keeps failing", async () => {
    const down = () => Response.json({ error: { message: "upstream down" } }, { status: 503, headers: { "retry-after": "0.01" } });
    const { impl, calls } = fakeFetch([down(), down(), down(), ok(answers)]);
    const llm = new OpenRouterDetector({ apiKey: "k", model: "acme/a:free,acme/b:free", fetch: impl, modelInfo: capable });
    expect(await llm.disambiguate(input)).toEqual(answers.answers);
    expect(calls.map((c) => c.body.model)).toEqual(["acme/a:free", "acme/a:free", "acme/a:free", "acme/b:free"]);
    // A flaky model isn't reported: it may be back for the next batch.
    expect(llm.notices()).toEqual([]);
  });

  it("names every model when all of them fail", async () => {
    const reject = (m: string) => Response.json({ error: { message: `${m} is not a valid model ID` } }, { status: 400 });
    const { impl } = fakeFetch([reject("acme/a:free"), reject("acme/b:free")]);
    const llm = new OpenRouterDetector({ apiKey: "k", model: "acme/a:free,acme/b:free", fetch: impl, modelInfo: capable });
    await expect(llm.disambiguate(input)).rejects.toThrow(/Every model failed.*acme\/a:free.*acme\/b:free/);
  });

  it("doesn't try other models with a bad key", async () => {
    const { impl, calls } = fakeFetch([Response.json({ error: { message: "No auth" } }, { status: 401 })]);
    const llm = new OpenRouterDetector({ apiKey: "bad", model: "acme/a:free,acme/b:free", fetch: impl, modelInfo: capable });
    await expect(llm.disambiguate(input)).rejects.toBeInstanceOf(MissingApiKeyError);
    expect(calls).toHaveLength(1);
  });

  it("uses the built-in free list by default", () => {
    const saved = process.env.REDACTION_MODEL;
    delete process.env.REDACTION_MODEL;
    const llm = new OpenRouterDetector({ apiKey: "k" });
    if (saved !== undefined) process.env.REDACTION_MODEL = saved;
    expect(llm.model).toBe(DEFAULT_MODELS[0]);
    expect(DEFAULT_MODELS.length).toBeGreaterThan(1);
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
