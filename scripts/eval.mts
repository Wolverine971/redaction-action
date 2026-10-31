/**
 * Catch-rate score: runs detection on the synthetic corpus and grades it against the answer key.
 *
 *   pnpm eval                  # full pipeline (needs OPENROUTER_API_KEY; REDACTION_MODEL picks the model)
 *   pnpm eval --model google/gemini-3.8-flash   # try any OpenRouter model
 *   pnpm eval --patterns-only  # no model: SSN patterns only (baseline)
 *   pnpm eval --fresh          # ignore cached model answers and call the model again
 *
 * Model answers are cached per model and per exact input, so after a code change only calls whose
 * input changed hit the network. Re-scoring a pipeline change is usually free and takes seconds.
 *
 * Grades the AI's suggestions as if exported with no human review — the floor the reviewer starts from.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import nextEnv from "@next/env";
import { createHash } from "node:crypto";
import { OpenRouterDetector, type DetectorLLM, type Usage } from "../src/lib/detect/llm";
import { detect, type DetectionResult, type DraftMention, type InputDocument } from "../src/lib/detect/pipeline";
import { effectiveDecision } from "../src/lib/decisions";
import { extractPdf } from "../src/lib/pdf/extract";

nextEnv.loadEnvConfig(process.cwd());
const argv = process.argv.slice(2);
const args = new Set(argv);
const modelArg = argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : undefined;
const ROOT = path.join(process.cwd(), "eval");
const CORPUS = path.join(ROOT, "corpus");
const RESULTS = path.join(ROOT, "results");
mkdirSync(RESULTS, { recursive: true });

interface TruthSpan {
  page: number;
  text: string;
  occurrence: number;
  expected: "redact" | "keep";
  category: string;
  entityId?: string;
  ambiguous?: boolean;
}
interface Truth {
  entities: { id: string; type: string; canonical: string; redact: boolean }[];
  documents: { file: string; title?: string; pages: number; spans: TruthSpan[] }[];
}

const truth: Truth = JSON.parse(readFileSync(path.join(CORPUS, "truth.json"), "utf8"));

// 1. Extract every corpus PDF exactly as the app does.
const docs: InputDocument[] = truth.documents.map((d) => {
  const bytes = new Uint8Array(readFileSync(path.join(CORPUS, "pdfs", d.file)));
  return { key: d.file, name: d.file, blocks: extractPdf(bytes, d.file).blocks };
});
const pages = docs.reduce((n, d) => n + new Set(d.blocks.map((b) => b.page)).size, 0);

// 2. Detect (or reuse a saved run).
const mode = args.has("--patterns-only") ? "patterns-only" : "full";
const live = mode === "full" ? new OpenRouterDetector({ model: modelArg }) : null;
const model = live?.model ?? "none";
const slug = model.replace(/[^\w.-]+/g, "_");
const llm = live ? cached(live, path.join(RESULTS, `llm-cache-${slug}.json`), args.has("--fresh")) : null;

/** Wraps the model so identical inputs replay the saved answer instead of calling the API. */
function cached(inner: DetectorLLM, file: string, fresh: boolean): DetectorLLM & { hits: number } {
  const store: Record<string, unknown> = !fresh && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const save = () => writeFileSync(file, JSON.stringify(store));
  const wrap =
    <I, O>(name: string, fn: (input: I) => Promise<O>) =>
    async (input: I): Promise<O> => {
      const key = `${name}:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
      if (key in store) {
        wrapper.hits++;
        return store[key] as O;
      }
      const out = await fn(input);
      store[key] = out;
      save();
      return out;
    };
  const wrapper = {
    model: inner.model,
    concurrency: inner.concurrency,
    hits: 0,
    cast: wrap("cast", (i: Parameters<DetectorLLM["cast"]>[0]) => inner.cast(i)),
    scan: wrap("scan", (i: Parameters<DetectorLLM["scan"]>[0]) => inner.scan(i)),
    disambiguate: wrap("disambiguate", (i: Parameters<DetectorLLM["disambiguate"]>[0]) => inner.disambiguate(i)),
    usage: (): Usage => inner.usage(),
  };
  return wrapper;
}
const cachePath = path.join(RESULTS, `detection-${mode === "full" ? slug : mode}.json`);
const started = Date.now();
const result: DetectionResult = await detect(docs, llm, { onStage: (st) => void process.stdout.write(`  ${st}\n`) });
const seconds = (Date.now() - started) / 1000;
writeFileSync(cachePath, JSON.stringify({ result, seconds }, null, 1));
if (llm && "hits" in llm && llm.hits) console.log(`  (${llm.hits} model answers replayed from cache)`);

// 3. Decide each mention the way the AI judged it. (The app itself redacts everything it finds until a
// person keeps it; grading the AI's own redact/keep calls keeps this score about the model's judgment.)
const entities = new Map(result.entities.map((e) => [e.key, { status: e.suggestion }]));
const decided = result.mentions.map((m) => ({
  m,
  decision:
    m.aiDecision !== "inherit" && !(m.ambiguous && m.candidateKeys.some((k) => entities.get(k)?.status === "redact"))
      ? m.aiDecision
      : effectiveDecision(
          { entityId: m.entityKey, override: null, ambiguous: m.ambiguous, assignmentConfirmed: false, candidateEntityIds: m.candidateKeys },
          (id) => entities.get(id),
        ),
}));

// 4. Map each truth span to character positions in the extracted blocks.
// Page text = the page's blocks joined with spaces, whitespace collapsed — the same normalization the answer key uses.
interface Pos {
  blockId: string;
  offset: number;
}
function pageIndex(doc: InputDocument, page: number) {
  let text = "";
  const pos: Pos[] = [];
  let lastSpace = true;
  for (const b of doc.blocks.filter((x) => x.page === page)) {
    if (!lastSpace) {
      text += " ";
      pos.push({ blockId: b.id, offset: -1 });
      lastSpace = true;
    }
    for (let i = 0; i < b.text.length; i++) {
      const ch = /\s/.test(b.text[i]) ? " " : b.text[i];
      if (ch === " " && lastSpace) continue;
      text += ch;
      pos.push({ blockId: b.id, offset: i });
      lastSpace = ch === " ";
    }
  }
  return { text: text.trimEnd(), pos };
}
const pageCache = new Map<string, ReturnType<typeof pageIndex>>();
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function locate(doc: InputDocument, span: TruthSpan): Pos[] | null {
  const key = `${doc.key}:${span.page}`;
  if (!pageCache.has(key)) pageCache.set(key, pageIndex(doc, span.page));
  const { text, pos } = pageCache.get(key)!;
  const needle = norm(span.text);
  let at = -1;
  for (let n = 0; n <= span.occurrence; n++) {
    at = text.indexOf(needle, at + 1);
    if (at < 0) return null;
  }
  return pos.slice(at, at + needle.length).filter((p, i) => p.offset >= 0 && !/\s/.test(needle[i]));
}

const covering = (p: Pos, filter: (d: (typeof decided)[number]) => boolean) =>
  decided.filter((d) => d.m.blockId === p.blockId && p.offset >= d.m.start && p.offset < d.m.end && filter(d));

// 5. Grade.
type Outcome = "caught" | "partial" | "missed";
const byCategory = new Map<string, { total: number; caught: number; partial: number; flagged: number }>();
const misses: { file: string; page: number; text: string; category: string; outcome: Outcome }[] = [];
const falsePositives: { file: string; page: number; text: string; category: string }[] = [];
const sources = new Map<string, number>();
const truthSpansHit = new Set<DraftMention>();
const attribution: { correct: number; total: number; wrong: { text: string; file: string; page: number; expected: string; got: string }[] } = {
  correct: 0,
  total: 0,
  wrong: [],
};
let unlocated = 0;

// Which detected entity is which answer-key entity? Majority vote over unambiguous spans.
const votes = new Map<string, Map<string, number>>();
for (const doc of truth.documents) {
  const input = docs.find((d) => d.key === doc.file)!;
  for (const span of doc.spans) {
    if (span.expected !== "redact" || !span.entityId || span.ambiguous) continue;
    const located = locate(input, span);
    for (const p of located ?? []) {
      for (const d of covering(p, (x) => !!x.m.entityKey)) {
        const v = votes.get(d.m.entityKey!) ?? new Map();
        v.set(span.entityId, (v.get(span.entityId) ?? 0) + 1);
        votes.set(d.m.entityKey!, v);
      }
    }
  }
}
const truthIdFor = (key: string | null) => {
  if (!key || !votes.has(key)) return null;
  return [...votes.get(key)!].sort((a, b) => b[1] - a[1])[0][0];
};
const truthLabel = (id: string | null) => truth.entities.find((e) => e.id === id)?.canonical ?? id ?? "nobody";

for (const doc of truth.documents) {
  const input = docs.find((d) => d.key === doc.file)!;
  for (const span of doc.spans) {
    const located = locate(input, span);
    const cat = `${span.expected}:${span.category}`;
    const stat = byCategory.get(cat) ?? { total: 0, caught: 0, partial: 0, flagged: 0 };
    stat.total++;
    byCategory.set(cat, stat);
    if (!located || located.length === 0) {
      unlocated++;
      continue;
    }
    if (span.expected === "redact") {
      const covered = located.filter((p) => covering(p, (d) => d.decision === "redact").length > 0).length;
      const outcome: Outcome = covered === located.length ? "caught" : covered > 0 ? "partial" : "missed";
      if (outcome === "caught") stat.caught++;
      else if (outcome === "partial") stat.partial++;
      if (outcome !== "caught") misses.push({ file: doc.file, page: span.page, text: span.text, category: span.category, outcome });
      const hits = located.flatMap((p) => covering(p, (d) => d.decision === "redact"));
      for (const h of hits) truthSpansHit.add(h.m);
      if (outcome === "caught") {
        const src = [...new Set(hits.map((h) => h.m.source))].sort().join("+");
        sources.set(src, (sources.get(src) ?? 0) + 1);
      }
      if (span.ambiguous && span.entityId) {
        const m = hits[0]?.m;
        if (m) {
          attribution.total++;
          const got = truthIdFor(m.entityKey);
          if (got === span.entityId) attribution.correct++;
          else attribution.wrong.push({ text: span.text, file: doc.file, page: span.page, expected: truthLabel(span.entityId), got: truthLabel(got) });
        }
      }
    } else {
      const flagged = located.some((p) => covering(p, (d) => d.decision === "redact").length > 0);
      if (flagged) {
        stat.flagged++;
        falsePositives.push({ file: doc.file, page: span.page, text: span.text, category: span.category });
      }
    }
  }
}

const redactSpans = [...byCategory].filter(([k]) => k.startsWith("redact:"));
const totalRedact = redactSpans.reduce((n, [, s]) => n + s.total, 0);
const caught = redactSpans.reduce((n, [, s]) => n + s.caught, 0);
const partial = redactSpans.reduce((n, [, s]) => n + s.partial, 0);
const keepSpans = [...byCategory].filter(([k]) => k.startsWith("keep:"));
const totalKeep = keepSpans.reduce((n, [, s]) => n + s.total, 0);
const flagged = keepSpans.reduce((n, [, s]) => n + s.flagged, 0);
const redactMentions = decided.filter((d) => d.decision === "redact");
const extra = redactMentions.filter((d) => !truthSpansHit.has(d.m));

// Reviewer workload: how many decisions clear everything.
const ambiguousGroups = new Set(
  result.mentions.filter((m) => m.ambiguous).map((m) => `${m.text.toLowerCase()}|${m.entityKey}`),
).size;
const exceptions = result.mentions.filter((m) => !m.ambiguous && m.aiDecision !== "inherit").length;
const lowConfidence = result.mentions.filter((m) => !m.ambiguous && m.aiDecision === "inherit" && m.confidence < 0.5).length;

const cost = result.usage?.costUsd ?? 0;

const report = {
  ranAt: new Date().toISOString(),
  mode,
  model,
  corpus: { documents: docs.length, pages, redactSpans: totalRedact, keepSpans: totalKeep, unlocated },
  recall: { caught, partial, missed: totalRedact - caught - partial, rate: caught / totalRedact },
  falsePositiveRate: totalKeep ? flagged / totalKeep : 0,
  attribution: { ...attribution, rate: attribution.total ? attribution.correct / attribution.total : null },
  byCategory: Object.fromEntries(byCategory),
  caughtBySource: Object.fromEntries(sources),
  extraRedactions: { count: extra.length, samples: extra.slice(0, 25).map((d) => `${d.m.docKey} p.${d.m.page}: "${d.m.text}" (${d.m.source})`) },
  workload: {
    entities: result.entities.length,
    ambiguousGroups,
    exceptions,
    lowConfidence,
    decisions: result.entities.length + ambiguousGroups + exceptions + lowConfidence,
    mentions: result.mentions.length,
  },
  usage: result.usage,
  costUsd: Number(cost.toFixed(3)),
  seconds: Number(seconds.toFixed(1)),
  misses,
  falsePositives,
  warnings: result.warnings,
};

const stamp = report.ranAt.replace(/[:.]/g, "-");
const label = mode === "full" ? slug : mode;
writeFileSync(path.join(RESULTS, `${stamp}-${label}.json`), JSON.stringify(report, null, 2));
writeFileSync(path.join(RESULTS, `latest-${label}.json`), JSON.stringify(report, null, 2));

const p = (n: number) => `${(n * 100).toFixed(1)}%`;
const line = (k: string, v: string) => console.log(`  ${k.padEnd(34)}${v}`);
console.log(`\nCatch-rate score — ${mode}${model !== "none" ? ` (${model})` : ""}`);
console.log(`  ${docs.length} documents, ${pages} pages, ${totalRedact} things to redact, ${totalKeep} planted traps\n`);
line("Caught (fully redacted)", `${caught}/${totalRedact}  ${p(caught / totalRedact)}`);
line("Partially redacted", `${partial}`);
line("Missed", `${totalRedact - caught - partial}`);
line("Traps wrongly redacted", `${flagged}/${totalKeep}  ${p(totalKeep ? flagged / totalKeep : 0)}`);
if (attribution.total) line("Shared names attributed right", `${attribution.correct}/${attribution.total}  ${p(attribution.correct / attribution.total)}`);
line("Redactions not in the answer key", `${extra.length}`);
console.log("\n  By category");
for (const [k, s] of [...byCategory].sort()) {
  const [exp, cat] = k.split(":");
  line(`    ${exp === "redact" ? "redact" : "keep  "} ${cat}`, exp === "redact" ? `${s.caught}/${s.total} caught` : `${s.flagged}/${s.total} wrongly redacted`);
}
console.log("\n  Caught by (detector)");
for (const [k, n] of [...sources].sort((a, b) => b[1] - a[1])) line(`    ${k}`, String(n));
console.log("\n  Reviewer workload");
line("    Decisions to clear the batch", `${report.workload.decisions} (for ${result.mentions.length} mentions)`);
if (result.usage) line("\n  Model usage", `${result.usage.calls} calls, ${result.usage.inputTokens} in / ${result.usage.outputTokens} out, ~$${cost.toFixed(2)}, ${seconds.toFixed(0)}s`);
if (misses.length) {
  console.log("\n  Misses");
  for (const m of misses.slice(0, 30)) console.log(`    ${m.outcome.padEnd(8)}${m.category.padEnd(14)}${m.file} p.${m.page}  "${m.text}"`);
  if (misses.length > 30) console.log(`    …and ${misses.length - 30} more`);
}
if (falsePositives.length) {
  console.log("\n  Traps wrongly redacted");
  for (const f of falsePositives.slice(0, 20)) console.log(`    ${f.category.padEnd(14)}${f.file} p.${f.page}  "${f.text}"`);
}
if (attribution.wrong.length) {
  console.log("\n  Shared names attributed wrong");
  for (const w of attribution.wrong.slice(0, 15)) console.log(`    "${w.text}" ${w.file} p.${w.page}: expected ${w.expected}, got ${w.got}`);
}
if (unlocated) console.log(`\n  ⚠ ${unlocated} answer-key spans couldn't be located in the extracted text (corpus/extractor mismatch).`);
for (const w of result.warnings) console.log(`\n  ⚠ ${w}`);
console.log(`\nSaved ${path.relative(process.cwd(), path.join(RESULTS, `latest-${label}.json`))}`);
