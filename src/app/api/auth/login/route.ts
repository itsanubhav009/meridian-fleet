import { getDb } from "@/server/db/client";
import { json, route } from "@/server/http/handler";
import { parseBody } from "@/server/http/validation";
import { loginSchema } from "@/lib/schemas";
import { login } from "@/server/services/authService";
import { sessionCookie } from "@/server/auth/token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/login
 * Body: { email, password }  ->  200 { user, token }
 * Sets an httpOnly session cookie; the token is also returned for API clients.
 */
export const POST = route(async (request) => {
  const body = await parseBody(request, loginSchema);
  const db = await getDb();
  const { user, token } = await login(db, body.email, body.password);

  const response = json({ user, token });
  response.headers.set("Set-Cookie", sessionCookie(token));
  return response;
});
