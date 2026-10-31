import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as mupdf from "mupdf";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { EntityType } from "@/db/schema";
import { renderPagePng } from "@/lib/pdf/render";
import type { CandidateState, ReportCandidate, ReportData, ReportEvent, ReportPlace } from "@/lib/report-types";
import { formatPageRanges, renderReportPdf, sanitizeText } from "./report-pdf";

const TZ = "America/New_York";
const BATCH = "State v. Smith — discovery set 1";

const DOCS = [
  { filename: "01-charging-document.pdf", pages: 3 },
  { filename: "02-police-incident-report.pdf", pages: 4 },
  { filename: "03-deposition-steve-smith.pdf", pages: 12 },
  { filename: "04-bank-subpoena-response.pdf", pages: 6 },
  { filename: "06-pediatric-intake-es.pdf", pages: 2 },
  { filename: "08-witness-statement-may-chen.pdf", pages: 2 },
];

/** 1:00 PM EDT on Oct 30, 2026, plus `minutes`. */
const at = (minutes: number) => new Date(Date.parse("2026-10-30T17:00:00Z") + minutes * 60_000).toISOString();

const TYPE_ORDER: EntityType[] = ["person", "org", "address", "ssn"];
const STATE_ORDER: CandidateState[] = ["kept", "redacted", "flagged"];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function event(e: Partial<ReportEvent> & Pick<ReportEvent, "at" | "actor" | "summary">): ReportEvent {
  return { action: "entity.flagged", toState: null, count: 1, ...e };
}

function place(p: Partial<ReportPlace> & Pick<ReportPlace, "document" | "page" | "text" | "outcome" | "reason">): ReportPlace {
  return { mentionId: `m-${slug(p.text)}-${p.page}`, before: "", after: "", individually: null, assignedBy: null, assignedAt: null, history: [], ...p };
}

const CONTEXTS: [string, string][] = [
  ["…the State calls", "to the stand and"],
  ["Counsel for the defense, joined by", "objected to the"],
  ["…signed on behalf of", "on the date shown"],
  ["…according to", "the vehicle was"],
];

/** One place per (document, page) in `locations`, then more on the same pages until there are `mentions`, in document order. */
function placesFor(c: { label: string; state: CandidateState; decidedBy: string | null; mentions: number; locations: ReportCandidate["locations"] }): ReportPlace[] {
  const pairs = c.locations.flatMap((l) => l.pages.map((page) => ({ document: l.document, page })));
  if (!pairs.length) return [];
  const outcome = c.state === "kept" ? "visible" : "redacted";
  const reason = c.state === "flagged" ? "System flagged: redacted by default" : `Follows the entity: ${c.state} by ${c.decidedBy}`;
  const docIndex = (d: string) => c.locations.findIndex((l) => l.document === d);
  return Array.from({ length: Math.max(c.mentions, pairs.length) }, (_, i) => {
    const { document, page } = pairs[i % pairs.length];
    const [before, after] = CONTEXTS[i % CONTEXTS.length];
    return place({ mentionId: `${slug(c.label)}-m${i + 1}`, document, page, text: c.label, before, after, outcome, reason });
  }).sort((a, b) => docIndex(a.document) - docIndex(b.document) || a.page - b.page);
}

/** System flag, then the reviewer's decision if there is one. */
function defaultHistory(c: Pick<ReportCandidate, "type" | "label" | "state" | "decidedBy" | "decidedAt" | "locations">, mentions: number): ReportEvent[] {
  const flagged = event({
    at: at(0),
    actor: "system",
    summary: `System flagged ${c.type} "${c.label}" for redaction (${mentions} mentions in ${c.locations.length} documents)`,
    toState: "flagged",
  });
  if (c.state === "flagged") return [flagged];
  return [
    flagged,
    event({
      at: c.decidedAt ?? at(30),
      actor: c.decidedBy ?? "DJ",
      action: `entity.${c.state}`,
      summary: c.state === "kept" ? `Kept ${c.type} "${c.label}" (left visible)` : `Redacted ${c.type} "${c.label}"`,
      toState: c.state,
    }),
  ];
}

function candidate(c: Partial<ReportCandidate> & Pick<ReportCandidate, "type" | "label" | "state">): ReportCandidate {
  const base = {
    id: `entity-${slug(c.label)}`,
    role: null,
    decidedBy: c.state === "flagged" ? null : "DJ",
    decidedAt: c.state === "flagged" ? null : at(30),
    mentions: 1,
    exceptions: 0,
    locations: [{ document: DOCS[0].filename, pages: [1] }],
    createdBy: "ai",
    ...c,
  };
  const places = c.places ?? placesFor(base);
  const redacted = places.filter((p) => p.outcome === "redacted").length;
  const mentions = places.length || base.mentions;
  return {
    ...base,
    mentions,
    mentionsRedacted: c.mentionsRedacted ?? redacted,
    history: c.history ?? defaultHistory(base, mentions),
    places,
    mixed: c.mixed ?? (redacted > 0 && redacted < places.length),
  };
}

/** Kept by DJ, but two places redacted one by one by Priya, one of them after going back and forth. */
function marcusPlaces(): ReportPlace[] {
  const follows = { outcome: "visible" as const, reason: "Follows the entity: kept by DJ", text: "Marcus Whitfield" };
  const redactP3 = event({ at: at(78), actor: "Priya Raman", action: "mention.redact", summary: `Redacted one mention "Marcus Whitfield" (Marcus Whitfield, p.3)`, toState: "redacted" });
  const p12 = [
    event({ at: at(78), actor: "Priya Raman", action: "mention.redact", summary: `Redacted one mention "Marcus Whitfield" (Marcus Whitfield, p.12)`, toState: "redacted" }),
    event({ at: at(80), actor: "DJ", action: "mention.keep", summary: `Kept one mention "Marcus Whitfield" (Marcus Whitfield, p.12) (was redacted individually by Priya Raman)`, toState: "kept" }),
    event({ at: at(95), actor: "Priya Raman", action: "mention.redact", summary: `Redacted one mention "Marcus Whitfield" (Marcus Whitfield, p.12) (was kept individually by DJ)`, toState: "redacted" }),
  ];
  return [
    place({ ...follows, mentionId: "mw-1", document: DOCS[0].filename, page: 1, before: "…the State calls", after: "to the stand and" }),
    place({ ...follows, mentionId: "mw-2", document: DOCS[0].filename, page: 1, before: "Assistant State’s Attorney", after: "appeared for the State" }),
    place({
      mentionId: "mw-3",
      document: DOCS[0].filename,
      page: 3,
      text: "Marcus Whitfield",
      before: "…the personal cell phone of",
      after: "(410) 555-0182, per the",
      outcome: "redacted",
      reason: "Redacted individually by Priya Raman",
      individually: { decision: "redact", by: "Priya Raman", at: at(78) },
      history: [redactP3],
    }),
    place({ ...follows, mentionId: "mw-4", document: DOCS[0].filename, page: 3, before: "Respectfully submitted,", after: "Assistant State’s Attorney" }),
    place({ ...follows, mentionId: "mw-5", document: DOCS[1].filename, page: 2, before: "…report was forwarded to ASA", after: "on October 3" }),
    place({ ...follows, mentionId: "mw-6", document: DOCS[1].filename, page: 2, before: "…per", after: "the charge was amended" }),
    place({ ...follows, mentionId: "mw-7", document: DOCS[2].filename, page: 1, before: "APPEARANCES: On behalf of the State,", after: "Esq." }),
    place({
      mentionId: "mw-8",
      document: DOCS[2].filename,
      page: 12,
      text: "Marcus Whitfield",
      before: "…the witness’s cousin,",
      after: "who lives on Elm Street",
      outcome: "redacted",
      reason: "Redacted individually by Priya Raman",
      individually: { decision: "redact", by: "Priya Raman", at: at(95) },
      history: p12,
    }),
    place({ ...follows, mentionId: "mw-9", document: DOCS[2].filename, page: 12, before: "BY MR.", after: ": Nothing further.", assignedBy: "DJ", assignedAt: at(77) }),
  ];
}

/** 80 back-and-forth decisions before the final one: long enough to run the history table across a page break. */
function stephenHistory(): ReportEvent[] {
  const label = "Stephen M. Smith";
  return [
    event({ at: at(0), actor: "system", summary: `System flagged person "${label}" for redaction (14 mentions in 1 document)`, toState: "flagged" }),
    ...Array.from({ length: 80 }, (_, i) => {
      const n = String(i + 1).padStart(2, "0");
      const keep = i % 2 === 0;
      return event({
        at: at(1 + i * 0.9),
        actor: i % 3 ? "Priya Raman" : "DJ",
        action: keep ? "entity.kept" : "entity.redacted",
        summary: keep ? `H${n} Kept person "${label}" (left visible)` : `H${n} Redacted person "${label}" (was kept by ${i % 3 ? "DJ" : "Priya Raman"})`,
        toState: keep ? "kept" : "redacted",
      });
    }),
    event({ at: at(74), actor: "DJ", action: "entity.redacted", summary: `Redacted person "${label}" (was kept by Priya Raman) — final`, toState: "redacted" }),
  ];
}

function sampleReport(): ReportData {
  const stephen = candidate({
    type: "person",
    label: "Stephen M. Smith",
    role: "Witness (deponent)",
    state: "redacted",
    decidedAt: at(74),
    mentions: 14,
    exceptions: 1,
    locations: [{ document: DOCS[2].filename, pages: [1, 2, 3, 4, 5, 7, 8, 11] }],
    history: stephenHistory(),
  });
  // One place redacted individually too, which matches the entity anyway: still listed, since a person set it.
  stephen.places[3] = { ...stephen.places[3], reason: "Redacted individually by DJ", individually: { decision: "redact", by: "DJ", at: at(60) } };

  const named: ReportCandidate[] = [
    candidate({
      type: "person",
      label: "John A. Smith",
      role: "Defendant",
      state: "flagged",
      mentions: 27,
      locations: [
        { document: DOCS[0].filename, pages: [1, 2, 3] },
        { document: DOCS[5].filename, pages: [1] },
      ],
    }),
    stephen,
    candidate({
      type: "person",
      label: "Marcus Whitfield",
      role: "Assistant State’s Attorney (prosecutor)",
      state: "kept",
      decidedAt: at(76),
      exceptions: 2,
      locations: [
        { document: DOCS[0].filename, pages: [1, 3] },
        { document: DOCS[1].filename, pages: [2] },
        { document: DOCS[2].filename, pages: [1, 12] },
      ],
      places: marcusPlaces(),
      history: [
        event({ at: at(0), actor: "system", summary: `System flagged person "Marcus Whitfield" for redaction (9 mentions in 3 documents)`, toState: "flagged" }),
        event({ at: at(76), actor: "DJ", action: "entity.kept", summary: `Kept person "Marcus Whitfield" (left visible)`, toState: "kept" }),
        event({ at: at(78), actor: "Priya Raman", action: "mention.redact", summary: `Redacted 2 mentions ("Marcus Whitfield") on pp.3, 12 individually`, toState: "redacted", count: 2 }),
        event({ at: at(80), actor: "DJ", action: "mention.keep", summary: `Kept one mention "Marcus Whitfield" (Marcus Whitfield, p.12) (was redacted individually by Priya Raman)`, toState: "kept" }),
        event({ at: at(95), actor: "Priya Raman", action: "mention.redact", summary: `Redacted one mention "Marcus Whitfield" (Marcus Whitfield, p.12) (was kept individually by DJ)`, toState: "redacted" }),
      ],
    }),
    candidate({
      type: "person",
      label: "José Peña",
      role: "Parent — “guardian” • pediatric intake…",
      state: "kept",
      decidedBy: "Priya Raman",
      decidedAt: at(81),
      mentions: 4,
      createdBy: "Priya Raman",
      locations: [{ document: DOCS[4].filename, pages: [1, 2] }],
    }),
    candidate({
      type: "person",
      label: "Smith’s associate “Red” → unknown 😀",
      state: "redacted",
      decidedAt: at(90),
      mentions: 3,
      locations: [{ document: DOCS[1].filename, pages: [3, 4] }],
    }),
    candidate({
      type: "org",
      label: "Acme Logistics, LLC",
      role: "Employer",
      state: "flagged",
      mentions: 11,
      locations: [{ document: DOCS[3].filename, pages: [1, 2, 3, 4, 5, 6] }],
    }),
    candidate({
      type: "address",
      label: "1418 Elm Street, Baltimore, MD 21201",
      role: "Defendant’s residence",
      state: "flagged",
      mentions: 6,
      locations: [
        { document: DOCS[0].filename, pages: [1] },
        { document: DOCS[1].filename, pages: [1, 2] },
        { document: DOCS[3].filename, pages: [2] },
      ],
    }),
    candidate({
      type: "ssn",
      label: "SSN ending 6789",
      role: "John A. Smith",
      state: "flagged",
      mentions: 2,
      locations: [{ document: DOCS[3].filename, pages: [1, 4] }],
    }),
  ];

  const generated: ReportCandidate[] = Array.from({ length: 150 }, (_, i) => {
    const n = i + 1;
    const state: CandidateState = n % 15 === 0 ? "kept" : n % 7 === 0 ? "redacted" : "flagged";
    const docCount = 1 + (n % 3);
    return candidate({
      type: TYPE_ORDER[n % 3],
      label: `Witness ${String(n).padStart(3, "0")}`,
      role: n % 4 === 0 ? "Bystander named in the incident narrative" : null,
      state,
      decidedBy: state === "flagged" ? null : n % 2 ? "DJ" : "Priya Raman",
      decidedAt: state === "flagged" ? null : at(100 + n),
      mentions: 1 + (n % 9),
      exceptions: n % 31 === 0 ? 1 : 0,
      locations: Array.from({ length: docCount }, (_, d) => ({
        document: DOCS[(n + d) % DOCS.length].filename,
        pages: [1, 2, 4, 5, 6].slice(0, 1 + ((n + d) % 5)),
      })),
    });
  });

  const candidates = [...named, ...generated].sort(
    (a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || b.mentions - a.mentions,
  );

  const unassigned: ReportPlace[] = [
    place({ document: DOCS[1].filename, page: 2, text: "the driver’s brother", before: "…statement given by", after: "who was present", outcome: "redacted", reason: "Not tied to an entity: redacted to be safe" }),
    place({
      document: DOCS[5].filename,
      page: 1,
      text: "Officer Daley",
      before: "…was interviewed by",
      after: "at the scene",
      outcome: "visible",
      reason: "Kept individually by DJ",
      individually: { decision: "keep", by: "DJ", at: at(120) },
    }),
  ];

  const retired: ReportData["retired"] = [
    {
      label: "Steve Smith",
      type: "person",
      reason: "A re-run of detection no longer found it",
      history: [
        event({ at: at(0), actor: "system", summary: `System flagged person "Steve Smith" for redaction (3 mentions in 1 document)`, toState: "flagged" }),
        event({ at: at(40), actor: "Priya Raman", action: "entity.kept", summary: `Kept person "Steve Smith" (left visible)`, toState: "kept" }),
        event({ at: at(200), actor: "system", action: "entity.dropped", summary: `Re-run no longer finds person "Steve Smith"`, toState: null }),
      ],
    },
  ];

  const events: ReportData["events"] = Array.from({ length: 300 }, (_, i) => {
    const n = String(i + 1).padStart(3, "0");
    const summaries = [
      `E${n} Processed ${DOCS[i % DOCS.length].filename}: found 12 candidates, 41 mentions`,
      `E${n} Kept a person → visible in 3 documents`,
      `E${n} Redacted a candidate everywhere it appears`,
      `E${n} Changed one mention back to the system default after reviewing the surrounding paragraph on page 4, because the name refers to a public official acting in their official capacity`,
    ];
    return { at: at(i), actor: i % 5 === 0 ? "System" : i % 2 ? "DJ" : "Priya Raman", summary: summaries[i % summaries.length] };
  });

  const count = (state: CandidateState) => candidates.filter((c) => c.state === state).length;
  return {
    batch: { name: BATCH, createdAt: at(-60), documents: DOCS },
    generatedAt: at(320),
    generatedBy: "DJ",
    totals: {
      candidates: candidates.length,
      byType: Object.fromEntries(TYPE_ORDER.map((t) => [t, candidates.filter((c) => c.type === t).length])) as Record<EntityType, number>,
      flagged: count("flagged"),
      redacted: count("redacted"),
      kept: count("kept"),
      mentions: candidates.reduce((s, c) => s + c.mentions, 0) + unassigned.length,
      mentionsRedacted: candidates.reduce((s, c) => s + c.mentionsRedacted, 0) + unassigned.filter((p) => p.outcome === "redacted").length,
    },
    candidates,
    unassigned,
    retired,
    events,
  };
}

/** Plain text of every page, via MuPDF. */
function pageTexts(bytes: Uint8Array): string[] {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    return Array.from({ length: doc.countPages() }, (_, i) => {
      const page = doc.loadPage(i);
      const stext = page.toStructuredText("preserve-whitespace");
      const text = stext.asText();
      stext.destroy();
      page.destroy();
      return text;
    });
  } finally {
    doc.destroy();
  }
}

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;
/** Collapses line breaks so assertions don't depend on where a cell wraps. */
const flat = (s: string) => s.replace(/\s+/g, " ");

const SECTIONS = [
  "You kept",
  "You redacted",
  "System flagged (redacted by default)",
  "Entity histories",
  "No longer in the results",
  "Not tied to an entity",
  "Audit trail",
];

/** The flattened body after the summary note, cut into the sections above (in order). */
function sections(all: string) {
  const text = flat(all);
  const body = text.slice(text.indexOf("not individually reviewed."));
  const starts = SECTIONS.map((s) => body.indexOf(s));
  const get = (name: string) => {
    const i = SECTIONS.indexOf(name);
    return body.slice(starts[i], starts[i + 1] ?? body.length);
  };
  return { body, starts, get };
}

/** Candidates in the order the entity histories list them: kept, redacted, flagged, each in report order. */
const historyOrder = (data: ReportData) => STATE_ORDER.flatMap((s) => data.candidates.filter((c) => c.state === s));

/** One entity's part of the entity histories: from its name to the next entity's name. */
function entityBlock(histories: string, data: ReportData, label: string) {
  const order = historyOrder(data);
  const i = order.findIndex((c) => c.label === label);
  const start = histories.indexOf(sanitizeText(label));
  const next = order[i + 1] ? histories.indexOf(sanitizeText(order[i + 1].label), start + 1) : -1;
  return histories.slice(start, next > start ? next : undefined);
}

describe("renderReportPdf", () => {
  it("renders a multi-page report with header, footer, summary, and sections in order", async () => {
    const bytes = await renderReportPdf(sampleReport(), { timeZone: TZ });
    const pages = pageTexts(bytes);
    const all = pages.join("\n");

    expect(pages.length).toBeGreaterThan(1);
    pages.forEach((text, i) => {
      expect(text).toContain(`Redaction report — ${BATCH}`);
      expect(text).toContain("INTERNAL — contains the redacted information. Do not share with the redacted documents.");
      expect(text).toContain(`Page ${i + 1} of ${pages.length}`);
      expect(text).toContain("Generated Oct 30, 2026 6:20 PM EDT");
    });

    // Summary on page 1.
    expect(pages[0]).toContain("Page 1 of");
    expect(pages[0]).toContain("Oct 30, 2026 6:20 PM EDT by DJ");
    expect(pages[0]).toContain("08-witness-statement-may-chen.pdf");
    expect(pages[0]).toContain("158 total");
    expect(pages[0]).toContain("Everything the system finds is redacted by default.");
    expect(pages[0]).toMatch(/You kept\s+12/);
    expect(flat(pages[0])).toContain("1 entity is visible in some places and redacted in others.");
    expect(flat(pages[0])).toContain("2 places aren’t tied to an entity.");

    // Sections, after the summary note, in the order a supervisor needs them.
    const { starts, get } = sections(all);
    expect(starts.every((i) => i > 0)).toBe(true);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);

    // Rows land in their own sections, with reviewer and time for decisions.
    const kept = get("You kept");
    const redacted = get("You redacted");
    const flagged = get("System flagged (redacted by default)");
    expect(kept).toContain("Marcus Whitfield");
    expect(kept).toContain("Assistant State’s Attorney (prosecutor)");
    expect(kept).toContain("9 (2 redacted)");
    expect(kept).toContain("· 2 set individually");
    expect(kept).toContain("Oct 30, 2026 2:16 PM");
    expect(redacted).toContain("Stephen M. Smith");
    expect(redacted).toContain("03-deposition-steve-smith.pdf p.1–5, 7–8, 11");
    expect(redacted).toContain("Oct 30, 2026 2:14 PM");
    expect(flagged).toContain("John A. Smith");
    expect(flagged).toContain("27 (27 redacted)");
    expect(flagged).toContain("SSN ending 6789");
    expect(flagged).not.toContain("Marcus Whitfield");
  });

  it("splits a mixed candidate's Where into visible and redacted places in its state table", async () => {
    const { get } = sections(pageTexts(await renderReportPdf(sampleReport(), { timeZone: TZ })).join("\n"));
    const kept = get("You kept");
    const row = kept.slice(kept.indexOf("Marcus Whitfield"));
    expect(row).toContain("· Mixed outcome");
    const visible = row.indexOf("Visible (7):");
    const redacted = row.indexOf("Redacted (2):");
    expect(visible).toBeGreaterThan(0);
    expect(redacted).toBeGreaterThan(visible);
    expect(row.slice(visible, redacted)).toContain("01-charging-document.pdf p.1, 3");
    expect(row.slice(visible, redacted)).toContain("02-police-incident-report.pdf p.2");
    expect(row.slice(redacted, redacted + 120)).toContain("01-charging-document.pdf p.3");
    expect(row.slice(redacted, redacted + 120)).toContain("03-deposition-steve-smith.pdf p.12");
    // Only the mixed one gets the split.
    expect(occurrences(kept, "Mixed outcome")).toBe(1);
  });

  it("gives every entity its latest status, history, and places, in the same order as the state sections", async () => {
    const data = sampleReport();
    const all = pageTexts(await renderReportPdf(data, { timeZone: TZ })).join("\n");
    const histories = sections(all).get("Entity histories");

    let cursor = 0;
    for (const c of historyOrder(data)) {
      const i = histories.indexOf(sanitizeText(c.label), cursor);
      expect(i, c.label).toBeGreaterThan(cursor - 1);
      cursor = i + 1;
    }
    expect(histories).toMatch(/You kept 12 entities/);
    expect(histories).toMatch(/System flagged \(redacted by default\) \d+ entities/);

    // An untouched system find: short form, but still status, history, and every document.
    const john = entityBlock(histories, data, "John A. Smith");
    expect(john).toContain("System flagged");
    expect(john).toContain("Person · Defendant · redacted by default, not reviewed");
    expect(john).toContain(`HISTORY Oct 30, 2026 1:00:00 PM · System · System flagged person "John A. Smith" for redaction (27 mentions in 2 documents)`);
    expect(john).toContain("WHERE All 27 redacted 01-charging-document.pdf p.1–3 08-witness-statement-may-chen.pdf p.1");
    expect(john).not.toMatch(/WHEN WHO WHAT/);

    // A reviewer's decision with nothing unusual: still short, with who decided it and when.
    const jose = entityBlock(histories, data, "José Peña");
    expect(jose).toContain("Parent — “guardian” • pediatric intake… · added by Priya Raman");
    expect(jose).toContain("Latest: kept (left visible) by Priya Raman · Oct 30, 2026 2:21 PM");
    expect(jose).toContain(`HISTORY Oct 30, 2026 1:00:00 PM · System · System flagged person "José Peña"`);
    expect(jose).toContain(`Oct 30, 2026 2:21:00 PM · Priya Raman · Kept person "José Peña" (left visible)`);
    expect(jose).toContain("WHERE All 4 visible 06-pediatric-intake-es.pdf p.1–2");
    expect(jose).not.toMatch(/WHEN WHO WHAT/);

    // A long history gets the full table.
    expect(entityBlock(histories, data, "Stephen M. Smith")).toMatch(/HISTORY WHEN WHO WHAT/);
  });

  it("lists every place of a mixed entity under its outcome, with context and who set it", async () => {
    const data = sampleReport();
    const all = pageTexts(await renderReportPdf(data, { timeZone: TZ })).join("\n");
    const marcus = entityBlock(sections(all).get("Entity histories"), data, "Marcus Whitfield");

    expect(marcus).toContain("Latest: kept (left visible) by DJ · Oct 30, 2026 2:16 PM");
    // History, oldest first, including the bulk action and the back-and-forth on p.12.
    const history = [
      `System flagged person "Marcus Whitfield" for redaction`,
      `Kept person "Marcus Whitfield" (left visible)`,
      `Redacted 2 mentions ("Marcus Whitfield") on pp.3, 12 individually`,
      `(was redacted individually by Priya Raman)`,
      `(was kept individually by DJ)`,
    ].map((s) => marcus.indexOf(s));
    expect(history.every((i) => i > 0)).toBe(true);
    expect([...history].sort((a, b) => a - b)).toEqual(history);

    expect(marcus).toContain("Mixed: 7 visible, 2 redacted. Every place is listed under its outcome.");
    const v = marcus.indexOf("Visible (7)");
    const r = marcus.indexOf("Redacted (2)");
    expect(v).toBeGreaterThan(0);
    expect(r).toBeGreaterThan(v);
    const visible = marcus.slice(v, r);
    const redacted = marcus.slice(r);
    expect(visible).toMatch(/DOCUMENT PAGE TEXT IN CONTEXT WHY/);
    expect(occurrences(visible, "Follows the entity: kept by DJ")).toBe(7);
    expect(visible).toContain("…the State calls Marcus Whitfield to the stand and");
    expect(visible).toContain("Matched to this entity by DJ · Oct 30, 2026 2:17 PM");
    expect(redacted).toContain("…the personal cell phone of Marcus Whitfield (410) 555-0182, per the");
    expect(occurrences(redacted, "Redacted individually by Priya Raman")).toBe(2);
    expect(redacted).toContain("Oct 30, 2026 2:18 PM"); // p.3, set at 2:18
    expect(redacted).toContain("This place’s history:");
    expect(redacted).toContain("Oct 30, 2026 2:18 PM · Priya Raman: redacted it individually");
    expect(redacted).toContain("Oct 30, 2026 2:20 PM · DJ: kept it visible individually");
    // No stray space before punctuation that follows the name.
    expect(visible).toContain("BY MR. Marcus Whitfield: Nothing further.");
  });

  it("lists places a person set individually even when the entity isn't mixed", async () => {
    const data = sampleReport();
    const all = pageTexts(await renderReportPdf(data, { timeZone: TZ })).join("\n");
    const stephen = entityBlock(sections(all).get("Entity histories"), data, "Stephen M. Smith");
    expect(stephen).toContain("WHERE IT APPEARS All 14 redacted 03-deposition-steve-smith.pdf p.1–5, 7–8, 11");
    expect(stephen).toContain("Decided individually or not following the entity (1)");
    expect(stephen).toMatch(/DOCUMENT PAGE TEXT IN CONTEXT OUTCOME AND WHY/);
    expect(stephen).toContain("Redacted Redacted individually by DJ Oct 30, 2026 2:00 PM");
    expect(stephen).not.toContain("Mixed");
  });

  it("runs a long entity history across pages, in order, with its header repeated", async () => {
    const data = sampleReport();
    const pages = pageTexts(await renderReportPdf(data, { timeZone: TZ }));
    const stephen = entityBlock(sections(pages.join("\n")).get("Entity histories"), data, "Stephen M. Smith");
    const steps = Array.from({ length: 80 }, (_, i) => stephen.indexOf(`H${String(i + 1).padStart(2, "0")} `));
    expect(steps.every((i) => i > 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(stephen.indexOf("— final")).toBeGreaterThan(steps[79]);

    const continued = pages.filter((p) => p.includes("Stephen M. Smith: history, continued"));
    expect(continued.length).toBeGreaterThan(0);
    for (const p of continued) expect(p).toMatch(/WHEN\s+WHO\s+WHAT/);
  });

  it("keeps entities that left the results and places not tied to an entity", async () => {
    const { get } = sections(pageTexts(await renderReportPdf(sampleReport(), { timeZone: TZ })).join("\n"));
    const retired = get("No longer in the results");
    expect(retired).toContain("Steve Smith Removed Person · A re-run of detection no longer found it");
    expect(retired).toMatch(/HISTORY WHEN WHO WHAT/);
    expect(retired).toContain(`Priya Raman Kept person "Steve Smith" (left visible)`);
    expect(retired).toContain(`Re-run no longer finds person "Steve Smith"`);

    const unassigned = get("Not tied to an entity");
    expect(unassigned).toContain("2 places · 1 visible");
    expect(unassigned).toMatch(/DOCUMENT PAGE TEXT IN CONTEXT OUTCOME AND WHY/);
    expect(unassigned).toContain("…statement given by the driver’s brother who was present Redacted Not tied to an entity: redacted to be safe");
    expect(unassigned).toContain("Visible Kept individually by DJ Oct 30, 2026 3:00 PM");
  });

  it("paginates long tables without losing rows and repeats the header row", async () => {
    const data = sampleReport();
    const pages = pageTexts(await renderReportPdf(data, { timeZone: TZ }));
    const all = pages.join("\n");
    const stateSections = all.slice(0, all.indexOf("Entity histories"));

    for (const c of data.candidates.filter((c) => c.label.startsWith("Witness "))) {
      expect(occurrences(stateSections, c.label), c.label).toBe(1);
    }
    for (let i = 1; i <= 300; i++) {
      const id = `E${String(i).padStart(3, "0")} `;
      expect(occurrences(all, id), id).toBe(1);
    }

    const flaggedContinued = pages.filter((p) => p.includes("System flagged (redacted by default), continued"));
    expect(flaggedContinued.length).toBeGreaterThan(0);
    for (const p of flaggedContinued) expect(p).toMatch(/TYPE\s+NAME\s+MENTIONS\s+WHERE\s+DECIDED/);

    const auditContinued = pages.filter((p) => p.includes("Audit trail, continued"));
    expect(auditContinued.length).toBeGreaterThan(1);
    for (const p of auditContinued) expect(p).toMatch(/WHEN\s+ACTOR\s+EVENT/);

    if (process.env.REPORT_PDF_PREVIEW_DIR) await writePreviews(process.env.REPORT_PDF_PREVIEW_DIR, data, pages);
  });

  it("sanitizes unicode in names, roles, and events", async () => {
    const all = flat(pageTexts(await renderReportPdf(sampleReport(), { timeZone: TZ })).join("\n"));
    expect(all).toContain("José Peña");
    expect(all).toContain("Parent — “guardian” • pediatric intake…");
    expect(all).toContain("Smith’s associate “Red” -> unknown");
    expect(all).toContain("Kept a person -> visible in 3 documents");
    expect(all).not.toContain("😀");
  });

  it("renders an empty batch and survives malformed input", async () => {
    const empty = await renderReportPdf({
      batch: { name: "", createdAt: "not a date", documents: [] },
      generatedAt: "",
      generatedBy: "",
      totals: { candidates: 0, byType: { person: 0, org: 0, address: 0, ssn: 0 }, flagged: 0, redacted: 0, kept: 0, mentions: 0, mentionsRedacted: 0 },
      candidates: [],
      unassigned: [],
      retired: [],
      events: [],
    });
    const [page, ...rest] = pageTexts(empty);
    expect(rest).toHaveLength(0);
    expect(page).toContain("Untitled batch");
    expect(occurrences(page, "None.")).toBe(3);
    expect(page).not.toContain("Entity histories");
    expect(page).not.toContain("No longer in the results");
    expect(page).not.toContain("Not tied to an entity");
    expect(page).toContain("No events recorded.");
    expect(page).toContain("Page 1 of 1");

    const malformed = {
      batch: { name: "Odd\u0000 batch​\ud800", createdAt: null, documents: [null, { filename: 42, pages: "x" }] },
      generatedAt: "garbage",
      generatedBy: undefined,
      totals: {},
      candidates: [
        null,
        {
          type: "phone",
          label: undefined,
          role: 7,
          state: "maybe",
          mentions: Number.NaN,
          locations: [{ document: null, pages: [0, -1, 2.5, 3] }],
        },
        {
          type: "person",
          label: "Garbage\u0000 places\ud800",
          state: "kept",
          createdBy: { not: "a string" },
          decidedAt: "never",
          history: [null, { at: "nope", actor: 5, summary: "\u0007bell" }, {}, { at: 12, actor: "system", summary: null, action: "entity.flagged" }],
          places: [
            null,
            { outcome: "maybe", page: "x", text: null, before: 5, after: {}, reason: undefined, individually: { at: "bad", by: 7 }, history: [null, { at: "nope" }, {}] },
            { outcome: "visible", page: 2, document: "doc\u0000.pdf", text: "Visible\ud800 one", before: "😀".repeat(500), after: "x".repeat(2000), individually: "yes" },
          ],
          locations: "nope",
        },
        { type: "org", label: "Places not an array", state: "redacted", places: 42, history: "nope", locations: [{ document: "a.pdf", pages: [1] }] },
      ],
      unassigned: [null, { page: -1, outcome: 3, history: "x", assignedBy: [], individually: null }],
      retired: [null, { label: undefined, type: "alien", reason: 9, history: [{ at: 12 }, null] }, { label: "No history", history: null }],
      events: [{ at: "nope", actor: null, summary: "\u0007bell" }],
    } as unknown as ReportData;
    const text = flat(pageTexts(await renderReportPdf(malformed, { timeZone: "Not/AZone" })).join("\n"));
    expect(text).toContain("Odd batch");
    expect(text).toContain("Phone");
    expect(text).toContain("p.3");
    expect(text).toContain("Garbage places");
    expect(text).toContain("Mixed: 1 visible, 1 redacted");
    expect(text).toContain("Visible one");
    expect(text).toContain("Places not an array");
    expect(text).toContain("No longer in the results");
    expect(text).toContain("Alien");
    expect(text).toContain("No history");
    expect(text).toContain("Not tied to an entity");
  });

  it("splits a row taller than a page and breaks long unbroken tokens", async () => {
    const data = sampleReport();
    const giant = candidate({
      type: "person",
      label: `Unbroken${"x".repeat(400)}`,
      state: "kept",
      locations: Array.from({ length: 160 }, (_, i) => ({ document: `exhibit-${String(i + 1).padStart(3, "0")}-very-long-file-name-without-spaces.pdf`, pages: [1, 2, 3, 9] })),
    });
    // A mixed entity whose one place has runaway text, and a history line longer than a page.
    giant.places[0] = { ...giant.places[0], outcome: "redacted", text: `Y${"y".repeat(3000)}`, before: "b".repeat(5000), after: "word ".repeat(2000), reason: "Redacted individually by DJ" };
    giant.history.push(event({ at: at(500), actor: "DJ", summary: `Giant ${"lorem ipsum dolor sit amet ".repeat(260)}end-of-giant` }));
    data.candidates = [giant, ...data.candidates.slice(0, 3)];
    const pages = pageTexts(await renderReportPdf(data, { timeZone: TZ }));
    const all = pages.join("\n");
    expect(all).toContain("exhibit-001-");
    expect(all).toContain("exhibit-160-");
    expect(all).toContain("end-of-giant");
    expect(pages.filter((p) => p.includes("You kept, continued")).length).toBeGreaterThan(1);
    // The giant's history row is taller than a page: it splits, and the table continues with its header.
    const continued = pages.filter((p) => /^Unbrokenx+…: history, continued$/m.test(p));
    expect(continued.length).toBeGreaterThan(0);
    for (const p of continued) expect(p).toMatch(/WHEN\s+WHO\s+WHAT/);
  });
});

describe("sanitizeText", () => {
  it("keeps WinAnsi characters and maps or drops the rest", () => {
    expect(sanitizeText("José Peña, Ñandú, Müller, façade")).toBe("José Peña, Ñandú, Müller, façade");
    expect(sanitizeText("Smith’s — “quoted” • a–b …")).toBe("Smith’s — “quoted” • a–b …");
    expect(sanitizeText("A → B ← C ≥ 2 − 1")).toBe("A -> B <- C >= 2 - 1");
    expect(sanitizeText("non breaking spaces\tand\nlines")).toBe("non breaking spaces and lines");
    expect(sanitizeText("zero​width﻿")).toBe("zerowidth");
    expect(sanitizeText("Ślęzak Łukasz ő")).toBe("Slezak ukasz o");
    expect(sanitizeText("ﬁle №5 😀 ✓")).toBe("file No.5 x");
    expect(sanitizeText("é")).toBe("é");
    expect(sanitizeText(null)).toBe("");
    expect(sanitizeText(undefined)).toBe("");
    expect(sanitizeText(12)).toBe("12");
  });

  it("only ever produces text Helvetica can encode", async () => {
    const doc = await PDFDocument.create();
    const fonts = await Promise.all([StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique].map((f) => doc.embedFont(f)));
    let everything = "";
    for (let cp = 0; cp < 0x3000; cp++) everything += String.fromCodePoint(cp);
    everything += "😀👩‍⚖️𐏿\udfff\ud800￿\u{1d400}";
    const out = sanitizeText(everything);
    for (const font of fonts) {
      expect(() => font.encodeText(out)).not.toThrow();
      expect(() => font.widthOfTextAtSize(out, 10)).not.toThrow();
    }
  });
});

describe("formatPageRanges", () => {
  it("compresses page lists into ranges", () => {
    expect(formatPageRanges([1, 2, 3])).toBe("p.1–3");
    expect(formatPageRanges([1])).toBe("p.1");
    expect(formatPageRanges([8, 1, 2, 3, 5, 7, 3])).toBe("p.1–3, 5, 7–8");
    expect(formatPageRanges([])).toBe("");
    expect(formatPageRanges([0, -2, 1.5])).toBe("");
  });
});

/**
 * REPORT_PDF_PREVIEW_DIR=/some/dir pnpm vitest run src/lib/report-pdf.test.ts writes the sample PDF and
 * a PNG of each page worth eyeballing.
 */
async function writePreviews(dir: string, data: ReportData, pages: string[]) {
  const bytes = await renderReportPdf(data, { timeZone: TZ });
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "sample-report.pdf"), bytes);
  const find = (needle: string) => pages.findIndex((p) => flat(p).includes(needle)) + 1;
  const shots: [string, number][] = [
    ["page-1", 1],
    ["kept-mixed-row", find("Mixed outcome")],
    ["continuation", find("System flagged (redacted by default), continued")],
    ["entity-histories", find("Entity histories")],
    ["mixed-entity", find("Visible (7)")],
    ["long-history", find("Stephen M. Smith: history, continued")],
    ["compact-entities", find(`"Witness 001" for redaction`)],
    ["retired", find("No longer in the results")],
    ["unassigned", find("Not tied to an entity")],
    ["audit-continuation", find("Audit trail, continued")],
  ];
  for (const [name, n] of shots) {
    if (n > 0) await writeFile(path.join(dir, `report-${name}.png`), renderPagePng(bytes, n, 2));
  }
}
