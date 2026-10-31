import { after } from "next/server";
import { db } from "@/db";
import { auditEvents } from "@/db/schema";
import { processBatch } from "@/lib/process";
import { getBatchStatus } from "@/lib/review";
import { currentReviewer, isUuid, jsonError } from "@/lib/server/reviewer";

/** Re-runs detection. This replaces every suggestion and decision, so it's logged. */
export async function POST(_req: Request, ctx: RouteContext<"/api/batches/[id]/reprocess">) {
  const { id } = await ctx.params;
  if (!isUuid(id) || !(await getBatchStatus(id))) return jsonError("Not found", 404);
  const actor = await currentReviewer();
  if (!actor) return jsonError("Enter your name before re-running detection", 401);
  await db.insert(auditEvents).values({ batchId: id, actor, action: "batch.reprocess", summary: "Re-ran detection; earlier decisions were cleared" });
  after(() => processBatch(id));
  return Response.json({ ok: true });
}
