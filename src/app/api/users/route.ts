import { getDb } from "@/server/db/client";
import { json, route } from "@/server/http/handler";
import { requireRole } from "@/server/http/session";
import { listByRole } from "@/server/repositories/userRepository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/users   (administrators only)
 * Feeds the "filter by driver" and "filter by customer" pickers on the
 * dashboard. Returns no password material.
 */
export const GET = route(async (request) => {
  await requireRole(request, "ADMIN");
  const db = await getDb();
  const [drivers, customers] = await Promise.all([
    listByRole(db, "DRIVER"),
    listByRole(db, "CUSTOMER"),
  ]);
  return json({ drivers, customers });
});
