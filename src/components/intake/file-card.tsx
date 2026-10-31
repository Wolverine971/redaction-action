"use client";

import { useEffect, useState } from "react";
import { formatDuration, planBatch, shapeOf, type Speed } from "@/lib/estimate";

export interface Preview {
  filename: string;
  pages: number;
  chars: number;
  /** Scan section sizes in characters, for the time estimate. */
  sections: number[];
  hasText: boolean;
  thumbnail: string | null;
  firstPageText: string;
  ssns: { page: number; last4: string; kind: string }[];
  speed: Speed;
}

export interface Staged {
  id: string;
  file: File;
  status: "reading" | "ready" | "error";
  error?: string;
  preview?: Preview;
  ai: "idle" | "loading" | "done" | "error";
  aiStartedAt?: number;
  aiError?: string;
  aiNote?: string | null;
  entities?: { type: "person" | "address" | "org"; label: string; role: string; redact: boolean }[];
}

/** One dropped PDF: thumbnail, size, time estimate, and what the quick look found on page 1. */
export function FileCard({ item, speed, onRemove }: { item: Staged; speed?: Speed; onRemove: () => void }) {
  const p = item.preview;
  const ssnCount = new Set(p?.ssns.map((s) => s.last4)).size;
  return (
    <li className="flex gap-4 rounded-lg border border-line bg-background/40 p-3">
      <div className="flex h-[104px] w-20 shrink-0 items-center justify-center overflow-hidden rounded border border-line bg-white">
        {p?.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.thumbnail} alt={`First page of ${item.file.name}`} className="h-full w-full object-cover object-top" />
        ) : (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-ink" />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 truncate font-medium">{item.file.name}</p>
          <button onClick={onRemove} className="text-muted hover:text-foreground" aria-label={`Remove ${item.file.name}`}>
            ×
          </button>
        </div>
        {item.status === "error" ? (
          <p className="text-sm text-red-700">{item.error}</p>
        ) : !p ? (
          <p className="text-sm text-muted">Reading…</p>
        ) : !p.hasText ? (
          <p className="text-sm text-amber-800">No selectable text. This looks like a scan, which this version can&apos;t read yet.</p>
        ) : (
          <>
            <p className="text-sm text-muted">
              {p.pages} page{p.pages === 1 ? "" : "s"} · about {formatDuration(planBatch(shapeOf([p]), speed ?? p.speed).total)} on its own
              {ssnCount > 0 && (
                <span className="text-foreground">
                  {" "}
                  · {ssnCount} SSN{ssnCount === 1 ? "" : "s"} found ({[...new Set(p.ssns.map((s) => `•••-${s.last4}`))].slice(0, 3).join(", ")})
                </span>
              )}
            </p>
            <QuickLook item={item} />
          </>
        )}
      </div>
    </li>
  );
}

function QuickLook({ item }: { item: Staged }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (item.ai !== "loading") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [item.ai]);

  if (item.ai === "loading") {
    const seconds = Math.max(0, Math.round((now - (item.aiStartedAt ?? now)) / 1000));
    return (
      <div className="flex flex-col gap-0.5 text-sm text-muted">
        <span className="flex items-center gap-2">
          <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-line border-t-ink" />
          <span className="tabular-nums">Looking for names and addresses on page 1… {seconds}s</span>
        </span>
        {seconds >= 10 && <span className="pl-5 text-xs">Can take a minute or two on the free model. You can start without it.</span>}
      </div>
    );
  }
  if (item.ai === "error") return <p className="text-sm text-amber-800">{item.aiError} You can still process it.</p>;
  if (item.ai !== "done") return null;
  const entities = item.entities ?? [];
  if (entities.length === 0) return <p className="text-sm text-muted">{item.aiNote ?? "No names or addresses on page 1."}</p>;
  const sorted = [...entities].sort((a, b) => Number(b.redact) - Number(a.redact));
  const shown = sorted.slice(0, 6);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted">Page 1:</span>
      {shown.map((e, i) => (
        <span
          key={i}
          title={`${e.role}${e.redact ? " — will suggest redacting" : " — will suggest keeping"}`}
          className={`rounded-full px-2 py-0.5 ${e.redact ? "bg-ink text-white" : "border border-emerald-600/40 text-emerald-800"}`}
        >
          {e.label}
        </span>
      ))}
      {sorted.length > shown.length && <span className="text-muted">+{sorted.length - shown.length} more</span>}
    </div>
  );
}
