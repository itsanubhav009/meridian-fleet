"use client";

import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { BookingForm } from "@/components/BookingForm";
import { RideCard } from "@/components/RideCard";
import { EmptyState, ErrorState, LoadingRows, Button } from "@/components/ui";
import { useRides } from "@/lib/hooks";
import { errorMessage } from "@/lib/api";
import { ACTIVE_STATUSES } from "@/domain/rideStatus";

/**
 * Customer home: book a ride, then watch the ones already booked.
 *
 * The list is split so the ride happening right now is not buried under
 * history — the thing a customer opens this page to check is almost always the
 * one still in motion.
 */
export default function CustomerPage() {
  const [showForm, setShowForm] = useState(true);
  const rides = useRides({ pageSize: 50 });

  const items = rides.data?.items ?? [];
  const live = items.filter(
    (ride) => ride.status === "REQUESTED" || (ACTIVE_STATUSES as readonly string[]).includes(ride.status),
  );
  const past = items.filter((ride) => ride.status === "COMPLETED" || ride.status === "CANCELLED");

  return (
    <AppShell
      allow={["CUSTOMER"]}
      title="Your rides"
      subtitle="Book a trip and follow it from request to drop-off."
      actions={
        <Button variant={showForm ? "ghost" : "primary"} size="sm" onClick={() => setShowForm((open) => !open)}>
          {showForm ? "Hide booking form" : "Book a ride"}
        </Button>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6 lg:order-2">{showForm && <BookingForm />}</div>

        <div className="space-y-6 lg:order-1">
          <section>
            <h2 className="eyebrow mb-3">In progress</h2>
            {rides.isLoading ? (
              <LoadingRows count={2} />
            ) : rides.isError ? (
              <ErrorState message={errorMessage(rides.error)} onRetry={() => rides.refetch()} />
            ) : live.length === 0 ? (
              <EmptyState
                title="No rides in progress"
                description="Book a ride and it will appear here while a driver is found."
                action={
                  !showForm ? (
                    <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
                      Book a ride
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="space-y-3">
                {live.map((ride) => (
                  <RideCard key={ride.id} ride={ride} viewerRole="CUSTOMER" />
                ))}
              </div>
            )}
          </section>

          {past.length > 0 && (
            <section>
              <h2 className="eyebrow mb-3">Earlier rides</h2>
              <div className="space-y-3">
                {past.map((ride) => (
                  <RideCard key={ride.id} ride={ride} viewerRole="CUSTOMER" />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </AppShell>
  );
}
