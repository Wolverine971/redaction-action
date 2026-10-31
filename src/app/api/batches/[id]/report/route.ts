import { db } from "@/db";
import { auditEvents } from "@/db/schema";
import { decisionsCsv, getReport, placesCsv, reportPdf, safeTimeZone } from "@/lib/report";
import { currentReviewer, isUuid, jsonError } from "@/lib/server/reviewer";

/** The redaction report as a PDF (default), a decisions CSV, or a CSV of every place. It names what was redacted, so downloads are logged. */
export async function GET(req: Request, ctx: RouteContext<"/api/batches/[id]/report">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return jsonError("Not found", 404);
  const actor = await currentReviewer();
  if (!actor) return jsonError("Enter your name before downloading the report — downloads are logged", 401);
  const url = new URL(req.url);
  const requested = url.searchParams.get("format");
  const format = requested === "csv" || requested === "places" ? requested : "pdf";
  await db.insert(auditEvents).values({
    batchId: id,
    actor,
    action: "report.download",
    summary: `Downloaded the redaction report (${format === "places" ? "places CSV" : format.toUpperCase()})`,
  });
  const report = await getReport(id, actor);
  if (!report) return jsonError("Not found", 404);
  const base = report.batch.name.replace(/[^\w.-]+/g, "-");
  const body =
    format === "csv" ? decisionsCsv(report) : format === "places" ? placesCsv(report) : Buffer.from(await reportPdf(report, safeTimeZone(url.searchParams.get("tz"))));
  return new Response(body, {
    headers: {
      "Content-Type": format === "pdf" ? "application/pdf" : "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${base}-${format === "csv" ? "decisions.csv" : format === "places" ? "places.csv" : "redaction-report.pdf"}"`,
      "Cache-Control": "no-store",
    },
  });
}
