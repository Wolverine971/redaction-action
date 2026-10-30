import { Suspense } from "react";
import { connection } from "next/server";
import { checkDb } from "@/db";

async function DbStatus() {
  await connection();
  const db = await checkDb();

  return (
    <>
      <span className={`inline-block h-2 w-2 rounded-full ${db.ok ? "bg-green-500" : "bg-red-500"}`} />
      {db.ok ? "Database connected" : `Database unreachable: ${db.message}`}
    </>
  );
}

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-4 px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Redaction Action</h1>
      <p className="text-foreground/70">Document ingestion and review.</p>
      <p className="flex items-center gap-2 text-sm">
        <Suspense fallback="Checking database…">
          <DbStatus />
        </Suspense>
      </p>
    </main>
  );
}
