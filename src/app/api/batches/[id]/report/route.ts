import { db } from "@/db";
import { auditEvents } from "@/db/schema";
import { decisionsCsv, getReport, reportPdf, safeTimeZone } from "@/lib/report";
import { currentReviewer, isUuid, jsonError } from "@/lib/server/reviewer";

/** The redaction report as a PDF (default) or a decisions CSV. It names what was redacted, so downloads are logged. */
export async function GET(req: Request, ctx: RouteContext<"/api/batches/[id]/report">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return jsonError("Not found", 404);
  const actor = await currentReviewer();
  if (!actor) return jsonError("Enter your name before downloading the report — downloads are logged", 401);
  const url = new URL(req.url);
  const format = url.searchParams.get("format") === "csv" ? "csv" : "pdf";
  await db.insert(auditEvents).values({
    batchId: id,
    actor,
    action: "report.download",
    summary: `Downloaded the redaction report (${format.toUpperCase()})`,
  });
  const report = await getReport(id, actor);
  if (!report) return jsonError("Not found", 404);
  const base = report.batch.name.replace(/[^\w.-]+/g, "-");
  const body = format === "csv" ? decisionsCsv(report) : Buffer.from(await reportPdf(report, safeTimeZone(url.searchParams.get("tz"))));
  return new Response(body, {
    headers: {
      "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/pdf",
      "Content-Disposition": `attachment; filename="${base}-${format === "csv" ? "decisions.csv" : "redaction-report.pdf"}"`,
      "Cache-Control": "no-store",
    },
  });
}
