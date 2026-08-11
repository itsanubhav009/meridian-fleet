import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as createRideRoute } from "@/app/api/rides/route";
import { POST as acceptRideRoute } from "@/app/api/rides/[id]/accept/route";
import { PATCH as statusRoute } from "@/app/api/rides/[id]/status/route";
import { POST as cancelRoute } from "@/app/api/rides/[id]/cancel/route";
import { GET as metricsRoute } from "@/app/api/admin/metrics/route";
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

async function book(pickup: string, distanceKm?: number) {
  const res = await call(createRideRoute, {
    method: "POST",
    url: "/api/rides",
    token: h.customer.token,
    body: rideRequest({ pickupAddress: pickup, distanceKm }),
  });
  return res.body.ride;
}

async function completeRide(rideId: string, driverToken: string) {
  await call(acceptRideRoute, {
    method: "POST", url: `/api/rides/${rideId}/accept`,
    token: driverToken, params: { id: rideId },
  });
  for (const status of ["DRIVER_ARRIVING", "STARTED", "COMPLETED"]) {
    await call(statusRoute, {
      method: "PATCH", url: `/api/rides/${rideId}/status`,
      token: driverToken, params: { id: rideId }, body: { status },
    });
  }
}

describe("GET /api/admin/metrics", () => {
  it("counts rides in every state and sums revenue from completed rides only", async () => {
    // Two completed rides: 10 km and 20 km.
    // 4000 + 10 x 1450 = 18_500 and 4000 + 20 x 1450 = 33_000  ->  51_500 total.
    const first = await book("Completed trip one", 10);
    await completeRide(first.id, h.driver.token);
    const second = await book("Completed trip two", 20);
    await completeRide(second.id, h.otherDriver.token);

    // One cancelled ride, which must not count towards revenue.
    const cancelled = await book("Cancelled trip", 40);
    await call(cancelRoute, {
      method: "POST", url: `/api/rides/${cancelled.id}/cancel`,
      token: h.customer.token, params: { id: cancelled.id }, body: {},
    });

    // One still waiting for a driver.
    await book("Open trip", 15);

    const res = await call(metricsRoute, { url: "/api/admin/metrics", token: h.admin.token });

    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({
      all: 4,
      requested: 1,
      active: 0,
      completed: 2,
      cancelled: 1,
    });
    expect(res.body.revenue.completedRideRevenueCents).toBe(51_500);
    expect(res.body.revenue.averageCompletedFareCents).toBe(25_750);
  });

  it("counts a ride as active only while it is between accepted and started", async () => {
    const ride = await book("In progress trip", 12);
    await call(acceptRideRoute, {
      method: "POST", url: `/api/rides/${ride.id}/accept`,
      token: h.driver.token, params: { id: ride.id },
    });

    const accepted = await call(metricsRoute, { url: "/api/admin/metrics", token: h.admin.token });
    expect(accepted.body.totals.active).toBe(1);
    expect(accepted.body.fleet.driversOnTrip).toBe(1);

    await call(statusRoute, {
      method: "PATCH", url: `/api/rides/${ride.id}/status`,
      token: h.driver.token, params: { id: ride.id }, body: { status: "DRIVER_ARRIVING" },
    });
    await call(statusRoute, {
      method: "PATCH", url: `/api/rides/${ride.id}/status`,
      token: h.driver.token, params: { id: ride.id }, body: { status: "STARTED" },
    });
    await call(statusRoute, {
      method: "PATCH", url: `/api/rides/${ride.id}/status`,
      token: h.driver.token, params: { id: ride.id }, body: { status: "COMPLETED" },
    });

    const done = await call(metricsRoute, { url: "/api/admin/metrics", token: h.admin.token });
    expect(done.body.totals.active).toBe(0);
    expect(done.body.fleet.driversOnTrip).toBe(0);
  });

  it("reports zero revenue rather than dividing by zero when nothing is completed", async () => {
    await book("Only an open ride", 8);
    const res = await call(metricsRoute, { url: "/api/admin/metrics", token: h.admin.token });

    expect(res.body.revenue.completedRideRevenueCents).toBe(0);
    expect(res.body.revenue.averageCompletedFareCents).toBe(0);
  });

  it("returns every status key even when a status has never occurred", async () => {
    const res = await call(metricsRoute, { url: "/api/admin/metrics", token: h.admin.token });
    expect(Object.keys(res.body.byStatus).sort()).toEqual([
      "ACCEPTED", "CANCELLED", "COMPLETED", "DRIVER_ARRIVING", "REQUESTED", "STARTED",
    ]);
    expect(res.body.byStatus.CANCELLED).toBe(0);
  });

  it("narrows the numbers when filtered by driver", async () => {
    const mine = await book("Driver one trip", 10);
    await completeRide(mine.id, h.driver.token);
    const theirs = await book("Driver two trip", 30);
    await completeRide(theirs.id, h.otherDriver.token);

    const res = await call(metricsRoute, {
      url: `/api/admin/metrics?driverId=${h.driver.id}`, token: h.admin.token,
    });

    expect(res.body.totals.completed).toBe(1);
    expect(res.body.revenue.completedRideRevenueCents).toBe(18_500);
  });

  it("reports fleet headcount", async () => {
    const res = await call(metricsRoute, { url: "/api/admin/metrics", token: h.admin.token });
    expect(res.body.fleet.totalDrivers).toBe(2);
    expect(res.body.fleet.totalCustomers).toBe(2);
  });
});
