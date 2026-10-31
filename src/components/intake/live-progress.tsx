"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { EntityType } from "@/db/schema";
import { formatDuration } from "@/lib/estimate";
import { secondsLeft, shareDone, smoothCountdown, timeLeft, type BatchProgress, type Countdown } from "@/lib/progress";

interface Live {
  id: string;
  name: string;
  status: "processing" | "ready" | "failed";
  stage: string;
  error: string | null;
  warning: string | null;
  progress: BatchProgress | null;
  documents: { id: string; filename: string; pageCount: number }[];
  summary: { byType: Record<EntityType, number>; mentions: number; redactions: number; needsLook: number } | null;
  stats: { seconds: number } | null;
  serverNow: number;
}

const TYPE: Record<EntityType, string> = { person: "Person", address: "Address", ssn: "SSN", org: "Org" };

/** Watch a batch being processed: a page strip per document, a live feed of finds, and a countdown. */
export function LiveProgress({
  batchId,
  onNewBatch,
  onFinished,
  compact,
}: {
  batchId: string;
  onNewBatch?: () => void;
  onFinished?: () => void;
  compact?: boolean;
}) {
  const [live, setLive] = useState<Live | null>(null);
  const [missing, setMissing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [clock, setClock] = useState<Countdown | null>(null);
  const liveRef = useRef<Live | null>(null);
  const skew = useRef(0); // server clock minus this browser's clock
  const [generation, setGeneration] = useState(0); // bumps on "Try again" to restart polling
  const finished = useRef(false);
  // Keep the latest callback without restarting polling when the parent re-renders.
  const onFinishedRef = useRef(onFinished);
  useEffect(() => {
    onFinishedRef.current = onFinished;
  }, [onFinished]);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const res = await fetch(`/api/batches/${batchId}`, { cache: "no-store" }).catch(() => null);
      if (stop) return;
      if (res?.status === 404) {
        setMissing(true);
        return;
      }
      if (res?.ok) {
        const next: Live = await res.json();
        skew.current = next.serverNow - Date.now();
        setLive(next);
        if (next.status !== "processing") {
          if (!finished.current) {
            finished.current = true;
            onFinishedRef.current?.();
          }
          return;
        }
      }
      timer = setTimeout(poll, 1500);
    };
    finished.current = false;
    void poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [batchId, generation]);

  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  useEffect(() => {
    if (live?.status !== "processing") return;
    const t = setInterval(() => {
      const at = Date.now() + skew.current;
      setNow(at);
      const p = liveRef.current?.progress;
      if (!p) return;
      const elapsed = Math.max(0, (at - Date.parse(p.startedAt)) / 1000);
      setClock((prev) => smoothCountdown(prev, { key: `${batchId}|${p.startedAt}`, at, target: secondsLeft(p, at), elapsed }));
    }, 1000);
    return () => clearInterval(t);
  }, [live?.status, batchId]);

  if (missing) {
    return (
      <section className="rounded-xl border border-line bg-paper p-5 text-sm">
        That batch no longer exists.{" "}
        <button className="font-medium underline" onClick={onNewBatch}>
          Start a new one
        </button>
      </section>
    );
  }
  if (!live) return <section className="rounded-xl border border-line bg-paper p-5 text-sm text-muted">Loading…</section>;

  const p = live.progress;
  const done = live.status === "ready";
  const elapsed = p ? Math.max(0, Math.round((now - Date.parse(p.startedAt)) / 1000)) : 0;
  const shown = p && clock?.key === `${batchId}|${p.startedAt}` ? clock : null;
  const left = p && !done ? (shown?.left ?? secondsLeft(p, now)) : 0;
  const fraction = done ? 1 : p ? (shown?.fraction ?? shareDone(elapsed, left)) : 0.01;
  // The free model sometimes gets busy; say so when the run is well past what we promised.
  const slow = !!p && !done && elapsed + left > p.estimateSeconds * 1.3 + 30;
  // When everything left is a call already past its plan, a countdown would be made up: say what we're waiting on.
  const waiting = p && !done ? timeLeft(p, now).waiting : null;

  return (
    <section className="flex flex-col overflow-hidden rounded-xl border border-line bg-paper">
      <header className="flex flex-col gap-3 border-b border-line p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">{live.name}</h2>
          {onNewBatch && (
            <button onClick={onNewBatch} className="text-sm text-muted hover:text-foreground">
              {live.status === "processing" ? "Start another batch (this one keeps going)" : "Start another batch"}
            </button>
          )}
        </div>
        {live.status === "failed" ? (
          <Failed batchId={batchId} error={live.error} onRetry={() => setGeneration((g) => g + 1)} />
        ) : done && live.summary ? (
          <Summary batchId={batchId} summary={live.summary} seconds={live.stats?.seconds ?? null} />
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-2">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-ink" />
                {live.stage}
              </span>
              <span className="tabular-nums text-muted">
                {!p
                  ? "Starting…"
                  : waiting
                    ? `${waiting.on} ${waiting.many ? "are" : "is"} taking longer than usual (${formatDuration(waiting.for)})${
                        waiting.then >= 20 ? ` · then ~${formatDuration(waiting.then)}` : ""
                      }`
                    : `~${formatDuration(left)} left · ${formatDuration(elapsed)} so far`}
                {(waiting || slow) && (
                  <span className="block text-right text-xs text-amber-800">
                    {waiting ? `The free model is busy right now · ${formatDuration(elapsed)} so far` : "Slower than planned: the model is busy"}
                  </span>
                )}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full bg-ink transition-all duration-700" style={{ width: `${Math.max(2, fraction * 100)}%` }} />
            </div>
          </div>
        )}
        {live.warning && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">{live.warning}</p>}
      </header>

      <div className={`grid gap-0 ${compact ? "" : "md:grid-cols-[1fr_minmax(260px,34%)]"}`}>
        <PageStrips live={live} />
        <Feed progress={p} done={done} />
      </div>
    </section>
  );
}

function PageStrips({ live }: { live: Live }) {
  const p = live.progress;
  const reading = p?.stage === "cast";
  return (
    <div className="flex min-w-0 flex-col gap-4 p-5">
      {live.documents.map((doc) => {
        const scanned = new Set(p?.scanned?.[doc.id] ?? []);
        const scanning = new Set(p?.scanning?.[doc.id] ?? []);
        const finds = p?.findsByPage?.[doc.id] ?? {};
        const total = Object.values(finds).reduce((a, b) => a + b, 0);
        const complete = doc.pageCount > 0 && scanned.size >= doc.pageCount;
        return (
          <div key={doc.id} className="flex min-w-0 flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate font-medium">{doc.filename}</span>
              <span className="shrink-0 tabular-nums text-xs text-muted">
                {doc.pageCount === 0
                  ? "reading…"
                  : complete
                    ? `✓ ${doc.pageCount} pages · ${total} finds`
                    : `${scanned.size}/${doc.pageCount} pages${total ? ` · ${total} finds` : ""}`}
              </span>
            </div>
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {Array.from({ length: doc.pageCount }, (_, i) => i + 1).map((n) => {
                const isScanned = scanned.has(n) || live.status === "ready";
                const isScanning = scanning.has(n);
                const count = finds[n] ?? 0;
                return (
                  <div
                    key={n}
                    title={`Page ${n}${count ? ` · ${count} finds` : ""}`}
                    className={`relative h-[62px] w-12 shrink-0 overflow-hidden rounded-sm border bg-white transition duration-500 ${
                      isScanning ? "border-focus ring-2 ring-focus/60 animate-pulse" : "border-line"
                    } ${reading && !isScanned ? "animate-pulse" : ""}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/documents/${doc.id}/pages/${n}?w=96`}
                      alt=""
                      loading="lazy"
                      className={`h-full w-full object-cover object-top transition duration-500 ${isScanned || isScanning ? "" : "opacity-35 grayscale"}`}
                    />
                    {count > 0 && (
                      <span className="absolute bottom-0.5 right-0.5 rounded bg-ink px-1 text-[10px] font-medium leading-4 text-white">{count}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Feed({ progress, done }: { progress: BatchProgress | null; done: boolean }) {
  const items = (progress?.found ?? []).filter((f) => f.count > 0 || progress?.stage !== "patterns");
  return (
    <aside className="flex max-h-[420px] min-w-0 flex-col border-t border-line md:border-l md:border-t-0">
      <h3 className="px-5 pb-2 pt-5 text-xs font-medium uppercase tracking-wide text-muted">
        {done ? "Found" : "Found so far"} {items.length > 0 && <span className="normal-case">· {items.length}</span>}
      </h3>
      {items.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted">{progress?.stage === "cast" ? "Reading the whole batch to learn who's who…" : "Nothing yet."}</p>
      ) : (
        <ul className="flex-1 overflow-y-auto px-3 pb-3">
          {items.map((f) => (
            <li key={f.key} className="feed-in flex items-center gap-2 rounded-md px-2 py-1.5 text-sm">
              <span className="w-12 shrink-0 text-[10px] uppercase tracking-wide text-muted">{TYPE[f.type]}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{f.type === "ssn" ? maskSsn(f.label) : f.label}</span>
                {f.role && <span className="block truncate text-xs text-muted">{f.role}</span>}
              </span>
              <span
                className={`shrink-0 rounded-full px-1.5 text-[10px] ${f.suggestion === "redact" ? "bg-ink text-white" : "border border-emerald-600/40 text-emerald-800"}`}
              >
                {f.suggestion}
              </span>
              <span className="w-7 shrink-0 text-right tabular-nums text-xs text-muted">{f.count || ""}</span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function maskSsn(label: string) {
  const last4 = label.match(/(\d{4})\D*$/)?.[1];
  return last4 ? `•••-••-${last4}` : label;
}

function Summary({
  batchId,
  summary,
  seconds,
}: {
  batchId: string;
  summary: NonNullable<Live["summary"]>;
  seconds: number | null;
}) {
  const t = summary.byType;
  const parts = [
    t.person && `${t.person} ${t.person === 1 ? "person" : "people"}`,
    t.address && `${t.address} address${t.address === 1 ? "" : "es"}`,
    t.ssn && `${t.ssn} SSN${t.ssn === 1 ? "" : "s"}`,
    t.org && `${t.org} organization${t.org === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg bg-background p-4">
      <div className="flex flex-col gap-0.5">
        <p className="font-medium">Found {parts.join(", ") || "nothing to redact"}</p>
        <p className="text-sm text-muted">
          {summary.redactions} of {summary.mentions} mentions suggested for redaction
          {summary.needsLook > 0 && <span className="text-amber-800"> · {summary.needsLook} need a second look</span>}
          {seconds !== null && seconds > 0 && ` · took ${formatDuration(seconds)}`}
        </p>
      </div>
      <Link href={`/batches/${batchId}`} className="rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white">
        Review redactions →
      </Link>
    </div>
  );
}

function Failed({ batchId, error, onRetry }: { batchId: string; error: string | null; onRetry: () => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-red-50 p-4 text-sm text-red-900">
      <p>
        <span className="font-medium">Couldn&apos;t finish.</span> {error}
        {problem && <span className="block pt-1">{problem}</span>}
      </p>
      <button
        className="rounded-lg bg-ink px-3 py-1.5 font-medium text-white"
        onClick={async () => {
          const res = await fetch(`/api/batches/${batchId}/reprocess`, { method: "POST" });
          if (res.ok) onRetry();
          else setProblem((await res.json().catch(() => ({}))).error ?? "Couldn't restart it.");
        }}
      >
        Try again
      </button>
    </div>
  );
}
