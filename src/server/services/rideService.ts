import type { Database } from "../db/types";
import { isUniqueViolation } from "../db/types";
import { errors } from "../errors";
import {
  canTransition,
  availableTransitions,
  STATUS_LABELS,
  type Role,
  type RideStatus,
  type TransitionRule,
} from "../../domain/rideStatus";
import { calculateFare, estimateDistanceKm, fareConfigFromEnv } from "../../domain/fare";
import type { Paginated, Ride } from "../../domain/types";
import * as rideRepo from "../repositories/rideRepository";
import type { SessionPayload } from "../auth/token";
import type { CreateRideInput, RideQuery, UpdateStatusInput } from "@/lib/schemas";

/**
 * Business logic lives here.
 *
 * Route handlers do three things: authenticate, validate, call a service.
 * Repositories do one thing: run SQL. Everything in between — who is allowed to
 * do what, which transitions are legal, how a fare is derived — is in this file,
 * which is why it can be tested without HTTP.
 */

export interface RideWithActions extends Ride {
  /** What the current viewer can do next. Drives the buttons in the UI. */
  availableActions: TransitionRule[];
  /** True when this viewer may accept the ride (driver, ride still open). */
  canAccept: boolean;
}

function decorate(ride: Ride, session: SessionPayload): RideWithActions {
  const check = {
    actorRole: session.role,
    isAssignedDriver: ride.driver?.id === session.userId,
    isRideOwner: ride.customer.id === session.userId,
  };
  return {
    ...ride,
    availableActions: availableTransitions(ride.status, check),
    canAccept: session.role === "DRIVER" && ride.status === "REQUESTED" && ride.driver === null,
  };
}

/**
 * May this viewer see this ride at all?
 *
 * Returning NOT_FOUND rather than FORBIDDEN for someone else's ride is
 * deliberate: a 403 would confirm that a given booking ID exists, which is
 * information the caller has no business having.
 */
function assertCanView(ride: Ride, session: SessionPayload): void {
  if (session.role === "ADMIN") return;
  if (session.role === "CUSTOMER" && ride.customer.id === session.userId) return;
  if (session.role === "DRIVER") {
    const isMine = ride.driver?.id === session.userId;
    const isOpen = ride.status === "REQUESTED" && ride.driver === null;
    if (isMine || isOpen) return;
  }
  throw errors.notFound("That booking does not exist, or is not yours to view.");
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
export async function createRide(
  db: Database,
  session: SessionPayload,
  input: CreateRideInput,
  idempotencyKey: string | null,
): Promise<{ ride: RideWithActions; duplicate: boolean }> {
  if (session.role !== "CUSTOMER") {
    throw errors.forbidden("Only customers can create bookings.");
  }

  // Retrying the same submission returns the original booking rather than
  // creating a second one. See docs/API.md for the Idempotency-Key contract.
  if (idempotencyKey) {
    const existing = await rideRepo.findByIdempotencyKey(db, session.userId, idempotencyKey);
    if (existing) return { ride: decorate(existing, session), duplicate: true };
  }

  // The fare is always computed here. A fare in the request body is ignored,
  // so a customer cannot book a 40 km trip for one rupee by editing the payload.
  const distanceKm = estimateDistanceKm({
    distanceKm: input.distanceKm ?? null,
    pickup: input.pickup ?? null,
    destination: input.destination ?? null,
    pickupAddress: input.pickupAddress,
    destinationAddress: input.destinationAddress,
  });
  const fare = calculateFare(distanceKm, fareConfigFromEnv());

  try {
    const ride = await rideRepo.create(db, {
      customerId: session.userId,
      pickupAddress: input.pickupAddress,
      destinationAddress: input.destinationAddress,
      pickup: input.pickup ?? null,
      destination: input.destination ?? null,
      estimatedDistanceKm: distanceKm,
      estimatedFareCents: fare.totalCents,
      requestedAt: new Date(input.requestedAt).toISOString(),
      notes: input.notes?.trim() ? input.notes.trim() : null,
      idempotencyKey,
    });
    return { ride: decorate(ride, session), duplicate: false };
  } catch (error) {
    // Two identical submissions landing at the same instant: the unique index
    // rejects the loser, and we return the winner's booking.
    if (idempotencyKey && isUniqueViolation(error, "uniq_rides_customer_idempotency")) {
      const existing = await rideRepo.findByIdempotencyKey(db, session.userId, idempotencyKey);
      if (existing) return { ride: decorate(existing, session), duplicate: true };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------
export async function getRide(
  db: Database,
  session: SessionPayload,
  rideId: string,
): Promise<RideWithActions> {
  const ride = await rideRepo.findById(db, rideId);
  if (!ride) throw errors.notFound("That booking does not exist.");
  assertCanView(ride, session);

  const history = await rideRepo.findHistory(db, rideId);
  return { ...decorate(ride, session), history };
}

/**
 * Lists rides, scoped to what the caller is allowed to see.
 *
 * The scoping is applied to the SQL filter, not to the results after the fact.
 * A customer's query can only ever produce their own rides, whatever they put
 * in the query string.
 */
export async function listRides(
  db: Database,
  session: SessionPayload,
  query: RideQuery,
): Promise<Paginated<RideWithActions>> {
  const filters: rideRepo.RideFilters = {
    status: query.status,
    from: query.from,
    to: query.to,
    search: query.search,
  };
  let order: rideRepo.PageRequest["order"] = "created_at_desc";

  if (session.role === "CUSTOMER") {
    filters.customerId = session.userId;
  } else if (session.role === "DRIVER") {
    if (query.scope === "available") {
      // The open queue: unassigned rides, oldest request first, so the person
      // who has waited longest is offered first.
      filters.status = ["REQUESTED"];
      filters.unassignedOnly = true;
      order = "requested_at_asc";
    } else {
      filters.driverId = session.userId;
    }
  } else {
    // Admins may filter by anyone.
    filters.customerId = query.customerId;
    filters.driverId = query.driverId;
  }

  const page = await rideRepo.list(db, filters, {
    page: query.page,
    pageSize: query.pageSize,
    order,
  });

  return { ...page, items: page.items.map((ride) => decorate(ride, session)) };
}

// ---------------------------------------------------------------------------
// Accept
// ---------------------------------------------------------------------------
export async function acceptRide(
  db: Database,
  session: SessionPayload,
  rideId: string,
): Promise<RideWithActions> {
  if (session.role !== "DRIVER") {
    throw errors.forbidden("Only drivers can accept rides.");
  }

  const outcome = await rideRepo.accept(db, rideId, session.userId);

  if (!outcome.ok) {
    if (outcome.reason === "NOT_FOUND") throw errors.notFound("That ride no longer exists.");
    if (outcome.reason === "DRIVER_BUSY") throw errors.driverHasActiveRide();
    throw errors.rideAlreadyAssigned();
  }

  return decorate(outcome.ride, session);
}

// ---------------------------------------------------------------------------
// Status changes
// ---------------------------------------------------------------------------
export async function updateStatus(
  db: Database,
  session: SessionPayload,
  rideId: string,
  input: UpdateStatusInput,
): Promise<RideWithActions> {
  const ride = await rideRepo.findById(db, rideId);
  if (!ride) throw errors.notFound("That ride does not exist.");
  assertCanView(ride, session);

  // Accepting is its own endpoint because it assigns a driver as well as
  // moving the status, and that assignment is what has to be race-proof.
  if (input.status === "ACCEPTED") {
    throw errors.validation("Use POST /api/rides/:id/accept to take a ride.");
  }

  if (input.expectedStatus && input.expectedStatus !== ride.status) {
    throw errors.invalidTransition(
      `This ride has already moved to "${STATUS_LABELS[ride.status]}". Refresh to see the latest.`,
    );
  }

  const decision = canTransition(ride.status, input.status, {
    actorRole: session.role,
    isAssignedDriver: ride.driver?.id === session.userId,
    isRideOwner: ride.customer.id === session.userId,
  });

  if (!decision.allowed) {
    throw transitionError(decision.reason, ride.status, input.status, session.role);
  }

  const outcome = await rideRepo.changeStatus(db, {
    rideId,
    expectedStatus: ride.status,
    nextStatus: input.status,
    actorId: session.userId,
    actorRole: session.role,
    note: input.note ?? null,
  });

  if (!outcome.ok) {
    if (outcome.reason === "NOT_FOUND") throw errors.notFound("That ride does not exist.");
    // Somebody changed the ride between our read and our write.
    throw errors.invalidTransition(
      "This ride changed while you were working on it. Refresh and try again.",
    );
  }

  return decorate(outcome.ride, session);
}

export async function cancelRide(
  db: Database,
  session: SessionPayload,
  rideId: string,
  reason?: string,
): Promise<RideWithActions> {
  const ride = await rideRepo.findById(db, rideId);
  if (!ride) throw errors.notFound("That booking does not exist.");
  assertCanView(ride, session);

  const decision = canTransition(ride.status, "CANCELLED", {
    actorRole: session.role,
    isAssignedDriver: ride.driver?.id === session.userId,
    isRideOwner: ride.customer.id === session.userId,
  });

  if (!decision.allowed) {
    if (decision.reason === "INVALID_TRANSITION") {
      throw errors.invalidTransition(
        ride.status === "STARTED"
          ? "This ride is already under way and can no longer be cancelled."
          : `A ${STATUS_LABELS[ride.status].toLowerCase()} booking cannot be cancelled.`,
      );
    }
    throw transitionError(decision.reason, ride.status, "CANCELLED", session.role);
  }

  const outcome = await rideRepo.changeStatus(db, {
    rideId,
    expectedStatus: ride.status,
    nextStatus: "CANCELLED",
    actorId: session.userId,
    actorRole: session.role,
    note: reason ?? null,
    cancellationReason: reason ?? null,
  });

  if (!outcome.ok) {
    if (outcome.reason === "NOT_FOUND") throw errors.notFound("That booking does not exist.");
    throw errors.invalidTransition(
      "This booking changed while you were cancelling it. Refresh and try again.",
    );
  }

  return decorate(outcome.ride, session);
}

function transitionError(
  reason: "INVALID_TRANSITION" | "ROLE_NOT_PERMITTED" | "NOT_ASSIGNED" | "NOT_OWNER",
  from: RideStatus,
  to: RideStatus,
  role: Role,
) {
  switch (reason) {
    case "INVALID_TRANSITION":
      return errors.invalidTransition(
        `A ride cannot go from "${STATUS_LABELS[from]}" to "${STATUS_LABELS[to]}".`,
      );
    case "ROLE_NOT_PERMITTED":
      return errors.forbidden(
        `A ${role.toLowerCase()} cannot move a ride to "${STATUS_LABELS[to]}".`,
      );
    case "NOT_ASSIGNED":
      return errors.forbidden("Only the driver assigned to this ride can update it.");
    case "NOT_OWNER":
      return errors.forbidden("You can only change your own bookings.");
  }
}
