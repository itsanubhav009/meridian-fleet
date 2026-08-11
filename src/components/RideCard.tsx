"use client";

import Link from "next/link";
import type { RideWithActions } from "@/lib/hooks";
import { formatDateTime, formatDistance, formatMoney, formatRelative } from "@/lib/format";
import { LifecycleRail } from "./LifecycleRail";
import { StatusBadge } from "./StatusBadge";
import { Button } from "./ui";

/**
 * One ride, summarised. The same card serves all three roles; what changes is
 * which supporting line is worth showing and whether an action button appears.
 */
export function RideCard({
  ride,
  viewerRole,
  onAccept,
  accepting = false,
  href,
}: {
  ride: RideWithActions;
  viewerRole: "CUSTOMER" | "DRIVER" | "ADMIN";
  onAccept?: (rideId: string) => void;
  accepting?: boolean;
  href?: string;
}) {
  const detailHref = href ?? `/rides/${ride.id}`;

  return (
    <article className="card p-4 transition-colors hover:border-line-soft">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={detailHref}
          className="font-mono text-[12px] font-semibold tracking-wide text-signal hover:underline"
        >
          {ride.reference}
        </Link>
        <StatusBadge status={ride.status} />
        <span className="ml-auto font-mono text-[13px] font-semibold text-ink">
          {formatMoney(ride.estimatedFareCents)}
        </span>
      </div>

      <Link href={detailHref} className="mt-3 block">
        <div className="grid gap-1.5">
          <Route label="From" value={ride.pickupAddress} />
          <Route label="To" value={ride.destinationAddress} />
        </div>
      </Link>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted">
        <span>{formatDistance(ride.estimatedDistanceKm)}</span>
        <span>Pickup {formatDateTime(ride.requestedAt)}</span>
        <span>Booked {formatRelative(ride.createdAt)}</span>
      </div>

      {viewerRole === "DRIVER" && ride.status === "REQUESTED" && (
        <p className="mt-2 text-[12px] text-muted">
          Customer: <span className="text-ink">{ride.customer.name}</span>
        </p>
      )}
      {viewerRole === "CUSTOMER" && ride.driver && (
        <p className="mt-2 text-[12px] text-muted">
          Driver: <span className="text-ink">{ride.driver.name}</span>
          {ride.driver.vehicle && <span className="ml-1 font-mono text-[11px]">· {ride.driver.vehicle}</span>}
        </p>
      )}
      {viewerRole === "ADMIN" && (
        <p className="mt-2 text-[12px] text-muted">
          {ride.customer.name}
          {ride.driver ? ` · driven by ${ride.driver.name}` : " · no driver yet"}
        </p>
      )}

      {ride.notes && <p className="mt-2 text-[12px] italic text-muted">“{ride.notes}”</p>}

      <LifecycleRail status={ride.status} compact className="mt-4" />

      {ride.canAccept && onAccept && (
        <Button
          variant="primary"
          size="sm"
          className="mt-4 w-full sm:w-auto"
          loading={accepting}
          onClick={() => onAccept(ride.id)}
        >
          Accept ride
        </Button>
      )}
    </article>
  );
}

function Route({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2.5">
      <span className="eyebrow mt-0.5 w-8 shrink-0">{label}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{value}</span>
    </div>
  );
}
