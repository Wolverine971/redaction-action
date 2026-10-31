import { effectiveDecision, candidateState } from "@/lib/decisions";
import { renderReportPdf } from "@/lib/report-pdf";
import { STATE_LABEL, type ReportCandidate, type ReportData } from "@/lib/report-types";
import { getAudit, getReview, toCsv, type ReviewData } from "@/lib/review";
import type { EntityType } from "@/db/schema";

const TYPE_ORDER: EntityType[] = ["person", "org", "address", "ssn"];
const TYPE_NAME: Record<EntityType, string> = { person: "Person", org: "Organization", address: "Address", ssn: "SSN" };

/** What the system flagged, what a reviewer redacted, and what a reviewer kept, plus the full audit trail. */
export async function getReport(batchId: string, generatedBy: string, data?: ReviewData): Promise<ReportData | null> {
  const review = data ?? (await getReview(batchId));
  if (!review) return null;
  const entityById = new Map(review.entities.map((e) => [e.id, e]));
  const filename = new Map(review.documents.map((d) => [d.id, d.filename]));

  const byEntity = new Map<string, ReviewData["mentions"]>();
  let mentionsRedacted = 0;
  const decided = new Map<string, boolean>();
  for (const m of review.mentions) {
    const redacted = effectiveDecision(m, (id) => entityById.get(id)) === "redact";
    decided.set(m.id, redacted);
    if (redacted) mentionsRedacted++;
    if (m.entityId) byEntity.set(m.entityId, [...(byEntity.get(m.entityId) ?? []), m]);
  }

  const candidates: ReportCandidate[] = review.entities.map((e) => {
    const list = byEntity.get(e.id) ?? [];
    const pagesByDoc = new Map<string, Set<number>>();
    for (const m of list) pagesByDoc.set(m.documentId, (pagesByDoc.get(m.documentId) ?? new Set()).add(m.page));
    const state = candidateState(e);
    return {
      type: e.type,
      label: e.label,
      role: e.role,
      state,
      decidedBy: state === "flagged" ? null : e.decidedBy,
      decidedAt: state === "flagged" ? null : e.decidedAt,
      mentions: list.length,
      mentionsRedacted: list.filter((m) => decided.get(m.id)).length,
      exceptions: list.filter((m) => m.override).length,
      locations: review.documents
        .filter((d) => pagesByDoc.has(d.id))
        .map((d) => ({ document: filename.get(d.id)!, pages: [...pagesByDoc.get(d.id)!].sort((a, b) => a - b) })),
    };
  });
  candidates.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || b.mentions - a.mentions || a.label.localeCompare(b.label));

  const byType: Record<EntityType, number> = { person: 0, org: 0, address: 0, ssn: 0 };
  for (const c of candidates) byType[c.type]++;
  const events = (await getAudit(batchId)).reverse().map((r) => ({ at: r.createdAt.toISOString(), actor: r.actor, summary: r.summary }));

  return {
    batch: {
      name: review.batch.name,
      createdAt: review.batch.createdAt,
      documents: review.documents.map((d) => ({ filename: d.filename, pages: d.pageCount })),
    },
    generatedAt: new Date().toISOString(),
    generatedBy,
    totals: {
      candidates: candidates.length,
      byType,
      flagged: candidates.filter((c) => c.state === "flagged").length,
      redacted: candidates.filter((c) => c.state === "redacted").length,
      kept: candidates.filter((c) => c.state === "kept").length,
      mentions: review.mentions.length,
      mentionsRedacted,
    },
    candidates,
    events,
  };
}

/** One row per candidate: its final state, who decided, when, and where it appears. */
export function decisionsCsv(report: ReportData) {
  return toCsv([
    ["type", "name", "role", "state", "decided_by", "decided_at", "mentions", "mentions_redacted", "mentions_set_individually", "where"],
    ...report.candidates.map((c) => [
      TYPE_NAME[c.type],
      c.label,
      c.role,
      c.state === "flagged" ? `${STATE_LABEL.flagged} (redacted by default)` : STATE_LABEL[c.state],
      c.decidedBy,
      c.decidedAt,
      c.mentions,
      c.mentionsRedacted,
      c.exceptions,
      c.locations.map((l) => `${l.document} p.${l.pages.join(",")}`).join("; "),
    ]),
  ]);
}

export function reportPdf(report: ReportData, timeZone?: string) {
  return renderReportPdf(report, { timeZone });
}

export function safeTimeZone(tz: string | null | undefined) {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}
