import { getDb } from "@/server/db/client";
import { json, route } from "@/server/http/handler";
import { requireSession } from "@/server/http/session";
import { parseBody, parseUuid } from "@/server/http/validation";
import { cancelRideSchema } from "@/lib/schemas";
import { cancelRide } from "@/server/services/rideService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/rides/:id/cancel   (the booking's customer, or an admin)
 * Body: { reason? }
 * Allowed until the ride starts; a started or completed ride returns 409.
 */
export const POST = route<{ id: string }>(async (request, { params }) => {
  const session = await requireSession(request);
  const { id } = await params;
  const body = await parseBody(request, cancelRideSchema).catch(() => ({ reason: undefined }));
  const db = await getDb();
  return json({
    ride: await cancelRide(db, session, parseUuid(id, "booking reference"), body.reason),
  });
});
