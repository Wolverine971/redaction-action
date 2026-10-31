import type { Decision, EntityType } from "@/db/schema";
import { aliasKey } from "@/lib/detect/aliases";
import { effectiveDecision } from "@/lib/decisions";
import type { ReviewData, ReviewEntity, ReviewMention } from "@/lib/review";

export type { ReviewData, ReviewEntity, ReviewMention };

export const TYPE_LABEL: Record<EntityType, { one: string; many: string }> = {
  person: { one: "Person", many: "People" },
  org: { one: "Organization", many: "Organizations" },
  address: { one: "Address", many: "Addresses" },
  ssn: { one: "SSN", many: "SSNs" },
};
/** The order groups appear in the candidate tree and the report. */
export const TYPE_ORDER: EntityType[] = ["person", "org", "address", "ssn"];

export interface AmbiguousGroup {
  key: string;
  text: string;
  guessId: string | null;
  candidateIds: string[];
  mentions: ReviewMention[];
  confidence: number;
  rationale: string | null;
}

export interface Derived {
  entityById: Map<string, ReviewEntity>;
  mentionsByEntity: Map<string, ReviewMention[]>;
  decision: Map<string, Decision>;
  /** Shared-name mentions ("Mr. Smith") whose fate depends on who they are: one possible person is kept. */
  ambiguousGroups: AmbiguousGroup[];
  stats: {
    candidates: number;
    byType: Record<EntityType, number>;
    flagged: number;
    redacted: number;
    kept: number;
    redactMentions: number;
    totalMentions: number;
  };
}

export function derive(data: ReviewData): Derived {
  const entityById = new Map(data.entities.map((e) => [e.id, e]));
  const mentionsByEntity = new Map<string, ReviewMention[]>();
  const decision = new Map<string, Decision>();
  for (const m of data.mentions) {
    decision.set(m.id, effectiveDecision(m, (id) => entityById.get(id)));
    const ids = new Set([m.entityId, ...(m.ambiguous && !m.assignmentConfirmed ? m.candidateEntityIds : [])]);
    for (const id of ids) {
      if (!id) continue;
      mentionsByEntity.set(id, [...(mentionsByEntity.get(id) ?? []), m]);
    }
  }

  // "Who is this?": unconfirmed mentions that fit more than one person, grouped by text + best guess, so
  // 80 "Mr. Smith" mentions in one deposition are one decision. Only shown once it matters: while every
  // possible person is redacted, these are redacted either way.
  const groups = new Map<string, AmbiguousGroup>();
  for (const m of data.mentions) {
    if (m.override || !m.ambiguous || m.assignmentConfirmed) continue;
    const ids = [...new Set([...m.candidateEntityIds, ...(m.entityId ? [m.entityId] : [])])];
    if (!ids.some((id) => entityById.get(id)?.status === "keep")) continue;
    const key = `${aliasKey(m.text)}|${m.entityId ?? "none"}`;
    const g = groups.get(key) ?? { key, text: m.text, guessId: m.entityId, candidateIds: [], mentions: [], confidence: 0, rationale: m.aiGuessRationale };
    g.mentions.push(m);
    g.candidateIds = [...new Set([...g.candidateIds, ...m.candidateEntityIds])];
    g.confidence += m.aiGuessConfidence ?? 0;
    groups.set(key, g);
  }
  const ambiguousGroups = [...groups.values()]
    .map((g) => ({ ...g, confidence: g.confidence / g.mentions.length }))
    .sort((a, b) => b.mentions.length - a.mentions.length);

  const byType: Record<EntityType, number> = { person: 0, org: 0, address: 0, ssn: 0 };
  for (const e of data.entities) byType[e.type]++;
  return {
    entityById,
    mentionsByEntity,
    decision,
    ambiguousGroups,
    stats: {
      candidates: data.entities.length,
      byType,
      flagged: data.entities.filter((e) => e.status === "pending").length,
      redacted: data.entities.filter((e) => e.status === "redact").length,
      kept: data.entities.filter((e) => e.status === "keep").length,
      redactMentions: [...decision.values()].filter((d) => d === "redact").length,
      totalMentions: data.mentions.length,
    },
  };
}

/** Most-mentioned first, so the people who matter most are at the top of each group. */
export function sortEntities(list: ReviewEntity[], derived: Derived) {
  const count = (e: ReviewEntity) => derived.mentionsByEntity.get(e.id)?.length ?? 0;
  return [...list].sort((a, b) => count(b) - count(a) || a.label.localeCompare(b.label));
}

export const pct = (n: number) => `${Math.round(n * 100)}%`;
