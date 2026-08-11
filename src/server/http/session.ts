import { errors } from "../errors";
import type { Role } from "../../domain/rideStatus";
import { readTokenFromRequest, verifyToken, type SessionPayload } from "../auth/token";

/**
 * Authentication and role checks, enforced on the server.
 *
 * The frontend also hides controls a role cannot use, but that is only there to
 * keep the UI honest. Every protected route calls one of these functions, so a
 * hand-crafted request from curl is rejected exactly like a click would be.
 */

export async function getSession(request: Request): Promise<SessionPayload | null> {
  const token = readTokenFromRequest(request);
  if (!token) return null;
  try {
    return await verifyToken(token);
  } catch {
    return null;
  }
}

/** Any signed-in user. Throws 401 otherwise. */
export async function requireSession(request: Request): Promise<SessionPayload> {
  const token = readTokenFromRequest(request);
  if (!token) throw errors.unauthenticated();
  return verifyToken(token); // throws UNAUTHENTICATED when invalid or expired
}

/** A signed-in user holding one of `allowed`. Throws 401 then 403. */
export async function requireRole(
  request: Request,
  ...allowed: Role[]
): Promise<SessionPayload> {
  const session = await requireSession(request);
  if (!allowed.includes(session.role)) {
    throw errors.forbidden(
      `This action is available to ${formatRoles(allowed)}, and you are signed in as a ${session.role.toLowerCase()}.`,
    );
  }
  return session;
}

function formatRoles(roles: Role[]): string {
  const words = roles.map((r) => `${r.toLowerCase()}s`);
  if (words.length === 1) return words[0]!;
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}
