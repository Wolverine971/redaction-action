import { getBatchLive } from "@/lib/review";
import { isUuid, jsonError } from "@/lib/server/reviewer";

export async function GET(_req: Request, ctx: RouteContext<"/api/batches/[id]">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return jsonError("Not found", 404);
  const live = await getBatchLive(id);
  return live ? Response.json(live) : jsonError("Not found", 404);
}
