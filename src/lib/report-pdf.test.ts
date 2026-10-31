import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as mupdf from "mupdf";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { EntityType } from "@/db/schema";
import { renderPagePng } from "@/lib/pdf/render";
import type { CandidateState, ReportCandidate, ReportData } from "@/lib/report-types";
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

function candidate(c: Partial<ReportCandidate> & Pick<ReportCandidate, "type" | "label" | "state">): ReportCandidate {
  const mentions = c.mentions ?? 1;
  return {
    role: null,
    decidedBy: c.state === "flagged" ? null : "DJ",
    decidedAt: c.state === "flagged" ? null : at(30),
    mentions,
    mentionsRedacted: c.state === "kept" ? 0 : mentions,
    exceptions: 0,
    locations: [{ document: DOCS[0].filename, pages: [1] }],
    ...c,
  };
}

function sampleReport(): ReportData {
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
    candidate({
      type: "person",
      label: "Stephen M. Smith",
      role: "Witness (deponent)",
      state: "redacted",
      decidedAt: at(74),
      mentions: 14,
      locations: [{ document: DOCS[2].filename, pages: [1, 2, 3, 4, 5, 7, 8, 11] }],
    }),
    candidate({
      type: "person",
      label: "Marcus Whitfield",
      role: "Assistant State’s Attorney (prosecutor)",
      state: "kept",
      decidedAt: at(76),
      mentions: 9,
      mentionsRedacted: 2,
      exceptions: 2,
      locations: [
        { document: DOCS[0].filename, pages: [1, 3] },
        { document: DOCS[1].filename, pages: [2] },
        { document: DOCS[2].filename, pages: [1, 12] },
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
      mentions: candidates.reduce((s, c) => s + c.mentions, 0),
      mentionsRedacted: candidates.reduce((s, c) => s + c.mentionsRedacted, 0),
    },
    candidates,
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

    // Sections, after the summary note, in the order a supervisor needs them.
    const body = flat(all).slice(flat(all).indexOf("not individually reviewed."));
    const order = ["You kept", "You redacted", "System flagged (redacted by default)", "Audit trail"].map((s) => body.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    // Rows land in their own sections, with reviewer and time for decisions.
    const kept = body.slice(order[0], order[1]);
    const redacted = body.slice(order[1], order[2]);
    const flagged = body.slice(order[2], order[3]);
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

  it("paginates long tables without losing rows and repeats the header row", async () => {
    const data = sampleReport();
    const pages = pageTexts(await renderReportPdf(data, { timeZone: TZ }));
    const all = pages.join("\n");
    const sections = all.slice(0, all.lastIndexOf("Audit trail"));

    for (const c of data.candidates.filter((c) => c.label.startsWith("Witness "))) {
      expect(occurrences(sections, c.label), c.label).toBe(1);
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
      events: [],
    });
    const [page, ...rest] = pageTexts(empty);
    expect(rest).toHaveLength(0);
    expect(page).toContain("Untitled batch");
    expect(occurrences(page, "None.")).toBe(3);
    expect(page).toContain("No events recorded.");
    expect(page).toContain("Page 1 of 1");

    const malformed = {
      batch: { name: "Odd\u0000 batch\u200b\ud800", createdAt: null, documents: [null, { filename: 42, pages: "x" }] },
      generatedAt: "garbage",
      generatedBy: undefined,
      totals: {},
      candidates: [
        null,
        { type: "phone", label: undefined, role: 7, state: "maybe", mentions: Number.NaN, locations: [{ document: null, pages: [0, -1, 2.5, 3] }] },
      ],
      events: [{ at: "nope", actor: null, summary: "\u0007bell" }],
    } as unknown as ReportData;
    const text = pageTexts(await renderReportPdf(malformed, { timeZone: "Not/AZone" })).join("\n");
    expect(text).toContain("Odd batch");
    expect(text).toContain("Phone");
    expect(text).toContain("p.3");
  });

  it("splits a row taller than a page and breaks long unbroken tokens", async () => {
    const data = sampleReport();
    const giant = candidate({
      type: "person",
      label: `Unbroken${"x".repeat(400)}`,
      state: "kept",
      locations: Array.from({ length: 160 }, (_, i) => ({ document: `exhibit-${String(i + 1).padStart(3, "0")}-very-long-file-name-without-spaces.pdf`, pages: [1, 2, 3, 9] })),
    });
    data.candidates = [giant, ...data.candidates.slice(0, 3)];
    const pages = pageTexts(await renderReportPdf(data, { timeZone: TZ }));
    const all = pages.join("\n");
    expect(all).toContain("exhibit-001-");
    expect(all).toContain("exhibit-160-");
    expect(pages.filter((p) => p.includes("You kept, continued")).length).toBeGreaterThan(1);
  });
});

describe("sanitizeText", () => {
  it("keeps WinAnsi characters and maps or drops the rest", () => {
    expect(sanitizeText("José Peña, Ñandú, Müller, façade")).toBe("José Peña, Ñandú, Müller, façade");
    expect(sanitizeText("Smith’s — “quoted” • a–b …")).toBe("Smith’s — “quoted” • a–b …");
    expect(sanitizeText("A → B ← C ≥ 2 − 1")).toBe("A -> B <- C >= 2 - 1");
    expect(sanitizeText("non\u00a0breaking\u202fspaces\tand\nlines")).toBe("non breaking spaces and lines");
    expect(sanitizeText("zero\u200bwidth\ufeff")).toBe("zerowidth");
    expect(sanitizeText("Ślęzak Łukasz ő")).toBe("Slezak ukasz o");
    expect(sanitizeText("ﬁle №5 😀 ✓")).toBe("file No.5 x");
    expect(sanitizeText("é")).toBe("é");
    expect(sanitizeText(null)).toBe("");
    expect(sanitizeText(undefined)).toBe("");
    expect(sanitizeText(12)).toBe("12");
  });

  it("only ever produces text Helvetica can encode", async () => {
    const doc = await PDFDocument.create();
    const fonts = await Promise.all([StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique].map((f) => doc.embedFont(f)));
    let everything = "";
    for (let cp = 0; cp < 0x3000; cp++) everything += String.fromCodePoint(cp);
    everything += "😀👩\u200d⚖️\ud800\udfff\udfff\ud800\uffff\u{1d400}";
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

/** REPORT_PDF_PREVIEW_DIR=/some/dir pnpm vitest run src/lib/report-pdf.test.ts writes the sample PDF and PNGs. */
async function writePreviews(dir: string, data: ReportData, pages: string[]) {
  const bytes = await renderReportPdf(data, { timeZone: TZ });
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "sample-report.pdf"), bytes);
  const continuation = pages.findIndex((p) => p.includes("System flagged (redacted by default), continued")) + 1;
  const audit = pages.findIndex((p) => p.includes("Audit trail, continued")) + 1;
  for (const [name, n] of [["page-1", 1], ["continuation", continuation], ["audit-continuation", audit]] as const) {
    if (n > 0) await writeFile(path.join(dir, `report-${name}.png`), renderPagePng(bytes, n, 2));
  }
}
