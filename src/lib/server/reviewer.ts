import { cookies } from "next/headers";

export const REVIEWER_COOKIE = "reviewer";

/** The reviewer's name, set on the review screen. Every decision in the audit log carries it. */
export async function currentReviewer(): Promise<string | null> {
  const value = (await cookies()).get(REVIEWER_COOKIE)?.value;
  return value ? decodeURIComponent(value).trim() || null : null;
}

export function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
