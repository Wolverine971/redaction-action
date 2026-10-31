import { effectiveDecision, candidateState } from "@/lib/decisions";
import { describeDecision, entityHistories, mentionHistories, type HistoryEvent } from "@/lib/history";
import { renderReportPdf } from "@/lib/report-pdf";
import { STATE_LABEL, type ReportCandidate, type ReportData, type ReportEvent, type ReportPlace } from "@/lib/report-types";
import { getAudit, getReview, toCsv, type ReviewData, type ReviewEntity, type ReviewMention } from "@/lib/review";
import type { EntityType } from "@/db/schema";

const TYPE_ORDER: EntityType[] = ["person", "org", "address", "ssn"];
const TYPE_NAME: Record<EntityType, string> = { person: "Person", org: "Organization", address: "Address", ssn: "SSN" };

/** What the system flagged, what a reviewer redacted, and what a reviewer kept, with each one's history and every place it appears. */
export async function getReport(batchId: string, generatedBy: string, data?: ReviewData): Promise<ReportData | null> {
  const review = data ?? (await getReview(batchId));
  if (!review) return null;
  const entityById = new Map(review.entities.map((e) => [e.id, e]));
  const lookup = (id: string) => entityById.get(id);
  const filename = new Map(review.documents.map((d) => [d.id, d.filename]));
  const auditRows = await getAudit(batchId);
  const { histories, retired } = entityHistories(auditRows, new Set(entityById.keys()));
  const byMention = mentionHistories(auditRows);

  const byEntity = new Map<string, ReportPlace[]>();
  const unassigned: ReportPlace[] = [];
  let mentionsRedacted = 0;
  for (const m of review.mentions) {
    const p = place(m, lookup, filename.get(m.documentId) ?? "(unknown document)", byMention.get(m.id) ?? []);
    if (p.outcome === "redacted") mentionsRedacted++;
    if (m.entityId && entityById.has(m.entityId)) byEntity.set(m.entityId, [...(byEntity.get(m.entityId) ?? []), p]);
    else unassigned.push(p);
  }

  const candidates: ReportCandidate[] = review.entities.map((e) => {
    const list = review.mentions.filter((m) => m.entityId === e.id);
    const places = byEntity.get(e.id) ?? [];
    const pagesByDoc = new Map<string, Set<number>>();
    for (const m of list) pagesByDoc.set(m.documentId, (pagesByDoc.get(m.documentId) ?? new Set()).add(m.page));
    const state = candidateState(e);
    const redacted = places.filter((p) => p.outcome === "redacted").length;
    return {
      id: e.id,
      type: e.type,
      label: e.label,
      role: e.role,
      state,
      decidedBy: state === "flagged" ? null : e.decidedBy,
      decidedAt: state === "flagged" ? null : e.decidedAt,
      mentions: list.length,
      mentionsRedacted: redacted,
      exceptions: list.filter((m) => m.override).length,
      locations: review.documents
        .filter((d) => pagesByDoc.has(d.id))
        .map((d) => ({ document: filename.get(d.id)!, pages: [...pagesByDoc.get(d.id)!].sort((a, b) => a - b) })),
      createdBy: e.createdBy,
      history: (histories.get(e.id) ?? []).map(reportEvent),
      places,
      mixed: redacted > 0 && redacted < places.length,
    };
  });
  candidates.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || b.mentions - a.mentions || a.label.localeCompare(b.label));

  const byType: Record<EntityType, number> = { person: 0, org: 0, address: 0, ssn: 0 };
  for (const c of candidates) byType[c.type]++;
  const events = [...auditRows].reverse().map((r) => ({ at: r.createdAt.toISOString(), actor: r.actor, summary: r.summary }));

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
    unassigned,
    retired: retired.map((r) => ({ label: r.label, type: r.type, reason: r.reason, history: r.history.map(reportEvent) })),
    events,
  };
}

const reportEvent = (e: HistoryEvent): ReportEvent => ({ at: e.at, actor: e.actor, action: e.action, summary: e.summary, toState: e.toState, count: e.count });

const edge = (s: string, n: number, from: "start" | "end") => {
  if (s.length <= n) return s;
  return from === "end" ? `…${s.slice(-n).replace(/^\S*\s/, "")}` : `${s.slice(0, n).replace(/\s\S*$/, "")}…`;
};

/** One place, with its outcome and the reason for it, worded for someone reading the record later. */
function place(m: ReviewMention, lookup: (id: string) => ReviewEntity | undefined, document: string, history: HistoryEvent[]): ReportPlace {
  const outcome = effectiveDecision(m, lookup) === "redact" ? "redacted" : "visible";
  const entity = m.entityId ? lookup(m.entityId) : undefined;
  let reason: string;
  if (m.override) reason = `${m.override === "keep" ? "Kept" : "Redacted"} individually${m.decidedBy ? ` by ${m.decidedBy}` : ""}`;
  else if (m.ambiguous && !m.assignmentConfirmed && outcome === "redacted" && entity?.status === "keep")
    reason = "Shared name, not confirmed: redacted to be safe because someone it could be is redacted";
  else if (!entity) reason = "Not tied to an entity: redacted to be safe";
  else if (entity.status === "pending") reason = "System flagged: redacted by default";
  else reason = `Follows the entity: ${describeDecision(entity)}`;
  return {
    mentionId: m.id,
    document,
    page: m.page,
    text: m.text,
    before: edge(m.before, 40, "end"),
    after: edge(m.after, 40, "start"),
    outcome,
    reason,
    individually: m.override ? { decision: m.override, by: m.decidedBy, at: m.decidedAt } : null,
    assignedBy: m.assignedBy,
    assignedAt: m.assignedAt,
    history: history.map(reportEvent),
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

/** One row per place: which entity, where, whether it's redacted or visible, and who decided. */
export function placesCsv(report: ReportData) {
  const row = (c: ReportCandidate | null, p: ReportPlace) => [
    c ? TYPE_NAME[c.type] : "",
    c?.label ?? "(not tied to an entity)",
    c ? STATE_LABEL[c.state] : "",
    p.document,
    p.page,
    p.text,
    `${p.before}[${p.text}]${p.after}`,
    p.outcome,
    p.reason,
    p.individually?.decision ?? "",
    p.individually?.by ?? "",
    p.individually?.at ?? "",
    p.assignedBy,
    p.assignedAt,
  ];
  return toCsv([
    ["type", "entity", "entity_state", "document", "page", "text", "context", "outcome", "why", "set_individually", "set_by", "set_at", "assigned_by", "assigned_at"],
    ...report.candidates.flatMap((c) => c.places.map((p) => row(c, p))),
    ...report.unassigned.map((p) => row(null, p)),
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
