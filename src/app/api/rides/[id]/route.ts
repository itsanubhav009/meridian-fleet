import { getDb } from "@/server/db/client";
import { json, route } from "@/server/http/handler";
import { requireSession } from "@/server/http/session";
import { parseUuid } from "@/server/http/validation";
import { getRide } from "@/server/services/rideService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/rides/:id  ->  200 { ride } including its full status history.
 * Returns 404 (not 403) for a ride belonging to someone else, so the API never
 * confirms that another user's booking ID exists.
 */
export const GET = route<{ id: string }>(async (request, { params }) => {
  const session = await requireSession(request);
  const { id } = await params;
  const db = await getDb();
  return json({ ride: await getRide(db, session, parseUuid(id, "booking reference")) });
});
