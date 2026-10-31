import { z } from "zod";

/**
 * The three model calls the pipeline makes. The interface keeps the pipeline testable
 * with a fake, and lets the eval swap models. Calls go through OpenRouter, so each stage
 * can use a different model, with fallbacks.
 */
export interface DetectorLLM {
  /** The first-choice model (per stage when they differ). Fallbacks aren't listed here. */
  model: string;
  /** How many calls to run at once. Free models are rate-limited, so they get fewer. */
  concurrency?: number;
  cast(input: CastInput): Promise<CastEntity[]>;
  scan(input: ScanInput): Promise<ScanFinding[]>;
  disambiguate(input: DisambiguateInput): Promise<DisambiguateAnswer[]>;
  usage(): Usage;
  /** Things the operator should fix, e.g. a configured model that no longer exists. Shown as batch warnings. */
  notices?(): string[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  /** Dollars, as reported by OpenRouter. */
  costUsd?: number;
  /** Calls answered by each model. More than one entry means a fallback model stepped in. */
  models?: Record<string, number>;
}

export const DEFAULT_POLICY = `Redact:
- Names of private individuals (parties, witnesses, victims, family members, minors) in every form they appear: full name, first name alone, surname alone, initials, nicknames, "Mr./Ms. Surname", possessives, "SURNAME, FIRST".
- Home or personal addresses, full or partial (a street number and street name is enough).
- Social Security numbers, including masked or partial ones (e.g. "XXX-XX-1234", "SSN ending in 1234").
Keep (do not redact):
- Judges, court staff, attorneys of record, and police or other officials acting in their official role.
- Names that appear only as parties in citations to other court cases (e.g. "Smith v. Jones, 512 U.S. 218").
- Businesses, government agencies, and their business addresses.
- Other numbers: phone, case, account, routing, invoice, Bates numbers, dates.`;

const EntityType = z.enum(["person", "address", "ssn", "org"]);

const CastSchema = z.object({
  entities: z.array(
    z.object({
      id: z.string().describe("Short unique slug, e.g. john_smith or addr_elm_street"),
      type: EntityType,
      name: z.string().describe("Fullest form: full name, full address, or the SSN as written"),
      aliases: z
        .array(z.string())
        .describe("Every distinct way this entity is written in the documents, copied exactly"),
      role: z.string().describe('Who/what this is in the matter, e.g. "defendant", "son of John Smith; witness", "judge"'),
      redact: z.boolean().describe("Should this be redacted under the policy?"),
      why: z.string().describe("Reason for the redact decision, under 15 words"),
    }),
  ),
});
export type CastEntity = z.infer<typeof CastSchema>["entities"][number];

export interface CastInput {
  policy: string;
  documents: { name: string; pages: { page: number; text: string }[] }[];
}

const ScanSchema = z.object({
  findings: z.array(
    z.object({
      block: z.string().describe("Paragraph id, e.g. b12"),
      text: z.string().describe("The exact text of the mention, copied character-for-character from the paragraph"),
      entity: z.string().describe("Id of a known entity, or a new slug if it is not in the known list"),
      new_entity: z
        .object({ type: EntityType, name: z.string(), role: z.string(), redact: z.boolean() })
        .nullable()
        .describe("Only for entities not in the known list; otherwise null"),
      redact: z
        .boolean()
        .describe("Should THIS mention be redacted? False e.g. for a surname inside a citation to a different case"),
      certain: z
        .boolean()
        .describe("False if this text could refer to more than one known person and the context does not settle it"),
      note: z.string().nullable().describe("Short note when redact differs from the entity's default, else null"),
    }),
  ),
});
export type ScanFinding = z.infer<typeof ScanSchema>["findings"][number];

export interface ScanInput {
  policy: string;
  known: Pick<CastEntity, "id" | "type" | "name" | "role" | "redact">[];
  blocks: { id: string; document: string; page: number; text: string }[];
}

const DisambiguateSchema = z.object({
  answers: z.array(
    z.object({
      id: z.string(),
      entity: z.string().describe('Id of the person this mention refers to, or "unclear"'),
      confidence: z.number().describe("0 to 1"),
      why: z.string().describe("Under 15 words"),
    }),
  ),
});
export type DisambiguateAnswer = z.infer<typeof DisambiguateSchema>["answers"][number];

export interface DisambiguateInput {
  candidates: { id: string; name: string; role: string }[];
  items: { id: string; document: string; page: number; context: string; candidateIds: string[] }[];
}

const CAST_SYSTEM = `You are the first pass of a legal redaction tool. A human reviewer will approve or reject every suggestion, so list everything they need to decide on, including things you think should be kept.

Read the whole batch and list each distinct entity once:
- person: every individual named, including judges, attorneys and officers (mark those redact=false).
- address: each distinct street address, home or business (business addresses redact=false).
- ssn: each Social Security number, full or partial, as written; put the owner in "role" (e.g. "John Smith's SSN").
- org: businesses and agencies (redact=false).

People who share a surname (e.g. a father and son) are separate entities. Never merge two people.
Do not list parties who appear only in citations to other court cases.

For aliases, copy every variant exactly as it appears: full name, first name alone, surname alone, initials, nicknames, "Mr. Surname", "SURNAME, FIRST". If an alias is shared by two people (e.g. "Mr. Smith"), list it under both.`;

const SCAN_SYSTEM = `You are scanning a few pages of a legal document batch for a redaction tool. A first pass over the whole batch produced the list of known entities below. Your job is to find every mention on these pages, so nothing is missed.

Report every occurrence — including repeats in the same paragraph, possessives ("Smith's" → report "Smith"), names in headers, captions and signature blocks, and partial SSNs. Copy "text" exactly as it appears in the paragraph so it can be located by string search. Report the shortest span that names the entity (e.g. "John Smith", not "defendant John Smith,").

Attribution: use the known entity id. When a name like "Mr. Smith" could be more than one known person, use the surrounding text (who is speaking, who is being addressed, which relationship is described) to pick one, and set certain=false only if the context truly doesn't settle it.

Per-mention decision: redact follows the policy for that specific mention. A surname that appears inside a citation to a different case ("Smith v. Jones, 512 U.S. 218") is not the person in this matter: report it with redact=false and a note. The caption of this matter itself (e.g. "State v. John Smith") is the defendant: redact=true.

Do not report ordinary words that happen to match a name (e.g. "will" as a verb, "May" as a month).`;

const DISAMBIGUATE_SYSTEM = `You resolve ambiguous name mentions in legal documents. Several people share a name (e.g. a father and son both called "Mr. Smith"). For each mention, marked with «guillemets» in its context, decide which candidate it refers to, based on who is speaking or being addressed, relationships described, and nearby full names. Answer "unclear" when the context does not settle it; a wrong guess is worse than "unclear".`;

type Stage = "cast" | "scan" | "resolve";
type Effort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface OpenRouterOptions {
  apiKey?: string;
  /**
   * The model for every stage: any OpenRouter model id, or a list to try in order (the rest are
   * fallbacks). A comma-separated string works too. Defaults to REDACTION_MODEL, then DEFAULT_MODELS.
   */
  model?: string | string[];
  /** Per-stage overrides, e.g. a cheaper model for the page-by-page scan. Same format as `model`. */
  models?: Partial<Record<Stage, string | string[]>>;
  effort?: Effort;
  concurrency?: number;
  /** Cancels in-flight calls (e.g. when the browser abandons a quick look). */
  signal?: AbortSignal;
  fetch?: typeof fetch;
  /** Looks up what a model supports; defaults to OpenRouter's public model list. */
  modelInfo?: (model: string) => Promise<ModelInfo | null>;
}

export interface ModelInfo {
  /** Strict JSON-schema output. */
  structured: boolean;
  /** Plain JSON mode (no schema). */
  json: boolean;
  reasoning: boolean;
  maxOutput: number | null;
  /** Charges per token. A ":free" model listed as paid has started charging and is skipped. */
  paid?: boolean;
}

interface OpenRouterModelList {
  data: {
    id: string;
    supported_parameters?: string[];
    top_provider?: { max_completion_tokens?: number | null };
    pricing?: { prompt?: string; completion?: string };
  }[];
}

let modelList: Promise<Map<string, ModelInfo>> | null = null;
/** OpenRouter's public model list, fetched once per process. */
export function openRouterModelInfo(model: string): Promise<ModelInfo | null> {
  modelList ??= fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(15_000) })
    .then((r) => r.json())
    .then((json: OpenRouterModelList) => {
      const map = new Map<string, ModelInfo>();
      for (const m of json.data) {
        const params = new Set(m.supported_parameters ?? []);
        map.set(m.id, {
          structured: params.has("structured_outputs"),
          json: params.has("response_format"),
          reasoning: params.has("reasoning"),
          maxOutput: m.top_provider?.max_completion_tokens ?? null,
          paid: Number(m.pricing?.prompt ?? 0) > 0 || Number(m.pricing?.completion ?? 0) > 0,
        });
      }
      return map;
    })
    .catch(() => {
      modelList = null; // try again next time
      return new Map();
    });
  return modelList.then((map) => map.get(model) ?? null);
}

/**
 * Free models, tried in this order. Each call starts at the top and moves down when a model is gone,
 * has started charging, rejects the request, or keeps failing, so one free model going away doesn't
 * stop detection. Three labs on purpose, so one provider's outage doesn't take out the whole list.
 *
 * Checked 2026-10-31 with a real scan call on the eval corpus. Left out: thinkingmachines/inkling (refuses
 * apps like this one: "only available on agentic harnesses") and openrouter/free (a random free model each
 * call; it returned junk that passed the schema). Score a replacement with `pnpm eval --model <id>` first.
 */
export const DEFAULT_MODELS = [
  "nvidia/nemotron-3.5-super-vl:free", // 98.7% caught on the eval corpus
  "dots-studio/dots-3-note-preview:free", // good scan answers, ~75s per section
  "google/gemma-4-31b-it:free", // good scan answers, but slow and often rate-limited
];
export const DEFAULT_MODEL = DEFAULT_MODELS[0];
const TIMEOUT_MS: Record<Stage, number> = { cast: 5 * 60_000, scan: 4 * 60_000, resolve: 2 * 60_000 };
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
/** Tries per model for rate limits, timeouts and server errors. Fewer when another model can step in. */
const ATTEMPTS = { withFallback: 3, last: 6 };

/** "a, b" or ["a", "b"] → ["a", "b"]; empty → undefined. */
function parseModels(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const list = (Array.isArray(value) ? value : value.split(",")).map((m) => m.trim()).filter(Boolean);
  return list.length > 0 ? [...new Set(list)] : undefined;
}

const expectsFree = (model: string) => model.endsWith(":free") || model === "openrouter/free";

export class OpenRouterDetector implements DetectorLLM {
  readonly model: string;
  /** Models to try per stage, first choice first. */
  private readonly chains: Record<Stage, string[]>;
  private readonly effort: Effort;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly modelInfo: (model: string) => Promise<ModelInfo | null>;
  private readonly signal?: AbortSignal;
  readonly concurrency: number;
  private totals: Required<Usage> = { inputTokens: 0, outputTokens: 0, calls: 0, costUsd: 0, models: {} };
  /** Models that won't work again this run (removed, or no longer free): skipped from now on. */
  private readonly gone = new Map<string, string>();
  /** Models that ran out of retries: tried after the others from now on. */
  private readonly flaky = new Set<string>();

  constructor(options: OpenRouterOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new MissingApiKeyError();
    this.apiKey = apiKey;
    const base = parseModels(options.model) ?? parseModels(process.env.REDACTION_MODEL) ?? DEFAULT_MODELS;
    this.chains = {
      cast: parseModels(options.models?.cast) ?? parseModels(process.env.REDACTION_MODEL_CAST) ?? base,
      scan: parseModels(options.models?.scan) ?? parseModels(process.env.REDACTION_MODEL_SCAN) ?? base,
      resolve: parseModels(options.models?.resolve) ?? parseModels(process.env.REDACTION_MODEL_RESOLVE) ?? base,
    };
    const first = { cast: this.chains.cast[0], scan: this.chains.scan[0], resolve: this.chains.resolve[0] };
    const distinct = [...new Set(Object.values(first))];
    this.model = distinct.length === 1 ? distinct[0] : `cast=${first.cast}, scan=${first.scan}, resolve=${first.resolve}`;
    this.effort = options.effort ?? (process.env.REDACTION_EFFORT as Effort | undefined) ?? "medium";
    this.fetchImpl = options.fetch ?? fetch;
    this.modelInfo = options.modelInfo ?? openRouterModelInfo;
    this.signal = options.signal;
    const free = Object.values(this.chains).flat().some(expectsFree);
    this.concurrency = options.concurrency ?? (Number(process.env.REDACTION_CONCURRENCY) || (free ? 4 : 6));
  }

  usage(): Usage {
    return { ...this.totals, costUsd: Number(this.totals.costUsd.toFixed(4)), models: { ...this.totals.models } };
  }

  notices(): string[] {
    return [...this.gone].map(([model, why]) => `${model} ${why}, so other models were used. Update REDACTION_MODEL (or DEFAULT_MODELS in src/lib/detect/llm.ts).`);
  }

  /**
   * One JSON call. Tries each model in the stage's list until one answers; see `callModel` for retries.
   * A bad API key, a cancelled request, or an answer cut off for length stop right away: another model won't help.
   */
  private async call<T extends z.ZodType>(stage: Stage, schema: T, system: string, user: string, maxTokens: number): Promise<z.infer<T>> {
    const chain = this.chains[stage].filter((m) => !this.gone.has(m));
    const order = [...chain.filter((m) => !this.flaky.has(m)), ...chain.filter((m) => this.flaky.has(m))];
    if (order.length === 0) {
      throw new Error(`No model left to try: ${[...this.gone].map(([m, why]) => `${m} ${why}`).join("; ")}`);
    }
    const failures: string[] = [];
    for (const [i, model] of order.entries()) {
      const next = order[i + 1];
      try {
        return await this.callModel(model, stage, schema, system, user, maxTokens, next ? ATTEMPTS.withFallback : ATTEMPTS.last);
      } catch (error) {
        if (!(error instanceof ModelUnavailableError)) throw error;
        failures.push(error.message);
        if (error.gone) this.gone.set(model, error.gone);
        else this.flaky.add(model);
        if (next) console.warn(`[openrouter] ${stage}: ${error.message}; falling back to ${next}`);
      }
    }
    throw new Error(failures.length === 1 ? failures[0] : `Every model failed. ${failures.join(" | ")}`);
  }

  /**
   * One JSON call to one model, with retries for rate limits, server errors, and malformed output.
   * Models with strict structured output get the schema enforced; others (many free models)
   * get the schema in the prompt, and the answer is validated here either way.
   * Throws ModelUnavailableError when the next model in the list should get a try.
   */
  private async callModel<T extends z.ZodType>(
    model: string,
    stage: Stage,
    schema: T,
    system: string,
    user: string,
    maxTokens: number,
    attempts: number,
  ): Promise<z.infer<T>> {
    // Unknown models are assumed capable; OpenRouter will say so if not.
    const listed = await this.modelInfo(model);
    if (listed?.paid && expectsFree(model)) throw new ModelUnavailableError(`${model} is no longer free`, "has started charging");
    const info = listed ?? { structured: true, json: true, reasoning: true, maxOutput: null };
    const jsonSchema = strictJsonSchema(schema);
    const fullSystem = info.structured
      ? system
      : `${system}\n\nRespond with only a JSON object (no prose, no code fences) that matches this JSON Schema:\n${JSON.stringify(jsonSchema)}`;
    // The default free models need nothing here: there's no input cost to save, and most providers reuse a
    // repeated prompt prefix on their own. Claude models need an explicit marker to cache the system prompt
    // (it carries the known-entity list, resent with every scan section). That only matters if you switch
    // to a paid Claude model, e.g. for zero-data-retention on real client documents.
    const systemContent = model.startsWith("anthropic/")
      ? [{ type: "text", text: fullSystem, cache_control: { type: "ephemeral" } }]
      : fullSystem;
    const responseFormat = info.structured
      ? { type: "json_schema", json_schema: { name: `${stage}_result`, strict: true, schema: jsonSchema } }
      : info.json
        ? { type: "json_object" }
        : undefined;
    const body = {
      model,
      max_tokens: info.maxOutput ? Math.min(maxTokens, info.maxOutput) : maxTokens,
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: user },
      ],
      ...(responseFormat && { response_format: responseFormat }),
      ...(info.reasoning && { reasoning: { effort: this.effort } }),
      // Only route to providers that honor every parameter we send (notably the JSON format).
      provider: { require_parameters: true },
      usage: { include: true },
    };

    let lastError = `${model} didn't answer`;
    let retryAfterMs: number | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(retryAfterMs ?? Math.min(30_000, 1000 * 2 ** attempt + Math.random() * 500));
      retryAfterMs = null;
      let res: Response;
      try {
        res = await this.fetchImpl(ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "X-Title": "Redaction Action",
          },
          body: JSON.stringify(body),
          // Free endpoints occasionally leave a request hanging; give up and retry rather than wait forever.
          signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(TIMEOUT_MS[stage])]) : AbortSignal.timeout(TIMEOUT_MS[stage]),
        });
      } catch (error) {
        if (this.signal?.aborted) throw error; // cancelled by the caller: don't retry
        lastError = `${model}: ${(error as Error).message}`; // network error or timeout: retry
        console.warn(`[openrouter] ${stage} on ${model}: ${(error as Error).message}; retrying`);
        continue;
      }
      const json = (await res.json().catch(() => null)) as OpenRouterResponse | null;
      if (!res.ok || !json || json.error) {
        const message = json?.error?.message ?? `HTTP ${res.status}`;
        // The key is shared by every model, so no fallback can help.
        if (res.status === 401) throw new MissingApiKeyError(`OpenRouter rejected the API key (${message})`);
        if (res.status === 402) throw new ModelUnavailableError(`${model} needs credits (${message})`, "needs credits");
        if (res.status === 404 || /not a valid model/i.test(message)) {
          throw new ModelUnavailableError(`${model} is not on OpenRouter anymore (${message})`, "is no longer on OpenRouter");
        }
        // 400: this model can't take this request (too long, unsupported option). 403: its moderation flagged the input.
        if (res.status === 400 || res.status === 403) throw new ModelUnavailableError(`${model} rejected the request (${message})`);
        // 408, 429, 5xx: retry, waiting as long as the server asks (free models are rate-limited per minute).
        const retryAfter = Number(res.headers.get("retry-after"));
        if (retryAfter > 0) retryAfterMs = Math.min(65_000, retryAfter * 1000);
        else if (res.status === 429) retryAfterMs = 15_000 * attempt + 5_000;
        lastError = `${model}: ${message}`;
        console.warn(`[openrouter] ${stage} on ${model}: HTTP ${res.status} (${message}); retrying`);
        continue;
      }
      this.totals.calls++;
      this.totals.inputTokens += json.usage?.prompt_tokens ?? 0;
      this.totals.outputTokens += json.usage?.completion_tokens ?? 0;
      this.totals.costUsd += json.usage?.cost ?? 0;
      const choice = json.choices?.[0];
      // The pipeline splits the section in half and tries again, which works better than another model.
      if (choice?.finish_reason === "length") throw new Error(`${model}'s answer was cut off (max_tokens). Try smaller chunks.`);
      if (choice?.message?.refusal) throw new ModelUnavailableError(`${model} declined: ${choice.message.refusal}`);
      try {
        const parsed = schema.parse(JSON.parse(extractJson(choice?.message?.content ?? "")));
        // openrouter/free reports which free model actually answered.
        const answeredBy = json.model && json.model !== model ? `${model} → ${json.model}` : model;
        this.totals.models[answeredBy] = (this.totals.models[answeredBy] ?? 0) + 1;
        return parsed;
      } catch (error) {
        lastError = `${model} returned output that didn't match the schema: ${(error as Error).message.slice(0, 200)}`;
      }
    }
    throw new ModelUnavailableError(lastError);
  }

  async cast(input: CastInput): Promise<CastEntity[]> {
    const docs = input.documents
      .map(
        (d) =>
          `<document name="${d.name}">\n${d.pages.map((p) => `<page number="${p.page}">\n${p.text}\n</page>`).join("\n")}\n</document>`,
      )
      .join("\n\n");
    const out = await this.call(
      "cast",
      CastSchema,
      `${CAST_SYSTEM}\n\n<policy>\n${input.policy}\n</policy>`,
      `${docs}\n\nList every entity in these documents.`,
      64000,
    );
    return out.entities;
  }

  async scan(input: ScanInput): Promise<ScanFinding[]> {
    const known = input.known
      .map((e) => `- ${e.id} [${e.type}] ${e.name} — ${e.role}${e.redact ? "" : " (keep)"}`)
      .join("\n");
    const blocks = input.blocks
      .map((b) => `<p id="${b.id}" document="${b.document}" page="${b.page}">\n${b.text}\n</p>`)
      .join("\n");
    // Known entities go in the system prompt, so every section's call starts with the same text
    // (providers that cache a repeated prefix only pay to read it once).
    const firstPass =
      input.known.length === 0
        ? "\n\nThere is no list of known entities: this is the only pass. Give each distinct person, address, SSN, and organization a short slug id, fill new_entity on its first mention, and reuse the same id for every later mention."
        : "";
    const out = await this.call(
      "scan",
      ScanSchema,
      `${SCAN_SYSTEM}${firstPass}\n\n<policy>\n${input.policy}\n</policy>\n\n<known_entities>\n${known}\n</known_entities>`,
      `${blocks}\n\nReport every mention in these paragraphs.`,
      32000,
    );
    return out.findings;
  }

  async disambiguate(input: DisambiguateInput): Promise<DisambiguateAnswer[]> {
    const candidates = input.candidates.map((c) => `- ${c.id}: ${c.name} — ${c.role}`).join("\n");
    const items = input.items
      .map(
        (i) =>
          `<mention id="${i.id}" document="${i.document}" page="${i.page}" candidates="${i.candidateIds.join(", ")}">\n${i.context}\n</mention>`,
      )
      .join("\n");
    const out = await this.call(
      "resolve",
      DisambiguateSchema,
      DISAMBIGUATE_SYSTEM,
      `<people>\n${candidates}\n</people>\n\n${items}\n\nWho does each marked mention refer to?`,
      16000,
    );
    return out.answers;
  }
}

export class MissingApiKeyError extends Error {
  constructor(message = "OPENROUTER_API_KEY is not set") {
    super(message);
  }
}

/** This model can't answer this call; the next one in the list should try. */
class ModelUnavailableError extends Error {
  /** Set when the model won't work again this run (removed, no longer free): the reason, for the batch warning. */
  readonly gone?: string;
  constructor(message: string, gone?: string) {
    super(message);
    this.gone = gone;
  }
}

interface OpenRouterResponse {
  model?: string;
  choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string; code?: number };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The JSON object in a reply, tolerating code fences or a sentence before/after it. */
export function extractJson(text: string): string {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  return start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced;
}

/**
 * JSON Schema for strict structured output: every object closed and every property required
 * (optional values are expressed as nullable instead).
 */
export function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const obj = node as Record<string, unknown>;
    if (obj.type === "object" && obj.properties && typeof obj.properties === "object") {
      obj.additionalProperties = false;
      obj.required = Object.keys(obj.properties);
    }
    Object.values(obj).forEach(visit);
  };
  visit(json);
  return json;
}

export function hasModelCredentials(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}
