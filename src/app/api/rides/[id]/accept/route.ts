import { getDb } from "@/server/db/client";
import { json, route } from "@/server/http/handler";
import { requireRole } from "@/server/http/session";
import { parseUuid } from "@/server/http/validation";
import { acceptRide } from "@/server/services/rideService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/rides/:id/accept   (drivers only)
 *   200 - the ride is now yours
 *   409 RIDE_ALREADY_ASSIGNED  - another driver got there first
 *   409 DRIVER_HAS_ACTIVE_RIDE - you already have a ride in progress
 *   404 - no such ride
 */
export const POST = route<{ id: string }>(async (request, { params }) => {
  const session = await requireRole(request, "DRIVER");
  const { id } = await params;
  const db = await getDb();
  return json({ ride: await acceptRide(db, session, parseUuid(id, "ride reference")) });
});
