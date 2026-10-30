import { checkDb } from "@/db";

export async function GET() {
  const db = await checkDb();
  if (db.ok) return Response.json({ status: "ok", db: "up" });
  return Response.json({ status: "error", db: "down", message: db.message }, { status: 503 });
}
