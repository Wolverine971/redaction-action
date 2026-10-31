import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ReportDownloads } from "@/components/report/downloads";
import type { EntityType } from "@/db/schema";
import { getReport } from "@/lib/report";
import type { CandidateState, ReportCandidate } from "@/lib/report-types";
import { isUuid } from "@/lib/server/reviewer";

const TYPE_NAME: Record<EntityType, [string, string]> = {
  person: ["person", "people"],
  org: ["organization", "organizations"],
  address: ["address", "addresses"],
  ssn: ["SSN", "SSNs"],
};

const SECTIONS: { state: CandidateState; title: string; hint: string; swatch: string }[] = [
  { state: "kept", title: "You kept", hint: "A reviewer chose to leave these visible. They appear unredacted in the shared documents.", swatch: "bg-emerald-600" },
  { state: "redacted", title: "You redacted", hint: "A reviewer explicitly chose to redact these.", swatch: "bg-ink" },
  {
    state: "flagged",
    title: "System flagged",
    hint: "Found by the system and redacted by default. Nobody has individually reviewed these.",
    swatch: "bg-neutral-300 ring-1 ring-neutral-400",
  },
];

async function Report({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const report = await getReport(id, "");
  if (!report) notFound();
  const { totals } = report;
  const pages = report.batch.documents.reduce((n, d) => n + d.pages, 0);
  const found = (Object.keys(TYPE_NAME) as EntityType[])
    .filter((t) => totals.byType[t] > 0)
    .map((t) => `${totals.byType[t]} ${TYPE_NAME[t][totals.byType[t] === 1 ? 0 : 1]}`);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href={`/batches/${id}`} className="text-sm text-muted hover:text-foreground">
            ← Back to review
          </Link>
          <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-muted">Redaction report</p>
          <h1 className="text-2xl font-semibold">{report.batch.name}</h1>
          <p className="text-sm text-muted">
            {report.batch.documents.length} document{report.batch.documents.length === 1 ? "" : "s"} · {pages} pages
          </p>
        </div>
        <ReportDownloads batchId={id} />
      </div>

      <section className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3">
        <Stat label="Found" value={String(totals.candidates)} detail={found.join(" · ") || "Nothing"} />
        <div className="flex flex-col gap-1.5 bg-paper p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Decisions</p>
          <StateCount swatch="bg-emerald-600" label="You kept" n={totals.kept} />
          <StateCount swatch="bg-ink" label="You redacted" n={totals.redacted} />
          <StateCount swatch="bg-neutral-300 ring-1 ring-neutral-400" label="System flagged" n={totals.flagged} />
        </div>
        <Stat
          label="Mentions redacted"
          value={`${totals.mentionsRedacted} of ${totals.mentions}`}
          detail={`${totals.mentions - totals.mentionsRedacted} stay visible`}
        />
      </section>
      <p className="rounded-lg bg-paper px-4 py-3 text-sm text-muted ring-1 ring-line">
        <span className="font-medium text-foreground">Everything the system finds is redacted by default.</span> Only what a reviewer marks Keep stays
        visible. The PDF version of this report names everything that was redacted: keep it internal.
      </p>

      {SECTIONS.map((s) => {
        const rows = report.candidates.filter((c) => c.state === s.state);
        return (
          <section key={s.state} className="flex flex-col gap-2">
            <div className="flex items-baseline gap-2">
              <i className={`inline-block h-3 w-3 shrink-0 rounded-sm ${s.swatch}`} />
              <h2 className="text-lg font-semibold">{s.title}</h2>
              <span className="text-sm text-muted">{rows.length}</span>
            </div>
            <p className="-mt-1 text-sm text-muted">{s.hint}</p>
            {rows.length === 0 ? <p className="text-sm text-muted">None.</p> : <CandidateTable rows={rows} />}
          </section>
        );
      })}

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Audit trail</h2>
        <p className="-mt-1 text-sm text-muted">Every flag, decision, and export, who made it, and when. Entries are never edited or deleted.</p>
        <div className="overflow-hidden rounded-xl border border-line bg-paper">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line bg-background text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">Who</th>
                <th className="px-4 py-2 font-medium">What</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {[...report.events].reverse().map((e, i) => (
                <tr key={i}>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted">
                    <time dateTime={e.at}>{new Date(e.at).toLocaleString()}</time>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">{e.actor === "system" ? <span className="text-muted">System</span> : e.actor}</td>
                  <td className="px-4 py-2">{e.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="flex flex-col gap-1 bg-paper p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-sm text-muted">{detail}</p>
    </div>
  );
}

function StateCount({ swatch, label, n }: { swatch: string; label: string; n: number }) {
  return (
    <p className="flex items-center gap-2 text-sm">
      <i className={`inline-block h-2.5 w-2.5 rounded-sm ${swatch}`} />
      <span className="flex-1">{label}</span>
      <span className="font-semibold tabular-nums">{n}</span>
    </p>
  );
}

function CandidateTable({ rows }: { rows: ReportCandidate[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-paper">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-line bg-background text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-4 py-2 font-medium">Name</th>
            <th className="px-4 py-2 font-medium">Type</th>
            <th className="px-4 py-2 font-medium">Mentions</th>
            <th className="px-4 py-2 font-medium">Where</th>
            <th className="px-4 py-2 font-medium">Decided</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((c, i) => (
            <tr key={i} className="align-top">
              <td className="px-4 py-2">
                <p className="font-medium">{c.label}</p>
                {c.role && <p className="text-xs text-muted">{c.role}</p>}
              </td>
              <td className="whitespace-nowrap px-4 py-2 capitalize text-muted">{TYPE_NAME[c.type][0]}</td>
              <td className="whitespace-nowrap px-4 py-2 tabular-nums">
                {c.mentions}
                {c.mentionsRedacted !== c.mentions && <span className="text-muted"> ({c.mentionsRedacted} redacted)</span>}
                {c.exceptions > 0 && <p className="text-xs text-amber-700">{c.exceptions} set individually</p>}
              </td>
              <td className="px-4 py-2 text-xs text-muted">
                {c.locations.map((l) => (
                  <p key={l.document}>
                    {l.document} p.{l.pages.join(", ")}
                  </p>
                ))}
              </td>
              <td className="whitespace-nowrap px-4 py-2 text-xs">
                {c.decidedBy ? (
                  <>
                    <p>{c.decidedBy}</p>
                    {c.decidedAt && (
                      <time className="text-muted" dateTime={c.decidedAt}>
                        {new Date(c.decidedAt).toLocaleString()}
                      </time>
                    )}
                  </>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ReportPage({ params }: PageProps<"/batches/[id]/audit">) {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-10">
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <Report params={params} />
      </Suspense>
    </main>
  );
}
