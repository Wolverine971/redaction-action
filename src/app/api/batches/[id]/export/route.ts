import { buildExport } from "@/lib/export";
import { safeTimeZone } from "@/lib/report";
import { ReviewError } from "@/lib/review";
import { currentReviewer, isUuid, jsonError } from "@/lib/server/reviewer";

export const maxDuration = 300;

export async function GET(req: Request, ctx: RouteContext<"/api/batches/[id]/export">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return jsonError("Not found", 404);
  const actor = await currentReviewer();
  if (!actor) return jsonError("Enter your name before exporting — exports are logged", 401);
  try {
    const tz = safeTimeZone(new URL(req.url).searchParams.get("tz"));
    const { zip, filename } = await buildExport(id, actor, tz);
    return new Response(Buffer.from(zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof ReviewError) return jsonError(error.message);
    return jsonError((error as Error).message, 500);
  }
}
