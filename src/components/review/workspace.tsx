"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Decision, EntityStatus, EntityType } from "@/db/schema";
import type { ReviewAction } from "@/lib/review";
import { candidateState, countOfType } from "@/lib/decisions";
import { SharedNames } from "./attention";
import { CandidateOverview, GroupHeader, type StateFilter } from "./candidate-tree";
import { EntityRow, SavedVersion } from "./entity-list";
import { FindPanel } from "./find-panel";
import { derive, sortEntities, TYPE_LABEL, TYPE_ORDER, type ReviewData, type ReviewMention } from "./model";
import { PageViewer, type ViewerTarget } from "./page-viewer";
import { ReviewerName, readReviewer } from "./reviewer-name";

export function ReviewWorkspace({ initial }: { initial: ReviewData }) {
  const [data, setData] = useState(initial);
  const derived = useMemo(() => derive(data), [data]);
  const [filter, setFilter] = useState<StateFilter>("all");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [selectedMentionId, setSelectedMentionId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<ViewerTarget>({ documentId: initial.documents[0]?.id ?? "", page: 1 });
  const [finding, setFinding] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [askName, setAskName] = useState<null | (() => void)>(null);
  // A decision made before the reviewer gave their name; it runs once they do.
  const [queued, setQueued] = useState<null | { action: ReviewAction; optimistic?: (d: ReviewData) => ReviewData; message?: string }>(null);
  const [warningDismissed, setWarningDismissed] = useState(false);
  const [saved, setSaved] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Which candidates a filter shows is decided when the filter is picked, then held, so a row doesn't
  // vanish from "System flagged" the moment you decide it.
  const idsKey = data.entities.map((e) => e.id).join();
  const order = useMemo(
    () => {
      const shown = data.entities.filter((e) => filter === "all" || candidateState(e) === filter);
      return Object.fromEntries(TYPE_ORDER.map((t) => [t, sortEntities(shown.filter((e) => e.type === t), derived).map((e) => e.id)])) as Record<
        EntityType,
        string[]
      >;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filter, idsKey],
  );
  const groups = useMemo(() => {
    const byId = new Map(data.entities.map((e) => [e.id, e]));
    return TYPE_ORDER.map((type) => ({ type, entities: order[type].flatMap((id) => byId.get(id) ?? []) })).filter(
      (g) => g.entities.length > 0,
    );
  }, [order, data.entities]);
  // Everything in an open group, top to bottom, for keyboard review.
  const visible = useMemo(() => groups.filter((g) => !closed.has(g.type)).flatMap((g) => g.entities), [groups, closed]);
  const toggleGroup = (key: string) =>
    setClosed((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const refetch = useCallback(async () => {
    const res = await fetch(`/api/batches/${data.batch.id}/review`, { cache: "no-store" });
    if (res.ok) setData(await res.json());
  }, [data.batch.id]);

  const flash = (text: string, error = false) => {
    setToast({ text, error });
    setTimeout(() => setToast((t) => (t?.text === text ? null : t)), error ? 6000 : 2200);
  };

  /** Sends a decision. Applies it locally first so the screen keeps up with fast keyboard review. */
  const act = useCallback(
    async (action: ReviewAction, optimistic?: (d: ReviewData) => ReviewData, message?: string) => {
      if (!readReviewer()) {
        setQueued({ action, optimistic, message });
        return;
      }
      if (optimistic) setData((d) => optimistic(d));
      const res = await fetch(`/api/batches/${data.batch.id}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        flash(json.error ?? "That didn't save. Reloading.", true);
        await refetch();
        return;
      }
      if (!optimistic) await refetch();
      setSaved((n) => n + 1);
      if (message) flash(message);
    },
    [data.batch.id, refetch],
  );

  const setEntity = useCallback(
    (ids: string[], status: EntityStatus) => {
      const reviewer = readReviewer();
      const decidedAt = new Date().toISOString();
      return act(
        { type: "setEntity", entityIds: ids, status },
        (d) => ({
          ...d,
          entities: d.entities.map((e) =>
            ids.includes(e.id) && e.status !== status
              ? { ...e, status, decidedBy: status === "pending" ? null : reviewer, decidedAt: status === "pending" ? null : decidedAt }
              : e,
          ),
        }),
        ids.length > 1
          ? `${status === "redact" ? "Redacted" : status === "keep" ? "Kept" : "Returned to system default:"} ${ids.length}`
          : undefined,
      );
    },
    [act],
  );
  const bulk = useCallback(
    (ids: string[], status: EntityStatus) => {
      // Keeping a whole group un-redacts a lot at once; make sure that's meant.
      if (status === "keep" && ids.length > 3 && !window.confirm(`Keep all ${ids.length}? They will stay visible in the exported documents.`)) return;
      setEntity(ids, status);
    },
    [setEntity],
  );
  const setMention = useCallback(
    (ids: string[], override: Decision | null) => {
      const reviewer = readReviewer();
      const decidedAt = new Date().toISOString();
      return act({ type: "setMention", mentionIds: ids, override }, (d) => ({
        ...d,
        mentions: d.mentions.map((m) =>
          ids.includes(m.id) && m.override !== override
            ? { ...m, override, decidedBy: override ? reviewer : null, decidedAt: override ? decidedAt : null }
            : m,
        ),
      }));
    },
    [act],
  );
  const assign = useCallback(
    (ids: string[], entityId: string) =>
      act(
        { type: "assign", mentionIds: ids, entityId },
        (d) => ({
          ...d,
          mentions: d.mentions.map((m) =>
            ids.includes(m.id) ? { ...m, entityId, assignmentConfirmed: true, assignedBy: readReviewer(), assignedAt: new Date().toISOString() } : m,
          ),
        }),
        `Assigned ${ids.length} to ${data.entities.find((e) => e.id === entityId)?.label}`,
      ),
    [act, data.entities],
  );
  const confirmGuess = useCallback(
    (ids: string[]) =>
      act(
        { type: "confirmGuess", mentionIds: ids },
        (d) => ({
          ...d,
          mentions: d.mentions.map((m) =>
            ids.includes(m.id) && m.entityId && !m.assignmentConfirmed
              ? { ...m, assignmentConfirmed: true, assignedBy: readReviewer(), assignedAt: new Date().toISOString() }
              : m,
          ),
        }),
        `Confirmed ${ids.length}`,
      ),
    [act],
  );

  const selectMention = useCallback((m: ReviewMention) => {
    setSelectedMentionId(m.id);
    if (m.entityId) setSelectedEntityId(m.entityId);
    setTarget({ documentId: m.documentId, page: m.page });
  }, []);

  const selectEntity = useCallback(
    (id: string) => {
      setSelectedEntityId(id);
      const first = derived.mentionsByEntity.get(id)?.[0];
      if (first) {
        setSelectedMentionId(first.id);
        setTarget({ documentId: first.documentId, page: first.page });
      }
    },
    [derived.mentionsByEntity],
  );

  const entityTrail = useMemo(
    () => (selectedEntityId ? (derived.mentionsByEntity.get(selectedEntityId) ?? []) : []),
    [selectedEntityId, derived.mentionsByEntity],
  );

  // Keyboard review: ↑/↓ move, r redact, k keep, u undo, → expand, n/p step through mentions, / find.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [role=dialog]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        setFinding(true);
        return;
      }
      if (e.key === "n" || e.key === "p") {
        if (entityTrail.length === 0) return;
        e.preventDefault();
        const i = entityTrail.findIndex((m) => m.id === selectedMentionId);
        selectMention(entityTrail[(i + (e.key === "n" ? 1 : -1) + entityTrail.length) % entityTrail.length]);
        return;
      }
      if (visible.length === 0) return;
      const index = visible.findIndex((x) => x.id === selectedEntityId);
      const move = (to: number) => {
        const next = visible[Math.max(0, Math.min(visible.length - 1, to))];
        selectEntity(next.id);
        listRef.current?.querySelector(`[data-entity-id="${next.id}"]`)?.scrollIntoView({ block: "nearest" });
      };
      if (e.key === "ArrowDown") {
        e.preventDefault();
        move(index + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        move(index - 1);
      } else if ((e.key === "r" || e.key === "k" || e.key === "u") && index >= 0) {
        // Stop the key from also being typed into the name dialog if it opens.
        e.preventDefault();
        const status = e.key === "r" ? "redact" : e.key === "k" ? "keep" : "pending";
        setEntity([visible[index].id], status);
        // Move on to the next item nobody has looked at yet.
        if (status !== "pending") {
          const next = visible.findIndex((x, i) => i > index && x.status === "pending");
          if (next >= 0) move(next);
        }
      } else if ((e.key === "ArrowRight" || e.key === "Enter") && index >= 0) {
        e.preventDefault();
        const id = visible[index].id;
        setExpanded((s) => {
          const n = new Set(s);
          if (n.has(id)) n.delete(id);
          else n.add(id);
          return n;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, selectedEntityId, selectedMentionId, entityTrail, selectEntity, selectMention, setEntity]);

  async function rerun() {
    if (!readReviewer()) {
      setAskName(() => rerun);
      return;
    }
    if (!window.confirm("Re-running detection replaces the system's suggestions. Decisions you've made carry over to anything it finds again, and anything you decided stays even if it isn't found. Continue?")) return;
    await fetch(`/api/batches/${data.batch.id}/reprocess`, { method: "POST" });
    window.location.reload();
  }

  const { stats } = derived;
  const decidedByYou = stats.redacted + stats.kept;

  return (
    <SavedVersion.Provider value={saved}>
    <div className="flex h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-paper px-5 py-3">
        <div className="min-w-0">
          <Link href="/" className="text-xs text-muted hover:text-foreground">
            ← All batches
          </Link>
          <h1 className="truncate text-lg font-semibold">{data.batch.name}</h1>
        </div>
        <p className="min-w-48 flex-1 text-xs text-muted">
          {data.documents.length} document{data.documents.length === 1 ? "" : "s"} · {stats.candidates} candidates · you&apos;ve decided {decidedByYou}
          {derived.ambiguousGroups.length > 0 && <span className="text-amber-700"> · {derived.ambiguousGroups.length} shared names to confirm</span>}
        </p>
        <div className="flex items-center gap-2 text-sm">
          <ReviewerName />
          <button onClick={() => setFinding(true)} className="rounded-lg border border-line px-3 py-1.5 hover:bg-background">
            Find text <kbd>/</kbd>
          </button>
          <Link href={`/batches/${data.batch.id}/audit`} className="rounded-lg border border-line px-3 py-1.5 hover:bg-background">
            Report
          </Link>
          <button onClick={() => setExporting(true)} className="rounded-lg bg-ink px-3 py-1.5 font-medium text-white">
            Export
          </button>
        </div>
      </header>

      {data.batch.warning && !warningDismissed && (
        <div className="flex items-start gap-3 border-b border-amber-200 bg-amber-50 px-5 py-2 text-sm text-amber-900">
          <p className="flex-1 whitespace-pre-line">{data.batch.warning}</p>
          <button onClick={rerun} className="shrink-0 rounded-md bg-amber-900 px-2.5 py-1 text-xs font-medium text-white">
            Re-run detection
          </button>
          <button onClick={() => setWarningDismissed(true)} className="shrink-0 text-amber-700">
            Dismiss
          </button>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(420px,44%)_1fr]">
        <section className="flex min-h-0 flex-col border-r border-line bg-paper">
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
            <CandidateOverview derived={derived} filter={filter} onFilter={setFilter} />
            {derived.ambiguousGroups.length > 0 && (
              <section>
                <GroupHeader
                  title="Confirm shared names"
                  count={derived.ambiguousGroups.length}
                  open={!closed.has("shared")}
                  onToggle={() => toggleGroup("shared")}
                  tone="warn"
                />
                {!closed.has("shared") && (
                  <div className="pt-3">
                    <SharedNames derived={derived} selectedMentionId={selectedMentionId} handlers={{ assign, confirmGuess, setMention, selectMention }} />
                  </div>
                )}
              </section>
            )}
            {groups.length === 0 && (
              <p className="px-6 py-12 text-center text-sm text-muted">
                {filter === "all" ? "Nothing was found in these documents." : "Nothing here yet."}
              </p>
            )}
            {groups.map((g) => (
              <section key={g.type}>
                <GroupHeader
                  title={TYPE_LABEL[g.type].many}
                  count={g.entities.length}
                  open={!closed.has(g.type)}
                  onToggle={() => toggleGroup(g.type)}
                  bulkIds={g.entities.map((e) => e.id)}
                  onBulk={bulk}
                />
                {!closed.has(g.type) && (
                  <ul>
                    {g.entities.map((e) => (
                      <EntityRow
                        key={e.id}
                        entity={e}
                        data={data}
                        derived={derived}
                        selected={e.id === selectedEntityId}
                        expanded={expanded.has(e.id)}
                        onToggle={() =>
                          setExpanded((s) => {
                            const n = new Set(s);
                            if (n.has(e.id)) n.delete(e.id);
                            else n.add(e.id);
                            return n;
                          })
                        }
                        selectedMentionId={selectedMentionId}
                        handlers={{
                          setEntity,
                          setMention,
                          selectMention,
                          selectEntity,
                          addAlias: (entityId, alias) => act({ type: "addAlias", entityId, alias }, undefined, `Added “${alias}”`),
                          merge: (fromEntityId, intoEntityId) => act({ type: "merge", fromEntityId, intoEntityId }, undefined, "Merged"),
                        }}
                      />
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
          <footer className="hidden flex-wrap gap-x-4 gap-y-1 border-t border-line px-4 py-2 text-xs text-muted lg:flex">
            <span>
              <kbd>↑</kbd> <kbd>↓</kbd> move
            </span>
            <span>
              <kbd>r</kbd> redact
            </span>
            <span>
              <kbd>k</kbd> keep
            </span>
            <span>
              <kbd>u</kbd> undo
            </span>
            <span>
              <kbd>→</kbd> mentions
            </span>
            <span>
              <kbd>n</kbd> <kbd>p</kbd> next/prev mention
            </span>
          </footer>
        </section>

        <section className="hidden min-h-0 lg:block">
          <PageViewer
            data={data}
            derived={derived}
            target={target}
            onTarget={setTarget}
            selectedMentionId={selectedMentionId}
            selectedEntityId={selectedEntityId}
            onSelectMention={selectMention}
            entityTrail={entityTrail}
          />
        </section>
      </div>

      {finding && (
        <FindPanel
          data={data}
          onClose={() => setFinding(false)}
          onJump={(documentId, page) => setTarget({ documentId, page })}
          onAddEntity={(entityType, label, query) =>
            act({ type: "addEntity", entityType, label, query }, undefined, `Added “${label}”`)
          }
          onAddAlias={(entityId, alias) => act({ type: "addAlias", entityId, alias }, undefined, `Added “${alias}”`)}
        />
      )}
      {exporting && (
        <ExportDialog
          data={data}
          derived={derived}
          onClose={() => setExporting(false)}
          onNeedName={(retry) => setAskName(() => retry)}
          onReviewUntouched={() => {
            setFilter("flagged");
            setExporting(false);
          }}
        />
      )}
      {(askName || queued) && (
        <ReviewerName
          prompt
          onDone={() => {
            const retry = askName;
            const next = queued;
            setAskName(null);
            setQueued(null);
            retry?.();
            if (next) act(next.action, next.optimistic, next.message);
          }}
          onCancel={() => {
            setAskName(null);
            setQueued(null);
          }}
        />
      )}
      {toast && (
        <div
          role="status"
          className={`fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg px-4 py-2 text-sm text-white shadow-lg ${toast.error ? "bg-red-700" : "bg-ink"}`}
        >
          {toast.text}
        </div>
      )}
    </div>
    </SavedVersion.Provider>
  );
}

function ExportDialog({
  data,
  derived,
  onClose,
  onNeedName,
  onReviewUntouched,
}: {
  data: ReviewData;
  derived: ReturnType<typeof derive>;
  onClose: () => void;
  onNeedName: (retry: () => void) => void;
  onReviewUntouched: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { flagged, kept, redacted } = derived.stats;
  // Entities nobody marked Redact or Keep, by type, with how many places each group covers.
  const untouched = TYPE_ORDER.map((type) => {
    const list = data.entities.filter((e) => e.type === type && e.status === "pending");
    const mentions = list.reduce((n, e) => n + (derived.mentionsByEntity.get(e.id) ?? []).filter((m) => m.entityId === e.id).length, 0);
    return { type, entities: list.length, mentions };
  }).filter((g) => g.entities > 0);
  const unsure = derived.ambiguousGroups.reduce((n, g) => n + g.mentions.length, 0);
  const docsWithRedactions = new Set(data.mentions.filter((m) => derived.decision.get(m.id) === "redact").map((m) => m.documentId)).size;

  async function run() {
    if (!readReviewer()) {
      onNeedName(run);
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/batches/${data.batch.id}/export?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`);
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? "Export failed");
      setBusy(false);
      return;
    }
    const blob = await res.blob();
    const name = res.headers.get("Content-Disposition")?.match(/filename="(.+)"/)?.[1] ?? "redacted.zip";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    setBusy(false);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-paper p-6 shadow-2xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Export">
        <h2 className="text-lg font-semibold">Export redacted documents</h2>
        <p className="mt-1 text-sm text-muted">
          {derived.stats.redactMentions} mentions in {docsWithRedactions} of {data.documents.length} documents will be permanently removed from the
          PDFs — not just covered. We re-read every page afterwards to confirm nothing is left under any box.
        </p>
        {flagged > 0 && (
          <div role="alert" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
            <p className="font-semibold">
              {flagged} {flagged === 1 ? "entity hasn't" : "entities haven't"} been reviewed by a person
            </p>
            <p className="mt-0.5">
              Nobody marked {flagged === 1 ? "it" : "these"} Redact or Keep. Every entity that isn&apos;t touched will be redacted in the exported
              documents.
            </p>
            <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
              {untouched.map((g) => (
                <li key={g.type} className="flex flex-col">
                  <span className="font-semibold tabular-nums">{countOfType(g.type, g.entities)}</span>
                  <span className="text-xs text-amber-800">
                    {g.mentions} mention{g.mentions === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
            <button onClick={onReviewUntouched} className="mt-2 text-xs font-medium underline underline-offset-2 hover:text-amber-800">
              Review them first
            </button>
          </div>
        )}
        <div className="mt-3 flex flex-col gap-1 rounded-lg bg-background p-3 text-sm">
          <p>
            <span className="font-medium">{kept}</span> kept by you will stay visible.
          </p>
          <p>
            <span className="font-medium">{redacted}</span> redacted by you.
          </p>
          {unsure > 0 && <p className="text-amber-800">{unsure} shared-name mentions you haven&apos;t confirmed will be redacted to be safe.</p>}
        </div>
        <div className="mt-4 flex flex-col gap-1.5 text-xs text-muted">
          <p>
            <span className="font-medium text-foreground">share/</span> The redacted PDFs, a redaction log (where, never what), and a verification report.
            Safe to send.
          </p>
          <p>
            <span className="font-medium text-foreground">internal/</span> The redaction report (PDF) with each entity&apos;s history, spreadsheets of decisions and of every place each entity appears, and the audit trail.
            These name what was redacted: keep them in your office.
          </p>
          <p>The export is recorded in the audit trail.</p>
        </div>
        {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm hover:bg-background">
            Cancel
          </button>
          <button disabled={busy} onClick={run} className="rounded-lg bg-ink px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50">
            {busy ? "Redacting…" : flagged > 0 ? "Redact untouched & download" : "Download"}
          </button>
        </div>
      </div>
    </div>
  );
}
