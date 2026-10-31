import { DEFAULT_POLICY, MissingApiKeyError, OpenRouterDetector } from "@/lib/detect/llm";
import { jsonError } from "@/lib/server/reviewer";

export const maxDuration = 180;

/** The AI's quick look at page 1 of a dropped PDF: the first few people, addresses, and organizations. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { filename?: string; text?: string } | null;
  const text = body?.text?.slice(0, 12_000) ?? "";
  if (!text.trim()) return Response.json({ entities: [], seconds: 0 });
  let llm: OpenRouterDetector;
  try {
    llm = new OpenRouterDetector({ model: process.env.REDACTION_MODEL_PREVIEW || undefined, effort: "low", signal: request.signal });
  } catch (error) {
    if (error instanceof MissingApiKeyError) return Response.json({ entities: [], seconds: 0, note: "No OpenRouter key: names will be found once one is set." });
    throw error;
  }
  const started = Date.now();
  try {
    const cast = await llm.cast({ policy: DEFAULT_POLICY, documents: [{ name: body?.filename ?? "document.pdf", pages: [{ page: 1, text }] }] });
    const entities = cast
      .filter((e) => e.type !== "ssn" && /[\p{L}\d]/u.test(e.name) && !/^(none|n\/a|not found|unknown)\b/i.test(e.name))
      .map((e) => ({ type: e.type, label: e.name, role: e.role, redact: e.redact }));
    return Response.json({ entities, seconds: (Date.now() - started) / 1000 });
  } catch (error) {
    return jsonError(`Quick look failed: ${(error as Error).message}`, 502);
  }
}
