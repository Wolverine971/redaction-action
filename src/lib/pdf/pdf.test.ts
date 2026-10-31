import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { extractPdf, rectsForSpan } from "./extract";
import { findLeaks, redactPdf } from "./redact";
import { renderPagePng } from "./render";

async function samplePdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText("Defendant John Smith, SSN 212-45-6789, lives at", { x: 72, y: 700, size: 12, font });
  page.drawText("1418 Elm Street, Baltimore, MD 21201.", { x: 72, y: 685, size: 12, font });
  page.drawText("Witness Steve Smith testified.", { x: 72, y: 640, size: 12, font });
  pdf.setTitle("John Smith case file");
  return pdf.save();
}

describe("PDF round trip", () => {
  it("extracts paragraphs with a box per character", async () => {
    const { pages, blocks } = extractPdf(await samplePdf(), "doc");
    expect(pages).toEqual([{ page: 1, width: 612, height: 792 }]);
    expect(blocks.map((b) => b.text)).toEqual([
      "Defendant John Smith, SSN 212-45-6789, lives at\n1418 Elm Street, Baltimore, MD 21201.",
      "Witness Steve Smith testified.",
    ]);
    for (const b of blocks) expect(b.boxes.length).toBe(b.text.length * 4);
  });

  it("splits a span that wraps onto two lines into two boxes", async () => {
    const { blocks } = extractPdf(await samplePdf(), "doc");
    const text = blocks[0].text;
    const start = text.indexOf("lives at");
    const end = text.indexOf("Street") + "Street".length;
    expect(rectsForSpan(blocks[0].boxes, start, end)).toHaveLength(2);
  });

  it("removes redacted text from the file, not just covers it", async () => {
    const bytes = await samplePdf();
    const { blocks } = extractPdf(bytes, "doc");
    const text = blocks[0].text;
    const span = (s: string) => rectsForSpan(blocks[0].boxes, text.indexOf(s), text.indexOf(s) + s.length);
    const rects = [...span("John Smith"), ...span("212-45-6789")];

    const before = findLeaks(bytes, [{ page: 1, rects }]);
    expect(before.map((l) => l.text)).toEqual(["JohnSmith", "212-45-6789"]);

    const result = redactPdf(bytes, [{ page: 1, rects }]);
    expect(result.leaks).toEqual([]);
    expect(result.boxes).toBe(2);
    const after = extractPdf(result.bytes, "out").blocks.map((b) => b.text).join("\n");
    expect(after).not.toContain("John Smith");
    expect(after).not.toContain("212-45-6789");
    expect(after).toContain("Steve Smith");
    expect(Buffer.from(result.bytes).toString("latin1")).not.toContain("John Smith case file");
  });

  it("renders a page to PNG", async () => {
    const png = renderPagePng(await samplePdf(), 1, 1);
    expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
  });
});
