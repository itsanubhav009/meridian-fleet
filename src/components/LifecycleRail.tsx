import {
  RIDE_PROGRESSION,
  STATUS_SHORT_LABELS,
  type RideStatus,
} from "@/domain/rideStatus";
import { cx } from "./ui";

/**
 * The lifecycle rail.
 *
 * A ride's status is the one thing all three roles need to read instantly, so
 * it gets the one piece of the interface that is not a rectangle full of text:
 * a line with a station for each step, filled in up to wherever the ride is.
 * The current station pulses while the ride is still moving and goes quiet once
 * it stops.
 *
 * The stations come straight from RIDE_PROGRESSION in the domain model, so
 * adding a status to the state machine adds it here with no change to this file.
 */
export function LifecycleRail({
  status,
  compact = false,
  className,
}: {
  status: RideStatus;
  compact?: boolean;
  className?: string;
}) {
  const cancelled = status === "CANCELLED";
  // A cancelled ride stopped wherever it was; we know it reached REQUESTED.
  const currentIndex = cancelled ? 0 : RIDE_PROGRESSION.indexOf(status);
  const live = !cancelled && status !== "COMPLETED";

  return (
    <div className={className}>
      <div
        className="flex items-center"
        role="img"
        aria-label={
          cancelled
            ? "This ride was cancelled"
            : `Ride progress: ${STATUS_SHORT_LABELS[status]}, step ${currentIndex + 1} of ${RIDE_PROGRESSION.length}`
        }
      >
        {RIDE_PROGRESSION.map((step, index) => {
          const state =
            cancelled && index > 0
              ? "pending"
              : cancelled
                ? "halted"
                : index < currentIndex
                  ? "done"
                  : index === currentIndex
                    ? "current"
                    : "pending";

          return (
            <div key={step} className={cx("flex items-center", index === 0 ? "" : "flex-1")}>
              {index > 0 && (
                <div
                  className="rail-segment"
                  data-state={!cancelled && index <= currentIndex ? "done" : "pending"}
                />
              )}
              <div className="rail-station" data-state={state} data-live={live && state === "current"} />
            </div>
          );
        })}
      </div>

      {!compact && (
        <div className="mt-2 flex justify-between">
          {RIDE_PROGRESSION.map((step, index) => (
            <span
              key={step}
              className={cx(
                "font-mono text-[9px] uppercase tracking-[0.08em]",
                !cancelled && index === currentIndex ? "font-semibold text-signal" : "text-muted",
                index === 0 ? "text-left" : index === RIDE_PROGRESSION.length - 1 ? "text-right" : "text-center",
              )}
            >
              {STATUS_SHORT_LABELS[step]}
            </span>
          ))}
        </div>
      )}

      {cancelled && (
        <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.1em] text-halt">
          Cancelled — this ride did not continue
        </p>
      )}
    </div>
  );
}
