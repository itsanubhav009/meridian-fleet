import { describe, expect, it } from "vitest";
import {
  RIDE_STATUSES,
  TRANSITIONS,
  availableTransitions,
  canTransition,
  isTerminal,
  isValidTransition,
} from "@/domain/rideStatus";

/**
 * The state machine is pure logic, so it is tested without a database, an HTTP
 * request or a browser. These are the fastest and most valuable tests in the
 * suite: every rule the API enforces is stated once, here.
 */
describe("ride lifecycle state machine", () => {
  it("walks the full happy path one step at a time", () => {
    expect(isValidTransition("REQUESTED", "ACCEPTED")).toBe(true);
    expect(isValidTransition("ACCEPTED", "DRIVER_ARRIVING")).toBe(true);
    expect(isValidTransition("DRIVER_ARRIVING", "STARTED")).toBe(true);
    expect(isValidTransition("STARTED", "COMPLETED")).toBe(true);
  });

  it("refuses to skip steps", () => {
    expect(isValidTransition("REQUESTED", "COMPLETED")).toBe(false);
    expect(isValidTransition("REQUESTED", "STARTED")).toBe(false);
    expect(isValidTransition("ACCEPTED", "COMPLETED")).toBe(false);
    expect(isValidTransition("ACCEPTED", "STARTED")).toBe(false);
  });

  it("never moves out of a terminal status", () => {
    for (const status of RIDE_STATUSES) {
      if (!isTerminal(status)) continue;
      expect(TRANSITIONS[status]).toHaveLength(0);
      for (const target of RIDE_STATUSES) {
        expect(isValidTransition(status, target)).toBe(false);
      }
    }
  });

  it("does not allow a completed ride to be cancelled", () => {
    expect(isValidTransition("COMPLETED", "CANCELLED")).toBe(false);
  });

  it("does not allow cancelling once the ride has started", () => {
    expect(isValidTransition("STARTED", "CANCELLED")).toBe(false);
    expect(isValidTransition("DRIVER_ARRIVING", "CANCELLED")).toBe(true);
  });

  it("never lets a ride move to the status it is already in", () => {
    for (const status of RIDE_STATUSES) {
      expect(isValidTransition(status, status)).toBe(false);
    }
  });

  describe("who may perform a transition", () => {
    const assignedDriver = { actorRole: "DRIVER" as const, isAssignedDriver: true, isRideOwner: false };
    const otherDriver = { actorRole: "DRIVER" as const, isAssignedDriver: false, isRideOwner: false };
    const owner = { actorRole: "CUSTOMER" as const, isAssignedDriver: false, isRideOwner: true };
    const stranger = { actorRole: "CUSTOMER" as const, isAssignedDriver: false, isRideOwner: false };
    const admin = { actorRole: "ADMIN" as const, isAssignedDriver: false, isRideOwner: false };

    it("lets only the assigned driver progress a ride", () => {
      expect(canTransition("ACCEPTED", "DRIVER_ARRIVING", assignedDriver).allowed).toBe(true);
      const denied = canTransition("ACCEPTED", "DRIVER_ARRIVING", otherDriver);
      expect(denied.allowed).toBe(false);
      expect(denied.allowed === false && denied.reason).toBe("NOT_ASSIGNED");
    });

    it("stops a customer from driving the ride forward", () => {
      const denied = canTransition("ACCEPTED", "STARTED", owner);
      expect(denied.allowed).toBe(false);
      expect(denied.allowed === false && denied.reason).toBe("INVALID_TRANSITION");

      const roleDenied = canTransition("STARTED", "COMPLETED", owner);
      expect(roleDenied.allowed).toBe(false);
      expect(roleDenied.allowed === false && roleDenied.reason).toBe("ROLE_NOT_PERMITTED");
    });

    it("lets the booking's own customer cancel, but not another customer", () => {
      expect(canTransition("REQUESTED", "CANCELLED", owner).allowed).toBe(true);
      const denied = canTransition("REQUESTED", "CANCELLED", stranger);
      expect(denied.allowed).toBe(false);
      expect(denied.allowed === false && denied.reason).toBe("NOT_OWNER");
    });

    it("lets an admin cancel any pending booking", () => {
      expect(canTransition("REQUESTED", "CANCELLED", admin).allowed).toBe(true);
      expect(canTransition("ACCEPTED", "CANCELLED", admin).allowed).toBe(true);
      expect(canTransition("STARTED", "CANCELLED", admin).allowed).toBe(false);
    });

    it("offers each role only the actions it can actually perform", () => {
      expect(availableTransitions("STARTED", assignedDriver).map((t) => t.to)).toEqual(["COMPLETED"]);
      expect(availableTransitions("STARTED", owner)).toHaveLength(0);
      expect(availableTransitions("REQUESTED", owner).map((t) => t.to)).toEqual(["CANCELLED"]);
      expect(availableTransitions("COMPLETED", admin)).toHaveLength(0);
    });
  });
});
