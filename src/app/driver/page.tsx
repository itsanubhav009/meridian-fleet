"use client";

import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { RideCard } from "@/components/RideCard";
import { Alert, EmptyState, ErrorState, LoadingRows, cx } from "@/components/ui";
import { useAcceptRide, useRides } from "@/lib/hooks";
import { errorMessage } from "@/lib/api";
import { ACTIVE_STATUSES } from "@/domain/rideStatus";

/**
 * Driver home: the open queue, and the rides already mine.
 *
 * The open queue polls, so a ride another driver takes disappears within a few
 * seconds without a refresh. If two drivers do tap the same ride at the same
 * moment, the server hands it to one of them and the other sees the banner
 * below rather than a silent failure.
 */
type Tab = "available" | "mine";

export default function DriverPage() {
  const [tab, setTab] = useState<Tab>("available");
  const available = useRides({ scope: "available", pageSize: 50 });
  const mine = useRides({ pageSize: 50 });
  const accept = useAcceptRide();

  const activeRide = (mine.data?.items ?? []).find((ride) =>
    (ACTIVE_STATUSES as readonly string[]).includes(ride.status),
  );

  const current = tab === "available" ? available : mine;
  const items = current.data?.items ?? [];

  return (
    <AppShell
      allow={["DRIVER"]}
      title="Dispatch board"
      subtitle="Take a job from the queue, then move it along as you drive."
    >
      <div className="mb-5 flex gap-1 border-b border-line">
        {(
          [
            ["available", "Open queue", available.data?.total],
            ["mine", "My rides", mine.data?.total],
          ] as const
        ).map(([value, label, count]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={cx(
              "-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors",
              tab === value
                ? "border-signal text-ink"
                : "border-transparent text-muted hover:text-ink",
            )}
          >
            {label}
            {typeof count === "number" && (
              <span className="ml-1.5 font-mono text-[11px] text-muted">{count}</span>
            )}
          </button>
        ))}
      </div>

      {accept.isError && (
        <div className="mb-4">
          <Alert tone="error" title="You did not get that ride">
            {errorMessage(accept.error)}
          </Alert>
        </div>
      )}

      {activeRide && tab === "available" && (
        <div className="mb-4">
          <Alert tone="info" title={`You are on ${activeRide.reference}`}>
            Finish or cancel it before taking another job.
          </Alert>
        </div>
      )}

      {current.isLoading ? (
        <LoadingRows count={3} />
      ) : current.isError ? (
        <ErrorState message={errorMessage(current.error)} onRetry={() => current.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          title={tab === "available" ? "Nothing waiting right now" : "No rides yet"}
          description={
            tab === "available"
              ? "New requests appear here on their own. Keep this open."
              : "Rides you accept from the open queue will show up here."
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {items.map((ride) => (
            <RideCard
              key={ride.id}
              ride={ride}
              viewerRole="DRIVER"
              accepting={accept.isPending && accept.variables === ride.id}
              onAccept={
                tab === "available" && !activeRide ? (rideId) => accept.mutate(rideId) : undefined
              }
            />
          ))}
        </div>
      )}
    </AppShell>
  );
}
