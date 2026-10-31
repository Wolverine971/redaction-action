"use client";

import { useState } from "react";
import { ReviewerName, readReviewer } from "@/components/review/reviewer-name";

/** Download buttons for the report. They ask for the reviewer's name first, since downloads are logged. */
export function ReportDownloads({ batchId }: { batchId: string }) {
  const [asking, setAsking] = useState<null | (() => void)>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download(kind: "pdf" | "csv" | "audit") {
    if (!readReviewer()) {
      setAsking(() => () => download(kind));
      return;
    }
    setBusy(kind);
    setError(null);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const url = kind === "audit" ? `/api/batches/${batchId}/audit` : `/api/batches/${batchId}/report?format=${kind}&tz=${encodeURIComponent(tz)}`;
    const res = await fetch(url);
    setBusy(null);
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? "Download failed");
      return;
    }
    const blob = await res.blob();
    const name = res.headers.get("Content-Disposition")?.match(/filename="(.+)"/)?.[1] ?? "report";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap justify-end gap-2 text-sm">
        <button onClick={() => download("pdf")} disabled={!!busy} className="rounded-lg bg-ink px-3 py-1.5 font-medium text-white disabled:opacity-50">
          {busy === "pdf" ? "Preparing…" : "Download report (PDF)"}
        </button>
        <button onClick={() => download("csv")} disabled={!!busy} className="rounded-lg border border-line bg-paper px-3 py-1.5 font-medium hover:bg-background disabled:opacity-50">
          Decisions (CSV)
        </button>
        <button onClick={() => download("audit")} disabled={!!busy} className="rounded-lg border border-line bg-paper px-3 py-1.5 font-medium hover:bg-background disabled:opacity-50">
          Audit trail (CSV)
        </button>
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {asking && (
        <ReviewerName
          prompt
          onDone={() => {
            const next = asking;
            setAsking(null);
            next();
          }}
          onCancel={() => setAsking(null)}
        />
      )}
    </div>
  );
}
