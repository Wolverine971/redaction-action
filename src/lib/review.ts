import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  auditEvents,
  batches,
  blocks,
  documents,
  entities,
  mentions,
  pages,
  type Decision,
  type EntityStatus,
  type EntityType,
} from "@/db/schema";
import { aliasKey, aliasPattern, findAliases } from "@/lib/detect/aliases";
import { candidateState, effectiveDecision } from "@/lib/decisions";
import { rectsForSpan } from "@/lib/pdf/extract";

export async function listBatches() {
  const rows = await db
    .select({
      id: batches.id,
      name: batches.name,
      status: batches.status,
      stage: batches.stage,
      createdAt: batches.createdAt,
      // Table-qualified on purpose: inside the subquery, a bare "id" would mean the inner table's id.
      documents: sql<number>`(select count(*) from documents d where d.batch_id = "batches"."id")`.mapWith(Number),
      pages: sql<number>`(select coalesce(sum(d.page_count), 0) from documents d where d.batch_id = "batches"."id")`.mapWith(Number),
      entities: sql<number>`(select count(*) from entities e where e.batch_id = "batches"."id")`.mapWith(Number),
      reviewed: sql<number>`(select count(*) from entities e where e.batch_id = "batches"."id" and e.status <> 'pending')`.mapWith(Number),
    })
    .from(batches)
    .orderBy(desc(batches.createdAt));
  return rows;
}

/** Everything the live processing view polls for: stage, progress, documents, and a summary once ready. */
export async function getBatchLive(batchId: string) {
  const [batch] = await db
    .select({
      id: batches.id,
      name: batches.name,
      status: batches.status,
      stage: batches.stage,
      error: batches.error,
      warning: batches.warning,
      progress: batches.progress,
      stats: batches.stats,
      createdAt: batches.createdAt,
    })
    .from(batches)
    .where(eq(batches.id, batchId));
  if (!batch) return null;
  // A batch left "processing" by a server restart would otherwise spin forever.
  const { activeRuns } = await import("@/lib/process");
  if (batch.status === "processing" && !activeRuns.has(batchId)) {
    const started = Math.max(
      batch.createdAt.getTime(),
      Date.parse(String((batch.progress as { startedAt?: string } | null)?.startedAt ?? "")) || 0,
    );
    if (Date.now() - started > 60_000) {
      const error = "Processing was interrupted (the server restarted). Try again.";
      await db.update(batches).set({ status: "failed", error }).where(eq(batches.id, batchId));
      Object.assign(batch, { status: "failed", error });
    }
  }
  const docs = await db
    .select({ id: documents.id, filename: documents.filename, pageCount: documents.pageCount })
    .from(documents)
    .where(eq(documents.batchId, batchId))
    .orderBy(asc(documents.position));
  let summary = null;
  if (batch.status === "ready") {
    const data = (await getReview(batchId))!;
    const entityById = new Map(data.entities.map((e) => [e.id, e]));
    const byType = { person: 0, address: 0, ssn: 0, org: 0 } as Record<EntityType, number>;
    for (const e of data.entities) byType[e.type]++;
    summary = {
      byType,
      mentions: data.mentions.length,
      redactions: data.mentions.filter((m) => effectiveDecision(m, (id) => entityById.get(id)) === "redact").length,
      needsLook: data.mentions.filter((m) => m.ambiguous && !m.assignmentConfirmed && !m.override).length,
    };
  }
  // The server's clock, so the countdown lines up with the call start times even if the viewer's clock is off.
  return { ...batch, documents: docs, summary, serverNow: Date.now() };
}

export async function getBatchStatus(batchId: string) {
  const [batch] = await db
    .select({ id: batches.id, status: batches.status, stage: batches.stage, error: batches.error })
    .from(batches)
    .where(eq(batches.id, batchId));
  return batch ?? null;
}

const clean = (s: string) => s.replace(/\s+/g, " ");

export async function getReview(batchId: string) {
  const [batch] = await db.select().from(batches).where(eq(batches.id, batchId));
  if (!batch) return null;
  const docs = await db
    .select({ id: documents.id, filename: documents.filename, pageCount: documents.pageCount, position: documents.position })
    .from(documents)
    .where(eq(documents.batchId, batchId))
    .orderBy(asc(documents.position));
  const docIds = docs.map((d) => d.id);
  const pageRows = docIds.length
    ? await db.select().from(pages).where(inArray(pages.documentId, docIds)).orderBy(asc(pages.pageNumber))
    : [];
  const entityRows = await db.select().from(entities).where(eq(entities.batchId, batchId));
  const mentionRows = await db
    .select({ m: mentions, blockText: blocks.text })
    .from(mentions)
    .innerJoin(blocks, eq(blocks.id, mentions.blockId))
    .where(eq(mentions.batchId, batchId))
    .orderBy(asc(mentions.documentId), asc(mentions.pageNumber), asc(blocks.position), asc(mentions.start));
  const docOrder = new Map(docs.map((d) => [d.id, d.position]));
  mentionRows.sort((a, b) => (docOrder.get(a.m.documentId) ?? 0) - (docOrder.get(b.m.documentId) ?? 0));

  return {
    batch: {
      id: batch.id,
      name: batch.name,
      status: batch.status,
      stage: batch.stage,
      error: batch.error,
      warning: batch.warning,
      model: batch.model,
      usage: batch.usage,
      createdAt: batch.createdAt.toISOString(),
    },
    documents: docs.map((d) => ({
      id: d.id,
      filename: d.filename,
      pageCount: d.pageCount,
      pages: pageRows.filter((p) => p.documentId === d.id).map((p) => ({ n: p.pageNumber, w: p.width, h: p.height })),
    })),
    entities: entityRows.map((e) => ({
      id: e.id,
      type: e.type,
      label: e.label,
      aliases: e.aliases,
      role: e.role,
      aiSuggestion: e.aiSuggestion,
      aiConfidence: e.aiConfidence,
      aiRationale: e.aiRationale,
      status: e.status,
      createdBy: e.createdBy,
      decidedBy: e.decidedBy,
      decidedAt: e.decidedAt?.toISOString() ?? null,
    })),
    mentions: mentionRows.map(({ m, blockText }) => ({
      id: m.id,
      entityId: m.entityId,
      documentId: m.documentId,
      page: m.pageNumber,
      text: m.text,
      rects: m.rects,
      source: m.source,
      confidence: m.confidence,
      aiDecision: m.aiDecision,
      aiReason: m.aiReason,
      ambiguous: m.ambiguous,
      candidateEntityIds: m.candidateEntityIds,
      aiGuessConfidence: m.aiGuessConfidence,
      aiGuessRationale: m.aiGuessRationale,
      assignmentConfirmed: m.assignmentConfirmed,
      override: m.override,
      before: clean(blockText.slice(Math.max(0, m.start - 90), m.start)),
      after: clean(blockText.slice(m.end, m.end + 90)),
    })),
  };
}

export type ReviewData = NonNullable<Awaited<ReturnType<typeof getReview>>>;
export type ReviewEntity = ReviewData["entities"][number];
export type ReviewMention = ReviewData["mentions"][number];

export type ReviewAction =
  | { type: "setEntity"; entityIds: string[]; status: EntityStatus }
  | { type: "setMention"; mentionIds: string[]; override: Decision | null }
  | { type: "assign"; mentionIds: string[]; entityId: string }
  | { type: "confirmGuess"; mentionIds: string[] }
  | { type: "addEntity"; entityType: EntityType; label: string; query: string }
  | { type: "addAlias"; entityId: string; alias: string }
  | { type: "merge"; fromEntityId: string; intoEntityId: string };

export class ReviewError extends Error {}

/** Applies one reviewer action and records it in the audit log, atomically. */
export async function applyAction(batchId: string, actor: string, action: ReviewAction) {
  const now = new Date();
  return db.transaction(async (tx) => {
    const entityRows = await tx.select().from(entities).where(eq(entities.batchId, batchId));
    const entityById = new Map(entityRows.map((e) => [e.id, e]));
    const label = (id: string | null) => (id ? (entityById.get(id)?.label ?? "unknown") : "unassigned");
    const audit = (row: Omit<typeof auditEvents.$inferInsert, "batchId" | "actor">) =>
      tx.insert(auditEvents).values({ batchId, actor, ...row });

    switch (action.type) {
      case "setEntity": {
        const ids = action.entityIds.filter((id) => entityById.has(id));
        if (ids.length === 0) throw new ReviewError("No such entity");
        await tx
          .update(entities)
          .set({ status: action.status, decidedBy: action.status === "pending" ? null : actor, decidedAt: action.status === "pending" ? null : now })
          .where(and(eq(entities.batchId, batchId), inArray(entities.id, ids)));
        for (const id of ids) {
          const e = entityById.get(id)!;
          const to = candidateState({ status: action.status });
          await audit({
            action: `entity.${to}`,
            entityId: id,
            summary:
              to === "redacted"
                ? `Redacted ${e.type} "${e.label}"`
                : to === "kept"
                  ? `Kept ${e.type} "${e.label}" (left visible)`
                  : `Returned ${e.type} "${e.label}" to the system default (flagged, redacted)`,
            details: { from: candidateState(e), to, bulk: ids.length > 1 },
          });
        }
        return { changed: ids.length };
      }
      case "setMention": {
        const rows = await tx
          .select()
          .from(mentions)
          .where(and(eq(mentions.batchId, batchId), inArray(mentions.id, action.mentionIds)));
        if (rows.length === 0) throw new ReviewError("No such mention");
        await tx
          .update(mentions)
          .set({ override: action.override, decidedBy: actor, decidedAt: now })
          .where(inArray(mentions.id, rows.map((r) => r.id)));
        for (const m of rows) {
          await audit({
            action: action.override ? `mention.${action.override}` : "mention.clear",
            entityId: m.entityId,
            mentionId: m.id,
            summary: `${action.override === "redact" ? "Redacted one mention" : action.override === "keep" ? "Kept one mention" : "Cleared the individual decision on"} "${m.text}" (${label(m.entityId)}, p.${m.pageNumber})`,
            details: { from: m.override, to: action.override, documentId: m.documentId, page: m.pageNumber, bulk: rows.length > 1 },
          });
        }
        return { changed: rows.length };
      }
      case "assign":
      case "confirmGuess": {
        const rows = await tx
          .select()
          .from(mentions)
          .where(and(eq(mentions.batchId, batchId), inArray(mentions.id, action.mentionIds)));
        if (rows.length === 0) throw new ReviewError("No such mention");
        if (action.type === "assign" && !entityById.has(action.entityId)) throw new ReviewError("No such entity");
        for (const m of rows) {
          const target = action.type === "assign" ? action.entityId : m.entityId;
          if (!target) continue; // nothing to confirm on an unresolved mention
          await tx
            .update(mentions)
            .set({ entityId: target, assignmentConfirmed: true, decidedBy: actor, decidedAt: now })
            .where(eq(mentions.id, m.id));
          await audit({
            action: action.type === "assign" && target !== m.entityId ? "mention.reassign" : "mention.confirm",
            entityId: target,
            mentionId: m.id,
            summary:
              target !== m.entityId
                ? `Reassigned "${m.text}" (p.${m.pageNumber}) from ${label(m.entityId)} to ${label(target)}`
                : `Confirmed "${m.text}" (p.${m.pageNumber}) is ${label(target)}`,
            details: { from: m.entityId, to: target, aiGuessConfidence: m.aiGuessConfidence, bulk: rows.length > 1 },
          });
        }
        return { changed: rows.length };
      }
      case "addEntity": {
        const query = action.query.trim() || action.label.trim();
        if (!query) throw new ReviewError("Enter the text to redact");
        const [entity] = await tx
          .insert(entities)
          .values({
            batchId,
            type: action.entityType,
            label: action.label.trim() || query,
            aliases: [query],
            aiSuggestion: "redact",
            aiConfidence: 1,
            aiRationale: "Added by reviewer",
            status: "redact",
            createdBy: actor,
            decidedBy: actor,
            decidedAt: now,
          })
          .returning();
        const added = await addMentionsForAlias(tx, batchId, entity.id, query, actor, now);
        await audit({
          action: "entity.add",
          entityId: entity.id,
          summary: `Added ${entity.type} "${entity.label}" and redacted ${added} matches of "${query}"`,
          details: { query, added },
        });
        return { changed: added, entityId: entity.id };
      }
      case "addAlias": {
        const entity = entityById.get(action.entityId);
        if (!entity) throw new ReviewError("No such entity");
        const alias = action.alias.trim();
        if (!alias) throw new ReviewError("Enter a spelling to add");
        if (!entity.aliases.some((a) => aliasKey(a) === aliasKey(alias))) {
          await tx.update(entities).set({ aliases: [...entity.aliases, alias] }).where(eq(entities.id, entity.id));
        }
        const added = await addMentionsForAlias(tx, batchId, entity.id, alias, actor, now);
        await audit({
          action: "entity.alias",
          entityId: entity.id,
          summary: `Added spelling "${alias}" to "${entity.label}" (${added} new matches)`,
          details: { alias, added },
        });
        return { changed: added };
      }
      case "merge": {
        const from = entityById.get(action.fromEntityId);
        const into = entityById.get(action.intoEntityId);
        if (!from || !into || from.id === into.id) throw new ReviewError("Pick two different entities");
        await tx.update(mentions).set({ entityId: into.id }).where(eq(mentions.entityId, from.id));
        await tx
          .update(mentions)
          .set({
            candidateEntityIds: sql`(select coalesce(jsonb_agg(distinct case when v = ${from.id} then ${into.id} else v end), '[]'::jsonb) from jsonb_array_elements_text(${mentions.candidateEntityIds}) v)`,
          })
          .where(and(eq(mentions.batchId, batchId), sql`${mentions.candidateEntityIds} ? ${from.id}`));
        await tx
          .update(entities)
          .set({ aliases: [...new Set([...into.aliases, ...from.aliases, from.label])] })
          .where(eq(entities.id, into.id));
        await tx.delete(entities).where(eq(entities.id, from.id));
        await audit({
          action: "entity.merge",
          entityId: into.id,
          summary: `Merged "${from.label}" into "${into.label}"`,
          details: { from: from.id, fromLabel: from.label, into: into.id },
        });
        return { changed: 1 };
      }
    }
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Finds every match of `alias` in the batch and attaches the unclaimed ones to the entity. */
async function addMentionsForAlias(tx: Tx, batchId: string, entityId: string, alias: string, actor: string, now: Date) {
  const blockRows = await tx
    .select({ id: blocks.id, documentId: blocks.documentId, pageNumber: blocks.pageNumber, text: blocks.text, boxes: blocks.boxes })
    .from(blocks)
    .innerJoin(documents, eq(documents.id, blocks.documentId))
    .where(eq(documents.batchId, batchId));
  const existing = await tx
    .select({ blockId: mentions.blockId, start: mentions.start, end: mentions.end })
    .from(mentions)
    .where(eq(mentions.batchId, batchId));
  const taken = new Map<string, [number, number][]>();
  for (const m of existing) taken.set(m.blockId, [...(taken.get(m.blockId) ?? []), [m.start, m.end]]);

  const rows: (typeof mentions.$inferInsert)[] = [];
  for (const b of blockRows) {
    for (const match of findAliases(b.text, [alias])) {
      if ((taken.get(b.id) ?? []).some(([s, e]) => match.start < e && match.end > s)) continue;
      rows.push({
        batchId,
        entityId,
        documentId: b.documentId,
        blockId: b.id,
        pageNumber: b.pageNumber,
        start: match.start,
        end: match.end,
        text: match.text,
        rects: rectsForSpan(b.boxes, match.start, match.end),
        source: "manual",
        confidence: 1,
        assignmentConfirmed: true,
        decidedBy: actor,
        decidedAt: now,
      });
    }
  }
  for (let i = 0; i < rows.length; i += 1000) await tx.insert(mentions).values(rows.slice(i, i + 1000));
  return rows.length;
}

/** Text search across the batch, for finding things the AI missed. */
export async function searchBatch(batchId: string, query: string) {
  if (query.trim().length < 2 || !aliasPattern(query)) return [];
  const blockRows = await db
    .select({ id: blocks.id, documentId: blocks.documentId, filename: documents.filename, pageNumber: blocks.pageNumber, text: blocks.text })
    .from(blocks)
    .innerJoin(documents, eq(documents.id, blocks.documentId))
    .where(eq(documents.batchId, batchId))
    .orderBy(asc(documents.position), asc(blocks.pageNumber), asc(blocks.position));
  const existing = await db
    .select({ id: mentions.id, blockId: mentions.blockId, start: mentions.start, end: mentions.end, entityId: mentions.entityId })
    .from(mentions)
    .where(eq(mentions.batchId, batchId));
  const results = [];
  // Search case-insensitively here: the reviewer is looking, not auto-redacting.
  const re = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "gi");
  for (const b of blockRows) {
    for (const m of b.text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      const hit = existing.find((e) => e.blockId === b.id && start < e.end && end > e.start);
      results.push({
        documentId: b.documentId,
        filename: b.filename,
        page: b.pageNumber,
        text: m[0],
        before: clean(b.text.slice(Math.max(0, start - 70), start)),
        after: clean(b.text.slice(end, end + 70)),
        mentionId: hit?.id ?? null,
        entityId: hit?.entityId ?? null,
      });
      if (results.length >= 200) return results;
    }
  }
  return results;
}

export async function getAudit(batchId: string) {
  return db.select().from(auditEvents).where(eq(auditEvents.batchId, batchId)).orderBy(desc(auditEvents.id));
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

export async function auditCsv(batchId: string) {
  const rows = await getAudit(batchId);
  return toCsv([
    ["id", "timestamp", "reviewer", "action", "summary", "entity_id", "mention_id", "details"],
    ...rows.map((r) => [r.id, r.createdAt, r.actor, r.action, r.summary, r.entityId, r.mentionId, JSON.stringify(r.details)]),
  ]);
}
