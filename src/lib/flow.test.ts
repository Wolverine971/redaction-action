import { eq } from "drizzle-orm";
import { unzipSync, strFromU8 } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { auditEvents, batches } from "@/db/schema";
import { FakeLLM } from "@/lib/detect/fake-llm";
import { extractPdf } from "@/lib/pdf/extract";
import { createBatch, processBatch } from "@/lib/process";
import { buildExport } from "@/lib/export";
import { getReport } from "@/lib/report";
import { applyAction, auditCsv, getReview, listBatches } from "@/lib/review";

async function pdf(lines: string[][]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const page of lines) {
    const p = doc.addPage([612, 792]);
    page.forEach((text, i) => p.drawText(text, { x: 72, y: 720 - i * 40, size: 11, font }));
  }
  return doc.save();
}

const llm = () =>
  new FakeLLM(
    [
      { id: "john", type: "person", name: "John Smith", aliases: ["John Smith", "Mr. Smith"], role: "defendant", redact: true, why: "private" },
      { id: "steve", type: "person", name: "Steve Smith", aliases: ["Steve Smith", "Mr. Smith"], role: "son", redact: true, why: "private" },
      { id: "judge", type: "person", name: "Patricia Alvarez", aliases: ["Judge Alvarez"], role: "judge", redact: false, why: "official" },
    ],
    [
      { text: "John Smith", entity: "john" },
      { text: "Steve Smith", entity: "steve" },
      { text: "Judge Alvarez", entity: "judge" },
    ],
    (context) => (context.includes("«Mr. Smith», where was your father") ? "Steve Smith" : "unclear"),
  );

describe("upload → detect → review → export", () => {
  const created: string[] = [];
  afterAll(async () => {
    for (const id of created) await db.delete(batches).where(eq(batches.id, id));
  });

  it("runs the whole flow and records every decision", async () => {
    const batch = await createBatch("Flow test", [
      { filename: "a.pdf", bytes: await pdf([["Defendant John Smith, SSN 212-45-6789.", "Judge Alvarez presided."]]) },
      { filename: "b.pdf", bytes: await pdf([["Steve Smith was deposed.", "Q. Mr. Smith, where was your father?", "Mr. Smith left early."]]) },
    ]);
    created.push(batch.id);
    await processBatch(batch.id, llm());

    expect((await listBatches()).find((b) => b.id === batch.id)).toMatchObject({ documents: 2, pages: 2, status: "ready" });
    const review = (await getReview(batch.id))!;
    expect(review.batch.status).toBe("ready");
    expect(review.documents.map((d) => d.pageCount)).toEqual([1, 1]);
    const entity = (label: string) => review.entities.find((e) => e.label === label)!;
    expect(entity("Patricia Alvarez").aiSuggestion).toBe("keep");

    // Two "Mr. Smith" mentions: one resolved from context, one left unclear.
    const mr = review.mentions.filter((m) => m.text === "Mr. Smith");
    expect(mr).toHaveLength(2);
    expect(mr.every((m) => m.ambiguous)).toBe(true);
    expect(mr.map((m) => m.entityId)).toEqual([entity("Steve Smith").id, null]);

    // Reviewer: redact John, keep Steve, confirm the resolved one, assign the unclear one to John.
    await applyAction(batch.id, "Dana", { type: "setEntity", entityIds: [entity("John Smith").id], status: "redact" });
    await applyAction(batch.id, "Dana", { type: "setEntity", entityIds: [entity("Steve Smith").id], status: "keep" });
    await applyAction(batch.id, "Dana", { type: "confirmGuess", mentionIds: [mr[0].id] });
    await applyAction(batch.id, "Dana", { type: "assign", mentionIds: [mr[1].id], entityId: entity("John Smith").id });

    const { zip } = await buildExport(batch.id, "Dana");
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual([
      "README.txt",
      "internal/Flow-test-redaction-report.pdf",
      "internal/audit-trail.csv",
      "internal/decisions.csv",
      "internal/places.csv",
      "share/a-redacted.pdf",
      "share/b-redacted.pdf",
      "share/redaction-log.csv",
      "share/verification.json",
    ]);
    const text = (name: string) => extractPdf(files[name], "x").blocks.map((b) => b.text).join("\n");
    expect(text("share/a-redacted.pdf")).not.toMatch(/John Smith|212-45-6789/);
    // Nobody touched the judge, so the system's flag stands: redacted by default, even though the AI thought it was fine.
    expect(text("share/a-redacted.pdf")).not.toContain("Alvarez");
    // Steve is kept, including the "Mr. Smith" confirmed as him; the other "Mr. Smith" is John and is gone.
    expect(text("share/b-redacted.pdf")).toContain("Steve Smith was deposed.");
    expect(text("share/b-redacted.pdf")).toContain("Q. Mr. Smith, where was your father?");
    expect(text("share/b-redacted.pdf")).not.toContain("Mr. Smith left early");
    // The shareable log never contains the redacted text.
    expect(strFromU8(files["share/redaction-log.csv"])).not.toMatch(/John|Smith|6789|Alvarez/);
    expect(strFromU8(files["share/redaction-log.csv"])).toContain("System flagged (redacted by default)");
    expect(JSON.parse(strFromU8(files["share/verification.json"])).documents.every((d: { leaks: number }) => d.leaks === 0)).toBe(true);

    // The internal decisions sheet has all three states, with who decided.
    const decisions = strFromU8(files["internal/decisions.csv"]);
    expect(decisions).toMatch(/Person,John Smith,defendant,You redacted,Dana,/);
    expect(decisions).toMatch(/Person,Steve Smith,son,You kept,Dana,/);
    expect(decisions).toMatch(/Person,Patricia Alvarez,judge,System flagged \(redacted by default\),,/);
    const report = extractPdf(files["internal/Flow-test-redaction-report.pdf"], "r").blocks.map((b) => b.text).join("\n");
    expect(report).toContain("INTERNAL");
    expect(report).toContain("Steve Smith");

    // Every place, with whether it's visible and why.
    const places = strFromU8(files["internal/places.csv"]);
    expect(places).toMatch(/Person,Steve Smith,You kept,b\.pdf,1,Steve Smith,.*,visible,Follows the entity: kept by Dana/);
    expect(places).toMatch(/Person,John Smith,You redacted,a\.pdf,1,John Smith,.*,redacted,Follows the entity: redacted by Dana/);

    // Confirming who a mention is records the confirmer separately from any redact/keep decision on it.
    const confirmed = (await getReview(batch.id))!.mentions.find((m) => m.id === mr[0].id)!;
    expect(confirmed).toMatchObject({ assignedBy: "Dana", decidedBy: null, override: null });

    const audit = await auditCsv(batch.id);
    expect(audit).toContain('System flagged person ""Patricia Alvarez"" for redaction');
    expect(audit).toContain('Redacted person ""John Smith""');
    expect(audit).toContain('Kept person ""Steve Smith"" (left visible)');
    expect(audit).toContain("Confirmed");
    expect(audit).toContain("Reassigned");
    expect(audit).toContain("Exported 2 redacted document(s)");
    // Nobody reviewed the judge or the SSN, and the export records that, by type.
    expect(audit).toMatch(/2 system flagged and redacted without a person's review \(1 person, 1 SSN\)/);
    expect(audit.match(/Dana/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it("keeps who decided what, and when, through overwrites and a re-run; the log can't be edited", async () => {
    const batch = await createBatch("History test", [
      { filename: "e.pdf", bytes: await pdf([["Defendant John Smith appeared.", "John Smith spoke to Steve Smith."], ["John Smith left.", "Apartment 4B was searched."]]) },
    ]);
    created.push(batch.id);
    await processBatch(batch.id, llm());
    let review = (await getReview(batch.id))!;
    const john = review.entities.find((e) => e.label === "John Smith")!;
    const johnMentions = review.mentions.filter((m) => m.entityId === john.id);
    expect(johnMentions.map((m) => m.page)).toEqual([1, 1, 2]);
    const page2 = johnMentions[2];

    // Priya keeps John; Dana overwrites that with redact but leaves the page 2 mention visible.
    await applyAction(batch.id, "Priya", { type: "setEntity", entityIds: [john.id], status: "keep" });
    await applyAction(batch.id, "Dana", { type: "setEntity", entityIds: [john.id], status: "redact" });
    await applyAction(batch.id, "Dana", { type: "setMention", mentionIds: [page2.id], override: "keep" });
    await applyAction(batch.id, "Dana", { type: "addEntity", entityType: "address", label: "Apartment 4B", query: "Apartment 4B" });
    const decided = (await getReview(batch.id))!.entities.find((e) => e.id === john.id)!;
    expect(decided).toMatchObject({ status: "redact", decidedBy: "Dana" });

    // Choosing the decision it already has doesn't take credit from whoever made it.
    expect(await applyAction(batch.id, "Sam", { type: "setEntity", entityIds: [john.id], status: "redact" })).toEqual({ changed: 0 });
    expect((await getReview(batch.id))!.entities.find((e) => e.id === john.id)).toMatchObject({ decidedBy: "Dana", decidedAt: decided.decidedAt });

    // Re-running detection keeps the decision, the exception, and the hand-added address, with the same ids.
    await processBatch(batch.id, llm());
    review = (await getReview(batch.id))!;
    expect(review.batch.status).toBe("ready");
    expect(review.entities.find((e) => e.id === john.id)).toMatchObject({ status: "redact", decidedBy: "Dana", decidedAt: decided.decidedAt });
    expect(review.mentions.find((m) => m.id === page2.id)).toMatchObject({ override: "keep", decidedBy: "Dana" });
    expect(review.entities.find((e) => e.label === "Apartment 4B")).toMatchObject({ status: "redact", createdBy: "Dana" });
    expect(review.mentions.filter((m) => m.text === "Apartment 4B")).toHaveLength(1);

    // The report: John is mixed. His history lists every decision, oldest first, and each place says visible or redacted.
    const report = (await getReport(batch.id, "Dana"))!;
    const c = report.candidates.find((x) => x.id === john.id)!;
    expect(c.mixed).toBe(true);
    expect(c.places.map((p) => [p.page, p.outcome])).toEqual([
      [1, "redacted"],
      [1, "redacted"],
      [2, "visible"],
    ]);
    expect(c.places[2]).toMatchObject({ reason: "Kept individually by Dana", individually: { decision: "keep", by: "Dana" } });
    expect(c.places[0].reason).toBe("Follows the entity: redacted by Dana");
    expect(c.history.map((e) => [e.actor, e.action, e.toState])).toEqual([
      ["system", "entity.flagged", "flagged"],
      ["Priya", "entity.kept", "kept"],
      ["Dana", "entity.redacted", "redacted"],
      ["Dana", "mention.keep", "kept"],
      ["system", "entity.redetected", "redacted"],
      ["system", "mention.carried", "kept"],
    ]);
    expect(c.history[2].summary).toBe('Redacted person "John Smith" (was kept by Priya)');
    expect(report.retired).toEqual([]);

    // The audit log refuses edits and deletes; only deleting the whole batch removes it.
    await expect(db.update(auditEvents).set({ summary: "tampered" }).where(eq(auditEvents.batchId, batch.id))).rejects.toThrow();
    await expect(db.delete(auditEvents).where(eq(auditEvents.batchId, batch.id))).rejects.toThrow();
    const csv = await auditCsv(batch.id);
    expect(csv).not.toContain("tampered");
    expect(csv.split("\n")[0]).toBe("id,timestamp,reviewer,action,entity,entity_type,mention_text,document,page,from,to,summary,entity_id,mention_id,details");
  });

  it("adds a missed spelling everywhere in one step", async () => {
    const batch = await createBatch("Alias test", [
      { filename: "c.pdf", bytes: await pdf([["John Smith arrived. Later, Smitty left.", "Everyone called him Smitty."]]) },
    ]);
    created.push(batch.id);
    await processBatch(batch.id, llm());
    const john = (await getReview(batch.id))!.entities.find((e) => e.label === "John Smith")!;
    const result = await applyAction(batch.id, "Dana", { type: "addAlias", entityId: john.id, alias: "Smitty" });
    expect(result.changed).toBe(2);
  });

  it("merges two entities and redacts new text the AI missed", async () => {
    const batch = await createBatch("Merge test", [
      { filename: "d.pdf", bytes: await pdf([["John Smith met Steve Smith.", "Apartment 4B was searched."]]) },
    ]);
    created.push(batch.id);
    await processBatch(batch.id, llm());
    let review = (await getReview(batch.id))!;
    const john = review.entities.find((e) => e.label === "John Smith")!;
    const steve = review.entities.find((e) => e.label === "Steve Smith")!;
    await applyAction(batch.id, "Dana", { type: "merge", fromEntityId: steve.id, intoEntityId: john.id });
    const added = await applyAction(batch.id, "Dana", { type: "addEntity", entityType: "address", label: "Apartment 4B", query: "Apartment 4B" });
    expect(added.changed).toBe(1);
    review = (await getReview(batch.id))!;
    expect(review.entities.some((e) => e.id === steve.id)).toBe(false);
    expect(review.mentions.filter((m) => m.entityId === john.id).map((m) => m.text).sort()).toEqual(["John Smith", "Steve Smith"]);
    expect(review.entities.find((e) => e.label === "John Smith")!.aliases).toContain("Steve Smith");
    expect(review.entities.find((e) => e.label === "Apartment 4B")).toMatchObject({ status: "redact", createdBy: "Dana" });

    // A re-run lists Steve separately again; Dana's merge is re-applied and logged, and Steve's history stays with John.
    await processBatch(batch.id, llm());
    review = (await getReview(batch.id))!;
    expect(review.entities.map((e) => e.label).sort()).toEqual(["Apartment 4B", "John Smith"]);
    expect(review.mentions.filter((m) => m.entityId === john.id).map((m) => m.text).sort()).toEqual(["John Smith", "Steve Smith"]);
    const history = (await getReport(batch.id, "Dana"))!.candidates.find((c) => c.id === john.id)!.history;
    expect(history.filter((e) => e.action === "entity.merge").map((e) => e.actor)).toEqual(["Dana", "system"]);
    expect(history.some((e) => e.summary.includes('flagged person "Steve Smith"'))).toBe(true);
  });
});
