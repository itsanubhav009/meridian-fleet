import { getDb } from "@/server/db/client";
import { json, route } from "@/server/http/handler";
import { requireSession } from "@/server/http/session";
import { parseBody, parseUuid } from "@/server/http/validation";
import { updateStatusSchema } from "@/lib/schemas";
import { updateStatus } from "@/server/services/rideService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/rides/:id/status
 * Body: { status, expectedStatus?, note? }
 *
 * The state machine in src/domain/rideStatus.ts decides whether the move
 * is legal and whether this caller may make it. Sending `expectedStatus` turns
 * the update into a compare-and-set, so a stale tab cannot overwrite newer state.
 */
export const PATCH = route<{ id: string }>(async (request, { params }) => {
  const session = await requireSession(request);
  const { id } = await params;
  const body = await parseBody(request, updateStatusSchema);
  const db = await getDb();
  return json({
    ride: await updateStatus(db, session, parseUuid(id, "ride reference"), body),
  });
});
