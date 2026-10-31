import type { EntityType } from "@/db/schema";

/**
 * Where a redaction candidate stands:
 *   flagged  — the system found it and it will be redacted; no reviewer has touched it
 *   redacted — a reviewer explicitly chose to redact it
 *   kept     — a reviewer explicitly chose to keep it (leave it visible)
 */
export type CandidateState = "flagged" | "redacted" | "kept";

export const STATE_LABEL: Record<CandidateState, string> = {
  flagged: "System flagged",
  redacted: "You redacted",
  kept: "You kept",
};

export interface ReportCandidate {
  type: EntityType;
  label: string;
  role: string | null;
  state: CandidateState;
  decidedBy: string | null;
  /** ISO timestamp of the reviewer's decision, null while flagged. */
  decidedAt: string | null;
  mentions: number;
  mentionsRedacted: number;
  /** Mentions a reviewer decided one by one, differently from the rest of the candidate. */
  exceptions: number;
  /** Where it appears, e.g. [{ document: "01-charging-document.pdf", pages: [1, 2] }]. */
  locations: { document: string; pages: number[] }[];
}

/** Everything the redaction report shows. Contains the redacted names: internal use only. */
export interface ReportData {
  batch: { name: string; createdAt: string; documents: { filename: string; pages: number }[] };
  generatedAt: string;
  generatedBy: string;
  totals: {
    candidates: number;
    byType: Record<EntityType, number>;
    flagged: number;
    redacted: number;
    kept: number;
    mentions: number;
    mentionsRedacted: number;
  };
  /** Sorted: type (person, org, address, ssn), then most mentions first. */
  candidates: ReportCandidate[];
  /** Full audit trail, oldest first. */
  events: { at: string; actor: string; summary: string }[];
}
