import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as createRideRoute } from "@/app/api/rides/route";
import { POST as acceptRideRoute } from "@/app/api/rides/[id]/accept/route";
import { PATCH as statusRoute } from "@/app/api/rides/[id]/status/route";
import { createToken } from "@/server/auth/token";
import { hashPassword } from "@/server/auth/password";
import { call, createHarness, rideRequest, usingRealPostgres, type Harness } from "../helpers/harness";

/**
 * Concurrency under real parallelism.
 *
 * The rest of the suite runs on PGlite, which is a single connection: it
 * serialises statements that a real server would interleave. That still proves
 * the *logic* is right, but it cannot prove the database enforces it when
 * requests genuinely overlap — which is the only situation that matters here.
 *
 * These tests therefore run only when TEST_DATABASE_URL points at a real
 * Postgres, where a connection pool gives each request its own backend and the
 * statements really do collide:
 *
 *   TEST_DATABASE_URL=postgresql://... npm test
 *
 * The guarantees being checked are not application-level `if` statements; they
 * are a conditional UPDATE and two partial unique indexes. That distinction is
 * the whole point — an `if (ride.status === 'REQUESTED')` in JavaScript would
 * pass every test in this file on PGlite and fail in production.
 */
describe.skipIf(!usingRealPostgres)("concurrency (real Postgres)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.clearRides();
  });

  /** Adds a driver directly, so a race can involve more than the fixture pair. */
  async function makeDriver(index: number) {
    const id = randomUUID();
    const email = `race-driver-${index}-${id.slice(0, 8)}@test.local`;
    await h.db.query(
      `INSERT INTO users (id, name, email, password_hash, role, vehicle)
       VALUES ($1, $2, $3, $4, 'DRIVER', $5)`,
      [id, `Race Driver ${index}`, email, await hashPassword("Password123!"), `MH 01 R${index}`],
    );
    return {
      id,
      token: await createToken({ userId: id, role: "DRIVER", name: `Race Driver ${index}`, email }),
    };
  }

  async function book() {
    const res = await call(createRideRoute, {
      method: "POST",
      url: "/api/rides",
      token: h.customer.token,
      body: rideRequest(),
    });
    expect(res.status).toBe(201);
    return res.body.ride.id as string;
  }

  it("gives a contested ride to exactly one of eight drivers", async () => {
    const rideId = await book();
    const drivers = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((i) => makeDriver(i)));

    // Fired together, so the conditional UPDATE in rideRepository.accept is what
    // decides the winner rather than the order the requests happened to arrive.
    const responses = await Promise.all(
      drivers.map((driver) =>
        call(acceptRideRoute, {
          method: "POST",
          url: `/api/rides/${rideId}/accept`,
          token: driver.token,
          params: { id: rideId },
        }),
      ),
    );

    const winners = responses.filter((r) => r.status === 200);
    const losers = responses.filter((r) => r.status === 409);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(7);
    for (const loser of losers) {
      expect(loser.body.error.code).toBe("RIDE_ALREADY_ASSIGNED");
    }

    // The database agrees, and the audit trail was not written twice.
    const ride = await h.db.query<{ driver_id: string; status: string }>(
      "SELECT driver_id, status FROM rides WHERE id = $1",
      [rideId],
    );
    expect(ride.rows[0]!.status).toBe("ACCEPTED");
    expect(ride.rows[0]!.driver_id).toBe(winners[0]!.body.ride.driver.id);

    const history = await h.db.query<{ count: string }>(
      "SELECT count(*) FROM ride_status_history WHERE ride_id = $1 AND new_status = 'ACCEPTED'",
      [rideId],
    );
    expect(Number(history.rows[0]!.count)).toBe(1);
  });

  it("keeps one driver from holding two rides at once", async () => {
    const [first, second] = await Promise.all([book(), book()]);
    const driver = await makeDriver(99);

    const responses = await Promise.all(
      [first, second].map((rideId) =>
        call(acceptRideRoute, {
          method: "POST",
          url: `/api/rides/${rideId}/accept`,
          token: driver.token,
          params: { id: rideId },
        }),
      ),
    );

    // One succeeds; the other trips the partial unique index on live rides.
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    const rejected = responses.find((r) => r.status !== 200)!;
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe("DRIVER_HAS_ACTIVE_RIDE");

    const held = await h.db.query<{ count: string }>(
      `SELECT count(*) FROM rides
        WHERE driver_id = $1 AND status IN ('ACCEPTED','DRIVER_ARRIVING','STARTED')`,
      [driver.id],
    );
    expect(Number(held.rows[0]!.count)).toBe(1);
  });

  it("creates one booking when the same form is submitted six times at once", async () => {
    const key = randomUUID();

    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        call(createRideRoute, {
          method: "POST",
          url: "/api/rides",
          token: h.customer.token,
          body: rideRequest(),
          headers: { "idempotency-key": key },
        }),
      ),
    );

    // Every caller gets the same booking back; only one of them created it.
    const created = responses.filter((r) => r.status === 201);
    const replays = responses.filter((r) => r.status === 200);
    expect(created).toHaveLength(1);
    expect(replays).toHaveLength(5);
    for (const replay of replays) {
      expect(replay.body.duplicate).toBe(true);
      expect(replay.body.ride.id).toBe(created[0]!.body.ride.id);
    }

    const rows = await h.db.query<{ count: string }>(
      "SELECT count(*) FROM rides WHERE customer_id = $1",
      [h.customer.id],
    );
    expect(Number(rows.rows[0]!.count)).toBe(1);
  });

  it("applies only one of two status changes racing on the same ride", async () => {
    const rideId = await book();
    await call(acceptRideRoute, {
      method: "POST",
      url: `/api/rides/${rideId}/accept`,
      token: h.driver.token,
      params: { id: rideId },
    });

    // Both send the same compare-and-set: from ACCEPTED to DRIVER_ARRIVING.
    // Two tabs, or a double tap on a slow connection.
    const responses = await Promise.all(
      [0, 1].map(() =>
        call(statusRoute, {
          method: "PATCH",
          url: `/api/rides/${rideId}/status`,
          token: h.driver.token,
          params: { id: rideId },
          body: { status: "DRIVER_ARRIVING", expectedStatus: "ACCEPTED" },
        }),
      ),
    );

    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(1);

    // One transition, so one history row — the timeline shown to the customer
    // must not gain a phantom duplicate entry.
    const history = await h.db.query<{ count: string }>(
      "SELECT count(*) FROM ride_status_history WHERE ride_id = $1 AND new_status = 'DRIVER_ARRIVING'",
      [rideId],
    );
    expect(Number(history.rows[0]!.count)).toBe(1);
  });
});
