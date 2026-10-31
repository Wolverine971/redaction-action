import type { Decision, EntityStatus } from "@/db/schema";
import type { CandidateState } from "@/lib/report-types";

/**
 * How a mention ends up redacted or kept. Shared by the review screen and the export, so what the
 * reviewer sees is exactly what gets burned into the PDF.
 *
 * Everything the system finds is redacted by default; only a person can keep something.
 *   1. A reviewer's per-mention decision wins.
 *   2. A shared-name mention nobody has confirmed is redacted if any person it might be is redacted.
 *   3. Otherwise the mention follows its candidate: kept only if a reviewer chose to keep it.
 */
export interface DecisionMention {
  entityId: string | null;
  override: Decision | null;
  ambiguous: boolean;
  assignmentConfirmed: boolean;
  candidateEntityIds: string[];
}

export interface DecisionEntity {
  status: EntityStatus;
}

/** "pending" means no reviewer has touched it: the system flagged it, so it's redacted. */
export function entityDecision(e: DecisionEntity): Decision {
  return e.status === "keep" ? "keep" : "redact";
}

export function candidateState(e: DecisionEntity): CandidateState {
  return e.status === "pending" ? "flagged" : e.status === "redact" ? "redacted" : "kept";
}

export function effectiveDecision(m: DecisionMention, entityById: (id: string) => DecisionEntity | undefined): Decision {
  if (m.override) return m.override;
  if (m.ambiguous && !m.assignmentConfirmed) {
    const ids = new Set([...m.candidateEntityIds, ...(m.entityId ? [m.entityId] : [])]);
    const anyRedact = [...ids].some((id) => {
      const e = entityById(id);
      return !e || entityDecision(e) === "redact";
    });
    if (anyRedact || ids.size === 0) return "redact";
  }
  const entity = m.entityId ? entityById(m.entityId) : undefined;
  return entity ? entityDecision(entity) : "redact";
}

/** Why a mention ended up the way it did, in plain words for the review screen. */
export function decisionReason(m: DecisionMention, entityById: (id: string) => DecisionEntity | undefined) {
  if (m.override) return m.override === "keep" ? "You kept this mention" : "You redacted this mention";
  const entity = m.entityId ? entityById(m.entityId) : undefined;
  if (m.ambiguous && !m.assignmentConfirmed && effectiveDecision(m, entityById) === "redact" && entity?.status === "keep") {
    return "Could be someone else who is redacted — redacted to be safe until you confirm who this is";
  }
  if (!entity) return "Unassigned — redacted to be safe";
  return { flagged: "System flagged — redacted by default", redacted: "You redacted this", kept: "You kept this" }[candidateState(entity)];
}
