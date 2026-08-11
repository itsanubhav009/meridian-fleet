# Architecture

## The shape of it

```
┌──────────────────────────────────────────────────────────────────────┐
│  Browser                                                             │
│                                                                      │
│  Pages          /  ·  /customer  ·  /driver  ·  /admin  ·  /rides/id │
│  Components     AppShell · BookingForm · RideCard · LifecycleRail    │
│  State          TanStack Query — caching, retries, polling           │
│  Transport      src/lib/api.ts — fetch + 15s timeout + typed errors  │
└───────────────────────────────┬──────────────────────────────────────┘
                                │  JSON over HTTPS
                                │  Bearer token or httpOnly cookie
┌───────────────────────────────▼──────────────────────────────────────┐
│  middleware.ts        verifies the cookie, routes pages by role       │
│                       (convenience only — not the security boundary)  │
├──────────────────────────────────────────────────────────────────────┤
│  Route handlers       src/app/api/**/route.ts                         │
│                       parse → authenticate → delegate → respond       │
│                       every one wrapped by route() for error mapping  │
├──────────────────────────────────────────────────────────────────────┤
│  Services             src/server/services/*.ts                        │
│                       the business rules. who may do what, when.      │
│                       knows nothing about HTTP or SQL.                │
├──────────────────────────────────────────────────────────────────────┤
│  Repositories         src/server/repositories/*.ts                    │
│                       every SQL statement in the codebase.            │
│                       rows in, domain objects out.                    │
├──────────────────────────────────────────────────────────────────────┤
│  Database client      src/server/db/client.ts                         │
│                       postgres:// → pg.Pool   pglite:// → WASM        │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                     ┌──────────▼──────────┐
                     │  PostgreSQL 16      │
                     │  CHECK constraints  │
                     │  partial unique idx │
                     │  append-only history│
                     └─────────────────────┘

        src/domain/   pure functions and types, imported by BOTH sides
                      rideStatus.ts · fare.ts · types.ts
```

`src/domain` is the piece that earns its place. The status machine is imported
by the service that enforces it *and* by the component that draws the lifecycle
rail, so the UI and the API can never disagree about what the statuses are.

---

## One request, end to end

`PATCH /api/rides/:id/status` with `{ "status": "STARTED" }`:

```
1  middleware        does the cookie carry a valid signature?  (page routes only)
2  route()           wraps the handler; anything thrown below becomes JSON
3  requireSession    verify JWT → { userId, role }         401 if absent/invalid
4  parseUuid         is :id actually a UUID?                422 if not
5  parseBody         Zod: is "STARTED" a real status?       422 if not
6  rideService       load the ride                          404 if not visible to this user
                     is this user the assigned driver?      403 if not
                     canTransition(from, to)?               409 if not
7  repository        UPDATE … WHERE id = $1 AND status = $2 409 if rowCount = 0
                     INSERT INTO ride_status_history        same transaction
8  response          200 with the updated ride + its available actions
```

Steps 3, 6 and 7 each independently refuse the request. That redundancy is
deliberate: the middleware could be deleted and nothing would leak.

---

## Why these layers

**Route handlers stay thin** — parse, delegate, respond. They are plain
`(Request) => Response` functions with no dependency on `next/headers`, which is
why the tests can call them directly and still exercise validation, auth,
business rules and SQL in one pass. No mocking, no running server.

**Services own the rules.** `rideService.updateStatus` is where "only the
assigned driver may start a ride" lives. It takes a session and arguments and
throws `AppError`s; it has never heard of HTTP status codes.

**Repositories own the SQL.** Every statement in the project is in one of two
files, so the indexes in `db/migrations/001_init.sql` can be justified against a
finite, readable list of queries. No ORM generating something surprising at 2am.

**Errors travel as `AppError`.** A code, a human-readable message, and optional
field details. `src/server/errors.ts` maps each code to a status once:

| Code | HTTP |
| --- | --- |
| `VALIDATION_ERROR` | 422 |
| `UNAUTHENTICATED`, `INVALID_CREDENTIALS` | 401 |
| `FORBIDDEN` | 403 |
| `NOT_FOUND` | 404 |
| `RIDE_ALREADY_ASSIGNED`, `INVALID_STATUS_TRANSITION`, `DRIVER_HAS_ACTIVE_RIDE`, `DUPLICATE_REQUEST` | 409 |
| `RATE_LIMITED` | 429 |
| `INTERNAL_ERROR` | 500 |

Unexpected exceptions get a generated incident ID: the full error goes to the
server log, and the client receives the ID and nothing else. Stack traces are
not a user-facing feature.

---

## The state machine

`src/domain/rideStatus.ts` states the transition table once:

```ts
const TRANSITIONS = {
  REQUESTED:       ["ACCEPTED", "CANCELLED"],
  ACCEPTED:        ["DRIVER_ARRIVING", "CANCELLED"],
  DRIVER_ARRIVING: ["STARTED", "CANCELLED"],
  STARTED:         ["COMPLETED"],       // no cancelling mid-journey
  COMPLETED:       [],                  // terminal
  CANCELLED:       [],                  // terminal
} as const;
```

Three things read this table:

1. `canTransition(from, to)` — the service's gate.
2. `availableTransitions(status, role)` — returned with every ride, so the
   client renders buttons from the server's answer instead of its own guess.
3. `LifecycleRail` — the visual progression.

Adding a status (a plausible live interview request) means: add it to the union,
add its row, add a label, and add it to the `CHECK` constraint in a new
migration. The compiler then lists every place that needs attention, because the
`Record<RideStatus, …>` maps stop being exhaustive.

---

## Authentication and authorisation

**Authentication.** Email plus bcrypt (10 rounds). On success the server signs an
HS256 JWT carrying `sub`, `role`, `name`, `email`, and sets it as an httpOnly,
`SameSite=Lax`, `Secure`-in-production cookie. The same token is returned in the
body so an API client can use `Authorization: Bearer`. `readTokenFromRequest`
checks the header first, then the cookie.

Login deliberately gives the same error for an unknown email and a wrong
password, and runs a dummy bcrypt comparison when the email does not exist so
the two paths take similar time. Otherwise the endpoint is an account-existence
oracle.

**Authorisation** happens in the services, per resource:

- A customer sees only rides where `customer_id` is theirs.
- A driver sees rides assigned to them, plus the open `REQUESTED` queue.
- An admin sees everything.

Asking for someone else's ride returns **404, not 403**. A 403 would confirm the
ride exists, which is a small information leak that costs nothing to avoid.
Role violations on a resource you *can* see still return 403, because there is
nothing to hide.

---

## Real-time updates

TanStack Query polls: every 5 seconds for a ride in motion, 15 for lists, and it
stops at a terminal status. Polling was the right call for the scope — it works
through every proxy, needs no extra infrastructure, and survives a sleeping
laptop.

At real scale it is wrong: N drivers × 12 requests/minute of mostly-unchanged
JSON. The upgrade path, in order of effort:

1. Add `updated_at` to the list response and support `If-Modified-Since`, so
   unchanged polls cost a 304 instead of a payload.
2. Server-Sent Events for the customer's single-ride view — one-directional,
   plain HTTP, no protocol change.
3. WebSockets once drivers push GPS pings, since that traffic is bidirectional
   and frequent. At that point the poll loops become subscriptions and the
   query cache is updated from the socket instead of the network.

The client already isolates this: every fetch goes through `src/lib/api.ts` and
every subscription through the hooks in `src/lib/hooks.ts`. Components would not
change.

---

## Failure handling

**On the client.** Every request has a 15-second `AbortController` timeout, so a
hung connection surfaces as a real error instead of a spinner forever. Reads
retry twice with backoff; writes never retry automatically, because a retried
`POST` is a duplicate booking — that is what the idempotency key is for. Every
list has explicit loading, error-with-retry and empty states.

**On the server.** Unexpected errors are logged with an incident ID and returned
as a generic 500. Constraint violations are translated rather than leaked: 23505
on the driver index becomes `DRIVER_HAS_ACTIVE_RIDE`, on the idempotency index
it becomes a replay of the original booking.

**In the database.** Status change plus history row happen in one transaction,
so the audit trail cannot drift from the ride. The history table is append-only.

---

## What I would change first at real volume

1. **Move the metrics off the rides table.** `GET /api/admin/metrics` scans and
   aggregates. It is indexed and fine at thousands of rows; at millions it wants
   a rollup table updated on completion, or a materialised view.
2. **Replace the in-memory login throttle with Redis.** Per-instance memory is
   not a rate limiter once there is more than one instance.
3. **Cursor pagination instead of `OFFSET`.** `OFFSET 10000` makes Postgres walk
   ten thousand rows to discard them.
4. **Push instead of poll** (above).
5. **Partition `ride_status_history` by month.** It is the fastest-growing table
   and is almost always queried for a single recent ride.
