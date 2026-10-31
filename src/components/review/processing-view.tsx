"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { LiveProgress } from "@/components/intake/live-progress";

/** Shown at /batches/[id] while the batch is still processing; swaps to the review screen when done. */
export function ProcessingView({ batchId }: { batchId: string }) {
  const router = useRouter();
  const onFinished = useCallback(() => router.refresh(), [router]);
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 px-6 py-10">
      <Link href="/" className="text-sm text-muted hover:text-foreground">
        ← All batches
      </Link>
      <LiveProgress batchId={batchId} onFinished={onFinished} />
    </main>
  );
}
