import type { Decision, EntityType, MentionSource } from "@/db/schema";
import {
  addressVariants,
  aliasKey,
  compileAliases,
  findAliases,
  isAliasOf,
  isCommonWord,
  isNameInContext,
  isPartOfOtherName,
  isSearchableAlias,
  personKey,
  personPatterns,
  personVariants,
  withHonorific,
  withPossessive,
} from "./aliases";
import { DEFAULT_POLICY, MissingApiKeyError, type CastEntity, type DetectorLLM, type ScanFinding, type Usage } from "./llm";
import { findCaseCitations, findSsns } from "./patterns";
import { SECTION_CHARS, splitSections } from "./sections";
import type { CallTiming } from "@/lib/estimate";

/**
 * The detection pipeline, independent of the database so the eval and tests can run it directly.
 *
 *   1. Patterns   – SSNs in every format (no model).
 *   2. Cast       – one model call over the whole batch: who and what is in these documents.
 *   3. Scan       – model calls over a few pages at a time: every mention, attributed in context.
 *   4. Sweep      – plain search for every name variant across every page, to catch what the model missed.
 *   5. Ambiguity  – mentions like "Mr. Smith" that fit several people get a model guess and go to review.
 */

export interface InputBlock {
  id: string;
  page: number;
  position: number;
  text: string;
}

export interface InputDocument {
  key: string;
  name: string;
  blocks: InputBlock[];
}

export interface DraftEntity {
  key: string;
  type: EntityType;
  label: string;
  aliases: string[];
  role: string | null;
  suggestion: Decision;
  confidence: number;
  rationale: string | null;
  /** Where the entity came from. Keep-suggested people the scan invented (e.g. a party in a cited case) aren't swept. */
  origin?: "pattern" | "cast" | "scan" | "reviewer";
}

export interface DraftMention {
  docKey: string;
  blockId: string;
  page: number;
  start: number;
  end: number;
  text: string;
  /** The entity this mention is attached to (for ambiguous mentions: the AI's best guess, or null). */
  entityKey: string | null;
  source: MentionSource;
  confidence: number;
  aiDecision: "inherit" | Decision;
  aiReason: string | null;
  ambiguous: boolean;
  candidateKeys: string[];
  guessConfidence: number | null;
  guessRationale: string | null;
}

export interface DetectionResult {
  entities: DraftEntity[];
  mentions: DraftMention[];
  usage: Usage | null;
  warnings: string[];
}

export interface DetectOptions {
  policy?: string;
  /** Characters of text per scan call (~4 chars per token). */
  chunkChars?: number;
  concurrency?: number;
  onStage?: (stage: string) => void | Promise<void>;
  /** Live snapshots for the "watch it scan" view: pages scanned, finds per page, entities found so far. */
  onProgress?: (progress: DetectProgress) => void | Promise<void>;
}

export type DetectStage = "patterns" | "cast" | "scan" | "sweep" | "resolve" | "done";

export interface DetectProgress {
  stage: DetectStage;
  label: string;
  sections: { done: number; total: number };
  /** Pages the model has finished reading, per document key. */
  scanned: Record<string, number[]>;
  /** Pages being read right now, per document key. */
  scanning: Record<string, number[]>;
  /** Mentions found so far per page, per document key. */
  findsByPage: Record<string, Record<number, number>>;
  /** Entities found so far with their mention counts, most-mentioned first. */
  found: { key: string; type: EntityType; label: string; role: string | null; suggestion: Decision; count: number }[];
  mentions: number;
  /** Model calls that run at the same time. */
  lanes: number;
  /** When each model call started and how long it took, for the countdown and for learning the model's speed. */
  calls: { scan: CallTiming[]; resolve: CallTiming[] };
}

interface Located {
  doc: InputDocument;
  block: InputBlock;
}

export async function detect(
  documents: InputDocument[],
  llm: DetectorLLM | null,
  options: DetectOptions = {},
): Promise<DetectionResult> {
  const policy = options.policy ?? DEFAULT_POLICY;
  const warnings: string[] = [];
  // Progress tracking for the live view.
  let currentStage: DetectStage = "patterns";
  let currentLabel = "";
  const sections = { done: 0, total: 0 };
  const scanned = new Map<string, Set<number>>();
  const scanning = new Map<string, Map<number, number>>(); // doc -> page -> sections in flight
  const markScanned = (docKey: string, page: number) => scanned.set(docKey, (scanned.get(docKey) ?? new Set()).add(page));
  const lanes = options.concurrency ?? llm?.concurrency ?? 6;
  const calls: DetectProgress["calls"] = { scan: [], resolve: [] };
  const snapshot = (): DetectProgress => {
    const counts = new Map<string, number>();
    const findsByPage: Record<string, Record<number, number>> = {};
    for (const m of mentions) {
      const key = m.entityKey ?? m.candidateKeys[0];
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
      const pages = (findsByPage[m.docKey] ??= {});
      pages[m.page] = (pages[m.page] ?? 0) + 1;
    }
    const found = [...entities.values()]
      .map((e) => ({ key: e.key, type: e.type, label: e.label, role: e.role, suggestion: e.suggestion, count: counts.get(e.key) ?? 0 }))
      .sort((a, b) => b.count - a.count || Number(b.suggestion === "redact") - Number(a.suggestion === "redact"));
    return {
      stage: currentStage,
      label: currentLabel,
      sections: { ...sections },
      scanned: Object.fromEntries([...scanned].map(([k, v]) => [k, [...v].sort((a, b) => a - b)])),
      scanning: Object.fromEntries(
        [...scanning].map(([k, v]) => [k, [...v].filter(([, n]) => n > 0).map(([p]) => p).sort((a, b) => a - b)]),
      ),
      findsByPage,
      found,
      mentions: mentions.length,
      lanes,
      calls: { scan: calls.scan.map((c) => ({ ...c })), resolve: calls.resolve.map((c) => ({ ...c })) },
    };
  };
  const report = async () => options.onProgress?.(snapshot());
  const stage = async (next: DetectStage, label: string) => {
    currentStage = next;
    currentLabel = label;
    await options.onStage?.(label);
    await report();
  };
  const blockIndex = new Map<string, Located>();
  for (const doc of documents) for (const block of doc.blocks) blockIndex.set(block.id, { doc, block });

  const entities = new Map<string, DraftEntity>();
  const mentions: DraftMention[] = [];
  const claimed = new Map<string, [number, number][]>(); // blockId -> spans already taken
  const isClaimed = (blockId: string, s: number, e: number) =>
    (claimed.get(blockId) ?? []).some(([a, b]) => s < b && e > a);
  const addMention = (m: DraftMention) => {
    if (isClaimed(m.blockId, m.start, m.end)) {
      // A longer sweep match ("Darnell Price") that contains what the model marked ("Darnell") extends it.
      if (m.source !== "sweep") return false;
      const inside = mentions.filter((x) => x.blockId === m.blockId && x.start < m.end && x.end > m.start);
      const target = inside.length === 1 ? inside[0] : null;
      if (!target || target.start < m.start || target.end > m.end || target.end - target.start === m.end - m.start) return false;
      if (target.entityKey && m.entityKey && target.entityKey !== m.entityKey && !m.candidateKeys.includes(target.entityKey)) return false;
      const spans = claimed.get(m.blockId)!;
      spans.splice(spans.findIndex(([a, b]) => a === target.start && b === target.end), 1, [m.start, m.end]);
      Object.assign(target, { start: m.start, end: m.end, text: m.text });
      return true;
    }
    claimed.set(m.blockId, [...(claimed.get(m.blockId) ?? []), [m.start, m.end]]);
    mentions.push(m);
    return true;
  };
  const base = (loc: Located, rawStart: number, rawEnd: number) => {
    // Redact "Ms. Chen's" whole: the honorific and possessive shouldn't hang off a black box.
    const start = withHonorific(loc.block.text, rawStart);
    const end = withPossessive(loc.block.text, rawEnd);
    return { docKey: loc.doc.key, blockId: loc.block.id, page: loc.block.page, start, end, text: loc.block.text.slice(start, end) };
  };

  // 1. Patterns: SSNs.
  await stage("patterns", "Matching Social Security number patterns");
  const ssnHits: { loc: Located; hit: ReturnType<typeof findSsns>[number] }[] = [];
  for (const loc of blockIndex.values()) for (const hit of findSsns(loc.block.text)) ssnHits.push({ loc, hit });
  const fullSsns = new Map<string, string>(); // digits -> entity key
  for (const { hit } of ssnHits) {
    if (hit.kind !== "full") continue;
    if (!fullSsns.has(hit.digits)) fullSsns.set(hit.digits, `ssn:${hit.digits}`);
  }
  const ssnEntityFor = (digits: string): string => {
    if (digits.length === 9) return fullSsns.get(digits) ?? `ssn:${digits}`;
    for (const [full, key] of fullSsns) if (full.endsWith(digits)) return key;
    return `ssn4:${digits}`;
  };
  const ensureSsnEntity = (key: string, sample: string, decision: Decision, confidence: number) => {
    const existing = entities.get(key);
    if (existing) {
      existing.confidence = Math.max(existing.confidence, confidence);
      if (decision === "redact") existing.suggestion = "redact";
      return;
    }
    const digits = key.split(":")[1];
    entities.set(key, {
      key,
      type: "ssn",
      label: digits.length === 9 ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}` : `SSN ending ${digits}`,
      aliases: [sample],
      role: null,
      suggestion: decision,
      confidence,
      rationale: null,
      origin: "pattern",
    });
  };
  for (const { loc, hit } of ssnHits) {
    const key = ssnEntityFor(hit.digits);
    ensureSsnEntity(key, hit.text, hit.decision, hit.confidence);
    addMention({
      ...base(loc, hit.start, hit.end),
      entityKey: key,
      source: "pattern",
      confidence: hit.confidence,
      aiDecision: hit.decision === "keep" ? "keep" : "inherit",
      aiReason: hit.reason,
      ambiguous: false,
      candidateKeys: [],
      guessConfidence: null,
      guessRationale: null,
    });
  }

  // 2 + 3. Model passes.
  const llmKeys = new Map<string, string>(); // model id -> entity key
  let cast: CastEntity[] = [];
  // Small batches (one scan's worth of text) skip the separate who's-who pass: one read does both jobs.
  const chunkChars = options.chunkChars ?? SECTION_CHARS;
  const totalChars = documents.reduce((n, d) => n + d.blocks.reduce((m, b) => m + b.text.length, 0), 0);
  const singlePass = totalChars <= chunkChars;
  if (llm && !singlePass) {
    await report(); // SSNs found by pattern show up right away
    await stage("cast", "Reading the whole batch to learn who's who");
    try {
      cast = await runCast(llm, documents, policy);
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      warnings.push(
        /api key|OPENROUTER_API_KEY|401/i.test(message)
          ? `${message}, so only Social Security number patterns were checked. Fix OPENROUTER_API_KEY in .env.local, restart the server, and re-run detection to find names and addresses.`
          : `Name and address detection failed (${message}). Only Social Security number patterns were checked. Re-run detection to try again.`,
      );
      llm = null;
    }
  }
  if (llm) {
    for (const c of cast) registerCastEntity(c, entities, llmKeys, ssnEntityFor);

    const chunks = singlePass ? [[...blockIndex.values()]] : chunkBlocks(documents, chunkChars);
    // A page counts as read once every section that touches it is done.
    const pending = new Map<string, number>(); // `${doc}|${page}` -> sections left
    const pagesOf = (chunk: Located[]) => [...new Set(chunk.map((l) => `${l.doc.key}|${l.block.page}`))];
    for (const chunk of chunks) for (const k of pagesOf(chunk)) pending.set(k, (pending.get(k) ?? 0) + 1);
    sections.total = chunks.length;
    calls.scan = chunks.map((chunk) => ({ size: chunk.reduce((n, l) => n + l.block.text.length, 0), startedAt: null, seconds: null }));
    const scanLabel = () =>
      chunks.length === 1
        ? "Reading every page for names, addresses, and SSNs"
        : `Scanning pages for every mention (${sections.done} of ${chunks.length} sections)`;
    await stage("scan", scanLabel());
    const known = cast.map(({ id, type, name, role, redact }) => ({ id, type, name, role, redact }));
    const model = llm;
    // Scans one section. If the answer is too long for the model, split the section in half and try each half.
    const scanChunk = async (chunk: Located[], index: number): Promise<{ loc: Located; finding: ScanFinding }[]> => {
      const local = new Map(chunk.map((loc, i) => [`b${i + 1}`, loc]));
      try {
        const findings = await model.scan({
          policy,
          known,
          blocks: [...local].map(([id, loc]) => ({ id, document: loc.doc.name, page: loc.block.page, text: loc.block.text })),
        });
        const located = findings.flatMap((finding) => {
          const loc = local.get(finding.block) ?? local.get(`b${Number(finding.block.match(/\d+/)?.[0] ?? NaN)}`);
          return loc ? [{ loc, finding }] : [];
        });
        console.info(
          `[scan] ${chunk[0].doc.name} p.${chunk[0].block.page}: ${findings.length} findings, ${located.length} matched a paragraph, ` +
            `${findings.filter((f) => f.new_entity).length} named a new entity`,
        );
        return located;
      } catch (error) {
        const message = (error as Error).message;
        if (/cut off|max_tokens/i.test(message) && chunk.length > 1) {
          const half = Math.ceil(chunk.length / 2);
          return [...(await scanChunk(chunk.slice(0, half), index)), ...(await scanChunk(chunk.slice(half), index))];
        }
        calls.scan[index].failed = true;
        warnings.push(
          error instanceof MissingApiKeyError
            ? `${message}. Only Social Security number patterns were checked; fix OPENROUTER_API_KEY and re-run detection.`
            : `A scan of ${chunk[0].doc.name} p.${chunk[0].block.page} failed: ${message}`,
        );
        return [];
      }
    };
    await pool(chunks, lanes, async (chunk, index) => {
      const keys = pagesOf(chunk);
      const timing = calls.scan[index];
      timing.startedAt = Date.now();
      for (const k of keys) {
        const [doc, page] = k.split("|");
        const inFlight = scanning.get(doc) ?? new Map<number, number>();
        inFlight.set(Number(page), (inFlight.get(Number(page)) ?? 0) + 1);
        scanning.set(doc, inFlight);
      }
      await report();
      const found = await scanChunk(chunk, index);
      timing.seconds = Math.round((Date.now() - timing.startedAt) / 100) / 10;
      // Apply each section's findings as it lands, so the live view fills in as pages are read.
      applyScanFindings(found, entities, llmKeys, ssnEntityFor, ensureSsnEntity, addMention, base);
      for (const k of keys) {
        const [doc, page] = k.split("|");
        const inFlight = scanning.get(doc)!;
        inFlight.set(Number(page), inFlight.get(Number(page))! - 1);
        pending.set(k, pending.get(k)! - 1);
        if (pending.get(k) === 0) markScanned(doc, Number(page));
      }
      sections.done++;
      await stage("scan", scanLabel());
    });
    if (warnings.length === 0 && !mentions.some((m) => m.source === "llm")) {
      warnings.push("The AI scan came back empty, so only Social Security number patterns were found. Re-run detection to try again.");
    }
  } else if (warnings.length === 0) {
    warnings.push(
      "No OpenRouter API key, so only Social Security numbers were detected. Add OPENROUTER_API_KEY to .env.local, restart the server, and re-run detection to find names and addresses.",
    );
  }

  // 4. Sweep: every variant of every name and address, everywhere.
  await stage("sweep", "Searching every page for every spelling of every name");
  sweep(blockIndex, entities, mentions, addMention, base, fullSsns);
  for (const { doc, block } of blockIndex.values()) markScanned(doc.key, block.page);
  scanning.clear();
  await report();

  // 5. Ambiguity: second look at mentions that fit more than one person.
  markAmbiguous(entities, mentions);
  if (llm) {
    const open = mentions.filter((m) => m.ambiguous && m.guessConfidence === null);
    if (open.length > 0) {
      await stage("resolve", `Double-checking ${open.length} names shared by more than one person`);
      await resolveAmbiguous(llm, open, entities, blockIndex, lanes, warnings, { calls: calls.resolve, report });
    }
  }
  for (const m of mentions) {
    if (m.ambiguous && m.entityKey === null && m.guessConfidence === null) m.guessRationale = "Not resolved automatically";
  }

  // Drop entities nothing points at (the model listed them but they never matched any text).
  const used = new Set(mentions.flatMap((m) => [m.entityKey, ...m.candidateKeys]));
  for (const key of [...entities.keys()]) if (!used.has(key)) entities.delete(key);
  const finalEntities = [...entities.values()];
  if (llm) warnings.push(...(llm.notices?.() ?? []));
  await stage("done", "Done");
  return { entities: finalEntities, mentions, usage: llm?.usage() ?? null, warnings };
}

async function runCast(llm: DetectorLLM, documents: InputDocument[], policy: string): Promise<CastEntity[]> {
  // The whole batch goes in one call when it fits; very large batches are split into groups and merged.
  const groups: InputDocument[][] = [[]];
  let size = 0;
  for (const doc of documents) {
    const chars = doc.blocks.reduce((n, b) => n + b.text.length, 0);
    if (size + chars > 900_000 && groups[groups.length - 1].length > 0) {
      groups.push([]);
      size = 0;
    }
    groups[groups.length - 1].push(doc);
    size += chars;
  }
  const results = await Promise.all(
    groups.map((group) =>
      llm.cast({
        policy,
        documents: group.map((doc) => ({ name: doc.name, pages: pagesOf(doc) })),
      }),
    ),
  );
  if (results.length === 1) return results[0];
  // Merge groups: same type + same normalized name = same entity.
  const merged = new Map<string, CastEntity>();
  for (const e of results.flat()) {
    const k = `${e.type}:${e.type === "person" ? personKey(e.name) : aliasKey(e.name)}`;
    const prev = merged.get(k);
    if (prev) prev.aliases = [...new Set([...prev.aliases, ...e.aliases])];
    else merged.set(k, { ...e, id: `${e.id}_${merged.size}` });
  }
  return [...merged.values()];
}

function pagesOf(doc: InputDocument) {
  const pages = new Map<number, string[]>();
  for (const b of doc.blocks) pages.set(b.page, [...(pages.get(b.page) ?? []), b.text]);
  return [...pages].map(([page, texts]) => ({ page, text: texts.join("\n\n") }));
}

function registerCastEntity(
  c: CastEntity,
  entities: Map<string, DraftEntity>,
  llmKeys: Map<string, string>,
  ssnEntityFor: (digits: string) => string,
) {
  if (c.type === "ssn") {
    const digits = (c.name.match(/\d/g) ?? []).join("");
    if (digits.length !== 9 && digits.length !== 4) return;
    const key = ssnEntityFor(digits);
    llmKeys.set(c.id, key);
    const existing = entities.get(key);
    if (existing) existing.role = c.role;
    else
      entities.set(key, {
        key,
        type: "ssn",
        label: digits.length === 9 ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}` : `SSN ending ${digits}`,
        aliases: [c.name],
        role: c.role,
        suggestion: "redact",
        confidence: 0.9,
        rationale: c.why,
      });
    return;
  }
  const key = `${c.type}:${c.id}`;
  llmKeys.set(c.id, key);
  entities.set(key, {
    key,
    type: c.type,
    label: c.name,
    aliases: [...new Set([c.name, ...c.aliases])],
    role: c.role,
    suggestion: c.redact ? "redact" : "keep",
    confidence: 0.85,
    rationale: c.why,
    origin: "cast",
  });
}

/** The most natural way to write a person's name, from how the documents wrote it: "John Andrew Smith", not "SMITH, JOHN" or "Ofc. K. Chen #4471". */
export function personLabel(texts: string[]): string {
  const clean = (t: string) => {
    let name = t
      .trim()
      .replace(/\s*#\s*\d+$/, "")
      .replace(/,?\s+(Esq|Jr|Sr|Ph\.?D|M\.?D)\.?$/i, "")
      .replace(/^((mr|mrs|ms|dr|det|ofc|officer|sgt|judge|hon|detective|sergeant)\.?\s+)+/i, "");
    const inverted = name.match(/^([^,]+),\s*([^,]+)$/); // "CHEN, MAY" -> "MAY CHEN"
    if (inverted) name = `${inverted[2]} ${inverted[1]}`;
    if (name === name.toUpperCase()) name = name.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (c) => c.toUpperCase());
    return name;
  };
  const names = texts.map(clean).filter(Boolean);
  // Prefer a spelling written in mixed case in the source, then the fullest one.
  const mixed = texts.filter((t) => t !== t.toUpperCase()).map(clean);
  const pool = mixed.length ? mixed : names;
  return pool.sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length || b.length - a.length)[0] ?? texts[0].trim();
}

/** Best guess at what a mention is when the model didn't say: from its id slug first, then from the text itself. */
export function guessEntityType(text: string, id: string): EntityType {
  if (/ssn|social/i.test(id) || /^\D*\d{3}[-\s]?\d{2}[-\s]?\d{4}\D*$/.test(text)) return "ssn";
  if (/^(addr|address|location|place)/i.test(id)) return "address";
  if (/^(org|company|business|agency|firm)/i.test(id)) return "org";
  if (/^\d+\s+\S.*\b(street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd|court|ct|way|place|pl|terrace|circle|pike|highway|hwy)\b/i.test(text))
    return "address";
  if (/\b(LLC|L\.L\.C\.|LLP|Inc|Corp|Corporation|Company|Co\.|Bank|Department|Office|Services|Association|University|Hospital|Group)\b/.test(text))
    return "org";
  return "person";
}

function applyScanFindings(
  findings: { loc: Located; finding: ScanFinding }[],
  entities: Map<string, DraftEntity>,
  llmKeys: Map<string, string>,
  ssnEntityFor: (digits: string) => string,
  ensureSsnEntity: (key: string, sample: string, decision: Decision, confidence: number) => void,
  addMention: (m: DraftMention) => boolean,
  base: (loc: Located, s: number, e: number) => Pick<DraftMention, "docKey" | "blockId" | "page" | "start" | "end" | "text">,
) {
  // New entities first, merged by normalized name so two sections naming the same person agree.
  const byName = new Map<string, string>();
  for (const e of entities.values()) byName.set(`${e.type}:${e.type === "person" ? personKey(e.label) : aliasKey(e.label)}`, e.key);
  for (const { finding } of findings) {
    if (llmKeys.has(finding.entity) || !finding.new_entity) continue;
    const ne = finding.new_entity;
    if (ne.type === "ssn") continue; // SSNs are keyed by their digits below
    const nameKey = `${ne.type}:${ne.type === "person" ? personKey(ne.name) : aliasKey(ne.name)}`;
    const existing = byName.get(nameKey);
    if (existing) {
      llmKeys.set(finding.entity, existing);
      continue;
    }
    const key = `${ne.type}:new_${finding.entity}`;
    entities.set(key, {
      key,
      type: ne.type,
      label: ne.name,
      aliases: [ne.name],
      role: ne.role,
      suggestion: ne.redact ? "redact" : "keep",
      confidence: 0.7,
      rationale: "Found while scanning pages",
      origin: "scan",
    });
    byName.set(nameKey, key);
    llmKeys.set(finding.entity, key);
  }

  // Some models skip new_entity when there is no known list. Build those entities from their mentions instead of dropping them.
  const orphans = new Map<string, ScanFinding[]>();
  for (const { finding } of findings) {
    if (llmKeys.has(finding.entity) || finding.new_entity || !finding.text.trim()) continue;
    orphans.set(finding.entity, [...(orphans.get(finding.entity) ?? []), finding]);
  }
  for (const [id, list] of orphans) {
    const type = guessEntityType(list[0].text.trim(), id);
    const label = type === "person" ? personLabel(list.map((f) => f.text)) : list.map((f) => f.text.trim()).sort((a, b) => b.length - a.length)[0];
    if (type === "ssn") {
      const digits = (label.match(/\d/g) ?? []).join("");
      if (digits.length !== 9 && digits.length !== 4) continue;
      const key = ssnEntityFor(digits);
      ensureSsnEntity(key, label, "redact", 0.8);
      llmKeys.set(id, key);
      continue;
    }
    const nameKey = `${type}:${type === "person" ? personKey(label) : aliasKey(label)}`;
    const existing = byName.get(nameKey);
    if (existing) {
      llmKeys.set(id, existing);
      continue;
    }
    const key = `${type}:new_${id}`;
    entities.set(key, {
      key,
      type,
      label,
      aliases: [label],
      role: null,
      suggestion: list.filter((f) => f.redact).length * 2 >= list.length ? "redact" : "keep",
      confidence: 0.6,
      rationale: "Found while scanning pages",
      origin: "scan",
    });
    byName.set(nameKey, key);
    llmKeys.set(id, key);
  }

  // Locate each finding in its paragraph. Repeated text is assigned to successive occurrences.
  const cursor = new Map<string, number>(); // `${blockId}|${text}` -> next search offset
  for (const { loc, finding } of findings) {
    const text = finding.text.trim();
    if (!text) continue;
    const cursorKey = `${loc.block.id}|${text}`;
    let start = indexOfLoose(loc.block.text, text, cursor.get(cursorKey) ?? 0);
    if (start.index < 0) start = indexOfLoose(loc.block.text, text, 0);
    if (start.index < 0) continue; // the model paraphrased; the sweep will still find real occurrences
    cursor.set(cursorKey, start.index + start.length);

    let entityKey = llmKeys.get(finding.entity) ?? null;
    const digits = (text.match(/\d/g) ?? []).join("");
    const isSsn = (entityKey && entities.get(entityKey)?.type === "ssn") || finding.new_entity?.type === "ssn";
    if (isSsn && (digits.length === 9 || digits.length === 4)) {
      entityKey = ssnEntityFor(digits);
      ensureSsnEntity(entityKey, text, "redact", 0.85);
    }
    if (!entityKey || !entities.has(entityKey)) continue;
    const entity = entities.get(entityKey)!;
    const defaultRedact = entity.suggestion === "redact";
    addMention({
      ...base(loc, start.index, start.index + start.length),
      entityKey,
      source: "llm",
      confidence: finding.certain ? 0.9 : 0.6,
      aiDecision: finding.redact === defaultRedact ? "inherit" : finding.redact ? "redact" : "keep",
      aiReason: finding.note,
      ambiguous: !finding.certain,
      candidateKeys: [],
      // When the scan was unsure, leave the guess open so the dedicated ambiguity pass takes a second look.
      guessConfidence: finding.certain ? 0.9 : null,
      guessRationale: finding.certain ? "Attributed from surrounding text" : "Model was unsure who this refers to",
    });
    // Learn new spellings ("Johnny") so the sweep finds them elsewhere. Only name-like text, never "the Defendant".
    const nameLike = isSearchableAlias(text) && text.length <= 80;
    if (entity.type !== "ssn" && nameLike && !entity.aliases.some((a) => aliasKey(a) === aliasKey(text))) entity.aliases.push(text);
  }
}

/** indexOf that tolerates line breaks or repeated spaces where the model wrote a single space. */
function indexOfLoose(haystack: string, needle: string, from: number): { index: number; length: number } {
  const exact = haystack.indexOf(needle, from);
  if (exact >= 0) return { index: exact, length: needle.length };
  const pattern = needle
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const re = new RegExp(pattern, "g");
  re.lastIndex = from;
  const m = re.exec(haystack);
  return m ? { index: m.index, length: m[0].length } : { index: -1, length: 0 };
}

function sweep(
  blockIndex: Map<string, Located>,
  entities: Map<string, DraftEntity>,
  mentions: DraftMention[],
  addMention: (m: DraftMention) => boolean,
  base: (loc: Located, s: number, e: number) => Pick<DraftMention, "docKey" | "blockId" | "page" | "start" | "end" | "text">,
  fullSsns: Map<string, string>,
) {
  // Build the alias → entities index. Entities whose model-provided aliases or generated variants share text
  // (e.g. "Mr. Smith" for a father and son) both land in the index; those matches become ambiguous.
  const index = new Map<string, Set<string>>();
  const sweepable = (e: DraftEntity) => e.type !== "ssn" && !(e.origin === "scan" && e.suggestion === "keep");
  const sweepables = [...entities.values()].filter(sweepable);
  // Initials ("E.S.") only for people being redacted: that's how minors are usually named, and it keeps
  // a kept official's initials from claiming text.
  const variantsOf = (e: DraftEntity) =>
    e.type === "person"
      ? personVariants(e.label, { initials: e.suggestion === "redact", aliases: e.aliases })
      : e.type === "address"
        ? addressVariants(e.label)
        : [];
  const usable = (e: DraftEntity, alias: string) => isSearchableAlias(alias) && (e.type !== "person" || isAliasOf(alias, e.label, e.aliases));
  // First names or surnames that are also ordinary words ("Will", "Price"). Searched separately, with a context check.
  const commonAliases = new Map<string, Set<string>>();
  for (const e of sweepables) {
    if (e.type !== "person" || e.suggestion !== "redact") continue;
    for (const a of [...e.aliases, ...variantsOf(e)]) {
      if (isCommonWord(a)) commonAliases.set(a.trim(), (commonAliases.get(a.trim()) ?? new Set()).add(e.key));
    }
  }

  // Aliases the model gave (or a reviewer added) are kept; generated ones are kept only if they turn up in the text.
  const given = new Map(sweepables.map((e) => [e.key, new Set(e.aliases.map(aliasKey))]));
  const seen = new Set<string>();
  for (const e of sweepables) {
    const aliases = [...new Set([...e.aliases, ...variantsOf(e)])].filter((a) => usable(e, a));
    for (const a of aliases) {
      const k = aliasKey(a);
      if (!k) continue;
      index.set(k, (index.get(k) ?? new Set()).add(e.key));
    }
    e.aliases = aliases;
  }
  const aliasesOf = (keep: (e: DraftEntity) => boolean) => [...new Set(sweepables.filter(keep).flatMap((e) => e.aliases))];
  const aliasList = [
    ...compileAliases(aliasesOf((e) => e.type !== "address")),
    ...compileAliases(aliasesOf((e) => e.type === "address"), { address: true }),
    ...sweepables.filter((e) => e.type === "person").flatMap((e) => personPatterns(e.label)),
  ];
  const commonList = compileAliases([...commonAliases.keys()]);

  for (const loc of blockIndex.values()) {
    const text = loc.block.text;
    const citations = findCaseCitations(text);
    for (const match of findAliases(text, aliasList)) {
      seen.add(aliasKey(match.alias)).add(aliasKey(match.text));
      const keys = [...(index.get(aliasKey(match.text)) ?? index.get(aliasKey(match.alias)) ?? [])];
      if (keys.length === 0) continue;
      const fullName = match.text.trim().split(/\s+/).length >= 2;
      if (!fullName && isPartOfOtherName(text, match.start, match.end)) continue;
      const inCitation = citations.some((c) => match.start >= c.start && match.end <= c.end);
      // A bare surname inside "Smith v. Jones" is almost always a different case's party.
      const citationKeep = inCitation && !fullName;
      addMention({
        ...base(loc, match.start, match.end),
        entityKey: keys.length === 1 ? keys[0] : null,
        source: "sweep",
        confidence: citationKeep ? 0.5 : keys.length === 1 ? 0.8 : 0.5,
        aiDecision: citationKeep ? "keep" : "inherit",
        aiReason: citationKeep ? "Surname inside a case citation — likely a different case's party" : null,
        ambiguous: keys.length > 1 && !citationKeep,
        candidateKeys: keys.length > 1 ? keys : [],
        guessConfidence: null,
        guessRationale: null,
      });
    }

    for (const match of findAliases(text, commonList)) {
      seen.add(aliasKey(match.alias));
      if (!isNameInContext(text, match.start, match.end) || isPartOfOtherName(text, match.start, match.end)) continue;
      const keys = [...(commonAliases.get(match.alias.trim()) ?? [])];
      addMention({
        ...base(loc, match.start, match.end),
        entityKey: keys.length === 1 ? keys[0] : null,
        source: "sweep",
        confidence: 0.6,
        aiDecision: "inherit",
        aiReason: `"${match.text}" is also an ordinary word; matched because it's capitalized mid-sentence`,
        ambiguous: keys.length > 1,
        candidateKeys: keys.length > 1 ? keys : [],
        guessConfidence: null,
        guessRationale: null,
      });
    }

    // SSN digits written another way (bare or spaced) and last-four mentions of known SSNs.
    for (const [digits, key] of fullSsns) {
      const formats = [digits, `${digits.slice(0, 3)} ${digits.slice(3, 5)} ${digits.slice(5)}`];
      for (const f of formats) {
        let i = text.indexOf(f);
        while (i >= 0) {
          const boundary = !/\d/.test(text[i - 1] ?? "") && !/\d/.test(text[i + f.length] ?? "");
          if (boundary)
            addMention({
              ...base(loc, i, i + f.length),
              entityKey: key,
              source: "sweep",
              confidence: 0.95,
              aiDecision: "inherit",
              aiReason: "Same digits as a known SSN",
              ambiguous: false,
              candidateKeys: [],
              guessConfidence: null,
              guessRationale: null,
            });
          i = text.indexOf(f, i + 1);
        }
      }
      for (const m of text.matchAll(new RegExp(`(?<![\\w-])${digits.slice(5)}(?![\\w-])`, "g"))) {
        addMention({
          ...base(loc, m.index, m.index + 4),
          entityKey: key,
          source: "sweep",
          confidence: 0.4,
          aiDecision: "inherit",
          aiReason: "Matches the last four digits of a known SSN — check context",
          ambiguous: false,
          candidateKeys: [],
          guessConfidence: null,
          guessRationale: null,
        });
      }
    }
  }
  for (const e of sweepables) {
    const mine = given.get(e.key)!;
    e.aliases = e.aliases.filter((a) => mine.has(aliasKey(a)) || seen.has(aliasKey(a)));
    if (e.aliases.length === 0) e.aliases = [e.label];
  }
  void mentions;
}

/**
 * A mention is ambiguous when its text is a variant of more than one person (e.g. "Mr. Smith",
 * "Smith"), even if the model attributed it confidently — the reviewer asked to double-check these.
 */
function markAmbiguous(entities: Map<string, DraftEntity>, mentions: DraftMention[]) {
  const index = new Map<string, Set<string>>();
  for (const e of entities.values()) {
    if (e.type !== "person" || (e.origin === "scan" && e.suggestion === "keep")) continue;
    for (const a of e.aliases) index.set(aliasKey(a), (index.get(aliasKey(a)) ?? new Set()).add(e.key));
  }
  for (const m of mentions) {
    if (m.aiDecision === "keep") continue; // kept either way, so who it refers to doesn't matter
    const entity = m.entityKey ? entities.get(m.entityKey) : null;
    if (entity && entity.type !== "person") continue;
    const keys = new Set(m.candidateKeys);
    for (const k of index.get(aliasKey(m.text)) ?? []) keys.add(k);
    if (m.entityKey) keys.add(m.entityKey);
    if (keys.size > 1) {
      m.ambiguous = true;
      m.candidateKeys = [...keys];
    } else if (m.ambiguous && keys.size <= 1) {
      // The model was unsure, but only one known person fits.
      m.ambiguous = false;
      m.candidateKeys = [];
    }
  }
}

async function resolveAmbiguous(
  llm: DetectorLLM,
  open: DraftMention[],
  entities: Map<string, DraftEntity>,
  blockIndex: Map<string, Located>,
  concurrency: number,
  warnings: string[],
  track: { calls: CallTiming[]; report: () => Promise<void> },
  batchSize = 20,
  round = 0,
) {
  const batches: DraftMention[][] = [];
  for (let i = 0; i < open.length; i += batchSize) batches.push(open.slice(i, i + batchSize));
  const skipped: DraftMention[] = [];
  const first = track.calls.length;
  track.calls.push(...batches.map((b) => ({ size: b.length, startedAt: null, seconds: null })));
  await track.report();
  await pool(batches, concurrency, async (batch, index) => {
    const timing = track.calls[first + index];
    timing.startedAt = Date.now();
    await track.report();
    const candidateKeys = [...new Set(batch.flatMap((m) => m.candidateKeys))];
    const ids = new Map(candidateKeys.map((k, i) => [k, `p${i + 1}`]));
    const back = new Map([...ids].map(([k, v]) => [v, k]));
    try {
      const answers = await llm.disambiguate({
        candidates: candidateKeys.map((k) => {
          const e = entities.get(k)!;
          return { id: ids.get(k)!, name: e.label, role: e.role ?? "" };
        }),
        items: batch.map((m, i) => ({
          id: `m${i + 1}`,
          document: blockIndex.get(m.blockId)!.doc.name,
          page: m.page,
          context: contextFor(blockIndex, m),
          candidateIds: m.candidateKeys.map((k) => ids.get(k)!),
        })),
      });
      const answered = new Set<DraftMention>();
      for (const a of answers) {
        const m = batch[Number(a.id.slice(1)) - 1];
        if (!m) continue;
        answered.add(m);
        const key = back.get(a.entity);
        if (key && m.candidateKeys.includes(key)) {
          m.entityKey = key;
          m.guessConfidence = Math.max(0, Math.min(1, a.confidence));
          m.guessRationale = a.why;
        } else {
          m.guessConfidence = 0;
          m.guessRationale = a.why || "Context doesn't say";
        }
      }
      // Smaller models sometimes answer only part of a batch; ask again about the rest.
      skipped.push(...batch.filter((m) => !answered.has(m)));
    } catch (error) {
      timing.failed = true;
      warnings.push(`Resolving ambiguous names failed for ${batch.length} mentions: ${(error as Error).message}`);
    }
    timing.seconds = Math.round((Date.now() - timing.startedAt) / 100) / 10;
    await track.report();
  });
  if (skipped.length > 0 && round < 2) {
    await resolveAmbiguous(llm, skipped, entities, blockIndex, concurrency, warnings, track, Math.max(5, Math.ceil(batchSize / 2)), round + 1);
  } else if (skipped.length > 0) {
    warnings.push(`${skipped.length} shared-name mentions weren't resolved automatically; they're in the "Who is this?" queue.`);
  }
}

/** The mention's paragraph with the mention marked, plus the paragraph before it. */
function contextFor(blockIndex: Map<string, Located>, m: DraftMention): string {
  const { doc, block } = blockIndex.get(m.blockId)!;
  const prev = doc.blocks[doc.blocks.indexOf(block) - 1];
  const marked = `${block.text.slice(0, m.start)}«${block.text.slice(m.start, m.end)}»${block.text.slice(m.end)}`;
  const clip = (s: string, n: number) => (s.length > n ? `…${s.slice(-n)}` : s);
  return `${prev ? clip(prev.text, 600) + "\n\n" : ""}${marked.length > 2400 ? marked.slice(Math.max(0, m.start - 1200), m.start + 1200) : marked}`;
}

function chunkBlocks(documents: InputDocument[], maxChars: number): Located[][] {
  return documents.flatMap((doc) =>
    splitSections(
      doc.blocks.map((block) => ({ doc, block })),
      (l) => l.block.text.length,
      maxChars,
    ),
  );
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
