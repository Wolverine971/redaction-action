import { getEntityHistory } from "@/lib/review";
import { isUuid, jsonError } from "@/lib/server/reviewer";

/** One entity's history, oldest first, including entities merged into it. For the review screen. */
export async function GET(req: Request, ctx: RouteContext<"/api/batches/[id]/history">) {
  const { id } = await ctx.params;
  const entityId = new URL(req.url).searchParams.get("entity") ?? "";
  if (!isUuid(id) || !isUuid(entityId)) return jsonError("Not found", 404);
  return Response.json({ events: await getEntityHistory(id, entityId) }, { headers: { "Cache-Control": "no-store" } });
}
