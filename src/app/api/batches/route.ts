import { after } from "next/server";
import { createBatch, processBatch } from "@/lib/process";
import { listBatches } from "@/lib/review";
import { jsonError } from "@/lib/server/reviewer";

export async function GET() {
  return Response.json(await listBatches());
}

/** Upload PDFs as multipart form data (`files`, optional `name`). Processing continues in the background. */
export async function POST(request: Request) {
  const form = await request.formData();
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return jsonError("Add at least one PDF");
  const notPdf = files.find((f) => !f.name.toLowerCase().endsWith(".pdf"));
  if (notPdf) return jsonError(`${notPdf.name} isn't a PDF`);
  const name = String(form.get("name") ?? "").trim() || files[0].name.replace(/\.pdf$/i, "");
  const batch = await createBatch(
    name,
    await Promise.all(files.map(async (f) => ({ filename: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))),
  );
  after(() => processBatch(batch.id));
  return Response.json({ id: batch.id }, { status: 201 });
}
