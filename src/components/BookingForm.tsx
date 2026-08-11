"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useCreateRide } from "@/lib/hooks";
import { errorMessage, fieldErrors, ApiError } from "@/lib/api";
import { createRideSchema } from "@/lib/schemas";
import { calculateFare, estimateDistanceKm, DEFAULT_FARE_CONFIG } from "@/domain/fare";
import { formatDistance, formatMoney, toLocalInputValue } from "@/lib/format";
import { Alert, Button, Field, Input, Textarea } from "./ui";

/**
 * Booking form.
 *
 * Three things worth pointing at:
 *
 *  1. Duplicate submission is handled twice. The button disables the moment a
 *     request is in flight, and every attempt carries an Idempotency-Key. The
 *     key is generated once per booking attempt and deliberately kept the same
 *     across retries, so retrying a request that timed out returns the original
 *     booking instead of creating a second one. A new key is minted only after
 *     a booking succeeds.
 *
 *  2. Validation runs against the same Zod schema the API uses, so the inline
 *     errors here and the 422 from the server can never disagree.
 *
 *  3. The fare shown is an estimate. The server recalculates it on arrival and
 *     that value is what gets stored — the number in the browser is never
 *     trusted. (If the rate card is changed through environment variables, this
 *     preview would need to read it from an endpoint rather than the defaults.)
 */
export function BookingForm({ onBooked }: { onBooked?: (rideId: string) => void }) {
  const createRide = useCreateRide();
  const idempotencyKey = useRef(crypto.randomUUID());

  const [pickupAddress, setPickupAddress] = useState("");
  const [destinationAddress, setDestinationAddress] = useState("");
  const [requestedAt, setRequestedAt] = useState(() =>
    toLocalInputValue(new Date(Date.now() + 30 * 60_000)),
  );
  const [notes, setNotes] = useState("");
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const [booked, setBooked] = useState<{ id: string; reference: string } | null>(null);

  const errors = { ...fieldErrors(createRide.error), ...clientErrors };

  // Live preview, recomputed as the person types.
  const preview = useMemo(() => {
    if (pickupAddress.trim().length < 4 || destinationAddress.trim().length < 4) return null;
    const km = estimateDistanceKm({ pickupAddress, destinationAddress });
    return { km, fare: calculateFare(km, DEFAULT_FARE_CONFIG) };
  }, [pickupAddress, destinationAddress]);

  function reset() {
    setPickupAddress("");
    setDestinationAddress("");
    setNotes("");
    setRequestedAt(toLocalInputValue(new Date(Date.now() + 30 * 60_000)));
    setClientErrors({});
    createRide.reset();
    idempotencyKey.current = crypto.randomUUID(); // a genuinely new booking
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (createRide.isPending) return;

    const parsed = createRideSchema.safeParse({
      pickupAddress,
      destinationAddress,
      requestedAt: new Date(requestedAt).toISOString(),
      notes: notes.trim() || undefined,
    });

    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.join(".");
        if (!next[key]) next[key] = issue.message;
      }
      setClientErrors(next);
      return;
    }

    setClientErrors({});
    createRide.mutate(
      { ...parsed.data, idempotencyKey: idempotencyKey.current },
      {
        onSuccess: (data) => {
          setBooked({ id: data.ride.id, reference: data.ride.reference });
          onBooked?.(data.ride.id);
        },
      },
    );
  }

  if (booked) {
    return (
      <div className="card p-5">
        <p className="eyebrow">Booking confirmed</p>
        <p className="mt-2 font-mono text-lg font-semibold text-signal">{booked.reference}</p>
        <p className="mt-1 text-[13px] text-muted">
          We are looking for a driver now. The status updates itself on the booking page.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href={`/rides/${booked.id}`}>
            <Button variant="primary" size="sm">
              Track this ride
            </Button>
          </Link>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setBooked(null);
              reset();
            }}
          >
            Book another
          </Button>
        </div>
      </div>
    );
  }

  const failure = createRide.error;
  const showRetry = failure instanceof ApiError && failure.isRetryable;

  return (
    <form onSubmit={handleSubmit} noValidate className="card space-y-4 p-5">
      <div>
        <p className="eyebrow">New booking</p>
        <h2 className="mt-1 text-base font-semibold text-ink">Where are you going?</h2>
      </div>

      {/* The form never claims success on a failure: this alert appears, the
          fields keep what was typed, and the same key makes a retry safe. */}
      {createRide.isError && Object.keys(fieldErrors(failure)).length === 0 && (
        <Alert
          tone="error"
          title="Your booking was not created"
          action={
            showRetry ? (
              <Button size="sm" variant="secondary" onClick={() => handleSubmit(new Event("submit") as never)}>
                Try again
              </Button>
            ) : undefined
          }
        >
          {errorMessage(failure)}
        </Alert>
      )}

      <Field label="Pickup" htmlFor="pickup" error={errors.pickupAddress} required>
        <Input
          id="pickup"
          value={pickupAddress}
          invalid={Boolean(errors.pickupAddress)}
          placeholder="Bandra Kurla Complex, Mumbai"
          onChange={(event) => setPickupAddress(event.target.value)}
        />
      </Field>

      <Field label="Destination" htmlFor="destination" error={errors.destinationAddress} required>
        <Input
          id="destination"
          value={destinationAddress}
          invalid={Boolean(errors.destinationAddress)}
          placeholder="Chhatrapati Shivaji Airport T2"
          onChange={(event) => setDestinationAddress(event.target.value)}
        />
      </Field>

      <Field
        label="Pickup time"
        htmlFor="requestedAt"
        error={errors.requestedAt}
        hint="Up to 30 days ahead."
        required
      >
        <Input
          id="requestedAt"
          type="datetime-local"
          value={requestedAt}
          invalid={Boolean(errors.requestedAt)}
          onChange={(event) => setRequestedAt(event.target.value)}
        />
      </Field>

      <Field label="Notes for the driver" htmlFor="notes" error={errors.notes} hint="Optional.">
        <Textarea
          id="notes"
          rows={2}
          value={notes}
          maxLength={500}
          invalid={Boolean(errors.notes)}
          placeholder="Two suitcases, please call on arrival"
          onChange={(event) => setNotes(event.target.value)}
        />
      </Field>

      <div className="flex items-center justify-between border-t border-line-soft pt-4">
        <div>
          <p className="eyebrow">Estimated fare</p>
          <p className="mt-0.5 font-mono text-lg font-semibold text-ink">
            {preview ? formatMoney(preview.fare.totalCents) : "—"}
          </p>
          {preview && (
            <p className="font-mono text-[11px] text-muted">
              {formatDistance(preview.km)}
              {preview.fare.minimumApplied && " · minimum fare"}
            </p>
          )}
        </div>
        <Button type="submit" variant="primary" loading={createRide.isPending}>
          {createRide.isPending ? "Booking" : "Book ride"}
        </Button>
      </div>
    </form>
  );
}
