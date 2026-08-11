import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as listRidesRoute, POST as createRideRoute } from "@/app/api/rides/route";
import { GET as getRideRoute } from "@/app/api/rides/[id]/route";
import { POST as acceptRideRoute } from "@/app/api/rides/[id]/accept/route";
import { PATCH as statusRoute } from "@/app/api/rides/[id]/status/route";
import { POST as cancelRoute } from "@/app/api/rides/[id]/cancel/route";
import { call, createHarness, rideRequest, type Harness } from "../helpers/harness";

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

/** Books a ride as the given customer and returns it. */
async function book(token: string, overrides: Record<string, unknown> = {}, key?: string) {
  const res = await call(createRideRoute, {
    method: "POST",
    url: "/api/rides",
    token,
    body: rideRequest(overrides),
    headers: key ? { "idempotency-key": key } : undefined,
  });
  return res;
}

/** Drives a ride to a given status using the real endpoints. */
async function advanceTo(rideId: string, target: "ACCEPTED" | "DRIVER_ARRIVING" | "STARTED" | "COMPLETED") {
  await call(acceptRideRoute, {
    method: "POST",
    url: `/api/rides/${rideId}/accept`,
    token: h.driver.token,
    params: { id: rideId },
  });
  if (target === "ACCEPTED") return;
  const steps: Array<"DRIVER_ARRIVING" | "STARTED" | "COMPLETED"> = ["DRIVER_ARRIVING", "STARTED", "COMPLETED"];
  for (const step of steps) {
    await call(statusRoute, {
      method: "PATCH",
      url: `/api/rides/${rideId}/status`,
      token: h.driver.token,
      params: { id: rideId },
      body: { status: step },
    });
    if (step === target) return;
  }
}

describe("POST /api/rides — creating a booking", () => {
  it("creates a booking with a generated reference, timestamp, status and fare", async () => {
    const res = await book(h.customer.token);

    expect(res.status).toBe(201);
    const ride = res.body.ride;
    expect(ride.reference).toMatch(/^RD-\d{5}$/);
    expect(ride.status).toBe("REQUESTED");
    expect(ride.createdAt).toBeTypeOf("string");
    expect(ride.estimatedFareCents).toBeGreaterThan(0);
    expect(Number.isInteger(ride.estimatedFareCents)).toBe(true);
    expect(ride.estimatedDistanceKm).toBeGreaterThan(0);
    expect(ride.driver).toBeNull();
    expect(ride.customer.id).toBe(h.customer.id);
  });

  it("writes the opening entry in the ride's history", async () => {
    const created = await book(h.customer.token);
    const id = created.body.ride.id;

    const res = await call(getRideRoute, {
      url: `/api/rides/${id}`,
      token: h.customer.token,
      params: { id },
    });

    expect(res.body.ride.history).toHaveLength(1);
    expect(res.body.ride.history[0]).toMatchObject({
      previousStatus: null,
      newStatus: "REQUESTED",
      changedBy: { id: h.customer.id, role: "CUSTOMER" },
    });
  });

  it("rejects a booking with missing required fields", async () => {
    const res = await call(createRideRoute, {
      method: "POST",
      url: "/api/rides",
      token: h.customer.token,
      body: { pickupAddress: "", destinationAddress: "" },
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details).toHaveProperty("pickupAddress");
    expect(res.body.error.details).toHaveProperty("destinationAddress");
    expect(res.body.error.details).toHaveProperty("requestedAt");
  });

  it("rejects a pickup time in the past", async () => {
    const res = await book(h.customer.token, {
      requestedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.details.requestedAt[0]).toMatch(/past/i);
  });

  it("ignores a fare supplied by the client and calculates its own", async () => {
    const res = await book(h.customer.token, { estimatedFareCents: 1, distanceKm: 20 });
    // 4000 base + 20km x 1450 = 33_000
    expect(res.body.ride.estimatedFareCents).toBe(33_000);
  });

  it("requires authentication", async () => {
    const res = await call(createRideRoute, {
      method: "POST",
      url: "/api/rides",
      body: rideRequest(),
    });
    expect(res.status).toBe(401);
  });
});

describe("duplicate submissions", () => {
  it("returns the original booking when the same Idempotency-Key is reused", async () => {
    const key = "booking-form-submit-1";
    const first = await book(h.customer.token, {}, key);
    const second = await book(h.customer.token, {}, key);

    expect(first.status).toBe(201);
    expect(first.body.duplicate).toBe(false);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.ride.id).toBe(first.body.ride.id);

    const list = await call(listRidesRoute, { url: "/api/rides", token: h.customer.token });
    expect(list.body.total).toBe(1);
  });

  it("creates one booking when two identical submissions race", async () => {
    const key = "double-click-key";
    const [a, b] = await Promise.all([
      book(h.customer.token, {}, key),
      book(h.customer.token, {}, key),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.ride.id).toBe(b.body.ride.id);

    const list = await call(listRidesRoute, { url: "/api/rides", token: h.customer.token });
    expect(list.body.total).toBe(1);
  });

  it("scopes idempotency keys per customer", async () => {
    const key = "shared-key";
    const mine = await book(h.customer.token, {}, key);
    const theirs = await book(h.otherCustomer.token, {}, key);

    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);
    expect(mine.body.ride.id).not.toBe(theirs.body.ride.id);
  });
});

describe("POST /api/rides/:id/accept — two drivers, one ride", () => {
  it("gives the ride to exactly one driver when both accept at once", async () => {
    const created = await book(h.customer.token);
    const rideId = created.body.ride.id;

    const [first, second] = await Promise.all([
      call(acceptRideRoute, {
        method: "POST",
        url: `/api/rides/${rideId}/accept`,
        token: h.driver.token,
        params: { id: rideId },
      }),
      call(acceptRideRoute, {
        method: "POST",
        url: `/api/rides/${rideId}/accept`,
        token: h.otherDriver.token,
        params: { id: rideId },
      }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);

    const loser = first.status === 409 ? first : second;
    expect(loser.body.error.code).toBe("RIDE_ALREADY_ASSIGNED");
    expect(loser.body.error.message).toMatch(/another driver/i);

    // The database is left consistent: one ACCEPTED ride, one driver on it.
    const row = await h.db.query<{ status: string; driver_id: string }>(
      "SELECT status, driver_id FROM rides WHERE id = $1",
      [rideId],
    );
    expect(row.rows[0]!.status).toBe("ACCEPTED");
    expect([h.driver.id, h.otherDriver.id]).toContain(row.rows[0]!.driver_id);

    // Exactly one ACCEPTED entry was written to the audit trail.
    const history = await h.db.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM ride_status_history WHERE ride_id = $1 AND new_status = 'ACCEPTED'",
      [rideId],
    );
    expect(Number(history.rows[0]!.count)).toBe(1);
  });

  it("rejects a second, later acceptance with a clear error", async () => {
    const created = await book(h.customer.token);
    const rideId = created.body.ride.id;

    const won = await call(acceptRideRoute, {
      method: "POST", url: `/api/rides/${rideId}/accept`,
      token: h.driver.token, params: { id: rideId },
    });
    const lost = await call(acceptRideRoute, {
      method: "POST", url: `/api/rides/${rideId}/accept`,
      token: h.otherDriver.token, params: { id: rideId },
    });

    expect(won.status).toBe(200);
    expect(won.body.ride.driver.id).toBe(h.driver.id);
    expect(lost.status).toBe(409);
  });

  it("stops a customer from accepting a ride", async () => {
    const created = await book(h.customer.token);
    const rideId = created.body.ride.id;

    const res = await call(acceptRideRoute, {
      method: "POST", url: `/api/rides/${rideId}/accept`,
      token: h.customer.token, params: { id: rideId },
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("stops a driver from taking a second ride while one is in progress", async () => {
    const a = await book(h.customer.token, { pickupAddress: "First pickup point" });
    const b = await book(h.customer.token, { pickupAddress: "Second pickup point" });

    const first = await call(acceptRideRoute, {
      method: "POST", url: `/api/rides/${a.body.ride.id}/accept`,
      token: h.driver.token, params: { id: a.body.ride.id },
    });
    const second = await call(acceptRideRoute, {
      method: "POST", url: `/api/rides/${b.body.ride.id}/accept`,
      token: h.driver.token, params: { id: b.body.ride.id },
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("DRIVER_HAS_ACTIVE_RIDE");
  });
});

describe("PATCH /api/rides/:id/status — lifecycle enforcement", () => {
  it("walks the full happy path and records every step", async () => {
    const created = await book(h.customer.token);
    const rideId = created.body.ride.id;
    await advanceTo(rideId, "COMPLETED");

    const res = await call(getRideRoute, {
      url: `/api/rides/${rideId}`, token: h.customer.token, params: { id: rideId },
    });

    expect(res.body.ride.status).toBe("COMPLETED");
    expect(res.body.ride.completedAt).not.toBeNull();
    expect(res.body.ride.history.map((entry: any) => entry.newStatus)).toEqual([
      "REQUESTED", "ACCEPTED", "DRIVER_ARRIVING", "STARTED", "COMPLETED",
    ]);
  });

  it("rejects a jump from ACCEPTED straight to COMPLETED and leaves the ride untouched", async () => {
    const created = await book(h.customer.token);
    const rideId = created.body.ride.id;
    await advanceTo(rideId, "ACCEPTED");

    const res = await call(statusRoute, {
      method: "PATCH", url: `/api/rides/${rideId}/status`,
      token: h.driver.token, params: { id: rideId },
      body: { status: "COMPLETED" },
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVALID_STATUS_TRANSITION");

    const after = await h.db.query<{ status: string }>("SELECT status FROM rides WHERE id = $1", [rideId]);
    expect(after.rows[0]!.status).toBe("ACCEPTED");

    // No history row was written for the rejected attempt.
    const history = await h.db.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM ride_status_history WHERE ride_id = $1",
      [rideId],
    );
    expect(Number(history.rows[0]!.count)).toBe(2); // REQUESTED, ACCEPTED
  });

  it("rejects a driver starting a ride nobody has accepted", async () => {
    const created = await book(h.customer.token);
    const rideId = created.body.ride.id;

    const res = await call(statusRoute, {
      method: "PATCH", url: `/api/rides/${rideId}/status`,
      token: h.driver.token, params: { id: rideId },
      body: { status: "STARTED" },
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVALID_STATUS_TRANSITION");
  });

  it("stops a customer from moving their ride forward", async () => {
    const created = await book(h.customer.token);
    const rideId = created.body.ride.id;
    await advanceTo(rideId, "STARTED");

    const res = await call(statusRoute, {
      method: "PATCH", url: `/api/rides/${rideId}/status`,
      token: h.customer.token, params: { id: rideId },
      body: { status: "COMPLETED" },
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("stops a driver from updating a ride assigned to someone else", async () => {
    const created = await book(h.customer.token);
    const rideId = created.body.ride.id;
    await advanceTo(rideId, "ACCEPTED"); // taken by h.driver

    const res = await call(statusRoute, {
      method: "PATCH", url: `/api/rides/${rideId}/status`,
      token: h.otherDriver.token, params: { id: rideId },
      body: { status: "DRIVER_ARRIVING" },
    });

    expect(res.status).toBe(404); // the ride is not visible to this driver at all
  });

  it("treats a repeated status update as a no-op conflict, not a double write", async () => {
    const created = await book(h.customer.token);
    const rideId = created.body.ride.id;
    await advanceTo(rideId, "ACCEPTED");

    const body = { status: "DRIVER_ARRIVING", expectedStatus: "ACCEPTED" };
    const first = await call(statusRoute, {
      method: "PATCH", url: `/api/rides/${rideId}/status`,
      token: h.driver.token, params: { id: rideId }, body,
    });
    const replay = await call(statusRoute, {
      method: "PATCH", url: `/api/rides/${rideId}/status`,
      token: h.driver.token, params: { id: rideId }, body,
    });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(409);

    const history = await h.db.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM ride_status_history WHERE ride_id = $1 AND new_status = 'DRIVER_ARRIVING'",
      [rideId],
    );
    expect(Number(history.rows[0]!.count)).toBe(1);
  });

  it("rejects a status this system does not have", async () => {
    const created = await book(h.customer.token);
    const rideId = created.body.ride.id;

    const res = await call(statusRoute, {
      method: "PATCH", url: `/api/rides/${rideId}/status`,
      token: h.driver.token, params: { id: rideId },
      body: { status: "TELEPORTED" },
    });

    expect(res.status).toBe(422);
  });
});

describe("POST /api/rides/:id/cancel", () => {
  it("lets the customer cancel before the ride starts", async () => {
    const created = await book(h.customer.token);
    const rideId = created.body.ride.id;

    const res = await call(cancelRoute, {
      method: "POST", url: `/api/rides/${rideId}/cancel`,
      token: h.customer.token, params: { id: rideId },
      body: { reason: "Plans changed" },
    });

    expect(res.status).toBe(200);
    expect(res.body.ride.status).toBe("CANCELLED");
    expect(res.body.ride.cancellationReason).toBe("Plans changed");
    expect(res.body.ride.cancelledAt).not.toBeNull();
  });

  it("lets the customer cancel after a driver has accepted", async () => {
    const created = await book(h.customer.token);
    const rideId = created.body.ride.id;
    await advanceTo(rideId, "ACCEPTED");

    const res = await call(cancelRoute, {
      method: "POST", url: `/api/rides/${rideId}/cancel`,
      token: h.customer.token, params: { id: rideId }, body: {},
    });
    expect(res.status).toBe(200);
  });

  it("refuses to cancel a ride that is already under way", async () => {
    const created = await book(h.customer.token);
    const rideId = created.body.ride.id;
    await advanceTo(rideId, "STARTED");

    const res = await call(cancelRoute, {
      method: "POST", url: `/api/rides/${rideId}/cancel`,
      token: h.customer.token, params: { id: rideId }, body: {},
    });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/under way/i);
  });

  it("refuses to cancel a completed ride", async () => {
    const created = await book(h.customer.token);
    const rideId = created.body.ride.id;
    await advanceTo(rideId, "COMPLETED");

    const res = await call(cancelRoute, {
      method: "POST", url: `/api/rides/${rideId}/cancel`,
      token: h.customer.token, params: { id: rideId }, body: {},
    });

    expect(res.status).toBe(409);
    const after = await h.db.query<{ status: string }>("SELECT status FROM rides WHERE id = $1", [rideId]);
    expect(after.rows[0]!.status).toBe("COMPLETED");
  });

  it("stops one customer cancelling another customer's booking", async () => {
    const created = await book(h.customer.token);
    const rideId = created.body.ride.id;

    const res = await call(cancelRoute, {
      method: "POST", url: `/api/rides/${rideId}/cancel`,
      token: h.otherCustomer.token, params: { id: rideId }, body: {},
    });

    expect(res.status).toBe(404);
  });
});

describe("GET /api/rides — visibility scoping", () => {
  it("shows a customer only their own bookings", async () => {
    await book(h.customer.token, { pickupAddress: "Mine one" });
    await book(h.customer.token, { pickupAddress: "Mine two" });
    await book(h.otherCustomer.token, { pickupAddress: "Theirs" });

    const res = await call(listRidesRoute, { url: "/api/rides", token: h.customer.token });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    for (const ride of res.body.items) {
      expect(ride.customer.id).toBe(h.customer.id);
    }
  });

  it("ignores a customerId in the query string from a customer", async () => {
    await book(h.otherCustomer.token, { pickupAddress: "Not yours" });

    const res = await call(listRidesRoute, {
      url: `/api/rides?customerId=${h.otherCustomer.id}`,
      token: h.customer.token,
    });

    expect(res.body.total).toBe(0);
  });

  it("refuses to show one customer another customer's ride", async () => {
    const created = await book(h.otherCustomer.token);
    const rideId = created.body.ride.id;

    const res = await call(getRideRoute, {
      url: `/api/rides/${rideId}`, token: h.customer.token, params: { id: rideId },
    });

    // 404, not 403: the API must not confirm that this booking exists.
    expect(res.status).toBe(404);
  });

  it("shows drivers the open queue, oldest request first", async () => {
    const later = new Date(Date.now() + 4 * 60 * 60_000).toISOString();
    const sooner = new Date(Date.now() + 60 * 60_000).toISOString();
    await book(h.customer.token, { pickupAddress: "Later request", requestedAt: later });
    await book(h.customer.token, { pickupAddress: "Sooner request", requestedAt: sooner });

    const res = await call(listRidesRoute, {
      url: "/api/rides?scope=available", token: h.driver.token,
    });

    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].pickupAddress).toBe("Sooner request");
    for (const ride of res.body.items) {
      expect(ride.status).toBe("REQUESTED");
      expect(ride.canAccept).toBe(true);
    }
  });

  it("drops a ride out of the open queue once it is accepted", async () => {
    const created = await book(h.customer.token);
    await advanceTo(created.body.ride.id, "ACCEPTED");

    const queue = await call(listRidesRoute, {
      url: "/api/rides?scope=available", token: h.otherDriver.token,
    });
    expect(queue.body.total).toBe(0);

    const mine = await call(listRidesRoute, { url: "/api/rides", token: h.driver.token });
    expect(mine.body.total).toBe(1);
  });

  it("shows an admin every ride, and honours a status filter", async () => {
    await book(h.customer.token, { pickupAddress: "Open one" });
    const toAccept = await book(h.otherCustomer.token, { pickupAddress: "Accepted one" });
    await advanceTo(toAccept.body.ride.id, "ACCEPTED");

    const all = await call(listRidesRoute, { url: "/api/rides", token: h.admin.token });
    expect(all.body.total).toBe(2);

    const filtered = await call(listRidesRoute, {
      url: "/api/rides?status=REQUESTED", token: h.admin.token,
    });
    expect(filtered.body.total).toBe(1);
    expect(filtered.body.items[0].status).toBe("REQUESTED");
  });

  it("paginates", async () => {
    for (let i = 0; i < 5; i += 1) {
      await book(h.customer.token, { pickupAddress: `Pickup number ${i}` });
    }
    const res = await call(listRidesRoute, {
      url: "/api/rides?page=2&pageSize=2", token: h.customer.token,
    });

    expect(res.body.items).toHaveLength(2);
    expect(res.body.page).toBe(2);
    expect(res.body.total).toBe(5);
    expect(res.body.totalPages).toBe(3);
  });

  it("returns 422 rather than 500 for an identifier that is not a UUID", async () => {
    const res = await call(getRideRoute, {
      url: "/api/rides/not-a-uuid", token: h.customer.token, params: { id: "not-a-uuid" },
    });
    expect(res.status).toBe(422);
  });
});
