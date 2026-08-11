"use client";

import Link from "next/link";
import { use, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { HistoryTimeline } from "@/components/HistoryTimeline";
import { LifecycleRail } from "@/components/LifecycleRail";
import { StatusBadge } from "@/components/StatusBadge";
import { Alert, Button, ErrorState, LoadingRows, Textarea } from "@/components/ui";
import { useCancelRide, useRide, useSession, useUpdateStatus } from "@/lib/hooks";
import { errorMessage } from "@/lib/api";
import { STATUS_LABELS } from "@/domain/rideStatus";
import { formatDateTime, formatDistance, formatMoney } from "@/lib/format";

/**
 * One ride, seen by whoever is signed in.
 *
 * There is a single detail page rather than three, because the ride is the same
 * object for everyone. What differs is the list of actions, and that list is
 * computed on the server from the state machine and returned with the ride —
 * so the buttons on this page can never offer something the API would refuse.
 *
 * The page polls while the ride is still moving (see useRide), which is what
 * makes the customer's view update after the driver changes the status.
 */
export default function RideDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const session = useSession();
  const { data, isLoading, isError, error, refetch, isFetching } = useRide(id);
  const updateStatus = useUpdateStatus();
  const cancelRide = useCancelRide();

  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");

  const ride = data?.ride;
  const role = session.data?.user.role ?? "CUSTOMER";
  const actionError = updateStatus.error ?? cancelRide.error;

  const forwardActions = (ride?.availableActions ?? []).filter((action) => action.to !== "CANCELLED");
  const canCancel = (ride?.availableActions ?? []).some((action) => action.to === "CANCELLED");

  return (
    <AppShell
      title={ride ? `Ride ${ride.reference}` : "Ride"}
      subtitle={ride ? STATUS_LABELS[ride.status] : undefined}
      actions={
        <Link href={role === "ADMIN" ? "/admin" : role === "DRIVER" ? "/driver" : "/customer"}>
          <Button variant="ghost" size="sm">
            Back
          </Button>
        </Link>
      }
    >
      {isLoading ? (
        <LoadingRows count={2} />
      ) : isError ? (
        <ErrorState
          title="This ride is not available"
          message={errorMessage(error)}
          onRetry={() => refetch()}
        />
      ) : !ride ? null : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          {/* ---------------------------------------------------------- */}
          {/* Left: status, route, actions                                */}
          {/* ---------------------------------------------------------- */}
          <div className="space-y-5">
            <section className="card p-5">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={ride.status} />
                {isFetching && (
                  <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
                    updating…
                  </span>
                )}
                <span className="ml-auto font-mono text-lg font-semibold text-ink">
                  {formatMoney(ride.estimatedFareCents)}
                </span>
              </div>

              <LifecycleRail status={ride.status} className="mt-5" />

              <dl className="mt-6 grid gap-4 sm:grid-cols-2">
                <Detail label="Pickup" value={ride.pickupAddress} />
                <Detail label="Destination" value={ride.destinationAddress} />
                <Detail label="Pickup time" value={formatDateTime(ride.requestedAt)} mono />
                <Detail label="Distance" value={formatDistance(ride.estimatedDistanceKm)} mono />
                <Detail label="Booked" value={formatDateTime(ride.createdAt)} mono />
                {ride.completedAt && (
                  <Detail label="Completed" value={formatDateTime(ride.completedAt)} mono />
                )}
              </dl>

              {ride.notes && (
                <div className="mt-4 border-t border-line-soft pt-4">
                  <p className="eyebrow">Note from the customer</p>
                  <p className="mt-1 text-[13px] text-ink">{ride.notes}</p>
                </div>
              )}

              {ride.cancellationReason && (
                <div className="mt-4 border-t border-line-soft pt-4">
                  <p className="eyebrow">Reason for cancelling</p>
                  <p className="mt-1 text-[13px] text-ink">{ride.cancellationReason}</p>
                </div>
              )}
            </section>

            {actionError && (
              <Alert tone="error" title="That change did not go through">
                {errorMessage(actionError)}
              </Alert>
            )}

            {(forwardActions.length > 0 || canCancel) && (
              <section className="card p-5">
                <p className="eyebrow">What happens next</p>

                <div className="mt-3 flex flex-wrap gap-2">
                  {forwardActions.map((action) => (
                    <Button
                      key={action.to}
                      variant="primary"
                      loading={updateStatus.isPending && updateStatus.variables?.status === action.to}
                      disabled={updateStatus.isPending || cancelRide.isPending}
                      onClick={() =>
                        updateStatus.mutate({
                          rideId: ride.id,
                          status: action.to,
                          // Compare-and-set: if the ride moved since this page
                          // loaded, the server rejects it instead of clobbering.
                          expectedStatus: ride.status,
                        })
                      }
                    >
                      {action.label}
                    </Button>
                  ))}

                  {canCancel && !cancelling && (
                    <Button variant="danger" onClick={() => setCancelling(true)}>
                      Cancel booking
                    </Button>
                  )}
                </div>

                {cancelling && (
                  <div className="mt-4 border-t border-line-soft pt-4">
                    <label htmlFor="reason" className="block text-[13px] font-medium text-ink-soft">
                      Why are you cancelling? <span className="text-muted">(optional)</span>
                    </label>
                    <Textarea
                      id="reason"
                      rows={2}
                      className="mt-1.5"
                      maxLength={300}
                      value={reason}
                      placeholder="Plans changed"
                      onChange={(event) => setReason(event.target.value)}
                    />
                    <div className="mt-3 flex gap-2">
                      <Button
                        variant="danger"
                        loading={cancelRide.isPending}
                        onClick={() =>
                          cancelRide.mutate(
                            { rideId: ride.id, reason: reason.trim() || undefined },
                            { onSuccess: () => { setCancelling(false); setReason(""); } },
                          )
                        }
                      >
                        Cancel this booking
                      </Button>
                      <Button variant="ghost" onClick={() => setCancelling(false)}>
                        Keep it
                      </Button>
                    </div>
                  </div>
                )}
              </section>
            )}
          </div>

          {/* ---------------------------------------------------------- */}
          {/* Right: people and history                                    */}
          {/* ---------------------------------------------------------- */}
          <div className="space-y-5">
            <section className="card p-5">
              <p className="eyebrow">Driver</p>
              {ride.driver ? (
                <div className="mt-2">
                  <p className="text-[14px] font-medium text-ink">{ride.driver.name}</p>
                  {ride.driver.vehicle && (
                    <p className="mt-0.5 font-mono text-[11px] text-muted">{ride.driver.vehicle}</p>
                  )}
                  {ride.driver.phone && (
                    <p className="mt-1 font-mono text-[12px] text-muted">{ride.driver.phone}</p>
                  )}
                </div>
              ) : (
                <p className="mt-2 text-[13px] text-muted">
                  No driver yet. We are still looking.
                </p>
              )}

              {(role === "DRIVER" || role === "ADMIN") && (
                <div className="mt-4 border-t border-line-soft pt-4">
                  <p className="eyebrow">Customer</p>
                  <p className="mt-2 text-[14px] font-medium text-ink">{ride.customer.name}</p>
                  {ride.customer.phone && (
                    <p className="mt-1 font-mono text-[12px] text-muted">{ride.customer.phone}</p>
                  )}
                </div>
              )}
            </section>

            <section className="card p-5">
              <p className="eyebrow mb-3">Status history</p>
              <HistoryTimeline entries={ride.history ?? []} />
            </section>
          </div>
        </div>
      )}
    </AppShell>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className={`mt-1 text-[13px] text-ink ${mono ? "font-mono text-[12px]" : ""}`}>{value}</dd>
    </div>
  );
}
