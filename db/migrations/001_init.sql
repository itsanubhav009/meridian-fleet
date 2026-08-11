-- ===========================================================================
-- 001_init.sql — Meridian Fleet initial schema
--
-- Design notes that matter:
--   * Money is stored as INTEGER paise/cents, never FLOAT. Floating point
--     arithmetic on money produces rounding drift (0.1 + 0.2 !== 0.3).
--   * Status values are constrained by CHECK, so an invalid status cannot be
--     written even by a direct SQL statement that bypasses the service layer.
--   * The "two drivers accept the same ride" race is prevented by the database,
--     not by application-level read-then-write logic. See the partial unique
--     index at the bottom plus the conditional UPDATE in rideRepository.ts.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- users
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY,
  name           TEXT        NOT NULL CHECK (length(btrim(name)) > 0),
  -- Emails are lower-cased by the repository before insert/lookup, so a plain
  -- UNIQUE constraint is enough to make them case-insensitive in practice.
  email          TEXT        NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash  TEXT        NOT NULL,
  role           TEXT        NOT NULL CHECK (role IN ('CUSTOMER', 'DRIVER', 'ADMIN')),
  phone          TEXT,
  vehicle        TEXT, -- drivers only; NULL for customers and admins
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Admin dashboard populates "filter by driver" / "filter by customer" pickers.
CREATE INDEX IF NOT EXISTS idx_users_role_name ON users (role, name);

-- --------------------------------------------------------------------------
-- rides
-- --------------------------------------------------------------------------

-- Human-readable booking reference (RD-01001, RD-01002, ...). A sequence gives
-- uniqueness without a round trip to check for collisions.
CREATE SEQUENCE IF NOT EXISTS ride_reference_seq START WITH 1001;

CREATE TABLE IF NOT EXISTS rides (
  id                     UUID PRIMARY KEY,
  reference              TEXT        NOT NULL UNIQUE,

  customer_id            UUID        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  driver_id              UUID                 REFERENCES users (id) ON DELETE RESTRICT,

  pickup_address         TEXT        NOT NULL CHECK (length(btrim(pickup_address)) > 0),
  destination_address    TEXT        NOT NULL CHECK (length(btrim(destination_address)) > 0),
  pickup_lat             NUMERIC(9, 6),
  pickup_lng             NUMERIC(9, 6),
  destination_lat        NUMERIC(9, 6),
  destination_lng        NUMERIC(9, 6),

  estimated_distance_km  NUMERIC(6, 2) NOT NULL CHECK (estimated_distance_km > 0),
  estimated_fare_cents   INTEGER       NOT NULL CHECK (estimated_fare_cents >= 0),

  status                 TEXT        NOT NULL CHECK (status IN (
                           'REQUESTED', 'ACCEPTED', 'DRIVER_ARRIVING',
                           'STARTED', 'COMPLETED', 'CANCELLED')),

  notes                  TEXT,
  cancellation_reason    TEXT,

  requested_at           TIMESTAMPTZ NOT NULL,  -- when the customer wants pickup
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at            TIMESTAMPTZ,
  started_at             TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ,
  cancelled_at           TIMESTAMPTZ,

  -- Client-supplied key used to make POST /api/rides safely retryable.
  idempotency_key        TEXT,

  -- A ride past REQUESTED must have a driver; a REQUESTED ride must not.
  CONSTRAINT rides_driver_matches_status CHECK (
    (status = 'REQUESTED' AND driver_id IS NULL)
    OR (status = 'CANCELLED')
    OR (status IN ('ACCEPTED', 'DRIVER_ARRIVING', 'STARTED', 'COMPLETED') AND driver_id IS NOT NULL)
  )
);

-- Index: driver "available rides" feed.
--   SELECT ... FROM rides WHERE status = 'REQUESTED' ORDER BY requested_at ASC
-- The partial predicate keeps the index tiny — it only ever holds the open
-- backlog, not the millions of historical completed rides.
CREATE INDEX IF NOT EXISTS idx_rides_open_queue
  ON rides (requested_at ASC)
  WHERE status = 'REQUESTED';

-- Index: "my bookings" for a customer, newest first.
--   SELECT ... WHERE customer_id = $1 ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_rides_customer_recent
  ON rides (customer_id, created_at DESC);

-- Index: "my rides" for a driver, newest first.
--   SELECT ... WHERE driver_id = $1 ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_rides_driver_recent
  ON rides (driver_id, created_at DESC)
  WHERE driver_id IS NOT NULL;

-- Index: admin dashboard filtered by status and date range.
--   SELECT ... WHERE status = $1 AND created_at BETWEEN $2 AND $3 ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_rides_status_created
  ON rides (status, created_at DESC);

-- Index: admin dashboard with no status filter, ordered by recency.
CREATE INDEX IF NOT EXISTS idx_rides_created
  ON rides (created_at DESC);

-- Constraint: retrying POST /api/rides with the same Idempotency-Key must not
-- create a second booking. Scoped per customer so keys can never collide
-- across accounts.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_rides_customer_idempotency
  ON rides (customer_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Constraint: a driver may hold at most ONE in-flight ride. This is the
-- database-level backstop for the concurrent-acceptance scenario. Even if two
-- requests somehow pass the conditional UPDATE, Postgres rejects the second
-- with SQLSTATE 23505 and the service maps that to HTTP 409.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_driver_single_active_ride
  ON rides (driver_id)
  WHERE status IN ('ACCEPTED', 'DRIVER_ARRIVING', 'STARTED');

-- --------------------------------------------------------------------------
-- ride_status_history — append-only audit trail
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ride_status_history (
  id               UUID PRIMARY KEY,
  ride_id          UUID        NOT NULL REFERENCES rides (id) ON DELETE CASCADE,
  previous_status  TEXT,       -- NULL for the row written at creation time
  new_status       TEXT        NOT NULL,
  changed_by       UUID        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  changed_by_role  TEXT        NOT NULL CHECK (changed_by_role IN ('CUSTOMER', 'DRIVER', 'ADMIN')),
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index: render a ride's timeline oldest-first.
--   SELECT ... WHERE ride_id = $1 ORDER BY created_at ASC
CREATE INDEX IF NOT EXISTS idx_history_ride_time
  ON ride_status_history (ride_id, created_at ASC);
