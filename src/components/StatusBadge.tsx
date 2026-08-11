import { STATUS_SHORT_LABELS, type RideStatus } from "@/domain/rideStatus";
import { cx } from "./ui";

/** One status, one colour, everywhere it appears. */
const TONES: Record<RideStatus, string> = {
  REQUESTED: "bg-line-soft text-ink-soft border-line",
  ACCEPTED: "bg-signal-soft text-signal-dark border-signal/25",
  DRIVER_ARRIVING: "bg-motion-soft text-motion border-motion/25",
  STARTED: "bg-motion-soft text-motion border-motion/25",
  COMPLETED: "bg-signal-soft text-signal-dark border-signal/25",
  CANCELLED: "bg-halt-soft text-halt border-halt/25",
};

export function StatusBadge({ status, className }: { status: RideStatus; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full border px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.09em]",
        TONES[status],
        className,
      )}
    >
      {STATUS_SHORT_LABELS[status]}
    </span>
  );
}
