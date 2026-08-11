import { randomUUID } from "node:crypto";
import { createDatabase, setDb } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { hashPassword } from "@/server/auth/password";
import { createToken } from "@/server/auth/token";
import type { Database } from "@/server/db/types";
import type { Role } from "@/domain/rideStatus";

/**
 * Test harness.
 *
 * Tests run against PGlite by default — a genuine Postgres build running inside
 * the test process — so constraints, transactions, sequences and SQLSTATE codes
 * behave exactly as they will in production. No Docker, no running server, no
 * mocks of the database.
 *
 * PGlite has one limitation worth being honest about: it is a single connection,
 * so it serialises statements that a real server would run in parallel. That is
 * fine for every test except the ones about two drivers colliding. Set
 * TEST_DATABASE_URL to a real Postgres and the whole suite runs against it
 * instead, on a throwaway schema, with genuinely concurrent connections:
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/fleet_test npm test
 *
 * CI does exactly that (see .github/workflows/ci.yml), so the concurrency
 * guarantees are proven against the same engine that runs in production.
 *
 * Route handlers are plain `(Request) => Response` functions, so the tests call
 * them directly. That covers validation, authentication, the service layer and
 * the SQL in one pass, while staying fast enough to run on every save.
 */

export interface TestUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  token: string;
}

export interface Harness {
  db: Database;
  admin: TestUser;
  customer: TestUser;
  otherCustomer: TestUser;
  driver: TestUser;
  otherDriver: TestUser;
  /** Wipes all rides between tests, leaving the users in place. */
  clearRides(): Promise<void>;
  close(): Promise<void>;
}

const PASSWORD = "Password123!";
export const TEST_PASSWORD = PASSWORD;

/** True when the suite is pointed at a real Postgres server. */
export const usingRealPostgres = Boolean(process.env.TEST_DATABASE_URL);

export async function createHarness(): Promise<Harness> {
  process.env.JWT_SECRET ||= "test-secret-key-that-is-definitely-long-enough-32";

  const baseUrl = process.env.TEST_DATABASE_URL ?? "pglite://memory";

  // On a real server each harness gets its own schema, so test files can run
  // side by side without deleting each other's rows. PGlite needs none of this:
  // every harness is already a separate in-memory database.
  //
  // The schema has to be pinned on the connection itself rather than with a
  // one-off `SET search_path`, because a pool hands out several connections and
  // a plain SET would only stick to whichever one happened to run it.
  let schema: string | undefined;
  let url = baseUrl;
  if (usingRealPostgres) {
    schema = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const bootstrap = await createDatabase(baseUrl);
    await bootstrap.exec(`CREATE SCHEMA "${schema}"`);
    await bootstrap.close();
    const separator = baseUrl.includes("?") ? "&" : "?";
    url = `${baseUrl}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
  }

  process.env.DATABASE_URL = url;
  const db = await createDatabase(url);
  await runMigrations(db);
  // Point the application's singleton at this database.
  setDb(Promise.resolve(db));

  // Hash once: bcrypt is deliberately slow, and five hashes per test file adds up.
  const passwordHash = await hashPassword(PASSWORD);

  async function makeUser(name: string, email: string, role: Role): Promise<TestUser> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO users (id, name, email, password_hash, role, phone, vehicle)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, name, email, passwordHash, role, "+91 90000 00000", role === "DRIVER" ? "MH 01 TEST" : null],
    );
    const token = await createToken({ userId: id, role, name, email });
    return { id, name, email, role, token };
  }

  const [admin, customer, otherCustomer, driver, otherDriver] = await Promise.all([
    makeUser("Admin Ana", "admin@test.local", "ADMIN"),
    makeUser("Customer Cara", "cara@test.local", "CUSTOMER"),
    makeUser("Customer Dev", "dev@test.local", "CUSTOMER"),
    makeUser("Driver Dan", "dan@test.local", "DRIVER"),
    makeUser("Driver Eve", "eve@test.local", "DRIVER"),
  ]);

  return {
    db,
    admin: admin!,
    customer: customer!,
    otherCustomer: otherCustomer!,
    driver: driver!,
    otherDriver: otherDriver!,
    async clearRides() {
      await db.exec("DELETE FROM ride_status_history; DELETE FROM rides;");
    },
    async close() {
      setDb(undefined);
      if (schema) {
        await db.exec(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
      }
      await db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Calling route handlers
// ---------------------------------------------------------------------------
type Handler = (request: Request, context: { params: Promise<never> }) => Promise<Response>;

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export async function call<T = any>(
  handler: unknown,
  options: {
    method?: string;
    url?: string;
    body?: unknown;
    token?: string;
    params?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
): Promise<ApiResponse<T>> {
  const method = options.method ?? "GET";
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");

  const request = new Request(`http://localhost${options.url ?? "/"}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const response = await (handler as Handler)(request, {
    params: Promise.resolve((options.params ?? {}) as never),
  });

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  return { status: response.status, body: body as T, headers: response.headers };
}

/** A booking payload with sensible defaults, overridable per test. */
export function rideRequest(overrides: Record<string, unknown> = {}) {
  return {
    pickupAddress: "Bandra Kurla Complex, Mumbai",
    destinationAddress: "Chhatrapati Shivaji Airport T2",
    requestedAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    notes: "One suitcase",
    ...overrides,
  };
}
