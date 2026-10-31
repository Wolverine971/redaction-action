import * as mupdf from "mupdf";
import type { Rect } from "@/db/schema";

export interface PageRedactions {
  page: number;
  rects: Rect[];
}

export interface RedactionResult {
  bytes: Uint8Array;
  /** Characters still readable under a redaction box after redacting. Must be empty. */
  leaks: { page: number; rect: Rect; text: string }[];
  boxes: number;
}

/**
 * Burns redactions into the PDF: the text, images and vector art under each box are removed
 * (not just covered), then re-reads the output to prove nothing is left under any box.
 */
export function redactPdf(bytes: Uint8Array, redactions: PageRedactions[]): RedactionResult {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf") as mupdf.PDFDocument;
  let boxes = 0;
  let out: Uint8Array;
  try {
    for (const { page: pageNumber, rects } of redactions) {
      if (rects.length === 0) continue;
      const page = doc.loadPage(pageNumber - 1) as mupdf.PDFPage;
      for (const rect of rects) {
        const annot = page.createAnnotation("Redact");
        annot.setRect(rect);
        boxes++;
      }
      page.applyRedactions(
        true,
        mupdf.PDFPage.REDACT_IMAGE_PIXELS,
        mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED,
        mupdf.PDFPage.REDACT_TEXT_REMOVE,
      );
      page.destroy();
    }
    // Drop document metadata (title/author can carry names).
    doc.setMetaData("info:Title", "");
    doc.setMetaData("info:Author", "");
    doc.setMetaData("info:Subject", "");
    doc.setMetaData("info:Keywords", "");
    out = doc.saveToBuffer("garbage=4,compress,clean").asUint8Array().slice();
  } finally {
    doc.destroy();
  }
  return { bytes: out, leaks: findLeaks(out, redactions), boxes };
}

/** Any character whose center falls inside a redaction box is a leak. */
export function findLeaks(bytes: Uint8Array, redactions: PageRedactions[]) {
  const leaks: RedactionResult["leaks"] = [];
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    for (const { page: pageNumber, rects } of redactions) {
      if (rects.length === 0) continue;
      const page = doc.loadPage(pageNumber - 1);
      const stext = page.toStructuredText("preserve-whitespace");
      const found = new Map<number, string>();
      stext.walk({
        onChar(c, _o, _f, _s, quad) {
          if (!c.trim()) return;
          const q = quad as unknown as number[];
          const cx = (q[0] + q[2] + q[4] + q[6]) / 4;
          const cy = (q[1] + q[3] + q[5] + q[7]) / 4;
          rects.forEach((r, i) => {
            if (cx > r[0] && cx < r[2] && cy > r[1] && cy < r[3]) found.set(i, (found.get(i) ?? "") + c);
          });
        },
      });
      for (const [i, text] of found) leaks.push({ page: pageNumber, rect: rects[i], text });
      stext.destroy();
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
  return leaks;
}
