import { getDb } from "@/server/db/client";
import { json, route } from "@/server/http/handler";
import { requireSession } from "@/server/http/session";
import { getCurrentUser } from "@/server/services/authService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/auth/me  ->  200 { user } | 401. Used to restore a session on load. */
export const GET = route(async (request) => {
  const session = await requireSession(request);
  const db = await getDb();
  return json({ user: await getCurrentUser(db, session) });
});
