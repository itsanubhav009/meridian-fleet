# Database

PostgreSQL 16. Three tables, one sequence, eight indexes. Migrations live in
`db/migrations/`, run in filename order, and are recorded in a
`schema_migrations` table so they apply once.

```
┌──────────────────────┐
│ users                │
│──────────────────────│
│ id            UUID PK│◀────────┐
│ name          TEXT   │         │
│ email         TEXT UQ│         │
│ password_hash TEXT   │         │
│ role          TEXT   │         │  customer_id
│ phone         TEXT   │         │  driver_id
│ vehicle       TEXT   │         │  changed_by
└──────────────────────┘         │
                                 │
┌────────────────────────────────┴─────┐
│ rides                                │
│──────────────────────────────────────│
│ id                    UUID PK        │◀───┐
│ reference             TEXT UQ        │    │
│ customer_id           UUID FK NOT NULL    │
│ driver_id             UUID FK NULL   │    │
│ pickup_address        TEXT           │    │
│ destination_address   TEXT           │    │
│ pickup_lat/lng        NUMERIC(9,6)   │    │
│ destination_lat/lng   NUMERIC(9,6)   │    │
│ estimated_distance_km NUMERIC(6,2)   │    │  ride_id
│ estimated_fare_cents  INTEGER        │    │  ON DELETE CASCADE
│ status                TEXT CHECK     │    │
│ notes                 TEXT           │    │
│ cancellation_reason   TEXT           │    │
│ requested_at          TIMESTAMPTZ    │    │
│ created_at/updated_at TIMESTAMPTZ    │    │
│ accepted_at           TIMESTAMPTZ    │    │
│ started_at            TIMESTAMPTZ    │    │
│ completed_at          TIMESTAMPTZ    │    │
│ cancelled_at          TIMESTAMPTZ    │    │
│ idempotency_key       TEXT           │    │
└──────────────────────────────────────┘    │
                                            │
┌───────────────────────────────────────────┴──┐
│ ride_status_history        (append-only)     │
│──────────────────────────────────────────────│
│ id              UUID PK                      │
│ ride_id         UUID FK NOT NULL             │
│ previous_status TEXT NULL   (NULL at create) │
│ new_status      TEXT NOT NULL                │
│ changed_by      UUID FK NOT NULL             │
│ changed_by_role TEXT NOT NULL                │
│ note            TEXT                         │
│ created_at      TIMESTAMPTZ                  │
└──────────────────────────────────────────────┘
```

---

## Choices worth defending

**Money is `INTEGER` paise, never `FLOAT`.** `0.1 + 0.2 !== 0.3` in binary
floating point, and money that drifts by a paise per ride is a reconciliation
bug that surfaces months later. `NUMERIC` would also be correct; integers are
faster and, since the smallest unit is a paise, lose nothing.

**Distance is `NUMERIC(6,2)`, not float.** Same reasoning, and it also bounds the
value: no ride of 100,000 km.

**Status is `TEXT` with a `CHECK`, not an `ENUM`.** Adding a value to a Postgres
enum is a migration that historically could not run inside a transaction, and
removing one is worse. A `CHECK` is edited with a plain `ALTER TABLE` and reads
identically. It still makes an invalid status impossible to write, even from
`psql`.

**Timestamps are `TIMESTAMPTZ`.** Stored in UTC, rendered in the viewer's zone.
A fleet operating across zones with naive timestamps is a guaranteed incident.

**Per-event columns (`accepted_at`, `started_at`, `completed_at`) as well as a
history table.** The history table is the truth and the audit trail; the columns
are a denormalisation so "average time from request to pickup" is one scan
instead of a self-join. Both are written in the same transaction.

**`ON DELETE RESTRICT` on user references.** Deleting a user who has rides would
orphan financial records. Deactivating a user is an application concern; the
database refuses to make the data inconsistent.

**`ON DELETE CASCADE` from history to ride.** History has no meaning without its
ride.

**A sequence for the human-readable reference.** `RD-01001` is what a customer
reads out on the phone. A sequence gives uniqueness with no round trip to check
for collisions; UUIDs remain the actual keys.

---

## Every index, and the query that justifies it

**`idx_rides_open_queue` — partial, `WHERE status = 'REQUESTED'`, on `requested_at ASC`**

```sql
SELECT … FROM rides WHERE status = 'REQUESTED' ORDER BY requested_at ASC;
```

The driver's queue, polled by every driver every few seconds — the hottest read
in the system. Partial matters: this index only ever holds the open backlog, so
it stays small and cache-resident no matter how many million completed rides
accumulate. A full index on `status` would grow forever and mostly hold rows
this query never wants.

**`idx_rides_customer_recent` — `(customer_id, created_at DESC)`**

```sql
SELECT … FROM rides WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20;
```

The customer's "my bookings" page. Composite in this order because the equality
column comes first and the sort column second, so Postgres can seek to the
customer and then walk rows already in order — no sort step.

**`idx_rides_driver_recent` — `(driver_id, created_at DESC) WHERE driver_id IS NOT NULL`**

The driver's history, same shape. Partial because roughly a third of rides are
unassigned and NULL entries would be dead weight.

**`idx_rides_status_created` — `(status, created_at DESC)`**

```sql
SELECT … FROM rides WHERE status = $1 AND created_at BETWEEN $2 AND $3
ORDER BY created_at DESC;
```

The admin dashboard filtered by status, and the metrics aggregation.

**`idx_rides_created` — `(created_at DESC)`**

The admin dashboard with no status filter — the default view.

**`idx_history_ride_time` — `(ride_id, created_at ASC)`**

Renders one ride's timeline oldest-first. Ascending because that is the display
order, so the index is walked forward rather than backward.

**`idx_users_role_name` — `(role, name)`**

Populates the "filter by driver" and "filter by customer" dropdowns, already
alphabetised.

---

## The two indexes that are really constraints

**`uniq_driver_single_active_ride`**

```sql
CREATE UNIQUE INDEX uniq_driver_single_active_ride
  ON rides (driver_id)
  WHERE status IN ('ACCEPTED', 'DRIVER_ARRIVING', 'STARTED');
```

A driver may hold at most one live ride. Partial-unique is the whole trick: the
uniqueness applies only to rows in a live status, so a driver can have a hundred
completed rides and still take another job. Expressing this in application code
would require a lock; here Postgres enforces it against every writer, including
a direct `psql` session. A violation arrives as SQLSTATE 23505 and the service
maps it to `409 DRIVER_HAS_ACTIVE_RIDE`.

**`uniq_rides_customer_idempotency`**

```sql
CREATE UNIQUE INDEX uniq_rides_customer_idempotency
  ON rides (customer_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

Makes `POST /api/rides` safely retryable. Scoped per customer so two customers
cannot collide on the same key, and partial so the overwhelming majority of
rows — those without a key — are not indexed at all.

**`rides_driver_matches_status`** is a table `CHECK`: a ride past `REQUESTED`
must have a driver, and a `REQUESTED` ride must not. It makes the impossible
state unrepresentable rather than merely unlikely.

---

## Reading the plan yourself

```sql
EXPLAIN ANALYZE
SELECT * FROM rides WHERE status = 'REQUESTED' ORDER BY requested_at ASC LIMIT 20;
```

On seed data Postgres may choose a sequential scan — with thirteen rows that is
genuinely faster, and it is the planner being right, not the index being wrong.
To see the index used, seed a larger table first.

---

## Migrations

`scripts/migrate.ts` reads `db/migrations/*.sql` in filename order, skips any
already listed in `schema_migrations`, and applies the rest inside a
transaction.

Twenty-five lines, no framework. It is enough for this project and it is
completely legible, which matters more here than features. A real system with
several developers wants down-migrations and drift detection, and at that point
I would reach for a tool rather than grow this one.

Adding a status — the change most likely to come up in an interview — is a new
file:

```sql
-- 002_add_waiting_status.sql
ALTER TABLE rides DROP CONSTRAINT rides_status_check;
ALTER TABLE rides ADD CONSTRAINT rides_status_check CHECK (status IN (
  'REQUESTED', 'ACCEPTED', 'DRIVER_ARRIVING', 'WAITING',
  'STARTED', 'COMPLETED', 'CANCELLED'));
```

…plus the union member and transition row in `src/domain/rideStatus.ts`. The
compiler then points at every exhaustive map that needs the new key.
