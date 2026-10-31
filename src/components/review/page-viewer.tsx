"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Derived, ReviewData, ReviewMention } from "./model";

export interface ViewerTarget {
  documentId: string;
  page: number;
}

export function PageViewer({
  data,
  derived,
  target,
  onTarget,
  selectedMentionId,
  selectedEntityId,
  onSelectMention,
  entityTrail,
}: {
  data: ReviewData;
  derived: Derived;
  target: ViewerTarget;
  onTarget: (t: ViewerTarget) => void;
  selectedMentionId: string | null;
  selectedEntityId: string | null;
  onSelectMention: (m: ReviewMention) => void;
  /** Every mention of the selected entity, in document order, for "3 of 42" stepping. */
  entityTrail: ReviewMention[];
}) {
  const [preview, setPreview] = useState(false);
  const [loaded, setLoaded] = useState<string | null>(null);
  const doc = data.documents.find((d) => d.id === target.documentId) ?? data.documents[0];
  const pageInfo = doc?.pages.find((p) => p.n === target.page) ?? doc?.pages[0];
  const scroller = useRef<HTMLDivElement>(null);
  const focusRef = useRef<HTMLButtonElement>(null);

  const onPage = useMemo(
    () => data.mentions.filter((m) => m.documentId === doc?.id && m.page === pageInfo?.n),
    [data.mentions, doc?.id, pageInfo?.n],
  );
  const perDoc = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of data.mentions) if (derived.decision.get(m.id) === "redact") counts.set(m.documentId, (counts.get(m.documentId) ?? 0) + 1);
    return counts;
  }, [data.mentions, derived.decision]);

  const src = doc && pageInfo ? `/api/documents/${doc.id}/pages/${pageInfo.n}` : null;

  useEffect(() => {
    if (!focusRef.current || !scroller.current || loaded !== src) return;
    const box = focusRef.current.getBoundingClientRect();
    const view = scroller.current.getBoundingClientRect();
    if (box.top < view.top + 40 || box.bottom > view.bottom - 40) {
      scroller.current.scrollBy({ top: box.top - view.top - view.height / 3, behavior: "smooth" });
    }
  }, [selectedMentionId, loaded, src]);

  if (!doc || !pageInfo) return <div className="p-8 text-muted">No pages.</div>;

  const trailIndex = entityTrail.findIndex((m) => m.id === selectedMentionId);
  const step = (dir: 1 | -1) => {
    if (entityTrail.length === 0) return;
    const next = entityTrail[(trailIndex + dir + entityTrail.length) % entityTrail.length];
    onSelectMention(next);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-paper px-4 py-2 text-sm">
        <select
          value={doc.id}
          onChange={(e) => onTarget({ documentId: e.target.value, page: 1 })}
          className="max-w-[16rem] truncate rounded-md border border-line bg-paper px-2 py-1"
          aria-label="Document"
        >
          {data.documents.map((d) => (
            <option key={d.id} value={d.id}>
              {d.filename} ({perDoc.get(d.id) ?? 0})
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1">
          <button
            className="rounded px-2 py-1 hover:bg-background disabled:opacity-30"
            disabled={pageInfo.n <= 1}
            onClick={() => onTarget({ documentId: doc.id, page: pageInfo.n - 1 })}
            aria-label="Previous page"
          >
            ‹
          </button>
          <span className="tabular-nums text-muted">
            Page {pageInfo.n} of {doc.pages.length}
          </span>
          <button
            className="rounded px-2 py-1 hover:bg-background disabled:opacity-30"
            disabled={pageInfo.n >= doc.pages.length}
            onClick={() => onTarget({ documentId: doc.id, page: pageInfo.n + 1 })}
            aria-label="Next page"
          >
            ›
          </button>
        </div>
        {selectedEntityId && entityTrail.length > 0 && (
          <div className="flex items-center gap-1 rounded-md bg-blue-50 px-2 py-0.5 text-blue-900">
            <button className="px-1" onClick={() => step(-1)} aria-label="Previous mention">
              ‹
            </button>
            <span className="tabular-nums">
              Mention {trailIndex >= 0 ? trailIndex + 1 : "–"} of {entityTrail.length}
            </span>
            <button className="px-1" onClick={() => step(1)} aria-label="Next mention">
              ›
            </button>
          </div>
        )}
        <label className="ml-auto flex cursor-pointer items-center gap-2 text-muted">
          <input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} />
          Preview final
        </label>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-auto bg-[#e9e7e2] p-6">
        <div
          className="relative mx-auto bg-white shadow-[0_1px_3px_rgba(0,0,0,0.12),0_8px_24px_rgba(0,0,0,0.08)]"
          style={{ maxWidth: 900, aspectRatio: `${pageInfo.w} / ${pageInfo.h}` }}
        >
          {src && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={src}
              src={src}
              alt={`${doc.filename}, page ${pageInfo.n}`}
              className="absolute inset-0 h-full w-full select-none"
              draggable={false}
              onLoad={() => setLoaded(src)}
            />
          )}
          {onPage.map((m) =>
            m.rects.map((r, i) => {
              const decision = derived.decision.get(m.id);
              const entity = m.entityId ? derived.entityById.get(m.entityId) : undefined;
              // Black only when a person chose it; the system's default shows as gray so you can still read it.
              const chosen = m.override === "redact" || (!m.override && entity?.status === "redact" && !(m.ambiguous && !m.assignmentConfirmed));
              const selected = m.id === selectedMentionId;
              const related = !selected && selectedEntityId !== null && m.entityId === selectedEntityId;
              const style = preview
                ? decision === "redact"
                  ? "bg-black"
                  : "bg-transparent"
                : decision === "redact"
                  ? chosen
                    ? "bg-black/80 ring-1 ring-black"
                    : "bg-neutral-500/35 ring-1 ring-neutral-600"
                  : "bg-emerald-400/15 ring-1 ring-emerald-600";
              return (
                <button
                  key={`${m.id}-${i}`}
                  ref={selected && i === 0 ? focusRef : undefined}
                  title={`${m.text} — ${decision === "redact" ? "redact" : "keep"}${entity ? ` (${entity.label})` : ""}`}
                  onClick={() => onSelectMention(m)}
                  className={`absolute rounded-[2px] ${style} ${selected ? "focus-pulse z-10" : ""} ${
                    related && !preview ? "outline-2 outline-offset-1 outline-blue-500/70" : ""
                  }`}
                  style={{
                    left: `${(r[0] / pageInfo.w) * 100}%`,
                    top: `${(r[1] / pageInfo.h) * 100}%`,
                    width: `${((r[2] - r[0]) / pageInfo.w) * 100}%`,
                    height: `${((r[3] - r[1]) / pageInfo.h) * 100}%`,
                  }}
                />
              );
            }),
          )}
        </div>
        <Legend />
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="mx-auto mt-4 flex max-w-[900px] flex-wrap gap-4 text-xs text-muted">
      <span className="flex items-center gap-1.5">
        <i className="inline-block h-3 w-5 rounded-[2px] bg-neutral-500/35 ring-1 ring-neutral-600" /> System flagged (redacted by default)
      </span>
      <span className="flex items-center gap-1.5">
        <i className="inline-block h-3 w-5 rounded-[2px] bg-black/80" /> You redacted
      </span>
      <span className="flex items-center gap-1.5">
        <i className="inline-block h-3 w-5 rounded-[2px] bg-emerald-400/15 ring-1 ring-emerald-600" /> You kept
      </span>
    </div>
  );
}
