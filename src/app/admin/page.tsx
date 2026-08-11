"use client";

import Link from "next/link";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";
import { Button, EmptyState, ErrorState, LoadingRows, Select, Input, Skeleton, cx } from "@/components/ui";
import { useDirectory, useMetrics, useRides } from "@/lib/hooks";
import { errorMessage } from "@/lib/api";
import { RIDE_STATUSES, STATUS_SHORT_LABELS, type RideStatus } from "@/domain/rideStatus";
import { formatDateTime, formatDistance, formatMoney } from "@/lib/format";

/**
 * Dispatch dashboard.
 *
 * Filters live in component state and are passed straight into the query key,
 * so React Query caches each combination and changing a filter never leaves a
 * stale table on screen. The same filters are sent to the metrics endpoint, so
 * the numbers at the top always describe the rows underneath them.
 */
interface Filters {
  status: RideStatus | "";
  driverId: string;
  customerId: string;
  from: string;
  to: string;
  search: string;
}

const EMPTY_FILTERS: Filters = {
  status: "",
  driverId: "",
  customerId: "",
  from: "",
  to: "",
  search: "",
};

export default function AdminPage() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);

  const directory = useDirectory();
  const metrics = useMetrics({
    from: filters.from ? new Date(filters.from).toISOString() : undefined,
    to: filters.to ? new Date(`${filters.to}T23:59:59`).toISOString() : undefined,
    driverId: filters.driverId || undefined,
    customerId: filters.customerId || undefined,
  });
  const rides = useRides({
    status: filters.status ? [filters.status] : undefined,
    driverId: filters.driverId || undefined,
    customerId: filters.customerId || undefined,
    from: filters.from ? new Date(filters.from).toISOString() : undefined,
    to: filters.to ? new Date(`${filters.to}T23:59:59`).toISOString() : undefined,
    search: filters.search || undefined,
    page,
    pageSize: 15,
  });

  function update<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1); // a new filter means a new result set; page 3 of it may not exist
  }

  const hasFilters = Object.values(filters).some(Boolean);
  const m = metrics.data;

  return (
    <AppShell
      allow={["ADMIN"]}
      title="Fleet overview"
      subtitle="Every ride, and what the fleet is doing right now."
    >
      {/* ------------------------------------------------------------------ */}
      {/* Metrics                                                             */}
      {/* ------------------------------------------------------------------ */}
      <section className="mb-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Total rides" value={m?.totals.all} loading={metrics.isLoading} />
          <Stat label="Requested" value={m?.totals.requested} loading={metrics.isLoading} />
          <Stat label="Active" value={m?.totals.active} loading={metrics.isLoading} accent="motion" />
          <Stat label="Completed" value={m?.totals.completed} loading={metrics.isLoading} accent="signal" />
          <Stat label="Cancelled" value={m?.totals.cancelled} loading={metrics.isLoading} accent="halt" />
          <Stat
            label="Revenue"
            value={m ? formatMoney(m.revenue.completedRideRevenueCents) : undefined}
            loading={metrics.isLoading}
            accent="signal"
            hint="Completed rides only"
          />
        </div>
        {m && (
          <p className="mt-2 font-mono text-[11px] text-muted">
            {m.fleet.driversOnTrip} of {m.fleet.totalDrivers} drivers on a trip ·{" "}
            {m.fleet.totalCustomers} customers · average completed fare{" "}
            {formatMoney(m.revenue.averageCompletedFareCents)}
          </p>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Filters                                                             */}
      {/* ------------------------------------------------------------------ */}
      <section className="card mb-4 p-4">
        <div className="mb-3 flex items-center justify-between">
          <p className="eyebrow">Filter</p>
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={() => { setFilters(EMPTY_FILTERS); setPage(1); }}>
              Clear all
            </Button>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block">
            <span className="eyebrow mb-1 block">Status</span>
            <Select value={filters.status} onChange={(event) => update("status", event.target.value as RideStatus | "")}>
              <option value="">Any status</option>
              {RIDE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {STATUS_SHORT_LABELS[status]}
                </option>
              ))}
            </Select>
          </label>

          <label className="block">
            <span className="eyebrow mb-1 block">Driver</span>
            <Select value={filters.driverId} onChange={(event) => update("driverId", event.target.value)}>
              <option value="">Any driver</option>
              {(directory.data?.drivers ?? []).map((driver) => (
                <option key={driver.id} value={driver.id}>
                  {driver.name}
                </option>
              ))}
            </Select>
          </label>

          <label className="block">
            <span className="eyebrow mb-1 block">Customer</span>
            <Select value={filters.customerId} onChange={(event) => update("customerId", event.target.value)}>
              <option value="">Any customer</option>
              {(directory.data?.customers ?? []).map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </Select>
          </label>

          <label className="block">
            <span className="eyebrow mb-1 block">Booked from</span>
            <Input type="date" value={filters.from} onChange={(event) => update("from", event.target.value)} />
          </label>

          <label className="block">
            <span className="eyebrow mb-1 block">Booked to</span>
            <Input type="date" value={filters.to} onChange={(event) => update("to", event.target.value)} />
          </label>

          <label className="block">
            <span className="eyebrow mb-1 block">Search</span>
            <Input
              type="search"
              placeholder="Reference, pickup or destination"
              value={filters.search}
              onChange={(event) => update("search", event.target.value)}
            />
          </label>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Rides                                                               */}
      {/* ------------------------------------------------------------------ */}
      {rides.isLoading ? (
        <LoadingRows count={4} />
      ) : rides.isError ? (
        <ErrorState message={errorMessage(rides.error)} onRetry={() => rides.refetch()} />
      ) : (rides.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          title={hasFilters ? "No rides match those filters" : "No rides yet"}
          description={
            hasFilters
              ? "Widen the date range or clear a filter to see more."
              : "Bookings will appear here as customers create them."
          }
          action={
            hasFilters ? (
              <Button variant="secondary" size="sm" onClick={() => { setFilters(EMPTY_FILTERS); setPage(1); }}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {/* Table on wide screens, cards on narrow ones. */}
          <div className="card hidden overflow-hidden md:block">
            <table className="w-full text-left text-[13px]">
              <thead className="border-b border-line bg-line-soft/60">
                <tr className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
                  <th className="px-4 py-2.5 font-medium">Ride</th>
                  <th className="px-4 py-2.5 font-medium">Route</th>
                  <th className="px-4 py-2.5 font-medium">Customer</th>
                  <th className="px-4 py-2.5 font-medium">Driver</th>
                  <th className="px-4 py-2.5 font-medium">Booked</th>
                  <th className="px-4 py-2.5 text-right font-medium">Fare</th>
                </tr>
              </thead>
              <tbody>
                {rides.data!.items.map((ride) => (
                  <tr key={ride.id} className="border-b border-line-soft last:border-0 hover:bg-paper/60">
                    <td className="px-4 py-3 align-top">
                      <Link href={`/rides/${ride.id}`} className="font-mono text-[12px] font-semibold text-signal hover:underline">
                        {ride.reference}
                      </Link>
                      <div className="mt-1.5">
                        <StatusBadge status={ride.status} />
                      </div>
                    </td>
                    <td className="max-w-[240px] px-4 py-3 align-top">
                      <p className="truncate text-ink">{ride.pickupAddress}</p>
                      <p className="truncate text-muted">{ride.destinationAddress}</p>
                      <p className="mt-0.5 font-mono text-[11px] text-muted">
                        {formatDistance(ride.estimatedDistanceKm)}
                      </p>
                    </td>
                    <td className="px-4 py-3 align-top text-ink">{ride.customer.name}</td>
                    <td className="px-4 py-3 align-top">
                      {ride.driver ? (
                        <>
                          <p className="text-ink">{ride.driver.name}</p>
                          {ride.driver.vehicle && (
                            <p className="font-mono text-[11px] text-muted">{ride.driver.vehicle}</p>
                          )}
                        </>
                      ) : (
                        <span className="text-muted">Unassigned</span>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top font-mono text-[11px] text-muted">
                      {formatDateTime(ride.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-right align-top font-mono font-semibold text-ink">
                      {formatMoney(ride.estimatedFareCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-3 md:hidden">
            {rides.data!.items.map((ride) => (
              <Link key={ride.id} href={`/rides/${ride.id}`} className="card block p-4">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[12px] font-semibold text-signal">{ride.reference}</span>
                  <StatusBadge status={ride.status} />
                  <span className="ml-auto font-mono text-[13px] font-semibold">
                    {formatMoney(ride.estimatedFareCents)}
                  </span>
                </div>
                <p className="mt-2 truncate text-[13px] text-ink">{ride.pickupAddress}</p>
                <p className="truncate text-[13px] text-muted">{ride.destinationAddress}</p>
                <p className="mt-1.5 font-mono text-[11px] text-muted">
                  {ride.customer.name}
                  {ride.driver ? ` · ${ride.driver.name}` : " · unassigned"}
                </p>
              </Link>
            ))}
          </div>

          {(rides.data?.totalPages ?? 1) > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <p className="font-mono text-[11px] text-muted">
                Page {rides.data!.page} of {rides.data!.totalPages} · {rides.data!.total} rides
              </p>
              <div className="flex gap-2">
                <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button
                  size="sm"
                  disabled={page >= (rides.data?.totalPages ?? 1)}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}

function Stat({
  label,
  value,
  loading,
  accent,
  hint,
}: {
  label: string;
  value: number | string | undefined;
  loading: boolean;
  accent?: "signal" | "motion" | "halt";
  hint?: string;
}) {
  return (
    <div className="card px-3.5 py-3">
      <p className="eyebrow">{label}</p>
      {loading && value === undefined ? (
        <Skeleton className="mt-2 h-6 w-12" />
      ) : (
        <p
          className={cx(
            "mt-1 font-mono text-xl font-semibold tabular-nums",
            accent === "signal" && "text-signal",
            accent === "motion" && "text-motion",
            accent === "halt" && "text-halt",
            !accent && "text-ink",
          )}
        >
          {value ?? "—"}
        </p>
      )}
      {hint && <p className="mt-0.5 text-[10px] text-muted">{hint}</p>}
    </div>
  );
}
