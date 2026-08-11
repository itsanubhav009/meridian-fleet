import { getDb } from "@/server/db/client";
import { json, route } from "@/server/http/handler";
import { requireRole } from "@/server/http/session";
import { parseQuery } from "@/server/http/validation";
import { metricsQuerySchema } from "@/lib/schemas";
import { getAdminMetrics } from "@/server/services/metricsService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/metrics   (administrators only)
 * Optional filters: ?from=&to=&driverId=&customerId=
 */
export const GET = route(async (request) => {
  const session = await requireRole(request, "ADMIN");
  const query = parseQuery(request, metricsQuerySchema);
  const db = await getDb();
  return json(await getAdminMetrics(db, session, query));
});
