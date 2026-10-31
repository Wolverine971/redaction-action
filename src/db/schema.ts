// Drizzle table definitions live here.
// After changing this file: `pnpm db:generate` then `pnpm db:migrate`.
import type { RunTiming } from "../lib/estimate";
import {
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => new Uint8Array(value),
});

export type EntityType = "person" | "address" | "ssn" | "org";
export type Decision = "redact" | "keep";
export type EntityStatus = "pending" | Decision;
export type MentionSource = "llm" | "pattern" | "sweep" | "manual";
/** A box on the page in PDF points, origin top-left: [x0, y0, x1, y1]. */
export type Rect = [number, number, number, number];

/** A batch is one matter: a set of related documents that share one list of people. */
export const batches = pgTable("batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  status: text("status").$type<"processing" | "ready" | "failed">().notNull().default("processing"),
  stage: text("stage").notNull().default("Queued"),
  error: text("error"),
  warning: text("warning"),
  model: text("model"),
  usage: jsonb("usage").$type<{ inputTokens: number; outputTokens: number; calls: number; costUsd?: number }>(),
  /** Live progress while processing (see BatchProgress in src/lib/progress.ts). */
  progress: jsonb("progress").$type<Record<string, unknown>>(),
  /** Size and duration of the finished run; used to estimate how long future batches take. */
  // timing: what each stage measured, so later time estimates learn from it.
  stats: jsonb("stats").$type<{ chars: number; pages: number; seconds: number; model: string | null; timing?: RunTiming }>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
});

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => batches.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    filename: text("filename").notNull(),
    pageCount: integer("page_count").notNull().default(0),
    bytes: bytea("bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("documents_batch_idx").on(t.batchId)],
);

export const pages = pgTable(
  "pages",
  {
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    pageNumber: integer("page_number").notNull(),
    width: real("width").notNull(),
    height: real("height").notNull(),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.pageNumber] })],
);

/** A paragraph-level text block. `boxes` holds 4 numbers per character of `text` (all -1 for line breaks). */
export const blocks = pgTable(
  "blocks",
  {
    id: text("id").primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    pageNumber: integer("page_number").notNull(),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    boxes: jsonb("boxes").$type<number[]>().notNull(),
  },
  (t) => [index("blocks_document_idx").on(t.documentId, t.pageNumber)],
);

/** A thing that may need redacting: one person, one address, one SSN, or one organization. */
export const entities = pgTable(
  "entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => batches.id, { onDelete: "cascade" }),
    type: text("type").$type<EntityType>().notNull(),
    label: text("label").notNull(),
    aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
    role: text("role"),
    aiSuggestion: text("ai_suggestion").$type<Decision>().notNull(),
    aiConfidence: real("ai_confidence").notNull().default(0.5),
    aiRationale: text("ai_rationale"),
    status: text("status").$type<EntityStatus>().notNull().default("pending"),
    createdBy: text("created_by").notNull().default("ai"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("entities_batch_idx").on(t.batchId)],
);

/** One place in one document where an entity appears. */
export const mentions = pgTable(
  "mentions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => batches.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id").references(() => entities.id, { onDelete: "set null" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    blockId: text("block_id")
      .notNull()
      .references(() => blocks.id, { onDelete: "cascade" }),
    pageNumber: integer("page_number").notNull(),
    start: integer("start").notNull(),
    end: integer("end").notNull(),
    text: text("text").notNull(),
    rects: jsonb("rects").$type<Rect[]>().notNull(),
    source: text("source").$type<MentionSource>().notNull(),
    confidence: real("confidence").notNull().default(0.5),
    /** "inherit" follows the entity's decision; "keep"/"redact" is a per-mention exception the AI suggests. */
    aiDecision: text("ai_decision").$type<"inherit" | Decision>().notNull().default("inherit"),
    aiReason: text("ai_reason"),
    /** True when the matched text could belong to more than one entity (e.g. "Mr. Smith"). */
    ambiguous: boolean("ambiguous").notNull().default(false),
    candidateEntityIds: jsonb("candidate_entity_ids").$type<string[]>().notNull().default([]),
    aiGuessConfidence: real("ai_guess_confidence"),
    aiGuessRationale: text("ai_guess_rationale"),
    assignmentConfirmed: boolean("assignment_confirmed").notNull().default(false),
    /** Who confirmed which entity this mention is, and when. */
    assignedBy: text("assigned_by"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    /** A per-mention exception. `decidedBy`/`decidedAt` say who set the current one; null when there is none. */
    override: text("override").$type<Decision>(),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [
    index("mentions_batch_idx").on(t.batchId),
    index("mentions_entity_idx").on(t.entityId),
    index("mentions_document_idx").on(t.documentId, t.pageNumber),
  ],
);

/**
 * Where an entity or mention stood before and after an event.
 *   flagged  — found by the system, redacted by default (entities)
 *   redacted — a person chose to redact it
 *   kept     — a person chose to leave it visible
 *   follows  — no per-mention exception: the mention follows its entity (mentions)
 */
export type HistoryState = "flagged" | "redacted" | "kept" | "follows";

/**
 * Append-only record of every flag, decision, merge, re-run, and export. The database refuses
 * UPDATE and DELETE on this table (see drizzle/0004); rows go away only with their whole batch.
 * Entity and mention fields are copies taken at the time, so the history still reads correctly
 * after the entity is merged away or a re-run replaces it.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => batches.id, { onDelete: "cascade" }),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    entityId: uuid("entity_id"),
    entityLabel: text("entity_label"),
    entityType: text("entity_type").$type<EntityType>(),
    mentionId: uuid("mention_id"),
    mentionText: text("mention_text"),
    documentId: uuid("document_id"),
    pageNumber: integer("page_number"),
    fromState: text("from_state").$type<HistoryState>(),
    toState: text("to_state").$type<HistoryState>(),
    summary: text("summary").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_batch_idx").on(t.batchId, t.createdAt), index("audit_entity_idx").on(t.entityId)],
);
