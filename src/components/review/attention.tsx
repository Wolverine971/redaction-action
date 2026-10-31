"use client";

import { useState } from "react";
import type { Decision } from "@/db/schema";
import { MentionLine } from "./entity-list";
import { type AmbiguousGroup, type Derived, pct, type ReviewMention } from "./model";

export interface AttentionHandlers {
  assign: (mentionIds: string[], entityId: string) => void;
  confirmGuess: (mentionIds: string[]) => void;
  setMention: (ids: string[], override: Decision | null) => void;
  selectMention: (m: ReviewMention) => void;
}

/**
 * Shared names that now matter: "Mr. Smith" could be John (redacted) or Stephen (whom you kept). Until you say
 * who each one is, they stay redacted to be safe.
 */
export function SharedNames({
  derived,
  selectedMentionId,
  handlers,
}: {
  derived: Derived;
  selectedMentionId: string | null;
  handlers: AttentionHandlers;
}) {
  return (
    <div className="flex flex-col gap-2 pb-3 pl-6 pr-4">
      <p className="text-xs text-muted">
        You kept someone who shares a name with a person being redacted. These mentions stay redacted until you say who each one is.
      </p>
      {derived.ambiguousGroups.map((g) => (
        <AmbiguousCard key={g.key} group={g} derived={derived} selectedMentionId={selectedMentionId} handlers={handlers} />
      ))}
    </div>
  );
}

function AmbiguousCard({
  group,
  derived,
  selectedMentionId,
  handlers,
}: {
  group: AmbiguousGroup;
  derived: Derived;
  selectedMentionId: string | null;
  handlers: AttentionHandlers;
}) {
  const [open, setOpen] = useState(false);
  const guess = group.guessId ? derived.entityById.get(group.guessId) : undefined;
  const candidates = group.candidateIds.map((id) => derived.entityById.get(id)).filter((e) => e !== undefined);
  const docs = new Set(group.mentions.map((m) => m.documentId)).size;
  const ids = group.mentions.map((m) => m.id);
  return (
    <div className="rounded-lg border border-line bg-paper">
      <div className="flex flex-col gap-2 px-3 py-2.5">
        <button className="flex min-w-0 items-baseline gap-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className={`inline-block w-3 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}>›</span>
          <span className="shrink-0 rounded bg-amber-100 px-1.5 font-medium text-amber-950">“{group.text}”</span>
          <span className="text-sm text-muted">
            × {group.mentions.length} in {docs} doc{docs === 1 ? "" : "s"}
          </span>
        </button>
        <div className="flex flex-wrap items-center gap-2 pl-5">
          {guess ? (
            <span className="min-w-0 flex-1 text-sm">
              Best guess: <span className="font-medium">{guess.label}</span> <span className="text-muted">({pct(group.confidence)})</span>
            </span>
          ) : (
            <span className="min-w-0 flex-1 text-sm text-amber-700">Can&apos;t tell from context</span>
          )}
          {guess && (
            <button className="rounded-md bg-ink px-2.5 py-1 text-xs font-medium text-white" onClick={() => handlers.confirmGuess(ids)}>
              Confirm all {group.mentions.length}
            </button>
          )}
          <select
            className="rounded-md border border-line px-1.5 py-1 text-xs"
            value=""
            onChange={(e) => e.target.value && handlers.assign(ids, e.target.value)}
            aria-label="Assign all to"
          >
            <option value="">{guess ? "No, it's…" : "Assign all to…"}</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
                {c.role ? ` — ${c.role}` : ""}
              </option>
            ))}
          </select>
        </div>
      </div>
      
      {open && (
        <ul className="flex flex-col gap-0.5 border-t border-line px-2 py-2">
          {group.mentions.map((m) => (
            <li key={m.id} className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <MentionLine mention={m} derived={derived} selected={m.id === selectedMentionId} handlers={handlers} />
              </div>
              <select
                className="shrink-0 rounded border border-line px-1 py-0.5 text-xs"
                value=""
                onChange={(e) => e.target.value && handlers.assign([m.id], e.target.value)}
                aria-label="This one is"
              >
                <option value="">This one is…</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
