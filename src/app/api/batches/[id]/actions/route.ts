import { z } from "zod";
import { applyAction, ReviewError, type ReviewAction } from "@/lib/review";
import { currentReviewer, isUuid, jsonError } from "@/lib/server/reviewer";

const ids = z.array(z.string().uuid()).min(1).max(5000);
const Action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("setEntity"), entityIds: ids, status: z.enum(["pending", "redact", "keep"]) }),
  z.object({ type: z.literal("setMention"), mentionIds: ids, override: z.enum(["redact", "keep"]).nullable() }),
  z.object({ type: z.literal("assign"), mentionIds: ids, entityId: z.string().uuid() }),
  z.object({ type: z.literal("confirmGuess"), mentionIds: ids }),
  z.object({
    type: z.literal("addEntity"),
    entityType: z.enum(["person", "address", "ssn", "org"]),
    label: z.string().max(200),
    query: z.string().max(200),
  }),
  z.object({ type: z.literal("addAlias"), entityId: z.string().uuid(), alias: z.string().min(1).max(200) }),
  z.object({ type: z.literal("merge"), fromEntityId: z.string().uuid(), intoEntityId: z.string().uuid() }),
]);

/** Every reviewer decision goes through here and lands in the audit log with the reviewer's name. */
export async function POST(request: Request, ctx: RouteContext<"/api/batches/[id]/actions">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return jsonError("Not found", 404);
  const actor = await currentReviewer();
  if (!actor) return jsonError("Enter your name before making decisions — every decision is logged", 401);
  const parsed = Action.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid action");
  try {
    return Response.json(await applyAction(id, actor, parsed.data as ReviewAction));
  } catch (error) {
    if (error instanceof ReviewError) return jsonError(error.message);
    throw error;
  }
}
