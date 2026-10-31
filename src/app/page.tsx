import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { Intake } from "@/components/intake/intake";
import { listBatches } from "@/lib/review";

async function BatchList() {
  await connection();
  const rows = await listBatches();
  if (rows.length === 0) {
    return <p className="text-sm text-muted">No batches yet. Upload PDFs or load the sample case to start.</p>;
  }
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-paper">
      {rows.map((b) => (
        <li key={b.id}>
          <Link
            href={b.status === "processing" ? `/?batch=${b.id}` : `/batches/${b.id}`}
            className="flex items-center gap-4 px-5 py-4 hover:bg-background"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{b.name}</p>
              <p className="text-sm text-muted">
                {b.documents} document{b.documents === 1 ? "" : "s"} · {b.pages} pages · {b.createdAt.toLocaleString()}
              </p>
            </div>
            {b.status === "ready" ? (
              <span className="text-right text-sm text-muted">
                {b.entities} candidates
                <span className="block text-xs">{b.reviewed} decided by you</span>
              </span>
            ) : b.status === "failed" ? (
              <span className="rounded-full bg-red-50 px-2.5 py-0.5 text-sm text-red-700">Failed</span>
            ) : (
              <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-sm text-amber-800">{b.stage}</span>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-6 py-14">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Redaction Action</h1>
        <p className="max-w-xl text-muted">
          Upload a batch of related PDFs. We find every name, home address, and Social Security number, group them by
          person, and you approve what gets blacked out.
        </p>
      </header>
      <Suspense fallback={<div className="h-48 rounded-xl border border-line bg-paper" />}>
        <Intake />
      </Suspense>
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted">Batches</h2>
        <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
          <BatchList />
        </Suspense>
      </section>
    </main>
  );
}
