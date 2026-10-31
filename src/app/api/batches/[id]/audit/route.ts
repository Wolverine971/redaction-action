import { auditCsv } from "@/lib/review";
import { isUuid, jsonError } from "@/lib/server/reviewer";

export async function GET(_req: Request, ctx: RouteContext<"/api/batches/[id]/audit">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return jsonError("Not found", 404);
  return new Response(await auditCsv(id), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-log-${id.slice(0, 8)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
