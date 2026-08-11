import type { Database } from "../db/types";
import { errors } from "../errors";
import { verifyPassword } from "../auth/password";
import { createToken, type SessionPayload } from "../auth/token";
import * as userRepo from "../repositories/userRepository";
import type { UserSummary } from "../../domain/types";

/**
 * Sign-in.
 *
 * Two details that are easy to get wrong:
 *
 *   1. A wrong email and a wrong password return the identical error. Saying
 *      "no account with that email" turns the login form into a tool for
 *      discovering which addresses are registered.
 *
 *   2. When no user is found we still run a bcrypt comparison against a dummy
 *      hash. Otherwise a missing account replies noticeably faster than a wrong
 *      password, and that timing difference leaks the same information.
 */

const DUMMY_HASH = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

export interface LoginResult {
  user: UserSummary;
  token: string;
  session: SessionPayload;
}

export async function login(
  db: Database,
  email: string,
  password: string,
): Promise<LoginResult> {
  const attemptKey = email.trim().toLowerCase();
  assertNotRateLimited(attemptKey);

  const user = await userRepo.findByEmail(db, email);
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);

  if (!user || !ok) {
    recordFailure(attemptKey);
    throw errors.invalidCredentials();
  }

  clearFailures(attemptKey);

  const session: SessionPayload = {
    userId: user.id,
    role: user.role,
    name: user.name,
    email: user.email,
  };
  const token = await createToken(session);

  const { passwordHash: _ignored, ...safeUser } = user;
  return { user: safeUser, token, session };
}

export async function getCurrentUser(
  db: Database,
  session: SessionPayload,
): Promise<UserSummary> {
  const user = await userRepo.findById(db, session.userId);
  // The token was signed by us, so a missing user means the account was
  // deleted after the token was issued. Treat it as a dead session.
  if (!user) throw errors.unauthenticated("This account is no longer active.");
  return user;
}

// ---------------------------------------------------------------------------
// Login throttling
//
// In-memory, therefore per-instance: it slows down a script hammering one
// server, and it is honest about not being a distributed rate limiter. In
// production this belongs in Redis or at the edge (Cloudflare, WAF), keyed on
// IP as well as email. Documented as a known limitation in the README.
// ---------------------------------------------------------------------------
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 5 * 60_000;

const attempts = new Map<string, { count: number; firstAt: number }>();

function assertNotRateLimited(key: string): void {
  const entry = attempts.get(key);
  if (!entry) return;
  if (Date.now() - entry.firstAt > WINDOW_MS) {
    attempts.delete(key);
    return;
  }
  if (entry.count >= MAX_ATTEMPTS) {
    throw errors.rateLimited("Too many sign-in attempts. Try again in a few minutes.");
  }
}

function recordFailure(key: string): void {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.firstAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: Date.now() });
    return;
  }
  entry.count += 1;
}

function clearFailures(key: string): void {
  attempts.delete(key);
}

/** Test hook so throttling from one test does not affect the next. */
export function resetLoginThrottle(): void {
  attempts.clear();
}
