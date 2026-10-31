import type { Decision, EntityType, HistoryState } from "@/db/schema";

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

/** One line of an entity's or a mention's history. */
export interface ReportEvent {
  /** ISO timestamp. */
  at: string;
  /** Reviewer name, or "system". */
  actor: string;
  action: string;
  summary: string;
  /** Where it stood after this event, when the event changed (or confirmed) a decision. */
  toState: HistoryState | null;
  /** More than 1 when one bulk action touched several mentions. */
  count: number;
}

/** One place an entity appears, and whether it ends up blacked out or left visible. */
export interface ReportPlace {
  mentionId: string;
  document: string;
  page: number;
  text: string;
  /** A few words either side, to find it on the page. */
  before: string;
  after: string;
  outcome: "redacted" | "visible";
  /** Why, in plain words: "Follows the entity: kept by Dana", "Kept individually", … */
  reason: string;
  /** Set when a person decided this one place differently from the rest of the entity. */
  individually: { decision: Decision; by: string | null; at: string | null } | null;
  /** Who confirmed which entity this place belongs to, if anyone. */
  assignedBy: string | null;
  assignedAt: string | null;
  /** Everything that happened to this one place, oldest first. */
  history: ReportEvent[];
}

export interface ReportCandidate {
  id: string;
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
  /** "ai", or the reviewer who added it by hand. */
  createdBy: string;
  /** Everything that happened to it, oldest first: flagged, decisions, exceptions, merges, re-runs. */
  history: ReportEvent[];
  /** Every place it appears, in document order. */
  places: ReportPlace[];
  /** Some places are visible and some redacted. */
  mixed: boolean;
}

/** An entity that's no longer in the results but had a person's decision, so its history is kept on record. */
export interface ReportRetired {
  label: string;
  type: EntityType | null;
  reason: string;
  history: ReportEvent[];
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
  /** Places not tied to any entity (redacted to be safe unless a person kept them). */
  unassigned: ReportPlace[];
  retired: ReportRetired[];
  /** Full audit trail, oldest first. */
  events: { at: string; actor: string; summary: string }[];
}
