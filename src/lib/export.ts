import { eq } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { db } from "@/db";
import { auditEvents, documents, type EntityType } from "@/db/schema";
import { candidateState, effectiveDecision } from "@/lib/decisions";
import { redactPdf } from "@/lib/pdf/redact";
import { decisionsCsv, getReport, reportPdf } from "@/lib/report";
import { auditCsv, getReview, ReviewError, toCsv } from "@/lib/review";

const README = `This download has two folders.

share/     Safe to send. The redacted PDFs (text under every box is permanently removed, not just covered),
           a redaction log that lists where things were redacted but never what, and a verification report.

internal/  Keep inside your office. The redaction report (PDF), a decisions spreadsheet, and the full audit
           trail. These name every person, address, and number that was redacted, and who decided what, and when.

Everything the system found was redacted unless a reviewer chose to keep it.
`;

/**
 * Builds the download: redacted PDFs plus a shareable log in share/, and the redaction report, decisions,
 * and audit trail (which name what was redacted) in internal/.
 */
export async function buildExport(batchId: string, actor: string, timeZone?: string) {
  const data = await getReview(batchId);
  if (!data) throw new ReviewError("No such batch");
  if (data.batch.status !== "ready") throw new ReviewError("This batch hasn't finished processing");
  const entityById = new Map(data.entities.map((e) => [e.id, e]));
  const base = data.batch.name.replace(/[^\w.-]+/g, "-");
  const files: Record<string, Uint8Array> = {};
  const log: unknown[][] = [["document", "page", "category", "why", "decided_by", "x0", "y0", "x1", "y1"]];
  const verification: { document: string; pages: number; boxes: number; leaks: number }[] = [];
  const counts = {
    flagged: data.entities.filter((e) => e.status === "pending").length,
    redacted: data.entities.filter((e) => e.status === "redact").length,
    kept: data.entities.filter((e) => e.status === "keep").length,
    sharedNamesUnconfirmed: 0,
  };

  for (const doc of data.documents) {
    const byPage = new Map<number, [number, number, number, number][]>();
    for (const m of data.mentions.filter((x) => x.documentId === doc.id)) {
      const unconfirmed = m.ambiguous && !m.assignmentConfirmed && !m.override;
      if (unconfirmed) counts.sharedNamesUnconfirmed++;
      if (effectiveDecision(m, (id) => entityById.get(id)) !== "redact") continue;
      const entity = m.entityId ? entityById.get(m.entityId) : undefined;
      const why = m.override
        ? "Reviewer redacted this mention"
        : unconfirmed && entity?.status === "keep"
          ? "Shared name, unconfirmed: redacted to be safe"
          : !entity || candidateState(entity) === "flagged"
            ? "System flagged (redacted by default)"
            : "Reviewer redacted";
      byPage.set(m.page, [...(byPage.get(m.page) ?? []), ...m.rects]);
      for (const r of m.rects) {
        log.push([doc.filename, m.page, entity ? categoryLabel(entity.type) : "Name", why, m.override ? "reviewer" : (entity?.decidedBy ?? "system"), ...r]);
      }
    }
    const [row] = await db.select({ bytes: documents.bytes }).from(documents).where(eq(documents.id, doc.id));
    const result = redactPdf(row.bytes, [...byPage].map(([page, rects]) => ({ page, rects })));
    if (result.leaks.length > 0) {
      throw new Error(
        `Verification failed: text is still readable under ${result.leaks.length} redaction box(es) in ${doc.filename} (pages ${[...new Set(result.leaks.map((l) => l.page))].join(", ")}). Nothing was exported.`,
      );
    }
    files[`share/${doc.filename.replace(/\.pdf$/i, "")}-redacted.pdf`] = result.bytes;
    verification.push({ document: doc.filename, pages: doc.pageCount, boxes: result.boxes, leaks: 0 });
  }

  const boxes = verification.reduce((n, v) => n + v.boxes, 0);
  files["share/redaction-log.csv"] = strToU8(toCsv(log));
  files["share/verification.json"] = strToU8(
    JSON.stringify(
      {
        batch: data.batch.name,
        exportedAt: new Date().toISOString(),
        exportedBy: actor,
        check: "Re-read every output page and confirmed no characters remain under any redaction box.",
        candidates: counts,
        documents: verification,
      },
      null,
      2,
    ),
  );

  // Log the export first, so the report and audit trail in this download include it.
  await db.insert(auditEvents).values({
    batchId,
    actor,
    action: "export",
    summary: `Exported ${data.documents.length} redacted document(s), ${boxes} boxes: ${counts.flagged} system flagged, ${counts.redacted} reviewer redacted, ${counts.kept} reviewer kept`,
    details: { candidates: counts, documents: verification },
  });
  const report = (await getReport(batchId, actor, data))!;
  files[`internal/${base}-redaction-report.pdf`] = await reportPdf(report, timeZone);
  files["internal/decisions.csv"] = strToU8(decisionsCsv(report));
  files["internal/audit-trail.csv"] = strToU8(await auditCsv(batchId));
  files["README.txt"] = strToU8(README);

  return { zip: zipSync(files, { level: 6 }), filename: `${base}-redacted.zip` };
}

function categoryLabel(type: EntityType) {
  return { person: "Name", address: "Address", ssn: "Social Security number", org: "Organization" }[type];
}
