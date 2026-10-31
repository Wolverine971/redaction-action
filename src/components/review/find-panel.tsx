"use client";

import { useEffect, useRef, useState } from "react";
import type { EntityType } from "@/db/schema";
import { TYPE_LABEL, type ReviewData } from "./model";

interface Hit {
  documentId: string;
  filename: string;
  page: number;
  text: string;
  before: string;
  after: string;
  mentionId: string | null;
  entityId: string | null;
}

/** Search the batch for anything the AI missed, then redact every match in one step. */
export function FindPanel({
  data,
  onClose,
  onAddEntity,
  onAddAlias,
  onJump,
}: {
  data: ReviewData;
  onClose: () => void;
  onAddEntity: (type: EntityType, label: string, query: string) => Promise<void>;
  onAddAlias: (entityId: string, alias: string) => Promise<void>;
  onJump: (documentId: string, page: number) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [type, setType] = useState<EntityType>("person");
  const [target, setTarget] = useState("new");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    if (q.trim().length < 2) return;
    const t = setTimeout(async () => {
      const res = await fetch(`/api/batches/${data.batch.id}/search?q=${encodeURIComponent(q)}`);
      if (res.ok) setHits(await res.json());
    }, 200);
    return () => clearTimeout(t);
  }, [q, data.batch.id, version]);

  // Results only show for a real query; stale results from a longer query are hidden.
  const shown = q.trim().length >= 2 ? hits : null;
  const unmarked = shown?.filter((h) => !h.mentionId).length ?? 0;
  const entityLabel = (id: string | null) => data.entities.find((e) => e.id === id)?.label;

  async function add() {
    setBusy(true);
    if (target === "new") await onAddEntity(type, q.trim(), q.trim());
    else await onAddAlias(target, q.trim());
    setBusy(false);
    setVersion((v) => v + 1);
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-xl flex-col bg-paper shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Find text"
      >
        <div className="flex items-center gap-2 border-b border-line p-4">
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
            placeholder="Find text across every document (e.g. Johnny, 4B, 6789)"
            className="flex-1 rounded-lg border border-line px-3 py-2 outline-none focus:border-focus"
          />
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-muted hover:bg-background">
            Close
          </button>
        </div>
        {shown && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-background px-4 py-3 text-sm">
            <span>
              {shown.length} match{shown.length === 1 ? "" : "es"}, {unmarked} not marked
            </span>
            {unmarked > 0 && (
              <>
                <span className="text-muted">→ redact as</span>
                <select value={target} onChange={(e) => setTarget(e.target.value)} className="rounded-md border border-line bg-paper px-2 py-1">
                  <option value="new">a new…</option>
                  {data.entities
                    .filter((e) => e.type !== "ssn")
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        spelling of {e.label}
                      </option>
                    ))}
                </select>
                {target === "new" && (
                  <select value={type} onChange={(e) => setType(e.target.value as EntityType)} className="rounded-md border border-line bg-paper px-2 py-1">
                    {(Object.keys(TYPE_LABEL) as EntityType[]).map((t) => (
                      <option key={t} value={t}>
                        {TYPE_LABEL[t].one.toLowerCase()}
                      </option>
                    ))}
                  </select>
                )}
                <button disabled={busy} onClick={add} className="rounded-md bg-ink px-3 py-1 font-medium text-white disabled:opacity-50">
                  {busy ? "Adding…" : `Redact ${unmarked}`}
                </button>
              </>
            )}
          </div>
        )}
        <ul className="flex-1 overflow-auto p-2">
          {shown?.map((h, i) => (
            <li key={i}>
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-background"
                onClick={() => onJump(h.documentId, h.page)}
              >
                <span className="w-40 shrink-0 truncate text-xs text-muted">
                  {h.filename} p.{h.page}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-muted">…{h.before.slice(-40)}</span>
                  <mark className={`mx-0.5 rounded px-0.5 ${h.mentionId ? "bg-black text-white" : "bg-amber-200"}`}>{h.text}</mark>
                  <span className="text-muted">{h.after.slice(0, 40)}…</span>
                </span>
                <span className="shrink-0 text-xs text-muted">{h.mentionId ? (entityLabel(h.entityId) ?? "marked") : "not marked"}</span>
              </button>
            </li>
          ))}
          {shown && shown.length === 0 && <li className="p-4 text-sm text-muted">No matches.</li>}
        </ul>
      </div>
    </div>
  );
}
