import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local.");
}

// Reuse one connection pool across hot reloads in dev.
const globalForDb = globalThis as unknown as { pgClient?: postgres.Sql };
const client = globalForDb.pgClient ?? postgres(connectionString);
if (process.env.NODE_ENV !== "production") globalForDb.pgClient = client;

export const db = drizzle(client, { schema });

export type DbHealth = { ok: true } | { ok: false; message: string };

export async function checkDb(): Promise<DbHealth> {
  try {
    await db.execute(sql`select 1`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: rootMessage(error) };
  }
}

// Drizzle wraps driver errors; the useful message is on `cause`.
function rootMessage(error: unknown): string {
  const root = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  return root instanceof Error ? root.message : String(root);
}
