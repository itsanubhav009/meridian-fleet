import { SignJWT, jwtVerify } from "jose";
import type { Role } from "../../domain/rideStatus";
import { errors } from "../errors";

/**
 * Stateless JWT sessions, signed HS256.
 *
 * The token is delivered two ways so the same API serves both surfaces:
 *   - an httpOnly cookie, which the browser sends automatically and JavaScript
 *     cannot read (so an XSS bug cannot exfiltrate the session)
 *   - an `Authorization: Bearer <token>` header, for curl, Postman and tests
 *
 * Trade-off worth naming out loud: stateless tokens cannot be revoked before
 * they expire. That is why the lifetime is short. A production system would
 * add a refresh token plus a server-side revocation list.
 */

export const SESSION_COOKIE = "fleet_session";

export interface SessionPayload {
  userId: string;
  role: Role;
  name: string;
  email: string;
}

function secretKey(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "JWT_SECRET must be set to a random string of at least 32 characters. " +
        "Generate one with: openssl rand -base64 48",
    );
  }
  return new TextEncoder().encode(secret);
}

export async function createToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ role: payload.role, name: payload.name, email: payload.email })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(payload.userId)
    .setIssuedAt()
    .setIssuer("meridian-fleet")
    .setExpirationTime(process.env.JWT_EXPIRES_IN || "8h")
    .sign(secretKey());
}

/** Throws UNAUTHENTICATED for anything malformed, tampered with or expired. */
export async function verifyToken(token: string): Promise<SessionPayload> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { issuer: "meridian-fleet" });
    if (!payload.sub || typeof payload.role !== "string") {
      throw new Error("missing claims");
    }
    return {
      userId: payload.sub,
      role: payload.role as Role,
      name: String(payload.name ?? ""),
      email: String(payload.email ?? ""),
    };
  } catch {
    throw errors.unauthenticated("Your session has expired. Sign in again.");
  }
}

export function sessionCookie(token: string, maxAgeSeconds = 8 * 60 * 60): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Reads the session token from the Authorization header, then the cookie. */
export function readTokenFromRequest(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=") || null;
  }
  return null;
}
