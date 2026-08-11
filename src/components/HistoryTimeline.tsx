import type { RideHistoryEntry } from "@/domain/types";
import { STATUS_SHORT_LABELS } from "@/domain/rideStatus";
import { formatDateTime } from "@/lib/format";

/**
 * The audit trail for one ride: every status change, who made it, and when.
 * Written by the API inside the same transaction as the status change itself,
 * so this list can never disagree with the ride's current status.
 */
export function HistoryTimeline({ entries }: { entries: RideHistoryEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-[13px] text-muted">No changes recorded yet.</p>;
  }

  return (
    <ol className="space-y-0">
      {entries.map((entry, index) => (
        <li key={entry.id} className="relative flex gap-3 pb-4 last:pb-0">
          {index < entries.length - 1 && (
            <span className="absolute left-[5px] top-4 h-full w-px bg-line" aria-hidden="true" />
          )}
          <span
            className={`relative mt-1.5 h-[11px] w-[11px] shrink-0 rounded-full border-2 ${
              entry.newStatus === "CANCELLED"
                ? "border-halt bg-halt"
                : index === entries.length - 1
                  ? "border-signal bg-surface"
                  : "border-signal bg-signal"
            }`}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-ink">
              <span className="font-semibold">
                {entry.previousStatus
                  ? `${STATUS_SHORT_LABELS[entry.previousStatus]} → ${STATUS_SHORT_LABELS[entry.newStatus]}`
                  : "Booking created"}
              </span>
            </p>
            <p className="mt-0.5 font-mono text-[11px] text-muted">
              {entry.changedBy.name} · {entry.changedBy.role.toLowerCase()} ·{" "}
              {formatDateTime(entry.createdAt)}
            </p>
            {entry.note && <p className="mt-1 text-[12px] text-muted">{entry.note}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
