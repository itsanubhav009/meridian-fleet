import type { Database } from "../db/types";
import { errors } from "../errors";
import { RIDE_STATUSES, type RideStatus } from "../../domain/rideStatus";
import type { AdminMetrics } from "../../domain/types";
import * as rideRepo from "../repositories/rideRepository";
import * as userRepo from "../repositories/userRepository";
import type { SessionPayload } from "../auth/token";
import type { MetricsQuery } from "@/lib/schemas";

/**
 * Numbers for the admin dashboard.
 *
 * Revenue counts COMPLETED rides only. A requested or cancelled ride has an
 * estimated fare attached to it, but no money has changed hands, so including
 * it would overstate takings — the sort of quiet bug that survives for months.
 */
export async function getAdminMetrics(
  db: Database,
  session: SessionPayload,
  query: MetricsQuery = {},
): Promise<AdminMetrics> {
  if (session.role !== "ADMIN") {
    throw errors.forbidden("Only administrators can view fleet metrics.");
  }

  const [aggregates, userCounts] = await Promise.all([
    rideRepo.aggregate(db, {
      from: query.from,
      to: query.to,
      driverId: query.driverId,
      customerId: query.customerId,
    }),
    userRepo.countByRole(db),
  ]);

  // Start from every known status at zero, so the dashboard shows "0 cancelled"
  // rather than a blank where a status has never occurred.
  const byStatus = Object.fromEntries(
    RIDE_STATUSES.map((status) => [status, aggregates.countsByStatus[status] ?? 0]),
  ) as Record<RideStatus, number>;

  const all = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
  const active = byStatus.ACCEPTED + byStatus.DRIVER_ARRIVING + byStatus.STARTED;

  return {
    totals: {
      all,
      requested: byStatus.REQUESTED,
      active,
      completed: byStatus.COMPLETED,
      cancelled: byStatus.CANCELLED,
    },
    byStatus,
    revenue: {
      completedRideRevenueCents: aggregates.completedRevenueCents,
      averageCompletedFareCents:
        aggregates.completedCount > 0
          ? Math.round(aggregates.completedRevenueCents / aggregates.completedCount)
          : 0,
      currency: "INR",
    },
    fleet: {
      totalDrivers: userCounts.DRIVER,
      driversOnTrip: aggregates.driversOnTrip,
      totalCustomers: userCounts.CUSTOMER,
    },
    generatedAt: new Date().toISOString(),
  };
}
