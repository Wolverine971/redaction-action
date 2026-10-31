import type { entities, EntityType, mentions } from "@/db/schema";
import { aliasKey } from "@/lib/detect/aliases";

/**
 * When detection runs again on a batch, reviewers' work carries over to the new results.
 *
 * - An entity found again keeps its id, its decision, and who made it and when, so its history continues.
 * - A mention found again at the same place keeps its id and any per-mention decision or confirmed assignment.
 * - Anything a person decided, confirmed, or added stays even if the new run doesn't find it.
 * - Merges a person made are re-applied when the new run lists the two separately again.
 * - Only things nobody touched can disappear.
 */

export type OldEntity = typeof entities.$inferSelect;
export type OldMention = typeof mentions.$inferSelect;

export interface NewEntity {
  key: string;
  type: EntityType;
  label: string;
  aliases: string[];
}

export interface NewMention {
  entityKey: string | null;
  blockId: string;
  start: number;
  end: number;
  text: string;
}

/** A merge a reviewer made earlier. `into` is the id the merged entity lives on as today. */
export interface PastMerge {
  fromLabel: string;
  fromType: EntityType | null;
  into: string;
  actor: string;
}

export interface CarryPlan {
  /** Every new entity key → its id: the earlier entity's id when it's the same entity, otherwise a fresh one. */
  idByKey: Map<string, string>;
  /** New entity key → the earlier entity it continues. */
  matched: Map<string, OldEntity>;
  /** New entities folded into another because a reviewer merged them before. */
  remerged: { key: string; intoKey: string; merge: PastMerge }[];
  /** Earlier entities the new run didn't find, kept because a person decided, confirmed, or added something. */
  keptOld: OldEntity[];
  /** Earlier entities the new run didn't find and nobody touched. */
  dropped: OldEntity[];
  /** For each new mention (same order): the earlier mention at exactly the same place, if any. */
  mentionMatch: (OldMention | null)[];
  /** Earlier mentions kept as they were: a person's work at a place the new run didn't report. */
  keptMentions: OldMention[];
  /** Earlier mentions with a person's work that couldn't be kept (the text is gone or now overlaps a different finding). */
  lost: OldMention[];
}

const place = (m: { blockId: string; start: number; end: number }) => `${m.blockId}:${m.start}:${m.end}`;

/** True when a person did something to this mention: an exception, a confirmed assignment, or added it. */
export const touchedMention = (m: OldMention) => m.override !== null || m.assignmentConfirmed || m.source === "manual";

/** How sure we are that a new entity is an earlier one: 3 same name, 2 its name was a known spelling, 1 the reverse. */
function score(n: NewEntity, o: OldEntity) {
  if (n.type !== o.type) return 0;
  const name = aliasKey(n.label);
  if (name === aliasKey(o.label)) return 3;
  if (o.aliases.some((a) => aliasKey(a) === name)) return 2;
  const old = aliasKey(o.label);
  if (n.aliases.some((a) => aliasKey(a) === old)) return 1;
  return 0;
}

export function planCarryOver(input: {
  oldEntities: OldEntity[];
  oldMentions: OldMention[];
  merges: PastMerge[];
  newEntities: NewEntity[];
  newMentions: NewMention[];
  /** The text of every paragraph after re-reading the PDFs, by paragraph id. */
  blockText: Map<string, string>;
  newId?: () => string;
}): CarryPlan {
  const { oldEntities, oldMentions, merges, newEntities, newMentions, blockText } = input;
  const newId = input.newId ?? (() => crypto.randomUUID());

  const touchedIds = new Set(
    oldEntities
      .filter((e) => e.status !== "pending" || e.createdBy !== "ai")
      .map((e) => e.id)
      .concat(oldMentions.filter(touchedMention).flatMap((m) => (m.entityId ? [m.entityId] : []))),
  );

  // Pair new entities with earlier ones, best evidence first; ties go to the pair sharing the most places.
  const oldPlaces = new Map<string, Set<string>>();
  for (const m of oldMentions) if (m.entityId) oldPlaces.set(m.entityId, (oldPlaces.get(m.entityId) ?? new Set()).add(place(m)));
  const newPlaces = new Map<string, string[]>();
  for (const m of newMentions) if (m.entityKey) newPlaces.set(m.entityKey, [...(newPlaces.get(m.entityKey) ?? []), place(m)]);
  const pairs: { n: NewEntity; o: OldEntity; score: number; shared: number }[] = [];
  for (const n of newEntities) {
    for (const o of oldEntities) {
      const s = score(n, o);
      if (s === 0) continue;
      const shared = (newPlaces.get(n.key) ?? []).filter((p) => oldPlaces.get(o.id)?.has(p)).length;
      pairs.push({ n, o, score: s, shared });
    }
  }
  pairs.sort((a, b) => b.score - a.score || b.shared - a.shared);
  const matched = new Map<string, OldEntity>();
  const taken = new Set<string>();
  for (const p of pairs) {
    if (matched.has(p.n.key) || taken.has(p.o.id)) continue;
    matched.set(p.n.key, p.o);
    taken.add(p.o.id);
  }

  // Re-apply earlier merges: "Steve Smith" was merged into "John Smith", and the new run lists Steve separately again.
  const keyByOldId = new Map([...matched].map(([key, o]) => [o.id, key]));
  const remerged: CarryPlan["remerged"] = [];
  const folded = new Set<string>();
  for (const merge of merges) {
    const intoKey = keyByOldId.get(merge.into);
    if (!intoKey) continue;
    const name = aliasKey(merge.fromLabel);
    const again = newEntities.find(
      (n) =>
        n.key !== intoKey &&
        !matched.has(n.key) &&
        !folded.has(n.key) &&
        (!merge.fromType || n.type === merge.fromType) &&
        aliasKey(n.label) === name,
    );
    if (!again) continue;
    folded.add(again.key);
    remerged.push({ key: again.key, intoKey, merge });
  }

  const idByKey = new Map<string, string>();
  for (const n of newEntities) if (!folded.has(n.key)) idByKey.set(n.key, matched.get(n.key)?.id ?? newId());
  for (const r of remerged) idByKey.set(r.key, idByKey.get(r.intoKey)!);

  const keptOld = oldEntities.filter((o) => !taken.has(o.id) && touchedIds.has(o.id));
  const dropped = oldEntities.filter((o) => !taken.has(o.id) && !touchedIds.has(o.id));
  const keptOldIds = new Set(keptOld.map((o) => o.id));

  // Mentions: the same words at the same place are the same mention.
  const oldByPlace = new Map(oldMentions.map((m) => [place(m), m]));
  const used = new Set<string>();
  const mentionMatch = newMentions.map((m) => {
    const old = oldByPlace.get(place(m)) ?? null;
    if (old && old.text === m.text && !used.has(old.id)) {
      used.add(old.id);
      return old;
    }
    return null;
  });

  // Earlier mentions the new run didn't report: keep a person's work, and everything on an entity kept above.
  const spans = new Map<string, [number, number][]>();
  for (const m of newMentions) spans.set(m.blockId, [...(spans.get(m.blockId) ?? []), [m.start, m.end]]);
  const keptMentions: OldMention[] = [];
  const lost: OldMention[] = [];
  for (const m of oldMentions) {
    if (used.has(m.id)) continue;
    const wanted = touchedMention(m) || (m.entityId !== null && keptOldIds.has(m.entityId));
    if (!wanted) continue;
    const overlaps = (spans.get(m.blockId) ?? []).some(([s, e]) => m.start < e && m.end > s);
    // If the PDF reads differently now, the old offsets could point at other words: don't guess.
    const sameWords = blockText.get(m.blockId)?.slice(m.start, m.end) === m.text;
    if (!sameWords || overlaps) {
      if (touchedMention(m)) lost.push(m);
      continue;
    }
    keptMentions.push(m);
    spans.set(m.blockId, [...(spans.get(m.blockId) ?? []), [m.start, m.end]]);
  }

  return { idByKey, matched, remerged, keptOld, dropped, mentionMatch, keptMentions, lost };
}
