import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { documents } from "@/db/schema";
import { renderPagePng } from "@/lib/pdf/render";
import { isUuid, jsonError } from "@/lib/server/reviewer";

// Rendering is the slow part of flipping pages; keep recent pages in memory.
const cache = new Map<string, Uint8Array>();
const MAX_CACHED = 600;
const docs = new Map<string, { bytes: Uint8Array; pageCount: number }>();

/** A page as PNG. `?w=120` returns a thumbnail that many pixels wide. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/documents/[id]/pages/[page]">) {
  const { id, page } = await ctx.params;
  const n = Number(page);
  if (!isUuid(id) || !Number.isInteger(n) || n < 1) return jsonError("Not found", 404);
  const w = Number(request.nextUrl.searchParams.get("w"));
  const width = w > 0 ? Math.min(1600, Math.max(40, Math.round(w))) : null;
  const key = `${id}:${n}:${width ?? "full"}`;
  let png = cache.get(key);
  if (!png) {
    // The live view requests every page's thumbnail at once; don't refetch the whole PDF for each.
    let doc = docs.get(id);
    if (!doc || n > doc.pageCount) {
      const [row] = await db.select({ bytes: documents.bytes, pageCount: documents.pageCount }).from(documents).where(eq(documents.id, id));
      if (!row) return jsonError("Not found", 404);
      doc = row;
      docs.set(id, row);
      if (docs.size > 8) docs.delete(docs.keys().next().value!);
    }
    if (n > doc.pageCount) return jsonError("Not found", 404);
    png = width ? renderPagePng(doc.bytes, n, { width }) : renderPagePng(doc.bytes, n, 2);
    cache.set(key, png);
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  }
  return new Response(Buffer.from(png), {
    headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600" },
  });
}
