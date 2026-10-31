"use client";

import type { EntityStatus, EntityType } from "@/db/schema";
import type { CandidateState } from "@/lib/report-types";
import { TYPE_LABEL, type Derived } from "./model";

export type StateFilter = "all" | CandidateState;

/** The top of the panel: what was found, where each candidate stands, and the redact-by-default rule. */
export function CandidateOverview({
  derived,
  filter,
  onFilter,
}: {
  derived: Derived;
  filter: StateFilter;
  onFilter: (f: StateFilter) => void;
}) {
  const { stats } = derived;
  const counts = (["person", "org", "address", "ssn"] as EntityType[])
    .filter((t) => stats.byType[t] > 0)
    .map((t) => {
      const word = stats.byType[t] === 1 ? TYPE_LABEL[t].one : TYPE_LABEL[t].many;
      return `${stats.byType[t]} ${t === "ssn" ? word : word.toLowerCase()}`;
    });
  return (
    <div className="flex flex-col gap-3 border-b border-line px-4 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Redaction candidates</h2>
        <span className="text-xs tabular-nums text-muted">
          {stats.redactMentions} of {stats.totalMentions} mentions will be redacted
        </span>
      </div>
      <p className="text-base font-medium">{counts.join(" · ") || "Nothing found"}</p>
      <div className="flex flex-wrap gap-1.5 text-xs" role="group" aria-label="Show">
        <Chip active={filter === "all"} onClick={() => onFilter("all")}>
          All {stats.candidates}
        </Chip>
        <Chip active={filter === "flagged"} onClick={() => onFilter("flagged")} swatch="bg-neutral-300">
          System flagged {stats.flagged}
        </Chip>
        <Chip active={filter === "redacted"} onClick={() => onFilter("redacted")} swatch="bg-ink">
          You redacted {stats.redacted}
        </Chip>
        <Chip active={filter === "kept"} onClick={() => onFilter("kept")} swatch="bg-emerald-600">
          You kept {stats.kept}
        </Chip>
      </div>
      <p className="flex items-start gap-2 rounded-md bg-background px-3 py-2 text-xs text-muted">
        <span aria-hidden className="mt-px flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-current text-[9px] font-bold">
          i
        </span>
        <span>
          <span className="font-medium text-foreground">Everything is redacted by default.</span> Anything you don&apos;t mark Keep gets redacted.
          Gray means the system flagged it; black means you chose to redact it; green means you chose to keep it.
        </span>
      </p>
    </div>
  );
}

function Chip({ active, onClick, swatch, children }: { active: boolean; onClick: () => void; swatch?: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 tabular-nums transition-colors ${
        active ? "border-ink bg-ink text-white" : "border-line bg-paper hover:bg-background"
      }`}
    >
      {swatch && <i className={`inline-block h-2 w-2 rounded-full ${swatch} ${active ? "ring-1 ring-white/70" : ""}`} />}
      {children}
    </button>
  );
}

/** A collapsible group header: "▾ People (14)" with bulk actions for everything shown in it. */
export function GroupHeader({
  title,
  count,
  open,
  onToggle,
  tone,
  bulkIds,
  onBulk,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  tone?: "warn";
  bulkIds?: string[];
  onBulk?: (ids: string[], status: EntityStatus) => void;
}) {
  return (
    <div className={`sticky top-0 z-[1] flex items-center gap-2 border-b border-line px-3 py-2 ${tone === "warn" ? "bg-amber-50" : "bg-background"}`}>
      <button onClick={onToggle} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-semibold">
        <span className={`inline-block w-3 text-muted transition-transform ${open ? "rotate-90" : ""}`}>›</span>
        <span className={tone === "warn" ? "text-amber-900" : ""}>{title}</span>
        <span className="font-normal text-muted">({count})</span>
      </button>
      {onBulk && bulkIds && bulkIds.length > 1 && (
        <span className="flex shrink-0 gap-1 text-xs">
          <button className="rounded px-1.5 py-0.5 text-muted hover:bg-paper hover:text-foreground" onClick={() => onBulk(bulkIds, "redact")}>
            Redact all
          </button>
          <button className="rounded px-1.5 py-0.5 text-muted hover:bg-paper hover:text-emerald-700" onClick={() => onBulk(bulkIds, "keep")}>
            Keep all
          </button>
        </span>
      )}
    </div>
  );
}
