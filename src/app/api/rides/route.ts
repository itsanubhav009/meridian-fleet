import { getDb } from "@/server/db/client";
import { json, route } from "@/server/http/handler";
import { requireRole, requireSession } from "@/server/http/session";
import { parseBody, parseQuery } from "@/server/http/validation";
import { createRideSchema, rideQuerySchema } from "@/lib/schemas";
import { createRide, listRides } from "@/server/services/rideService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/rides
 * Returns the rides this caller is allowed to see, paginated.
 *   customer -> their own bookings
 *   driver   -> ?scope=available for the open queue, otherwise their own rides
 *   admin    -> everything, filterable by status/driver/customer/date
 */
export const GET = route(async (request) => {
  const session = await requireSession(request);
  const query = parseQuery(request, rideQuerySchema);
  const db = await getDb();
  return json(await listRides(db, session, query));
});

/**
 * POST /api/rides   (customers only)
 * Body: { pickupAddress, destinationAddress, requestedAt, notes?, distanceKm?, ... }
 * Header: Idempotency-Key (optional but recommended) makes a retry safe.
 *   201 - booking created
 *   200 - this Idempotency-Key was already used; the original booking is returned
 */
export const POST = route(async (request) => {
  const session = await requireRole(request, "CUSTOMER");
  const body = await parseBody(request, createRideSchema);
  const idempotencyKey = request.headers.get("idempotency-key")?.slice(0, 100) || null;

  const db = await getDb();
  const { ride, duplicate } = await createRide(db, session, body, idempotencyKey);

  return json({ ride, duplicate }, { status: duplicate ? 200 : 201 });
});
