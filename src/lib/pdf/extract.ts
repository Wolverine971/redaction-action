import * as mupdf from "mupdf";
import type { Rect } from "@/db/schema";

export interface ExtractedBlock {
  /** Stable id: `${documentKey}:${page}:${position}`. */
  id: string;
  page: number;
  position: number;
  text: string;
  /** 4 numbers per character of `text`; -1s for synthetic characters (line breaks). */
  boxes: number[];
}

export interface ExtractedPage {
  page: number;
  width: number;
  height: number;
}

export interface ExtractedDocument {
  pages: ExtractedPage[];
  blocks: ExtractedBlock[];
}

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * Reads a digital PDF into paragraph-level blocks with a box for every character.
 * Positions are PDF points with the origin at the page's top-left.
 */
export function extractPdf(bytes: Uint8Array, documentKey: string): ExtractedDocument {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const pages: ExtractedPage[] = [];
  const blocks: ExtractedBlock[] = [];
  try {
    const count = doc.countPages();
    for (let i = 0; i < count; i++) {
      const pageNumber = i + 1;
      const page = doc.loadPage(i);
      const [x0, y0, x1, y1] = page.getBounds();
      pages.push({ page: pageNumber, width: round(x1 - x0), height: round(y1 - y0) });

      let text = "";
      let boxes: number[] = [];
      let position = 0;
      const stext = page.toStructuredText("preserve-whitespace");
      stext.walk({
        beginTextBlock() {
          text = "";
          boxes = [];
        },
        onChar(c, _origin, _font, _size, quad) {
          const q = quad as unknown as number[];
          const xs = [q[0], q[2], q[4], q[6]];
          const ys = [q[1], q[3], q[5], q[7]];
          // A character can be more than one UTF-16 unit; repeat its box per unit so offsets line up.
          for (let k = 0; k < c.length; k++) {
            text += c[k];
            boxes.push(round(Math.min(...xs)), round(Math.min(...ys)), round(Math.max(...xs)), round(Math.max(...ys)));
          }
        },
        endLine() {
          text += "\n";
          boxes.push(-1, -1, -1, -1);
        },
        endTextBlock() {
          const trimmed = text.replace(/\n+$/, "");
          if (trimmed.trim()) {
            blocks.push({
              id: `${documentKey}:${pageNumber}:${position}`,
              page: pageNumber,
              position,
              text: trimmed,
              boxes: boxes.slice(0, trimmed.length * 4),
            });
            position++;
          }
        },
      });
      stext.destroy();
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
  return { pages, blocks };
}

/** Boxes covering text[start, end), merged into one rectangle per line. */
export function rectsForSpan(boxes: number[], start: number, end: number, pad = 1): Rect[] {
  const rects: Rect[] = [];
  let current: Rect | null = null;
  for (let i = start; i < end; i++) {
    const x0 = boxes[i * 4];
    if (x0 === undefined || x0 < 0) {
      if (current) rects.push(current);
      current = null;
      continue;
    }
    const box: Rect = [x0, boxes[i * 4 + 1], boxes[i * 4 + 2], boxes[i * 4 + 3]];
    const sameLine: boolean = !!current && Math.abs(current[1] - box[1]) < 2 && box[0] >= current[0] - 1;
    if (current && sameLine) {
      current = [Math.min(current[0], box[0]), Math.min(current[1], box[1]), Math.max(current[2], box[2]), Math.max(current[3], box[3])];
    } else {
      if (current) rects.push(current);
      current = box;
    }
  }
  if (current) rects.push(current);
  return rects.map(([a, b, c, d]) => [round(a - pad), round(b - pad), round(c + pad), round(d + pad)] as Rect);
}
