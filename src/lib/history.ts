import type { auditEvents, Decision, EntityStatus, EntityType, HistoryState } from "@/db/schema";

export type AuditInsert = typeof auditEvents.$inferInsert;
export type AuditRecord = typeof auditEvents.$inferSelect;

/** Copies of an entity's name and type, so its history still reads correctly after a merge or re-run removes it. */
export const entityFields = (e: { id: string; label: string; type: EntityType }) => ({
  entityId: e.id,
  entityLabel: e.label,
  entityType: e.type,
});

export const mentionFields = (m: { id: string; text: string; documentId: string; pageNumber: number }) => ({
  mentionId: m.id,
  mentionText: m.text,
  documentId: m.documentId,
  pageNumber: m.pageNumber,
});

export const entityState = (status: EntityStatus): HistoryState =>
  status === "pending" ? "flagged" : status === "redact" ? "redacted" : "kept";

export const mentionState = (override: Decision | null): HistoryState =>
  override === "redact" ? "redacted" : override === "keep" ? "kept" : "follows";

/** "kept by Dana", "redacted by Dana", or "system flagged". */
export function describeDecision(e: { status: EntityStatus; decidedBy: string | null }) {
  if (e.status === "pending") return "system flagged";
  return `${e.status === "keep" ? "kept" : "redacted"} by ${e.decidedBy ?? "an unknown reviewer"}`;
}

export interface HistoryEvent {
  id: number;
  at: string;
  actor: string;
  action: string;
  summary: string;
  fromState: HistoryState | null;
  toState: HistoryState | null;
  mentionId: string | null;
  /** More than 1 when one bulk action touched several mentions; shown as one line. */
  count: number;
}

export interface RetiredEntity {
  id: string;
  label: string;
  type: EntityType | null;
  /** Why it's no longer in the results. */
  reason: string;
  history: HistoryEvent[];
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

/** Where an entity's history continues: a merged entity carries on as the one it was merged into. */
export function lineage(events: AuditRecord[]) {
  const mergedInto = new Map<string, string>();
  for (const e of events) {
    const from = str(e.details.from);
    if (e.action === "entity.merge" && from && e.entityId && from !== e.entityId) mergedInto.set(from, e.entityId);
  }
  return (id: string) => {
    const seen = new Set<string>();
    while (mergedInto.has(id) && !seen.has(id)) {
      seen.add(id);
      id = mergedInto.get(id)!;
    }
    return id;
  };
}

const quote = (s: string) => `"${s}"`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One line for a bulk action that touched many mentions at once, e.g. confirming 80 "Mr. Smith"s. */
function bulkSummary(group: AuditRecord[]) {
  const first = group[0];
  const n = group.length;
  const texts = [...new Set(group.map((e) => e.mentionText).filter((t): t is string => !!t))];
  const pages = [...new Set(group.map((e) => e.pageNumber).filter((p): p is number => p !== null))].sort((a, b) => a - b);
  const what = `${plural(n, "mention")}${texts.length ? ` (${texts.slice(0, 3).map(quote).join(", ")}${texts.length > 3 ? ", …" : ""})` : ""}`;
  const where = pages.length ? ` on ${pages.length === 1 ? "p." : "pp."}${pages.slice(0, 8).join(", ")}${pages.length > 8 ? ", …" : ""}` : "";
  const label = first.entityLabel ? quote(first.entityLabel) : "this entity";
  switch (first.action) {
    case "mention.redact":
      return `Redacted ${what}${where} individually`;
    case "mention.keep":
      return `Kept ${what}${where} individually (left visible)`;
    case "mention.clear":
      return `Cleared the individual decision on ${what}${where}`;
    case "mention.confirm":
      return `Confirmed ${what}${where} are ${label}`;
    case "mention.reassign":
      return `Reassigned ${what}${where} to ${label}`;
    case "mention.carried":
      return `Re-run kept the individual decisions on ${what}${where}`;
    case "mention.lost":
      return `Re-run couldn't find ${what}${where} again; their individual decisions no longer apply`;
    default:
      return `${first.summary} (+${n - 1} more)`;
  }
}

function toEvents(rows: AuditRecord[]): HistoryEvent[] {
  const out: HistoryEvent[] = [];
  const groups = new Map<string, AuditRecord[]>();
  const order: (AuditRecord | string)[] = [];
  for (const r of rows) {
    if (!r.action.startsWith("mention.")) {
      order.push(r);
      continue;
    }
    const key = `${r.createdAt.toISOString()}|${r.actor}|${r.action}|${r.entityId}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(r);
  }
  for (const item of order) {
    const group = typeof item === "string" ? groups.get(item)! : [item];
    const first = group[0];
    out.push({
      id: first.id,
      at: first.createdAt.toISOString(),
      actor: first.actor,
      action: first.action,
      summary: group.length === 1 ? first.summary : bulkSummary(group),
      fromState: first.fromState,
      toState: first.toState,
      mentionId: group.length === 1 ? first.mentionId : null,
      count: group.length,
    });
  }
  return out;
}

/**
 * Every entity's history, oldest first: system flags, decisions, per-mention exceptions, merges, and re-runs.
 * Entities that are no longer in the results but had a person's decision are returned as `retired`.
 */
export function entityHistories(rows: AuditRecord[], currentIds: Set<string>) {
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  const resolve = lineage(sorted);
  const byEntity = new Map<string, AuditRecord[]>();
  const add = (id: string, r: AuditRecord) => {
    const list = byEntity.get(id) ?? [];
    if (list.at(-1) !== r) list.push(r);
    byEntity.set(id, list);
  };
  for (const r of sorted) {
    if (r.entityId) add(resolve(r.entityId), r);
    // A mention moved away from an entity is part of that entity's story too.
    const from = str(r.details.from);
    if (r.action === "mention.reassign" && from) add(resolve(from), r);
  }

  const histories = new Map<string, HistoryEvent[]>();
  const retired: RetiredEntity[] = [];
  for (const [id, list] of byEntity) {
    if (currentIds.has(id)) {
      histories.set(id, toEvents(list));
      continue;
    }
    if (!list.some((r) => r.actor !== "system")) continue;
    const last = list.at(-1)!;
    const labelled = [...list].reverse().find((r) => r.entityId && resolve(r.entityId) === id && r.entityLabel);
    retired.push({
      id,
      label: labelled?.entityLabel ?? /"([^"]+)"/.exec(list.find((r) => r.entityId === id)?.summary ?? "")?.[1] ?? "(unknown)",
      type: labelled?.entityType ?? null,
      reason:
        last.action === "entity.dropped"
          ? "A re-run of detection no longer found it"
          : "Removed when detection was re-run (before decisions carried over)",
      history: toEvents(list),
    });
  }
  return { histories, retired };
}

/** Each mention's own history, oldest first, one line per event. */
export function mentionHistories(rows: AuditRecord[]) {
  const out = new Map<string, HistoryEvent[]>();
  for (const r of [...rows].sort((a, b) => a.id - b.id)) {
    if (!r.mentionId) continue;
    out.set(r.mentionId, [
      ...(out.get(r.mentionId) ?? []),
      {
        id: r.id,
        at: r.createdAt.toISOString(),
        actor: r.actor,
        action: r.action,
        summary: r.summary,
        fromState: r.fromState,
        toState: r.toState,
        mentionId: r.mentionId,
        count: 1,
      },
    ]);
  }
  return out;
}
