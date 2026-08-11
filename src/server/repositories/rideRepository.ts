import { randomUUID } from "node:crypto";
import type { Database, Queryable } from "../db/types";
import { isUniqueViolation } from "../db/types";
import type { Role, RideStatus } from "../../domain/rideStatus";
import { ACTIVE_STATUSES } from "../../domain/rideStatus";
import type { Coordinates, Paginated, Ride, RideHistoryEntry } from "../../domain/types";

/**
 * All SQL against `rides` and `ride_status_history`.
 *
 * The two statements worth reading closely are `accept` and `changeStatus`.
 * Both are single conditional UPDATEs: the current status is part of the WHERE
 * clause, so the check and the write happen in one atomic statement. There is
 * no window between "read the ride" and "write the ride" for a second request
 * to slip into. If the UPDATE matches zero rows, somebody else got there first.
 */

// ---------------------------------------------------------------------------
// Row shape and mapping
// ---------------------------------------------------------------------------
interface RideRow {
  id: string;
  reference: string;
  customer_id: string;
  driver_id: string | null;
  pickup_address: string;
  destination_address: string;
  pickup_lat: string | null;
  pickup_lng: string | null;
  destination_lat: string | null;
  destination_lng: string | null;
  estimated_distance_km: string;
  estimated_fare_cents: number;
  status: RideStatus;
  notes: string | null;
  cancellation_reason: string | null;
  requested_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
  accepted_at: Date | string | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  cancelled_at: Date | string | null;
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
  driver_name: string | null;
  driver_email: string | null;
  driver_phone: string | null;
  driver_vehicle: string | null;
}

/** Postgres NUMERIC arrives as a string to avoid silent precision loss. */
function num(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function coords(lat: string | null, lng: string | null): Coordinates | null {
  const a = num(lat);
  const b = num(lng);
  return a === null || b === null ? null : { lat: a, lng: b };
}

function toRide(row: RideRow): Ride {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    customer: {
      id: row.customer_id,
      name: row.customer_name,
      email: row.customer_email,
      phone: row.customer_phone,
    },
    driver: row.driver_id
      ? {
          id: row.driver_id,
          name: row.driver_name ?? "",
          email: row.driver_email ?? "",
          phone: row.driver_phone,
          vehicle: row.driver_vehicle,
        }
      : null,
    pickupAddress: row.pickup_address,
    destinationAddress: row.destination_address,
    pickup: coords(row.pickup_lat, row.pickup_lng),
    destination: coords(row.destination_lat, row.destination_lng),
    estimatedDistanceKm: num(row.estimated_distance_km) ?? 0,
    estimatedFareCents: Number(row.estimated_fare_cents),
    notes: row.notes,
    cancellationReason: row.cancellation_reason,
    requestedAt: iso(row.requested_at)!,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    acceptedAt: iso(row.accepted_at),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    cancelledAt: iso(row.cancelled_at),
  };
}

const RIDE_SELECT = `
  SELECT r.*,
         c.name    AS customer_name,
         c.email   AS customer_email,
         c.phone   AS customer_phone,
         d.name    AS driver_name,
         d.email   AS driver_email,
         d.phone   AS driver_phone,
         d.vehicle AS driver_vehicle
    FROM rides r
    JOIN users c ON c.id = r.customer_id
    LEFT JOIN users d ON d.id = r.driver_id
`;

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
interface HistoryRow {
  id: string;
  ride_id: string;
  previous_status: RideStatus | null;
  new_status: RideStatus;
  changed_by: string;
  changed_by_role: Role;
  note: string | null;
  created_at: Date | string;
  changed_by_name: string;
}

export async function insertHistory(
  db: Queryable,
  entry: {
    rideId: string;
    previousStatus: RideStatus | null;
    newStatus: RideStatus;
    changedBy: string;
    changedByRole: Role;
    note?: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO ride_status_history
       (id, ride_id, previous_status, new_status, changed_by, changed_by_role, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      entry.rideId,
      entry.previousStatus,
      entry.newStatus,
      entry.changedBy,
      entry.changedByRole,
      entry.note ?? null,
    ],
  );
}

export async function findHistory(
  db: Queryable,
  rideId: string,
): Promise<RideHistoryEntry[]> {
  // Served by idx_history_ride_time.
  const { rows } = await db.query<HistoryRow>(
    `SELECT h.*, u.name AS changed_by_name
       FROM ride_status_history h
       JOIN users u ON u.id = h.changed_by
      WHERE h.ride_id = $1
      ORDER BY h.created_at ASC, h.id ASC`,
    [rideId],
  );
  return rows.map((row) => ({
    id: row.id,
    rideId: row.ride_id,
    previousStatus: row.previous_status,
    newStatus: row.new_status,
    changedBy: { id: row.changed_by, name: row.changed_by_name, role: row.changed_by_role },
    note: row.note,
    createdAt: iso(row.created_at)!,
  }));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export async function findById(db: Queryable, id: string): Promise<Ride | null> {
  const { rows } = await db.query<RideRow>(`${RIDE_SELECT} WHERE r.id = $1`, [id]);
  return rows[0] ? toRide(rows[0]) : null;
}

export interface RideFilters {
  status?: RideStatus[];
  customerId?: string;
  driverId?: string;
  /** ISO date-time lower bound on created_at, inclusive. */
  from?: string;
  /** ISO date-time upper bound on created_at, inclusive. */
  to?: string;
  /** Free-text match on reference, pickup or destination. */
  search?: string;
  /** Rides with no driver yet — the driver-facing open queue. */
  unassignedOnly?: boolean;
}

export interface PageRequest {
  page: number;
  pageSize: number;
  /** REQUESTED-first for the driver queue, newest-first everywhere else. */
  order?: "requested_at_asc" | "created_at_desc";
}

/**
 * Builds the WHERE clause from whichever filters are present.
 *
 * Values are always passed as bind parameters ($1, $2, ...) and never
 * concatenated into the SQL string — that is what makes this immune to SQL
 * injection even though the clause is assembled dynamically.
 */
function buildWhere(filters: RideFilters): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    conditions.push(sql.replace("?", `$${params.length}`));
  };

  if (filters.status?.length) add("r.status = ANY(?)", filters.status);
  if (filters.customerId) add("r.customer_id = ?", filters.customerId);
  if (filters.driverId) add("r.driver_id = ?", filters.driverId);
  if (filters.from) add("r.created_at >= ?", filters.from);
  if (filters.to) add("r.created_at <= ?", filters.to);
  if (filters.unassignedOnly) conditions.push("r.driver_id IS NULL");
  if (filters.search) {
    params.push(`%${filters.search.trim()}%`);
    const p = `$${params.length}`;
    conditions.push(
      `(r.reference ILIKE ${p} OR r.pickup_address ILIKE ${p} OR r.destination_address ILIKE ${p})`,
    );
  }

  return {
    clause: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

export async function list(
  db: Queryable,
  filters: RideFilters,
  page: PageRequest,
): Promise<Paginated<Ride>> {
  const { clause, params } = buildWhere(filters);
  const orderBy =
    page.order === "requested_at_asc"
      ? "ORDER BY r.requested_at ASC"
      : "ORDER BY r.created_at DESC";

  const limit = Math.min(Math.max(page.pageSize, 1), 100);
  const offset = (Math.max(page.page, 1) - 1) * limit;

  const [items, total] = await Promise.all([
    db.query<RideRow>(
      `${RIDE_SELECT} ${clause} ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
    db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM rides r ${clause}`,
      params,
    ),
  ]);

  const totalCount = Number(total.rows[0]?.count ?? 0);
  return {
    items: items.rows.map(toRide),
    page: Math.max(page.page, 1),
    pageSize: limit,
    total: totalCount,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
  };
}

export async function findByIdempotencyKey(
  db: Queryable,
  customerId: string,
  key: string,
): Promise<Ride | null> {
  // Served by uniq_rides_customer_idempotency.
  const { rows } = await db.query<RideRow>(
    `${RIDE_SELECT} WHERE r.customer_id = $1 AND r.idempotency_key = $2`,
    [customerId, key],
  );
  return rows[0] ? toRide(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
export interface CreateRideInput {
  customerId: string;
  pickupAddress: string;
  destinationAddress: string;
  pickup: Coordinates | null;
  destination: Coordinates | null;
  estimatedDistanceKm: number;
  estimatedFareCents: number;
  requestedAt: string;
  notes: string | null;
  idempotencyKey: string | null;
}

/**
 * Creates the ride and its first history row in one transaction, so a ride can
 * never exist without the audit entry that explains how it started.
 */
export async function create(db: Database, input: CreateRideInput): Promise<Ride> {
  const id = randomUUID();

  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO rides (
         id, reference, customer_id,
         pickup_address, destination_address,
         pickup_lat, pickup_lng, destination_lat, destination_lng,
         estimated_distance_km, estimated_fare_cents,
         status, notes, requested_at, idempotency_key
       ) VALUES (
         $1, 'RD-' || lpad(nextval('ride_reference_seq')::text, 5, '0'), $2,
         $3, $4,
         $5, $6, $7, $8,
         $9, $10,
         'REQUESTED', $11, $12, $13
       )`,
      [
        id,
        input.customerId,
        input.pickupAddress,
        input.destinationAddress,
        input.pickup?.lat ?? null,
        input.pickup?.lng ?? null,
        input.destination?.lat ?? null,
        input.destination?.lng ?? null,
        input.estimatedDistanceKm,
        input.estimatedFareCents,
        input.notes,
        input.requestedAt,
        input.idempotencyKey,
      ],
    );
    await insertHistory(tx, {
      rideId: id,
      previousStatus: null,
      newStatus: "REQUESTED",
      changedBy: input.customerId,
      changedByRole: "CUSTOMER",
      note: "Booking created",
    });
  });

  const ride = await findById(db, id);
  if (!ride) throw new Error("Ride disappeared immediately after insert");
  return ride;
}

export type AcceptOutcome =
  | { ok: true; ride: Ride }
  | { ok: false; reason: "NOT_FOUND" | "ALREADY_ASSIGNED" | "DRIVER_BUSY" };

/**
 * Assigns a driver to a REQUESTED ride.
 *
 * Concurrency, in two layers:
 *
 *   1. `WHERE id = $2 AND status = 'REQUESTED' AND driver_id IS NULL`
 *      Postgres takes a row lock for the duration of the UPDATE, so if two
 *      requests arrive together one of them updates 0 rows. No read-then-write,
 *      no application-level lock, no race window.
 *
 *   2. `uniq_driver_single_active_ride`
 *      A partial unique index that stops one driver from holding two live
 *      rides, which the conditional UPDATE alone would not catch. It surfaces
 *      as SQLSTATE 23505 and becomes a 409.
 */
export async function accept(
  db: Database,
  rideId: string,
  driverId: string,
): Promise<AcceptOutcome> {
  let updatedId: string | null = null;

  try {
    updatedId = await db.transaction(async (tx) => {
      const result = await tx.query<{ id: string }>(
        `UPDATE rides
            SET driver_id   = $1,
                status      = 'ACCEPTED',
                accepted_at = now(),
                updated_at  = now()
          WHERE id = $2
            AND status = 'REQUESTED'
            AND driver_id IS NULL
          RETURNING id`,
        [driverId, rideId],
      );

      if (result.rowCount === 0) return null;

      await insertHistory(tx, {
        rideId,
        previousStatus: "REQUESTED",
        newStatus: "ACCEPTED",
        changedBy: driverId,
        changedByRole: "DRIVER",
        note: "Driver accepted the ride",
      });
      return rideId;
    });
  } catch (error) {
    if (isUniqueViolation(error, "uniq_driver_single_active_ride")) {
      return { ok: false, reason: "DRIVER_BUSY" };
    }
    throw error;
  }

  if (updatedId === null) {
    // Zero rows updated. Work out which of the two reasons it was, so the
    // driver sees "someone beat you to it" rather than a generic failure.
    const existing = await db.query<{ id: string }>("SELECT id FROM rides WHERE id = $1", [
      rideId,
    ]);
    return existing.rowCount === 0
      ? { ok: false, reason: "NOT_FOUND" }
      : { ok: false, reason: "ALREADY_ASSIGNED" };
  }

  const ride = await findById(db, updatedId);
  return ride ? { ok: true, ride } : { ok: false, reason: "NOT_FOUND" };
}

export type StatusChangeOutcome =
  | { ok: true; ride: Ride }
  | { ok: false; reason: "NOT_FOUND" | "STATUS_MOVED" };

/**
 * Moves a ride from `expectedStatus` to `nextStatus`.
 *
 * `expectedStatus` in the WHERE clause is optimistic concurrency control: the
 * update only lands if the ride is still where the caller last saw it. A
 * duplicate or stale request updates zero rows instead of overwriting a newer
 * state — which is also what makes a retried request harmless.
 */
export async function changeStatus(
  db: Database,
  args: {
    rideId: string;
    expectedStatus: RideStatus;
    nextStatus: RideStatus;
    actorId: string;
    actorRole: Role;
    note?: string | null;
    cancellationReason?: string | null;
  },
): Promise<StatusChangeOutcome> {
  const updatedId = await db.transaction(async (tx) => {
    const result = await tx.query<{ id: string }>(
      `UPDATE rides
          SET status              = $1,
              updated_at          = now(),
              started_at          = CASE WHEN $1 = 'STARTED'   THEN now() ELSE started_at   END,
              completed_at        = CASE WHEN $1 = 'COMPLETED' THEN now() ELSE completed_at END,
              cancelled_at        = CASE WHEN $1 = 'CANCELLED' THEN now() ELSE cancelled_at END,
              cancellation_reason = CASE WHEN $1 = 'CANCELLED' THEN $2 ELSE cancellation_reason END
        WHERE id = $3
          AND status = $4
        RETURNING id`,
      [args.nextStatus, args.cancellationReason ?? null, args.rideId, args.expectedStatus],
    );

    if (result.rowCount === 0) return null;

    await insertHistory(tx, {
      rideId: args.rideId,
      previousStatus: args.expectedStatus,
      newStatus: args.nextStatus,
      changedBy: args.actorId,
      changedByRole: args.actorRole,
      note: args.note ?? null,
    });
    return args.rideId;
  });

  if (updatedId === null) {
    const existing = await db.query<{ id: string }>("SELECT id FROM rides WHERE id = $1", [
      args.rideId,
    ]);
    return existing.rowCount === 0
      ? { ok: false, reason: "NOT_FOUND" }
      : { ok: false, reason: "STATUS_MOVED" };
  }

  const ride = await findById(db, updatedId);
  return ride ? { ok: true, ride } : { ok: false, reason: "NOT_FOUND" };
}

// ---------------------------------------------------------------------------
// Aggregates for the admin dashboard
// ---------------------------------------------------------------------------
export interface RideAggregates {
  countsByStatus: Record<string, number>;
  completedRevenueCents: number;
  completedCount: number;
  driversOnTrip: number;
}

export async function aggregate(
  db: Queryable,
  filters: RideFilters = {},
): Promise<RideAggregates> {
  const { clause, params } = buildWhere(filters);

  // One grouped scan rather than six COUNT queries.
  const counts = await db.query<{ status: string; count: string; fare_sum: string | null }>(
    `SELECT r.status,
            COUNT(*)::text AS count,
            COALESCE(SUM(r.estimated_fare_cents), 0)::text AS fare_sum
       FROM rides r
       ${clause}
      GROUP BY r.status`,
    params,
  );

  const countsByStatus: Record<string, number> = {};
  let completedRevenueCents = 0;
  let completedCount = 0;
  let driversOnTrip = 0;

  for (const row of counts.rows) {
    const count = Number(row.count);
    countsByStatus[row.status] = count;
    if (row.status === "COMPLETED") {
      completedCount = count;
      completedRevenueCents = Number(row.fare_sum ?? 0);
    }
    if ((ACTIVE_STATUSES as readonly string[]).includes(row.status)) {
      driversOnTrip += count;
    }
  }

  return { countsByStatus, completedRevenueCents, completedCount, driversOnTrip };
}
