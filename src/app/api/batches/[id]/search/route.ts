import type { NextRequest } from "next/server";
import { searchBatch } from "@/lib/review";
import { isUuid, jsonError } from "@/lib/server/reviewer";

export async function GET(request: NextRequest, ctx: RouteContext<"/api/batches/[id]/search">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return jsonError("Not found", 404);
  const q = request.nextUrl.searchParams.get("q") ?? "";
  return Response.json(await searchBatch(id, q.slice(0, 200)));
}
