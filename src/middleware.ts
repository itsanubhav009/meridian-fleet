import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

/**
 * Page-level routing guard.
 *
 * This verifies the session cookie's signature before letting someone land on a
 * role's screens, so an unauthenticated visitor gets the sign-in page rather
 * than a flash of an empty dashboard.
 *
 * It is worth being precise about what this is NOT: it is not the security
 * boundary. Every API route independently re-checks the token and the role on
 * the server (see src/server/http/session.ts). If this middleware were deleted
 * tomorrow, the data would still be safe — a request with no token, or a
 * customer's token on an admin endpoint, is refused there. Middleware only
 * saves a round trip and a bad first impression.
 */

const SESSION_COOKIE = "fleet_session";

const ROLE_HOME: Record<string, string> = {
  CUSTOMER: "/customer",
  DRIVER: "/driver",
  ADMIN: "/admin",
};

/** Which roles may see which page prefix. */
const AREA_ROLES: Array<{ prefix: string; roles: string[] }> = [
  { prefix: "/customer", roles: ["CUSTOMER"] },
  { prefix: "/driver", roles: ["DRIVER"] },
  { prefix: "/admin", roles: ["ADMIN"] },
  { prefix: "/rides", roles: ["CUSTOMER", "DRIVER", "ADMIN"] },
];

async function readRole(request: NextRequest): Promise<string | null> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const secret = process.env.JWT_SECRET;
  if (!token || !secret) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: "meridian-fleet",
    });
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null; // expired, tampered with, or signed by someone else
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const role = await readRole(request);

  // Signed in and looking at the sign-in page: send them to their own board.
  if (pathname === "/") {
    if (role && ROLE_HOME[role]) {
      return NextResponse.redirect(new URL(ROLE_HOME[role]!, request.url));
    }
    return NextResponse.next();
  }

  const area = AREA_ROLES.find((entry) => pathname.startsWith(entry.prefix));
  if (!area) return NextResponse.next();

  if (!role) {
    const signIn = new URL("/", request.url);
    signIn.searchParams.set("next", pathname);
    return NextResponse.redirect(signIn);
  }

  if (!area.roles.includes(role)) {
    return NextResponse.redirect(new URL(ROLE_HOME[role] ?? "/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Pages only. API routes do their own checks and must return JSON errors,
  // not redirects — a fetch() following a 302 to an HTML page is a confusing
  // failure mode for a client.
  matcher: ["/", "/customer/:path*", "/driver/:path*", "/admin/:path*", "/rides/:path*"],
};
