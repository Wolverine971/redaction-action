"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { formatDuration, planBatch, shapeOf, type Speed } from "@/lib/estimate";
import { FileCard, type Staged } from "./file-card";
import { LiveProgress } from "./live-progress";

/**
 * The whole intake flow in one place: drop PDFs → instant preview per file → Find redactions →
 * watch it scan → summary + Review. The running batch id lives in the URL (?batch=) so a refresh resumes.
 */
export function Intake() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const batchId = params.get("batch");
  const [staged, setStaged] = useState<Staged[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Quick looks still running when the batch starts are cancelled so they don't compete with processing.
  const inflight = useRef(new Set<AbortController>());

  const update = useCallback((id: string, patch: Partial<Staged>) => {
    setStaged((list) => list.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  /** Reads one file: instant preview (pages, thumbnail, SSNs, estimate), then the AI's look at page 1. */
  const inspect = useCallback(
    async (item: Staged) => {
      const form = new FormData();
      form.append("file", item.file);
      const abort = new AbortController();
      inflight.current.add(abort);
      try {
        const res = await fetch("/api/preview", { method: "POST", body: form, signal: abort.signal });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Couldn't read this PDF");
        update(item.id, { status: "ready", preview: json, ai: json.hasText ? "loading" : "idle", aiStartedAt: Date.now() });
        if (!json.hasText) return;
        const ai = await fetch("/api/preview/entities", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: item.file.name, text: json.firstPageText }),
          signal: abort.signal,
        });
        const aiJson = await ai.json();
        if (!ai.ok) throw Object.assign(new Error(aiJson.error ?? "Quick look failed"), { ai: true });
        update(item.id, { ai: "done", entities: aiJson.entities, aiNote: aiJson.note ?? null });
      } catch (e) {
        if (abort.signal.aborted) return;
        if ((e as { ai?: boolean }).ai) update(item.id, { ai: "error", aiError: (e as Error).message });
        else update(item.id, { status: "error", error: (e as Error).message });
      } finally {
        inflight.current.delete(abort);
      }
    },
    [update],
  );

  const add = (list: FileList | null) => {
    if (!list) return;
    const pdfs = [...list].filter((f) => f.name.toLowerCase().endsWith(".pdf"));
    setError(pdfs.length < list.length ? "Only PDF files can be added." : null);
    const fresh = pdfs
      .filter((f) => !staged.some((s) => s.file.name === f.name && s.file.size === f.size))
      .map((file): Staged => ({ id: `${file.name}-${file.size}-${Math.random()}`, file, status: "reading", ai: "idle" }));
    if (fresh.length === 0) return;
    setStaged((prev) => [...prev, ...fresh]);
    // Read a few at a time so a big drop doesn't flood the free model's rate limit.
    const queue = [...fresh];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await inspect(next);
    };
    void Promise.all([worker(), worker(), worker()]);
  };

  const ready = staged.filter((s) => s.status !== "error");
  const speed: Speed | undefined = staged.find((s) => s.preview)?.preview?.speed;
  const allMeasured = ready.every((s) => s.preview);
  // The same plan the live countdown starts from: exact sections, run a few at a time.
  const estimate = speed ? planBatch(shapeOf(ready.flatMap((s) => (s.preview ? [s.preview] : []))), speed).total : null;
  const totalPages = ready.reduce((n, s) => n + (s.preview?.pages ?? 0), 0);

  async function start() {
    for (const a of inflight.current) a.abort();
    setBusy(true);
    setError(null);
    const form = new FormData();
    ready.forEach((s) => form.append("files", s.file));
    form.append("name", name.trim() || defaultName(ready));
    try {
      const res = await fetch("/api/batches", { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Upload failed");
      setStaged([]);
      setName("");
      router.replace(`${pathname}?batch=${json.id}`, { scroll: false });
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (batchId) {
    return (
      <LiveProgress
        batchId={batchId}
        onNewBatch={() => {
          router.replace(pathname, { scroll: false });
          router.refresh();
        }}
        onFinished={() => router.refresh()}
      />
    );
  }

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-line bg-paper p-5">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          add(e.dataTransfer.files);
        }}
        onClick={() => input.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-6 text-center transition ${
          staged.length ? "py-5" : "py-10"
        } ${dragging ? "border-focus bg-blue-50" : "border-line hover:border-muted"}`}
      >
        <p className="font-medium">{staged.length ? "Drop more PDFs, or click to add" : "Drop PDFs here, or click to choose"}</p>
        <p className="text-sm text-muted">
          Each file gets a quick look right away. People are matched across every file in the batch.
        </p>
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          onChange={(e) => {
            add(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {staged.length > 0 && (
        <>
          <ul className="flex flex-col gap-2">
            {staged.map((s) => (
              <FileCard key={s.id} item={s} speed={speed} onRemove={() => setStaged((list) => list.filter((x) => x.id !== s.id))} />
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`Batch name (e.g. ${defaultName(ready) || "State v. Smith"})`}
              className="min-w-48 flex-1 rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-focus"
            />
            <button
              disabled={busy || ready.length === 0}
              onClick={start}
              className="rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy
                ? "Uploading…"
                : `Find redactions in ${ready.length} document${ready.length === 1 ? "" : "s"}${
                    allMeasured && estimate !== null ? ` · ~${formatDuration(estimate)}` : ""
                  }`}
            </button>
          </div>
          {allMeasured && totalPages > 0 && (
            <p className="-mt-2 text-xs text-muted">
              {totalPages} pages in total. Estimate based on {speed?.samples ? `your last ${speed.samples} batch${speed.samples === 1 ? "" : "es"}` : "measured runs"} on the current model.
            </p>
          )}
        </>
      )}

      {staged.length === 0 && <SampleCase onStarted={(id) => router.replace(`${pathname}?batch=${id}`, { scroll: false })} />}
      {error && <p className="text-sm text-red-700">{error}</p>}
    </section>
  );
}

function defaultName(list: Staged[]) {
  if (list.length === 0) return "";
  const first = list[0].file.name.replace(/\.pdf$/i, "");
  return list.length === 1 ? first : `${first} + ${list.length - 1} more`;
}

function SampleCase({ onStarted }: { onStarted: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line pt-4 text-sm">
      <p className="text-muted">No documents handy? Try a 10-document sample case with planted names and SSNs.</p>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const res = await fetch("/api/batches/sample", { method: "POST" });
          const json = await res.json();
          if (!res.ok) {
            setError(json.error ?? "Couldn't load the sample");
            setBusy(false);
            return;
          }
          onStarted(json.id);
          router.refresh();
        }}
        className="shrink-0 rounded-lg border border-line px-3 py-1.5 font-medium hover:bg-background disabled:opacity-50"
      >
        {busy ? "Loading…" : "Load sample case"}
      </button>
      {error && <p className="text-red-700">{error}</p>}
    </div>
  );
}
