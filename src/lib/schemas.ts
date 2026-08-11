import { z } from "zod";
import { RIDE_STATUSES } from "@/domain/rideStatus";

/**
 * Request schemas, defined once and imported by both sides.
 *
 * The browser uses them to show inline field errors before sending anything;
 * the API uses them to reject whatever actually arrives. Sharing the schema
 * means the two can never drift apart — but the server still validates
 * independently, because client-side validation is a convenience, not a
 * security control.
 */

export const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Enter your email address.")
    .email("That does not look like an email address."),
  password: z.string().min(1, "Enter your password."),
});
export type LoginInput = z.infer<typeof loginSchema>;

const coordinate = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  })
  .optional()
  .nullable();

export const createRideSchema = z.object({
  pickupAddress: z
    .string()
    .trim()
    .min(4, "Pickup needs at least 4 characters.")
    .max(200, "Pickup is too long (200 characters max)."),
  destinationAddress: z
    .string()
    .trim()
    .min(4, "Destination needs at least 4 characters.")
    .max(200, "Destination is too long (200 characters max)."),
  requestedAt: z
    .string()
    .min(1, "Choose a pickup date and time.")
    .refine((value) => !Number.isNaN(Date.parse(value)), "That is not a valid date and time.")
    .refine(
      (value) => Date.parse(value) > Date.now() - 15 * 60_000,
      "Pickup time cannot be in the past.",
    )
    .refine(
      (value) => Date.parse(value) < Date.now() + 30 * 24 * 60 * 60_000,
      "Pickup time cannot be more than 30 days ahead.",
    ),
  notes: z.string().trim().max(500, "Notes are limited to 500 characters.").optional(),
  /** Optional manual override; otherwise the server estimates it. */
  distanceKm: z
    .number()
    .positive("Distance must be greater than zero.")
    .max(500, "Distance must be under 500 km.")
    .optional()
    .nullable(),
  pickup: coordinate,
  destination: coordinate,
});
export type CreateRideInput = z.infer<typeof createRideSchema>;

export const updateStatusSchema = z.object({
  status: z.enum(RIDE_STATUSES, {
    errorMap: () => ({ message: "That is not a ride status this system recognises." }),
  }),
  /** The status the client believed the ride was in — optimistic concurrency. */
  expectedStatus: z.enum(RIDE_STATUSES).optional(),
  note: z.string().trim().max(300).optional(),
});
export type UpdateStatusInput = z.infer<typeof updateStatusSchema>;

export const cancelRideSchema = z.object({
  reason: z.string().trim().max(300, "Keep the reason under 300 characters.").optional(),
});
export type CancelRideInput = z.infer<typeof cancelRideSchema>;

const csvOf = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((value) => value.split(",").map((v) => v.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)));

export const rideQuerySchema = z.object({
  status: csvOf(RIDE_STATUSES).optional(),
  scope: z.enum(["mine", "available", "all"]).optional(),
  customerId: z.string().uuid().optional(),
  driverId: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type RideQuery = z.infer<typeof rideQuerySchema>;

export const metricsQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  driverId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
});
export type MetricsQuery = z.infer<typeof metricsQuerySchema>;
