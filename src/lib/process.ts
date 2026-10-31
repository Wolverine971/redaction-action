import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditEvents, batches, blocks, documents, entities, mentions, pages, type EntityType } from "@/db/schema";
import { planCarryOver, type OldMention, type PastMerge } from "@/lib/carry-over";
import { aliasKey } from "@/lib/detect/aliases";
import { describeDecision, entityFields, entityState, lineage, mentionFields, mentionState } from "@/lib/history";
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

/**
 * Reads every PDF, runs detection, and stores entities and mentions. Safe to re-run: the new results replace the
 * system's earlier suggestions, and reviewers' decisions carry over to them (see src/lib/carry-over.ts).
 */
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
    // Earlier results, and the decisions on them, stay until the new results are saved. Pages and paragraphs
    // have stable ids, so they're re-read in place; ones that no longer exist are removed when saving.
    const docs = await db.select().from(documents).where(eq(documents.batchId, batchId)).orderBy(asc(documents.position));
    const docIds = docs.map((d) => d.id);
    const pageKeys = new Set<string>();
    const blockText = new Map<string, string>();

    const inputs: InputDocument[] = [];
    const boxesByBlock = new Map<string, number[]>();
    for (const doc of docs) {
      await setStage(`Reading ${doc.filename}`);
      const extracted = extractPdf(doc.bytes, doc.id);
      await db.update(documents).set({ pageCount: extracted.pages.length }).where(eq(documents.id, doc.id));
      if (extracted.pages.length > 0) {
        await db
          .insert(pages)
          .values(extracted.pages.map((p) => ({ documentId: doc.id, pageNumber: p.page, width: p.width, height: p.height })))
          .onConflictDoUpdate({ target: [pages.documentId, pages.pageNumber], set: { width: sql`excluded.width`, height: sql`excluded.height` } });
      }
      for (let i = 0; i < extracted.blocks.length; i += 500) {
        await db
          .insert(blocks)
          .values(
            extracted.blocks.slice(i, i + 500).map((b) => ({
              id: b.id,
              documentId: doc.id,
              pageNumber: b.page,
              position: b.position,
              text: b.text,
              boxes: b.boxes,
            })),
          )
          .onConflictDoUpdate({
            target: blocks.id,
            set: { pageNumber: sql`excluded.page_number`, position: sql`excluded.position`, text: sql`excluded.text`, boxes: sql`excluded.boxes` },
          });
      }
      for (const p of extracted.pages) pageKeys.add(`${doc.id}:${p.page}`);
      for (const b of extracted.blocks) {
        boxesByBlock.set(b.id, b.boxes);
        blockText.set(b.id, b.text);
      }
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
      const now = new Date();
      const oldEntities = await tx.select().from(entities).where(eq(entities.batchId, batchId));
      const oldMentions = await tx.select().from(mentions).where(eq(mentions.batchId, batchId));
      const history = await tx
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.batchId, batchId), eq(auditEvents.action, "entity.merge")))
        .orderBy(asc(auditEvents.id));
      const resolve = lineage(history);
      const merges: PastMerge[] = history.flatMap((e) => {
        const fromLabel = e.details.fromLabel;
        if (e.actor === "system" || typeof fromLabel !== "string" || !e.entityId) return [];
        const fromType = typeof e.details.fromType === "string" ? (e.details.fromType as EntityType) : null;
        return [{ fromLabel, fromType, into: resolve(e.entityId), actor: e.actor }];
      });
      const plan = planCarryOver({ oldEntities, oldMentions, merges, newEntities: result.entities, newMentions: result.mentions, blockText });
      const rerun = oldEntities.length > 0 || oldMentions.length > 0;

      // Replace the earlier results. Ids carry over, so history and decisions line up with the new rows.
      await tx.delete(mentions).where(eq(mentions.batchId, batchId));
      await tx.delete(entities).where(eq(entities.batchId, batchId));
      if (docIds.length > 0) {
        const stale = await tx
          .select({ id: blocks.id })
          .from(blocks)
          .where(inArray(blocks.documentId, docIds));
        const gone = stale.map((b) => b.id).filter((id) => !blockText.has(id));
        for (let i = 0; i < gone.length; i += 1000) await tx.delete(blocks).where(inArray(blocks.id, gone.slice(i, i + 1000)));
        const pageRows = await tx.select({ documentId: pages.documentId, pageNumber: pages.pageNumber }).from(pages).where(inArray(pages.documentId, docIds));
        for (const p of pageRows) {
          if (!pageKeys.has(`${p.documentId}:${p.pageNumber}`)) {
            await tx.delete(pages).where(and(eq(pages.documentId, p.documentId), eq(pages.pageNumber, p.pageNumber)));
          }
        }
      }

      const folded = new Map(plan.remerged.map((r) => [r.key, r]));
      const extraAliases = new Map<string, string[]>();
      for (const r of plan.remerged) {
        const e = result.entities.find((x) => x.key === r.key)!;
        extraAliases.set(r.intoKey, [...(extraAliases.get(r.intoKey) ?? []), e.label, ...e.aliases]);
      }
      const entityRows: (typeof entities.$inferInsert)[] = [
        ...result.entities
          .filter((e) => !folded.has(e.key))
          .map((e) => {
            const old = plan.matched.get(e.key);
            const aliases = [...new Set([...(old ? [old.label, ...old.aliases] : []), ...e.aliases, ...(extraAliases.get(e.key) ?? [])])];
            return {
              id: plan.idByKey.get(e.key)!,
              batchId,
              type: e.type,
              // An entity found again keeps the name reviewers already know it by; the new name becomes a spelling.
              label: old?.label ?? e.label,
              aliases: old && aliasKey(old.label) !== aliasKey(e.label) ? [...new Set([...aliases, e.label])] : aliases,
              role: e.role ?? old?.role ?? null,
              aiSuggestion: e.suggestion,
              aiConfidence: e.confidence,
              aiRationale: e.rationale,
              status: old?.status ?? "pending",
              createdBy: old?.createdBy ?? "ai",
              decidedBy: old?.decidedBy ?? null,
              decidedAt: old?.decidedAt ?? null,
              createdAt: old?.createdAt ?? now,
            };
          }),
        ...plan.keptOld,
      ];
      for (let i = 0; i < entityRows.length; i += 500) await tx.insert(entities).values(entityRows.slice(i, i + 500));

      const liveIds = new Set(entityRows.map((e) => e.id!));
      const values: (typeof mentions.$inferInsert)[] = result.mentions.map((m, i) => {
        const old = plan.mentionMatch[i];
        const confirmed = old?.assignmentConfirmed && old.entityId && liveIds.has(old.entityId) ? old : null;
        return {
          id: old?.id,
          batchId,
          entityId: confirmed ? confirmed.entityId : m.entityKey ? (plan.idByKey.get(m.entityKey) ?? null) : null,
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
          candidateEntityIds: [...new Set(m.candidateKeys.flatMap((k) => plan.idByKey.get(k) ?? []))],
          aiGuessConfidence: m.guessConfidence,
          aiGuessRationale: m.guessRationale,
          assignmentConfirmed: !!confirmed,
          assignedBy: confirmed?.assignedBy ?? null,
          assignedAt: confirmed?.assignedAt ?? null,
          override: old?.override ?? null,
          decidedBy: old?.override ? old.decidedBy : null,
          decidedAt: old?.override ? old.decidedAt : null,
        };
      });
      for (const m of plan.keptMentions) {
        values.push({
          ...m,
          entityId: m.entityId && liveIds.has(m.entityId) ? m.entityId : null,
          candidateEntityIds: m.candidateEntityIds.filter((id) => liveIds.has(id)),
          rects: rectsForSpan(boxesByBlock.get(m.blockId) ?? [], m.start, m.end),
        });
      }
      for (let i = 0; i < values.length; i += 1000) await tx.insert(mentions).values(values.slice(i, i + 1000));

      // The audit trail starts with what the system flagged. Everything it finds is redacted unless a person keeps it.
      // On a re-run it also says what carried over, what's new, and what no longer applies.
      const mentionCount = new Map<string, number>();
      const docCount = new Map<string, Set<string>>();
      for (const m of values) {
        if (!m.entityId) continue;
        mentionCount.set(m.entityId, (mentionCount.get(m.entityId) ?? 0) + 1);
        docCount.set(m.entityId, (docCount.get(m.entityId) ?? new Set()).add(m.documentId));
      }
      const where = (id: string) => {
        const n = mentionCount.get(id) ?? 0;
        const d = docCount.get(id)?.size ?? 0;
        return `${n} mention${n === 1 ? "" : "s"} in ${d} document${d === 1 ? "" : "s"}`;
      };
      const labelOf = new Map(entityRows.map((e) => [e.id!, e]));
      const docTotal = inputs.length;
      const events: (typeof auditEvents.$inferInsert)[] = [];
      const system = (row: Omit<typeof auditEvents.$inferInsert, "batchId" | "actor" | "createdAt">) =>
        events.push({ batchId, actor: "system", createdAt: now, ...row });

      for (const e of result.entities) {
        if (folded.has(e.key)) continue;
        const id = plan.idByKey.get(e.key)!;
        const row = labelOf.get(id)!;
        const old = plan.matched.get(e.key);
        if (!old) {
          system({
            action: "entity.flagged",
            ...entityFields({ id, label: row.label, type: row.type }),
            toState: "flagged",
            summary: `System flagged ${e.type} "${row.label}" for redaction (${where(id)})`,
            details: { state: "flagged", mentions: mentionCount.get(id) ?? 0, documents: docCount.get(id)?.size ?? 0 },
          });
          continue;
        }
        const state = entityState(old.status);
        system({
          action: "entity.redetected",
          ...entityFields(old),
          fromState: state,
          toState: state,
          summary:
            `Re-run found ${old.type} "${old.label}" again (${where(id)})` +
            (old.status === "pending" ? "; still flagged for redaction" : `; the decision still applies (${describeDecision(old)})`),
          details: { newLabel: e.label, mentions: mentionCount.get(id) ?? 0, decidedBy: old.decidedBy, decidedAt: old.decidedAt?.toISOString() ?? null },
        });
      }
      for (const r of plan.remerged) {
        const e = result.entities.find((x) => x.key === r.key)!;
        const into = labelOf.get(plan.idByKey.get(r.intoKey)!)!;
        system({
          action: "entity.merge",
          ...entityFields({ id: into.id!, label: into.label, type: into.type }),
          summary: `Re-run listed "${e.label}" separately; re-applied ${r.merge.actor}'s merge into "${into.label}"`,
          details: { fromLabel: e.label, reapplied: true, originalBy: r.merge.actor },
        });
      }
      for (const o of plan.keptOld) {
        const why = o.status !== "pending" ? describeDecision(o) : o.createdBy !== "ai" ? `${o.createdBy} added it` : "a reviewer confirmed or set some of its mentions";
        system({
          action: "entity.carried",
          ...entityFields(o),
          fromState: entityState(o.status),
          toState: entityState(o.status),
          summary: `Re-run didn't find ${o.type} "${o.label}"; kept it with its ${where(o.id)} because a person worked on it (${why})`,
        });
      }
      for (const o of plan.dropped) {
        system({
          action: "entity.dropped",
          ...entityFields(o),
          fromState: entityState(o.status),
          summary: `Re-run no longer finds ${o.type} "${o.label}"; nobody had reviewed it, so it was removed`,
        });
      }
      const carriedMentions = [...plan.mentionMatch.filter((m): m is OldMention => !!m?.override), ...plan.keptMentions.filter((m) => m.override)];
      for (const m of carriedMentions) {
        const owner = m.entityId ? labelOf.get(m.entityId) : undefined;
        const state = mentionState(m.override);
        system({
          action: "mention.carried",
          ...(owner ? entityFields({ id: owner.id!, label: owner.label, type: owner.type }) : {}),
          ...mentionFields(m),
          fromState: state,
          toState: state,
          summary: `Re-run kept the individual decision on "${m.text}" (${owner?.label ?? "unassigned"}, p.${m.pageNumber}): ${state} by ${m.decidedBy ?? "an unknown reviewer"}`,
        });
      }
      for (const m of plan.lost.filter((x) => x.override)) {
        const owner = oldEntities.find((o) => o.id === m.entityId);
        system({
          action: "mention.lost",
          ...(owner ? entityFields(owner) : { entityId: m.entityId }),
          ...mentionFields(m),
          fromState: mentionState(m.override),
          summary: `Re-run couldn't find "${m.text}" (p.${m.pageNumber}) at the same place again; ${m.decidedBy ?? "a reviewer"}'s individual decision (${mentionState(m.override)}) no longer applies`,
        });
      }

      const candidates = entityRows.length;
      const confirmations = values.filter((m) => m.assignmentConfirmed).length;
      const decided = entityRows.filter((e) => e.status !== "pending").length;
      const lostDecisions = plan.lost.filter((m) => m.override).length;
      events.unshift({
        batchId,
        actor: "system",
        createdAt: now,
        action: "batch.processed",
        summary: rerun
          ? `Re-scanned ${docTotal} document${docTotal === 1 ? "" : "s"} (${pagesTotal} pages): ${candidates} candidates (${plan.matched.size} found again, ${candidates - plan.matched.size - plan.keptOld.length} new` +
            `${plan.keptOld.length ? `, ${plan.keptOld.length} kept from before` : ""}${plan.dropped.length ? `; ${plan.dropped.length} unreviewed no longer found` : ""}). ` +
            `Carried over ${decided} entity decision${decided === 1 ? "" : "s"}, ${carriedMentions.length} individual mention decision${carriedMentions.length === 1 ? "" : "s"}, and ${confirmations} confirmed assignment${confirmations === 1 ? "" : "s"}` +
            (lostDecisions ? `. ${lostDecisions} individual decision${lostDecisions === 1 ? "" : "s"} couldn't be matched to the new results` : "")
          : `Scanned ${docTotal} document${docTotal === 1 ? "" : "s"} (${pagesTotal} pages): flagged ${result.entities.length} candidates for redaction`,
        details: {
          model: llm?.model ?? null,
          candidates,
          mentions: values.length,
          rerun,
          ...(rerun
            ? {
                foundAgain: plan.matched.size,
                keptFromBefore: plan.keptOld.length,
                dropped: plan.dropped.length,
                remerged: plan.remerged.length,
                carriedEntityDecisions: decided,
                carriedMentionDecisions: carriedMentions.length,
                carriedConfirmations: confirmations,
                lostMentionDecisions: lostDecisions,
              }
            : {}),
        },
      });
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
