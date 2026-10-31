import { extractPdf } from "@/lib/pdf/extract";
import { renderPagePng } from "@/lib/pdf/render";
import { findSsns } from "@/lib/detect/patterns";
import { sectionSizes } from "@/lib/detect/sections";
import { DEFAULT_SPEED } from "@/lib/estimate";
import { currentSpeed, defaultDetector } from "@/lib/process";
import { jsonError } from "@/lib/server/reviewer";

/**
 * Instant look at one dropped PDF, before anything is saved: page count, a page-1 thumbnail,
 * SSNs found by pattern, and how long full processing will take. Names come from /api/preview/entities.
 */
export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".pdf")) return jsonError("Send one PDF as `file`");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let extracted;
  try {
    extracted = extractPdf(bytes, "preview");
  } catch {
    return jsonError(`${file.name} couldn't be opened as a PDF`);
  }
  const chars = extracted.blocks.reduce((n, b) => n + b.text.length, 0);
  const ssns = extracted.blocks.flatMap((b) =>
    findSsns(b.text)
      .filter((h) => h.decision === "redact")
      .map((h) => ({ page: b.page, last4: h.digits.slice(-4), kind: h.kind })),
  );
  const first = extracted.pages[0];
  const thumbnail = first ? Buffer.from(renderPagePng(bytes, 1, { width: 160 })).toString("base64") : null;
  const llm = defaultDetector();
  const speed = await currentSpeed(llm?.model ?? null, llm?.concurrency ?? DEFAULT_SPEED.lanes);
  return Response.json({
    filename: file.name,
    pages: extracted.pages.length,
    chars,
    sections: sectionSizes(extracted.blocks.map((b) => b.text.length)),
    hasText: chars > 0,
    thumbnail: thumbnail ? `data:image/png;base64,${thumbnail}` : null,
    firstPageText: extracted.blocks
      .filter((b) => b.page === 1)
      .map((b) => b.text)
      .join("\n\n")
      .slice(0, 12_000),
    ssns,
    speed,
  });
}
