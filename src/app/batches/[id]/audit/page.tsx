import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ReportDownloads } from "@/components/report/downloads";
import { ExpandAll } from "@/components/report/expand-all";
import type { EntityType, HistoryState } from "@/db/schema";
import { getReport } from "@/lib/report";
import type { CandidateState, ReportCandidate, ReportEvent, ReportPlace } from "@/lib/report-types";
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
  const mixed = report.candidates.filter((c) => c.mixed).length;
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
          detail={`${totals.mentions - totals.mentionsRedacted} stay visible${mixed ? ` · ${mixed} ${mixed === 1 ? "entity is" : "entities are"} partly visible` : ""}`}
        />
      </section>
      <p className="rounded-lg bg-paper px-4 py-3 text-sm text-muted ring-1 ring-line">
        <span className="font-medium text-foreground">Everything the system finds is redacted by default.</span> Only what a reviewer marks Keep stays
        visible. The PDF version of this report names everything that was redacted: keep it internal.
      </p>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">Open any entity to see its history, newest first, and every place it appears, redacted or visible.</p>
        <ExpandAll />
      </div>

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
            {rows.length === 0 ? (
              <p className="text-sm text-muted">None.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {rows.map((c) => (
                  <EntityCard key={c.id} c={c} />
                ))}
              </div>
            )}
          </section>
        );
      })}

      {report.unassigned.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">Not tied to an entity</h2>
          <p className="-mt-1 text-sm text-muted">Places the system couldn&apos;t attribute to anyone. They&apos;re redacted to be safe unless a person kept them.</p>
          <div className="rounded-xl border border-line bg-paper px-4 py-3">
            <PlaceList places={report.unassigned} />
          </div>
        </section>
      )}

      {report.retired.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">No longer in the results</h2>
          <p className="-mt-1 text-sm text-muted">Entities a person worked on that later left the results. Their history stays on record.</p>
          <div className="flex flex-col gap-2">
            {report.retired.map((r, i) => (
              <details key={i} data-entity className="group rounded-xl border border-line bg-paper">
                <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
                  <Chevron />
                  <span className="font-medium">{r.label}</span>
                  {r.type && <span className="text-sm capitalize text-muted">{TYPE_NAME[r.type][0]}</span>}
                  <span className="text-xs text-muted">{r.reason}</span>
                </summary>
                <div className="border-t border-line px-4 py-3">
                  <History events={r.history} />
                </div>
              </details>
            ))}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Full audit trail</h2>
        <p className="-mt-1 text-sm text-muted">
          Every flag, decision, re-run, and export across the batch, who made it, and when. The database refuses edits and deletes to these entries.
        </p>
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

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" }) : "");

const STATE_DOT: Record<HistoryState, string> = {
  flagged: "bg-neutral-300 ring-1 ring-neutral-400",
  redacted: "bg-ink",
  kept: "bg-emerald-600",
  follows: "bg-paper ring-1 ring-neutral-400",
};

const PILL: Record<CandidateState, string> = {
  kept: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  redacted: "bg-neutral-900 text-white ring-neutral-900",
  flagged: "bg-neutral-100 text-neutral-700 ring-neutral-300",
};
const PILL_LABEL: Record<CandidateState, string> = { kept: "Kept", redacted: "Redacted", flagged: "System flagged" };

function Chevron() {
  return <span className="w-3 shrink-0 self-center text-muted transition-transform group-open:rotate-90">›</span>;
}

/** One entity: latest status up top; open it for its history and every place it appears. */
function EntityCard({ c }: { c: ReportCandidate }) {
  const visible = c.places.filter((p) => p.outcome === "visible").length;
  const redacted = c.places.length - visible;
  return (
    <details data-entity open={c.mixed} className={`group rounded-xl border bg-paper ${c.mixed ? "border-amber-300" : "border-line"}`}>
      <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
        <Chevron />
        <span className="font-medium">{c.label}</span>
        {c.role && <span className="text-sm text-muted">{c.role}</span>}
        <span className="text-sm capitalize text-muted">{TYPE_NAME[c.type][0]}</span>
        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ring-1 ${PILL[c.state]}`}>{PILL_LABEL[c.state]}</span>
        {c.decidedBy && (
          <span className="text-xs text-muted">
            by {c.decidedBy}
            {c.decidedAt && (
              <>
                {" · "}
                <time dateTime={c.decidedAt}>{when(c.decidedAt)}</time>
              </>
            )}
          </span>
        )}
        <span className="ml-auto text-xs tabular-nums">
          {c.mixed ? (
            <span className="rounded bg-amber-50 px-1.5 py-0.5 font-medium text-amber-800 ring-1 ring-amber-200">
              Mixed: {visible} visible · {redacted} redacted
            </span>
          ) : (
            <span className="text-muted">
              {c.places.length} place{c.places.length === 1 ? "" : "s"}, {visible ? "all visible" : "all redacted"}
            </span>
          )}
        </span>
      </summary>
      <div className="grid gap-5 border-t border-line px-4 py-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">History</h3>
          <History events={c.history} />
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Where it appears</h3>
          {c.places.length === 0 ? (
            <p className="text-sm text-muted">No places in the documents.</p>
          ) : c.mixed ? (
            <>
              <PlaceGroup title="Visible" tone="visible" places={c.places.filter((p) => p.outcome === "visible")} />
              <PlaceGroup title="Redacted" tone="redacted" places={c.places.filter((p) => p.outcome === "redacted")} />
            </>
          ) : (
            <PlaceGroup title={visible ? "Visible everywhere" : "Redacted everywhere"} tone={visible ? "visible" : "redacted"} places={c.places} />
          )}
        </div>
      </div>
    </details>
  );
}

/** Newest first, so the line at the top is where it stands now. */
function History({ events }: { events: ReportEvent[] }) {
  if (events.length === 0) return <p className="text-sm text-muted">No recorded events.</p>;
  return (
    <ol className="flex flex-col">
      {[...events].reverse().map((e, i) => (
        <li key={i} className="relative flex gap-3 pb-3 pl-1 last:pb-0">
          <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${e.toState ? STATE_DOT[e.toState] : "bg-paper ring-1 ring-line"}`} />
          <div className="min-w-0 text-sm">
            <p>
              <span className={e.actor === "system" ? "text-muted" : "font-medium"}>{e.actor === "system" ? "System" : e.actor}</span>
              <span className="text-muted"> · </span>
              <time className="text-xs tabular-nums text-muted" dateTime={e.at}>
                {when(e.at)}
              </time>
              {i === 0 && <span className="ml-2 rounded bg-background px-1 text-[11px] font-medium text-muted ring-1 ring-line">Latest</span>}
            </p>
            <p className="break-words">{e.summary}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function PlaceGroup({ title, tone, places }: { title: string; tone: ReportPlace["outcome"]; places: ReportPlace[] }) {
  return (
    <div>
      <p className={`mb-1 flex items-center gap-1.5 text-sm font-medium ${tone === "visible" ? "text-emerald-800" : ""}`}>
        <i className={`inline-block h-2.5 w-2.5 rounded-sm ${tone === "visible" ? "bg-emerald-600" : "bg-ink"}`} />
        {title} <span className="font-normal text-muted">{places.length}</span>
      </p>
      <PlaceList places={places} />
    </div>
  );
}

/** Every place, grouped by document, with why it ended up redacted or visible. */
function PlaceList({ places }: { places: ReportPlace[] }) {
  const byDoc = new Map<string, ReportPlace[]>();
  for (const p of places) byDoc.set(p.document, [...(byDoc.get(p.document) ?? []), p]);
  return (
    <div className="flex flex-col gap-2">
      {[...byDoc].map(([doc, list]) => (
        <div key={doc}>
          <p className="text-xs font-medium text-muted">
            {doc} · {list.length}
          </p>
          <ul className="mt-0.5 flex flex-col divide-y divide-line/60">
            {list.map((p) => (
              <li key={p.mentionId} className="py-1 text-sm">
                <p className="truncate">
                  <span className="mr-2 text-xs tabular-nums text-muted">p.{p.page}</span>
                  <span className="text-muted">{p.before}</span>
                  <mark className={`mx-0.5 rounded px-0.5 ${p.outcome === "visible" ? "bg-emerald-100 text-emerald-900" : "bg-black text-white"}`}>{p.text}</mark>
                  <span className="text-muted">{p.after}</span>
                </p>
                <p className={`text-xs ${p.individually ? (p.individually.decision === "keep" ? "text-emerald-800" : "text-foreground") : "text-muted"}`}>
                  <span className="font-medium">{p.outcome === "visible" ? "Visible" : "Redacted"}</span> · {p.reason}
                  {p.individually?.at && <> · {when(p.individually.at)}</>}
                  {p.assignedBy && (
                    <span className="text-muted">
                      {" "}
                      · confirmed as this entity by {p.assignedBy}
                      {p.assignedAt && <>, {when(p.assignedAt)}</>}
                    </span>
                  )}
                </p>
                {p.history.filter((e) => e.actor !== "system" || e.action === "mention.carried").length > 1 && (
                  <ol className="mt-0.5 border-l border-line pl-2 text-xs text-muted">
                    {[...p.history].reverse().map((e, i) => (
                      <li key={i}>
                        {when(e.at)} · {e.actor === "system" ? "System" : e.actor} · {e.summary}
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
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
