import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { auditEvents, batches, blocks, documents, entities, mentions, pages } from "@/db/schema";
import { MissingApiKeyError, OpenRouterDetector, type DetectorLLM } from "@/lib/detect/llm";
import { detect, type DetectProgress, type InputDocument } from "@/lib/detect/pipeline";
import { sectionSizes } from "@/lib/detect/sections";
import { DEFAULT_SPEED, fitSpeed, planBatch, shapeOf, type CallTiming, type RunTiming, type Speed } from "@/lib/estimate";
import type { BatchProgress } from "@/lib/progress";
import { extractPdf, rectsForSpan } from "@/lib/pdf/extract";

export async function createBatch(name: string, files: { filename: string; bytes: Uint8Array }[]) {
  return db.transaction(async (tx) => {
    const [batch] = await tx.insert(batches).values({ name }).returning();
    if (files.length > 0) {
      await tx.insert(documents).values(
        files.map((f, position) => ({ batchId: batch.id, position, filename: f.filename, bytes: f.bytes })),
      );
    }
    return batch;
  });
}

/** Batches this server process is working on right now. Anything else marked "processing" was interrupted. */
const globalRuns = globalThis as unknown as { redactionRuns?: Set<string> };
export const activeRuns = (globalRuns.redactionRuns ??= new Set<string>());

/** Reads every PDF, runs detection, and stores entities and mentions. Safe to re-run: it replaces earlier results. */
export async function processBatch(batchId: string, llm: DetectorLLM | null = defaultDetector()) {
  activeRuns.add(batchId);
  try {
    await runBatch(batchId, llm);
  } finally {
    activeRuns.delete(batchId);
  }
}

async function runBatch(batchId: string, llm: DetectorLLM | null) {
  const setStage = (stage: string) => db.update(batches).set({ stage }).where(eq(batches.id, batchId));
  try {
    await db
      .update(batches)
      .set({ status: "processing", stage: "Reading PDFs", error: null, warning: null, model: llm?.model ?? null, progress: null })
      .where(eq(batches.id, batchId));
    await db.delete(entities).where(eq(entities.batchId, batchId));
    await db.delete(mentions).where(eq(mentions.batchId, batchId));

    const docs = await db.select().from(documents).where(eq(documents.batchId, batchId)).orderBy(asc(documents.position));
    const docIds = docs.map((d) => d.id);
    if (docIds.length > 0) {
      await db.delete(blocks).where(inArray(blocks.documentId, docIds));
      await db.delete(pages).where(inArray(pages.documentId, docIds));
    }

    const inputs: InputDocument[] = [];
    const boxesByBlock = new Map<string, number[]>();
    for (const doc of docs) {
      await setStage(`Reading ${doc.filename}`);
      const extracted = extractPdf(doc.bytes, doc.id);
      await db.update(documents).set({ pageCount: extracted.pages.length }).where(eq(documents.id, doc.id));
      if (extracted.pages.length > 0) {
        await db.insert(pages).values(extracted.pages.map((p) => ({ documentId: doc.id, pageNumber: p.page, ...p })));
      }
      for (let i = 0; i < extracted.blocks.length; i += 500) {
        await db.insert(blocks).values(
          extracted.blocks.slice(i, i + 500).map((b) => ({
            id: b.id,
            documentId: doc.id,
            pageNumber: b.page,
            position: b.position,
            text: b.text,
            boxes: b.boxes,
          })),
        );
      }
      for (const b of extracted.blocks) boxesByBlock.set(b.id, b.boxes);
      inputs.push({ key: doc.id, name: doc.filename, blocks: extracted.blocks });
    }
    if (inputs.every((d) => d.blocks.length === 0)) {
      throw new Error("No selectable text found. Scanned PDFs need OCR, which this version doesn't do.");
    }

    // Live progress for the "watch it scan" view, written at most about once a second.
    const chars = inputs.reduce((n, d) => n + d.blocks.reduce((m, b) => m + b.text.length, 0), 0);
    const pagesTotal = inputs.reduce((n, d) => n + new Set(d.blocks.map((b) => b.page)).size, 0);
    // The same plan the intake screen showed, built from the exact sections the scanner will run.
    const shape = shapeOf(inputs.map((d) => ({ sections: sectionSizes(d.blocks.map((b) => b.text.length)) })));
    const speed = await currentSpeed(llm?.model ?? null, llm?.concurrency ?? DEFAULT_SPEED.lanes);
    const plan = planBatch(llm ? shape : { chars: 0, sections: [], cast: false }, speed);
    const startedAt = new Date().toISOString();
    const progress: BatchProgress = {
      startedAt,
      estimateSeconds: plan.total,
      plan,
      speed,
      chars,
      pages: pagesTotal,
      stageStartedAt: { extract: startedAt },
    };
    let lastWrite = 0;
    let trailing: ReturnType<typeof setTimeout> | null = null;
    let pendingWrite: Promise<unknown> = Promise.resolve();
    const write = () => {
      if (trailing) clearTimeout(trailing);
      trailing = null;
      lastWrite = Date.now();
      const snapshot = structuredClone(progress);
      pendingWrite = pendingWrite.then(() =>
        db
          .update(batches)
          .set({ progress: snapshot as unknown as Record<string, unknown>, stage: String(snapshot.label ?? "Processing") })
          .where(eq(batches.id, batchId)),
      );
      return pendingWrite.then(() => undefined);
    };
    const onProgress = (p: DetectProgress) => {
      const stageChanged = p.stage !== progress.stage;
      if (stageChanged) progress.stageStartedAt[p.stage] = new Date().toISOString();
      Object.assign(progress, p, { found: p.found.slice(0, 60) });
      if (stageChanged || Date.now() - lastWrite >= 900) return write();
      // Throttled: make sure the latest state still lands shortly, even if nothing else follows it.
      trailing ??= setTimeout(() => void write(), 900 - (Date.now() - lastWrite));
    };
    await onProgress({ stage: "patterns", label: "Reading PDFs", sections: { done: 0, total: 0 }, scanned: {}, scanning: {}, findsByPage: {}, found: [], mentions: 0, lanes: speed.lanes, calls: { scan: [], resolve: [] } });

    const result = await detect(inputs, llm, { onProgress }).finally(() => trailing && clearTimeout(trailing));
    await pendingWrite;

    await setStage("Saving results");
    await db.transaction(async (tx) => {
      const idByKey = new Map<string, string>();
      for (let i = 0; i < result.entities.length; i += 500) {
        const rows = await tx
          .insert(entities)
          .values(
            result.entities.slice(i, i + 500).map((e) => ({
              batchId,
              type: e.type,
              label: e.label,
              aliases: e.aliases,
              role: e.role,
              aiSuggestion: e.suggestion,
              aiConfidence: e.confidence,
              aiRationale: e.rationale,
            })),
          )
          .returning({ id: entities.id });
        rows.forEach((row, j) => idByKey.set(result.entities[i + j].key, row.id));
      }
      const values = result.mentions.map((m) => ({
        batchId,
        entityId: m.entityKey ? (idByKey.get(m.entityKey) ?? null) : null,
        documentId: m.docKey,
        blockId: m.blockId,
        pageNumber: m.page,
        start: m.start,
        end: m.end,
        text: m.text,
        rects: rectsForSpan(boxesByBlock.get(m.blockId) ?? [], m.start, m.end),
        source: m.source,
        confidence: m.confidence,
        aiDecision: m.aiDecision,
        aiReason: m.aiReason,
        ambiguous: m.ambiguous,
        candidateEntityIds: m.candidateKeys.flatMap((k) => idByKey.get(k) ?? []),
        aiGuessConfidence: m.guessConfidence,
        aiGuessRationale: m.guessRationale,
      }));
      for (let i = 0; i < values.length; i += 1000) await tx.insert(mentions).values(values.slice(i, i + 1000));

      // The audit trail starts with what the system flagged. Everything it finds is redacted unless a person keeps it.
      const mentionCount = new Map<string, number>();
      const docCount = new Map<string, Set<string>>();
      for (const m of result.mentions) {
        if (!m.entityKey) continue;
        mentionCount.set(m.entityKey, (mentionCount.get(m.entityKey) ?? 0) + 1);
        docCount.set(m.entityKey, (docCount.get(m.entityKey) ?? new Set()).add(m.docKey));
      }
      const docTotal = inputs.length;
      const events: (typeof auditEvents.$inferInsert)[] = [
        {
          batchId,
          actor: "system",
          action: "batch.processed",
          summary: `Scanned ${docTotal} document${docTotal === 1 ? "" : "s"} (${pagesTotal} pages): flagged ${result.entities.length} candidates for redaction`,
          details: { model: llm?.model ?? null, candidates: result.entities.length, mentions: result.mentions.length },
        },
        ...result.entities.map((e) => {
          const n = mentionCount.get(e.key) ?? 0;
          const d = docCount.get(e.key)?.size ?? 0;
          return {
            batchId,
            actor: "system",
            action: "entity.flagged",
            entityId: idByKey.get(e.key) ?? null,
            summary: `System flagged ${e.type} "${e.label}" for redaction (${n} mention${n === 1 ? "" : "s"} in ${d} document${d === 1 ? "" : "s"})`,
            details: { state: "flagged", mentions: n, documents: d },
          };
        }),
      ];
      for (let i = 0; i < events.length; i += 500) await tx.insert(auditEvents).values(events.slice(i, i + 500));

      await tx
        .update(batches)
        .set({
          status: "ready",
          stage: "Ready for review",
          warning: result.warnings.join("\n") || null,
          usage: result.usage,
          processedAt: new Date(),
          progress: progress as unknown as Record<string, unknown>,
          stats: {
            chars,
            pages: pagesTotal,
            seconds: Math.round((Date.now() - Date.parse(startedAt)) / 1000),
            model: llm?.model ?? null,
            timing: runTiming(progress) ?? undefined,
          },
        })
        .where(eq(batches.id, batchId));
    });
  } catch (error) {
    console.error(`Processing batch ${batchId} failed`, error);
    await db
      .update(batches)
      .set({ status: "failed", error: (error as Error).message ?? String(error) })
      .where(eq(batches.id, batchId));
  }
}

/** The model's speed per stage, fitted from the last finished batches on the same model. */
export async function currentSpeed(model: string | null, lanes: number): Promise<Speed> {
  const rows = await db
    .select({ stats: batches.stats })
    .from(batches)
    .where(and(eq(batches.status, "ready"), isNotNull(batches.stats)))
    .orderBy(desc(batches.processedAt))
    .limit(30);
  const runs = rows.flatMap((r) => (r.stats?.model === model && r.stats.timing ? [r.stats.timing] : [])).slice(0, 10);
  return fitSpeed(runs, lanes);
}

/** What this run measured, from its live progress. Null when the model never got to scan. */
function runTiming(p: BatchProgress): RunTiming | null {
  const scan = p.calls?.scan ?? [];
  if (scan.length === 0) return null;
  const at = (stage: keyof BatchProgress["stageStartedAt"]) => {
    const t = p.stageStartedAt[stage];
    return t ? Date.parse(t) : null;
  };
  const [castAt, scanAt, resolveAt, doneAt] = [at("cast"), at("scan"), at("resolve"), at("done")];
  // Failed calls aren't a fair sample of the model's speed.
  const measured = (calls: CallTiming[]) => calls.flatMap((c) => (c.seconds !== null && !c.failed ? [{ size: c.size, seconds: c.seconds }] : []));
  return {
    lanes: p.lanes ?? DEFAULT_SPEED.lanes,
    cast: castAt && scanAt ? { chars: p.chars, seconds: (scanAt - castAt) / 1000 } : null,
    sections: measured(scan).map((c) => ({ chars: c.size, seconds: c.seconds })),
    resolve: {
      seconds: resolveAt && doneAt ? (doneAt - resolveAt) / 1000 : 0,
      calls: measured(p.calls?.resolve ?? []).map((c) => c.seconds),
    },
  };
}

export function defaultDetector(): DetectorLLM | null {
  if (process.env.REDACTION_PATTERNS_ONLY === "1") return null;
  try {
    return new OpenRouterDetector();
  } catch (error) {
    if (error instanceof MissingApiKeyError) return null; // pattern-only mode; the batch shows a banner
    throw error;
  }
}
