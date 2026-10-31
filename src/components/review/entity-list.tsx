"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { Decision, EntityStatus } from "@/db/schema";
import type { HistoryEvent } from "@/lib/history";
import { candidateState, decisionReason } from "@/lib/decisions";
import { STATE_LABEL } from "@/lib/report-types";
import { type Derived, type ReviewData, type ReviewEntity, type ReviewMention } from "./model";

/** Goes up by one each time a decision is saved, so open histories know to reload. */
export const SavedVersion = createContext(0);

export interface EntityHandlers {
  setEntity: (ids: string[], status: EntityStatus) => void;
  setMention: (ids: string[], override: Decision | null) => void;
  addAlias: (entityId: string, alias: string) => void;
  merge: (fromId: string, intoId: string) => void;
  selectMention: (m: ReviewMention) => void;
  selectEntity: (id: string) => void;
}

export function EntityRow({
  entity,
  data,
  derived,
  selected,
  expanded,
  onToggle,
  selectedMentionId,
  handlers,
}: {
  entity: ReviewEntity;
  data: ReviewData;
  derived: Derived;
  selected: boolean;
  expanded: boolean;
  onToggle: () => void;
  selectedMentionId: string | null;
  handlers: EntityHandlers;
}) {
  const mentions = derived.mentionsByEntity.get(entity.id) ?? [];
  const own = mentions.filter((m) => m.entityId === entity.id);
  const shared = mentions.length - own.length;
  const docs = new Set(own.map((m) => m.documentId)).size;
  const exceptions = mentions.filter((m) => m.override).length;
  const aliases = entity.aliases.filter((a) => a !== entity.label);
  const state = candidateState(entity);

  return (
    <li
      data-entity-id={entity.id}
      className={`border-b border-line/70 last:border-b-0 ${selected ? "bg-blue-50/60" : "bg-paper"} transition-colors`}
    >
      <div className="flex items-start gap-2 py-2.5 pl-6 pr-4">
        <button
          className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted hover:bg-background"
          onClick={onToggle}
          aria-label={expanded ? "Collapse" : "Expand"}
          aria-expanded={expanded}
        >
          <span className={`transition-transform ${expanded ? "rotate-90" : ""}`}>›</span>
        </button>
        <button className="min-w-0 flex-1 text-left" onClick={() => handlers.selectEntity(entity.id)}>
          <div className="flex items-baseline gap-2">
            <span className="truncate font-medium">{entity.label}</span>
            {entity.role && <span className="truncate text-sm text-muted">{entity.role}</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
            <span>
              {own.length} mention{own.length === 1 ? "" : "s"} in {docs} doc{docs === 1 ? "" : "s"}
              {shared > 0 && ` + ${shared} shared`}
            </span>
            <span className={state === "kept" ? "text-emerald-700" : state === "redacted" ? "text-foreground" : ""}>
              · {STATE_LABEL[state]}
              {entity.decidedBy && state !== "flagged" && ` · ${entity.decidedBy}${entity.decidedAt ? ` · ${shortTime(entity.decidedAt)}` : ""}`}
            </span>
            {exceptions > 0 && (
              <span>
                · {exceptions} mention{exceptions === 1 ? "" : "s"} set individually
              </span>
            )}
          </div>
          {aliases.length > 0 && (
            <p className="mt-1 truncate text-xs text-muted">Also: {aliases.slice(0, 6).join(" · ")}{aliases.length > 6 ? ` · +${aliases.length - 6}` : ""}</p>
          )}
        </button>
        <DecisionToggle status={entity.status} onChange={(s) => handlers.setEntity([entity.id], s)} />
      </div>
      {expanded && (
        <EntityDetail entity={entity} data={data} derived={derived} mentions={mentions} selectedMentionId={selectedMentionId} handlers={handlers} />
      )}
    </li>
  );
}

/**
 * Three states: system flagged (light gray Redact — redacted by default), you redacted (black), you kept (green).
 * Clicking your own choice again hands it back to the system default.
 */
export function DecisionToggle({ status, onChange }: { status: EntityStatus; onChange: (s: EntityStatus) => void }) {
  return (
    <div className="flex shrink-0 overflow-hidden rounded-md border border-line text-xs font-medium">
      <button
        className={`px-2.5 py-1.5 transition-colors ${
          status === "redact" ? "bg-ink text-white" : status === "pending" ? "bg-neutral-200 text-neutral-600 hover:bg-neutral-300" : "hover:bg-background"
        }`}
        onClick={() => onChange(status === "redact" ? "pending" : "redact")}
        title={
          status === "pending"
            ? "System flagged: redacted by default. Click to confirm you're redacting it (r)"
            : status === "redact"
              ? "You redacted this. Click to go back to the system default (u)"
              : "Redact (r)"
        }
        aria-pressed={status === "redact"}
      >
        Redact
      </button>
      <button
        className={`border-l border-line px-2.5 py-1.5 transition-colors ${status === "keep" ? "bg-emerald-600 text-white" : "hover:bg-background"}`}
        onClick={() => onChange(status === "keep" ? "pending" : "keep")}
        title={status === "keep" ? "You kept this. Click to go back to the system default (u)" : "Keep: leave it visible (k)"}
        aria-pressed={status === "keep"}
      >
        Keep
      </button>
    </div>
  );
}

export function shortTime(iso: string) {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function EntityDetail({
  entity,
  data,
  derived,
  mentions,
  selectedMentionId,
  handlers,
}: {
  entity: ReviewEntity;
  data: ReviewData;
  derived: Derived;
  mentions: ReviewMention[];
  selectedMentionId: string | null;
  handlers: EntityHandlers;
}) {
  const [alias, setAlias] = useState("");
  const [mergeInto, setMergeInto] = useState("");
  const byDoc = data.documents
    .map((d) => ({ doc: d, mentions: mentions.filter((m) => m.documentId === d.id) }))
    .filter((g) => g.mentions.length > 0);
  const sameType = data.entities.filter((e) => e.type === entity.type && e.id !== entity.id);

  return (
    <div className="flex flex-col gap-3 pb-4 pl-12 pr-4">
      {byDoc.map(({ doc, mentions }) => (
        <div key={doc.id}>
          <p className="mb-1 text-xs font-medium text-muted">
            {doc.filename} · {mentions.length}
          </p>
          <ul className="flex flex-col gap-0.5">
            {mentions.map((m) => (
              <li key={m.id}>
                <MentionLine
                  mention={m}
                  derived={derived}
                  selected={m.id === selectedMentionId}
                  handlers={handlers}
                  foreign={m.entityId !== entity.id}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
      <EntityHistory batchId={data.batch.id} entityId={entity.id} />
      <div className="flex flex-wrap gap-2 border-t border-line pt-3 text-xs">
        <form
          className="flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (alias.trim()) handlers.addAlias(entity.id, alias.trim());
            setAlias("");
          }}
        >
          <input
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            placeholder="Add a spelling (e.g. Johnny)"
            className="w-48 rounded-md border border-line px-2 py-1 outline-none focus:border-focus"
          />
          <button className="rounded-md border border-line px-2 py-1 hover:bg-background">Find & add</button>
        </form>
        {sameType.length > 0 && (
          <form
            className="flex gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (mergeInto) handlers.merge(entity.id, mergeInto);
            }}
          >
            <select
              value={mergeInto}
              onChange={(e) => setMergeInto(e.target.value)}
              className="max-w-48 rounded-md border border-line px-2 py-1"
            >
              <option value="">Same as…</option>
              {sameType.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
            <button className="rounded-md border border-line px-2 py-1 hover:bg-background" disabled={!mergeInto}>
              Merge
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

/** Who decided what about this entity, and when, newest first. Loads when the entity is opened. */
function EntityHistory({ batchId, entityId }: { batchId: string; entityId: string }) {
  const saved = useContext(SavedVersion);
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(`/api/batches/${batchId}/history?entity=${entityId}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { events: [] }))
      .then((json: { events: HistoryEvent[] }) => live && setEvents(json.events))
      .catch(() => live && setEvents([]));
    return () => {
      live = false;
    };
  }, [batchId, entityId, saved]);
  if (!events) return <p className="border-t border-line pt-3 text-xs text-muted">Loading history…</p>;
  const newest = [...events].reverse();
  const shown = all ? newest : newest.slice(0, 4);
  return (
    <div className="border-t border-line pt-3">
      <p className="mb-1 text-xs font-medium text-muted">History</p>
      <ol className="flex flex-col gap-1 text-xs">
        {shown.map((e) => (
          <li key={e.id} className="flex gap-2">
            <span className="w-28 shrink-0 tabular-nums text-muted">{shortTime(e.at)}</span>
            <span className={`w-20 shrink-0 truncate ${e.actor === "system" ? "text-muted" : "font-medium"}`}>{e.actor === "system" ? "System" : e.actor}</span>
            <span className="min-w-0 flex-1">{e.summary}</span>
          </li>
        ))}
      </ol>
      {newest.length > shown.length && (
        <button className="mt-1 text-xs text-muted underline hover:text-foreground" onClick={() => setAll(true)}>
          Show all {newest.length}
        </button>
      )}
    </div>
  );
}

export function MentionLine({
  mention: m,
  derived,
  selected,
  handlers,
  foreign,
  showEntity,
}: {
  mention: ReviewMention;
  derived: Derived;
  selected: boolean;
  handlers: Pick<EntityHandlers, "setMention" | "selectMention">;
  foreign?: boolean;
  showEntity?: boolean;
}) {
  const decision = derived.decision.get(m.id);
  const entity = m.entityId ? derived.entityById.get(m.entityId) : undefined;
  const reason = decisionReason(m, (id) => derived.entityById.get(id));
  const chosen = m.override === "redact" || (!m.override && entity?.status === "redact");
  return (
    <div
      className={`group flex items-center gap-2 rounded-md px-2 py-1 text-sm ${selected ? "bg-blue-100" : "hover:bg-background"}`}
    >
      <button className="min-w-0 flex-1 truncate text-left" onClick={() => handlers.selectMention(m)} title={reason}>
        <span className="mr-2 text-xs tabular-nums text-muted">p.{m.page}</span>
        <span className="text-muted">…{m.before.slice(-30)}</span>
        <mark
          className={`mx-0.5 rounded px-0.5 ${
            decision === "keep" ? "bg-emerald-100 text-emerald-900" : chosen ? "bg-black text-white" : "bg-neutral-300 text-neutral-900"
          }`}
        >
          {m.text}
        </mark>
        <span className="text-muted">{m.after.slice(0, 60)}…</span>
      </button>
      {showEntity && entity && <span className="max-w-32 shrink-0 truncate text-xs text-muted">{entity.label}</span>}
      {foreign && <span className="shrink-0 text-xs text-amber-700">unconfirmed</span>}
      {m.override && (
        <span
          className="shrink-0 rounded bg-background px-1.5 text-xs text-muted"
          title={`${reason}${m.decidedBy ? ` · ${m.decidedBy}` : ""}${m.decidedAt ? ` · ${shortTime(m.decidedAt)}` : ""}`}
        >
          set individually{m.decidedBy ? ` · ${m.decidedBy}` : ""}
        </span>
      )}
      <div className="flex shrink-0 gap-1 text-xs opacity-60 group-hover:opacity-100">
        <button
          className={`rounded px-1.5 py-0.5 ${m.override === "redact" ? "bg-ink text-white" : "hover:bg-line"}`}
          onClick={() => handlers.setMention([m.id], m.override === "redact" ? null : "redact")}
          title="Always redact this mention"
        >
          Redact
        </button>
        <button
          className={`rounded px-1.5 py-0.5 ${m.override === "keep" ? "bg-emerald-600 text-white" : "hover:bg-line"}`}
          onClick={() => handlers.setMention([m.id], m.override === "keep" ? null : "keep")}
          title="Keep just this mention"
        >
          Keep
        </button>
      </div>
    </div>
  );
}
