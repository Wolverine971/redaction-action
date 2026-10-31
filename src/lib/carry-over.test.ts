import { describe, expect, it } from "vitest";
import { planCarryOver, type NewEntity, type NewMention, type OldEntity, type OldMention } from "./carry-over";

const at = new Date("2026-10-30T19:00:00Z");

function entity(id: string, label: string, extra: Partial<OldEntity> = {}): OldEntity {
  return {
    id,
    batchId: "b",
    type: "person",
    label,
    aliases: [label],
    role: null,
    aiSuggestion: "redact",
    aiConfidence: 0.9,
    aiRationale: null,
    status: "pending",
    createdBy: "ai",
    decidedBy: null,
    decidedAt: null,
    createdAt: at,
    ...extra,
  };
}

function mention(id: string, entityId: string | null, blockId: string, start: number, end: number, extra: Partial<OldMention> = {}): OldMention {
  return {
    id,
    batchId: "b",
    entityId,
    documentId: "d",
    blockId,
    pageNumber: 1,
    start,
    end,
    text: "x".repeat(end - start),
    rects: [],
    source: "llm",
    confidence: 0.9,
    aiDecision: "inherit",
    aiReason: null,
    ambiguous: false,
    candidateEntityIds: [],
    aiGuessConfidence: null,
    aiGuessRationale: null,
    assignmentConfirmed: false,
    assignedBy: null,
    assignedAt: null,
    override: null,
    decidedBy: null,
    decidedAt: null,
    ...extra,
  };
}

const ne = (key: string, label: string, aliases: string[] = [label]): NewEntity => ({ key, type: "person", label, aliases });
const nm = (entityKey: string | null, blockId: string, start: number, end: number, text = "x".repeat(end - start)): NewMention => ({
  entityKey,
  blockId,
  start,
  end,
  text,
});
/** Paragraph text where every old mention ("x" at its offsets) still reads the same. */
const blocks = (...ids: string[]) => new Map(ids.map((id) => [id, "x".repeat(40)]));

let n = 0;
const newId = () => `new-${++n}`;

describe("carrying reviewer work over to a re-run", () => {
  it("keeps the id and decision of an entity found again, even under a different name", () => {
    const john = entity("john", "John Smith", { status: "redact", decidedBy: "Dana", decidedAt: at, aliases: ["John Smith", "John A. Smith"] });
    const plan = planCarryOver({
      oldEntities: [john],
      oldMentions: [],
      merges: [],
      newEntities: [ne("k1", "John A. Smith"), ne("k2", "May Chen")],
      newMentions: [],
      blockText: new Map(),
      newId,
    });
    expect(plan.idByKey.get("k1")).toBe("john");
    expect(plan.matched.get("k1")?.decidedBy).toBe("Dana");
    expect(plan.idByKey.get("k2")).toMatch(/^new-/);
    expect(plan.dropped).toEqual([]);
  });

  it("drops only what nobody touched; keeps decided and hand-added entities with their mentions", () => {
    const plan = planCarryOver({
      oldEntities: [
        entity("gone", "Old Guess"),
        entity("kept", "Will Marsh", { status: "keep", decidedBy: "Priya", decidedAt: at }),
        entity("added", "Apartment 4B", { type: "address", createdBy: "Dana", status: "redact" }),
      ],
      oldMentions: [mention("m1", "kept", "b1", 0, 10), mention("m2", "added", "b2", 5, 17, { source: "manual", assignmentConfirmed: true })],
      merges: [],
      newEntities: [],
      newMentions: [],
      blockText: blocks("b1", "b2"),
      newId,
    });
    expect(plan.dropped.map((e) => e.id)).toEqual(["gone"]);
    expect(plan.keptOld.map((e) => e.id).sort()).toEqual(["added", "kept"]);
    expect(plan.keptMentions.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
  });

  it("carries a per-mention decision at the same place, and reports one it can't place", () => {
    const john = entity("john", "John Smith");
    const plan = planCarryOver({
      oldEntities: [john],
      oldMentions: [
        mention("same", "john", "b1", 0, 10, { override: "keep", decidedBy: "Dana", decidedAt: at }),
        mention("shifted", "john", "b1", 20, 30, { override: "keep", decidedBy: "Dana", decidedAt: at }),
        mention("vanished", "john", "b9", 0, 5, { override: "redact", decidedBy: "Dana", decidedAt: at }),
      ],
      merges: [],
      newEntities: [ne("k", "John Smith")],
      // Same place for "same"; a different, overlapping span where "shifted" was; b9 no longer exists.
      newMentions: [nm("k", "b1", 0, 10), nm("k", "b1", 18, 30)],
      blockText: blocks("b1"),
      newId,
    });
    expect(plan.mentionMatch.map((m) => m?.id ?? null)).toEqual(["same", null]);
    expect(plan.keptMentions).toEqual([]);
    expect(plan.lost.map((m) => m.id).sort()).toEqual(["shifted", "vanished"]);
  });

  it("won't carry a decision to a place whose words changed", () => {
    const plan = planCarryOver({
      oldEntities: [entity("john", "John Smith", { status: "redact", decidedBy: "Dana" })],
      oldMentions: [
        mention("moved", "john", "b1", 0, 1, { override: "keep", decidedBy: "Dana" }),
        mention("reworded", "john", "b2", 0, 1, { override: "keep", decidedBy: "Dana" }),
      ],
      merges: [],
      newEntities: [ne("k", "John Smith")],
      newMentions: [nm("k", "b1", 0, 1, "y")],
      blockText: new Map([
        ["b1", "y"],
        ["b2", "y"],
      ]),
      newId,
    });
    expect(plan.mentionMatch).toEqual([null]);
    expect(plan.keptMentions).toEqual([]);
    expect(plan.lost.map((m) => m.id).sort()).toEqual(["moved", "reworded"]);
  });

  it("re-applies a reviewer's merge when the re-run lists the two separately again", () => {
    const john = entity("john", "John Smith", { aliases: ["John Smith", "Johnny"] });
    const plan = planCarryOver({
      oldEntities: [john],
      oldMentions: [],
      merges: [{ fromLabel: "Johnny", fromType: "person", into: "john", actor: "Dana" }],
      newEntities: [ne("k1", "John Smith"), ne("k2", "Johnny")],
      newMentions: [nm("k2", "b1", 0, 6)],
      blockText: blocks("b1"),
      newId,
    });
    expect(plan.remerged).toMatchObject([{ key: "k2", intoKey: "k1" }]);
    expect(plan.idByKey.get("k2")).toBe("john");
  });

  it("prefers an exact name over a shared spelling when two people could match", () => {
    const john = entity("john", "John Smith", { aliases: ["John Smith", "Mr. Smith"] });
    const steve = entity("steve", "Steve Smith", { aliases: ["Steve Smith", "Mr. Smith"] });
    const plan = planCarryOver({
      oldEntities: [john, steve],
      oldMentions: [],
      merges: [],
      newEntities: [ne("s", "Steve Smith", ["Steve Smith", "Mr. Smith"]), ne("j", "John Smith", ["John Smith", "Mr. Smith"])],
      newMentions: [],
      blockText: new Map(),
      newId,
    });
    expect(plan.idByKey.get("j")).toBe("john");
    expect(plan.idByKey.get("s")).toBe("steve");
  });

  it("never pairs entities of different types", () => {
    const plan = planCarryOver({
      oldEntities: [entity("org", "Smith", { type: "org", status: "keep", decidedBy: "Dana" })],
      oldMentions: [],
      merges: [],
      newEntities: [ne("p", "Smith")],
      newMentions: [],
      blockText: new Map(),
      newId,
    });
    expect(plan.matched.size).toBe(0);
    expect(plan.keptOld.map((e) => e.id)).toEqual(["org"]);
  });
});
