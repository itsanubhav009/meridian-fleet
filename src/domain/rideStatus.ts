/**
 * The ride lifecycle, expressed once, in one place.
 *
 *   REQUESTED -> ACCEPTED -> DRIVER_ARRIVING -> STARTED -> COMPLETED
 *        |           |             |
 *        +-----------+-------------+--------> CANCELLED
 *
 * Every status change in the system — from the driver's buttons, from the
 * customer's cancel action, from the admin console — is checked against this
 * table on the server. Nothing else is allowed to invent a transition.
 *
 * Adding a new status (a question the interviewer may ask you to answer live)
 * is a three-step change:
 *   1. add it to RIDE_STATUSES below
 *   2. add its edges to TRANSITIONS
 *   3. add it to the CHECK constraint in db/migrations (as a new migration)
 * The UI, the API validation and the admin metrics all read from this file,
 * so they pick the new status up automatically.
 */

export const RIDE_STATUSES = [
  "REQUESTED",
  "ACCEPTED",
  "DRIVER_ARRIVING",
  "STARTED",
  "COMPLETED",
  "CANCELLED",
] as const;

export type RideStatus = (typeof RIDE_STATUSES)[number];

export const ROLES = ["CUSTOMER", "DRIVER", "ADMIN"] as const;
export type Role = (typeof ROLES)[number];

/** The happy path, in order. Used to render the progress rail in the UI. */
export const RIDE_PROGRESSION: readonly RideStatus[] = [
  "REQUESTED",
  "ACCEPTED",
  "DRIVER_ARRIVING",
  "STARTED",
  "COMPLETED",
];

/** Statuses from which no further change is possible. */
export const TERMINAL_STATUSES: readonly RideStatus[] = ["COMPLETED", "CANCELLED"];

/** Statuses where a driver is committed to the ride and cannot take another. */
export const ACTIVE_STATUSES: readonly RideStatus[] = [
  "ACCEPTED",
  "DRIVER_ARRIVING",
  "STARTED",
];

export interface TransitionRule {
  to: RideStatus;
  /** Which roles may perform this transition at all. */
  roles: readonly Role[];
  /**
   * When true, a DRIVER performing this transition must be the driver already
   * assigned to the ride. Stops driver B from progressing driver A's ride.
   */
  driverMustBeAssigned: boolean;
  /** Shown on the button that performs this transition. */
  label: string;
}

export const TRANSITIONS: Record<RideStatus, readonly TransitionRule[]> = {
  REQUESTED: [
    // Handled by POST /api/rides/:id/accept, which also assigns the driver.
    { to: "ACCEPTED", roles: ["DRIVER"], driverMustBeAssigned: false, label: "Accept ride" },
    { to: "CANCELLED", roles: ["CUSTOMER", "ADMIN"], driverMustBeAssigned: false, label: "Cancel booking" },
  ],
  ACCEPTED: [
    { to: "DRIVER_ARRIVING", roles: ["DRIVER"], driverMustBeAssigned: true, label: "On my way" },
    { to: "CANCELLED", roles: ["CUSTOMER", "ADMIN"], driverMustBeAssigned: false, label: "Cancel booking" },
  ],
  DRIVER_ARRIVING: [
    { to: "STARTED", roles: ["DRIVER"], driverMustBeAssigned: true, label: "Start ride" },
    { to: "CANCELLED", roles: ["CUSTOMER", "ADMIN"], driverMustBeAssigned: false, label: "Cancel booking" },
  ],
  STARTED: [
    { to: "COMPLETED", roles: ["DRIVER"], driverMustBeAssigned: true, label: "Complete ride" },
    // Deliberately no CANCELLED edge: the assignment states a booking may only
    // be cancelled before the ride starts. Once the customer is in the car,
    // the ride ends by completing it.
  ],
  COMPLETED: [],
  CANCELLED: [],
};

export function isRideStatus(value: unknown): value is RideStatus {
  return typeof value === "string" && (RIDE_STATUSES as readonly string[]).includes(value);
}

export function isTerminal(status: RideStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Is `to` reachable from `from` at all, ignoring who is asking? */
export function isValidTransition(from: RideStatus, to: RideStatus): boolean {
  return TRANSITIONS[from].some((rule) => rule.to === to);
}

export interface TransitionCheck {
  actorRole: Role;
  /** True when the actor is the driver currently assigned to this ride. */
  isAssignedDriver: boolean;
  /** True when the actor is the customer who booked this ride. */
  isRideOwner: boolean;
}

export type TransitionDecision =
  | { allowed: true; rule: TransitionRule }
  | { allowed: false; reason: "INVALID_TRANSITION" | "ROLE_NOT_PERMITTED" | "NOT_ASSIGNED" | "NOT_OWNER" };

/**
 * The single authority on "may this actor move this ride to this status?".
 * Returns a decision rather than throwing so callers can map it to whichever
 * HTTP status is right for their endpoint.
 */
export function canTransition(
  from: RideStatus,
  to: RideStatus,
  check: TransitionCheck,
): TransitionDecision {
  const rule = TRANSITIONS[from].find((r) => r.to === to);
  if (!rule) return { allowed: false, reason: "INVALID_TRANSITION" };

  if (!rule.roles.includes(check.actorRole)) {
    return { allowed: false, reason: "ROLE_NOT_PERMITTED" };
  }
  if (check.actorRole === "DRIVER" && rule.driverMustBeAssigned && !check.isAssignedDriver) {
    return { allowed: false, reason: "NOT_ASSIGNED" };
  }
  if (check.actorRole === "CUSTOMER" && !check.isRideOwner) {
    return { allowed: false, reason: "NOT_OWNER" };
  }
  return { allowed: true, rule };
}

/** Transitions this actor could perform right now — drives the action buttons. */
export function availableTransitions(
  from: RideStatus,
  check: TransitionCheck,
): TransitionRule[] {
  return TRANSITIONS[from].filter((rule) => canTransition(from, rule.to, check).allowed);
}

// ---------------------------------------------------------------------------
// Presentation helpers shared by every surface that renders a status.
// ---------------------------------------------------------------------------
export const STATUS_LABELS: Record<RideStatus, string> = {
  REQUESTED: "Looking for a driver",
  ACCEPTED: "Driver assigned",
  DRIVER_ARRIVING: "Driver on the way",
  STARTED: "On the trip",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export const STATUS_SHORT_LABELS: Record<RideStatus, string> = {
  REQUESTED: "Requested",
  ACCEPTED: "Accepted",
  DRIVER_ARRIVING: "Arriving",
  STARTED: "Started",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};
