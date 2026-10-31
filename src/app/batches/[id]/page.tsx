import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ProcessingView } from "@/components/review/processing-view";
import { ReviewWorkspace } from "@/components/review/workspace";
import { getReview } from "@/lib/review";
import { isUuid } from "@/lib/server/reviewer";

async function Batch({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const data = await getReview(id);
  if (!data) notFound();
  if (data.batch.status !== "ready") {
    return <ProcessingView batchId={id} />;
  }
  return <ReviewWorkspace key={data.batch.id} initial={data} />;
}

export default function BatchPage({ params }: PageProps<"/batches/[id]">) {
  return (
    <Suspense fallback={<p className="p-8 text-sm text-muted">Loading batch…</p>}>
      <Batch params={params} />
    </Suspense>
  );
}
