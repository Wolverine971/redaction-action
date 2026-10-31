import { getReview } from "@/lib/review";
import { isUuid, jsonError } from "@/lib/server/reviewer";

export async function GET(_req: Request, ctx: RouteContext<"/api/batches/[id]/review">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return jsonError("Not found", 404);
  const data = await getReview(id);
  return data ? Response.json(data) : jsonError("Not found", 404);
}
