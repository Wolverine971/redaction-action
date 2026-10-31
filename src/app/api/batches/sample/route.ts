import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { after } from "next/server";
import { createBatch, processBatch } from "@/lib/process";
import { jsonError } from "@/lib/server/reviewer";

/** Creates a batch from the synthetic test corpus in eval/corpus/pdfs. */
export async function POST() {
  const dir = path.join(process.cwd(), "eval", "corpus", "pdfs");
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".pdf")).sort();
  if (names.length === 0) return jsonError("Sample corpus not found. Run: pnpm corpus", 404);
  const batch = await createBatch(
    "State v. Smith (sample corpus)",
    await Promise.all(names.map(async (n) => ({ filename: n, bytes: new Uint8Array(await readFile(path.join(dir, n))) }))),
  );
  after(() => processBatch(batch.id));
  return Response.json({ id: batch.id }, { status: 201 });
}
