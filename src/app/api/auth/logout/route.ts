import { json, route } from "@/server/http/handler";
import { clearedSessionCookie } from "@/server/auth/token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/logout  ->  200 { ok: true }
 *
 * Clears the cookie. The JWT itself stays valid until it expires — see the
 * note on revocation in src/server/auth/token.ts.
 */
export const POST = route(async () => {
  const response = json({ ok: true });
  response.headers.set("Set-Cookie", clearedSessionCookie());
  return response;
});
