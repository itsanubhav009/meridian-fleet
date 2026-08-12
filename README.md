

# Meridian Fleet

A mini fleet booking and tracking platform. Customers book rides, drivers pick
them up from a shared queue and drive them through a status lifecycle, and an
admin watches the whole fleet.

Built for the Junior Full-Stack Developer project assignment.

---

## Contents

| Document | What is in it |
| --- | --- |
| This file | Setup, credentials, assumptions, limitations |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layers, request flow, diagrams, why the design is shaped this way |
| [docs/API.md](docs/API.md) | Every endpoint, with request and response examples |
| [docs/DATABASE.md](docs/DATABASE.md) | Schema, every index and the query it exists for |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Deploying to Vercel + Neon |
| [docs/DECISIONS.md](docs/DECISIONS.md) | The judgement calls, and what I would change |

---

## The problem

Three people need three different views of the same object.

- A **customer** books a ride and wants to know where it is.
- A **driver** wants the next job and a way to report progress.
- An **admin** wants to know what the fleet is doing and what it earned.

A ride moves through a fixed lifecycle:

```
REQUESTED ──▶ ACCEPTED ──▶ DRIVER_ARRIVING ──▶ STARTED ──▶ COMPLETED
     │            │               │
     └────────────┴───────────────┴──▶ CANCELLED
```

Most of the interesting work is in the rules around that diagram: a ride cannot
skip from `REQUESTED` to `COMPLETED`, a completed ride cannot be cancelled, a
ride cannot be started before someone accepts it, and **two drivers must never
end up holding the same ride**. That last one is a concurrency problem, and it
is solved in the database rather than in JavaScript — see
[Concurrency](#concurrency) below.

---

## Tech stack

| Layer | Choice | Why |
| --- | --- | --- |
| Framework | Next.js 15 (App Router), React 19 | One codebase, one deploy, one set of types shared by client and server |
| Language | TypeScript (strict) | The status lifecycle is a union type, so an impossible status is a compile error |
| Database | PostgreSQL 16 | Partial unique indexes and `CHECK` constraints do the concurrency work |
| Data access | `pg` with hand-written SQL | The indexes only matter if I know the queries; an ORM would hide them |
| Validation | Zod | One schema per payload, shared by the API and the forms |
| Auth | JWT (HS256) via `jose`, `bcryptjs` | Stateless, works on serverless, no session table |
| Client state | TanStack Query | Caching, retries and polling without hand-rolled `useEffect` chains |
| Styling | Tailwind CSS v4 | Design tokens live in one `@theme` block |
| Tests | Vitest + PGlite | Real Postgres in the test process — no Docker, no mocks |

---

## Running it

Requires **Node 20+**. A local Postgres is optional (see below).

```bash
git clone <your-repo-url>
cd meridian-fleet
npm install
cp .env.example .env.local
```

Open `.env.local` and set `JWT_SECRET` to any string of 32+ characters
(`openssl rand -base64 48` will do it). Then:

```bash
npm run db:migrate   # create the schema
npm run db:seed      # 8 demo users, 13 rides across every status
npm run dev          # http://localhost:3000
```

### Two ways to get a database

**Option A — a real Postgres** (what production uses). Point `DATABASE_URL` at
it:

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/meridian_fleet
```

**Option B — no install at all.** Set:

```
DATABASE_URL=pglite://.pgdata
```

PGlite is genuine Postgres compiled to WebAssembly, running inside the Node
process and persisting to a folder. Constraints, transactions, sequences and
error codes behave exactly as the real server does, which makes it ideal for a
reviewer who does not want to install anything.

One caveat, stated plainly: PGlite is a **single connection**, so it serialises
requests that a real server would run in parallel. Use it for development and
for the test suite; use real Postgres for anything where concurrency matters.
`next start` in particular runs multiple worker processes and PGlite cannot be
shared between them.

---

## Test credentials

Every seeded account uses the password from `SEED_PASSWORD`, which defaults to
`Password123!`.

| Role | Email | Notes |
| --- | --- | --- |
| Admin | `admin@meridianfleet.test` | Fleet dashboard, metrics, all filters |
| Customer | `priya@meridianfleet.test` | Has rides in several states |
| Customer | `arjun@meridianfleet.test` | Useful for checking one customer cannot see another's rides |
| Customer | `meera@meridianfleet.test` | |
| Driver | `rahul@meridianfleet.test` | |
| Driver | `sunita@meridianfleet.test` | Open a second browser as this driver to race Rahul for a ride |
| Driver | `imran@meridianfleet.test` | |
| Driver | `deepa@meridianfleet.test` | Already mid-trip in the seed data |

The sign-in page lists these accounts and fills the form in one tap. The
password is read from `NEXT_PUBLIC_DEMO_PASSWORD` and is never hardcoded in the
source; if that variable is unset the page shows the emails without a password,
which is what you want in a real deployment.

---

## Tests

```bash
npm test          # 73 tests, no setup needed (PGlite)
npm run test:watch
```

Against a real Postgres, four extra concurrency tests unskip themselves:

```bash
createdb fleet_test
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/fleet_test npm test
# 77 passed
```

Each test file gets its own throwaway schema, so files can run side by side.
CI (`.github/workflows/ci.yml`) runs the full 77 against Postgres 16, plus
`tsc --noEmit`, ESLint and a production build.

What the suite actually covers:

- **State machine** — every legal transition allowed, every illegal one refused,
  including the exact ones the brief calls out.
- **Fare** — base + per-km, minimum fare floor, rounding, integer arithmetic.
- **Auth** — wrong password, unknown email, forged signature, tampered payload,
  expired token, missing token, repeated-failure throttling.
- **Authorisation** — a customer cannot read another customer's ride, cannot
  move a ride's status, and cannot reach admin endpoints; an unassigned driver
  cannot touch a ride that is not theirs.
- **Booking** — validation of every field, idempotent retries, pagination,
  ownership scoping.
- **Concurrency** — eight drivers accepting one ride simultaneously, one driver
  trying to hold two rides, six identical form submissions at once, two status
  updates racing. Each asserts the HTTP results *and* then queries the database
  to confirm the rows agree.
- **Metrics** — revenue counts completed rides only, filters apply, no
  divide-by-zero on an empty fleet.

---

## Concurrency

This is the part of the assignment worth reading the code for. Two drivers tap
"Accept" on the same ride in the same instant.

The naive version reads, checks, then writes — and loses, because both requests
read `REQUESTED` before either writes:

```ts
const ride = await findById(id);
if (ride.status !== "REQUESTED") throw conflict();  // both pass here
await assignDriver(id, driverId);                   // both write
```

The version in `src/server/repositories/rideRepository.ts` makes the check and
the write the same statement, so Postgres serialises them:

```sql
UPDATE rides
   SET driver_id = $2, status = 'ACCEPTED', accepted_at = now(), updated_at = now()
 WHERE id = $1
   AND status = 'REQUESTED'      -- the check…
   AND driver_id IS NULL         -- …is part of the write
RETURNING *;
```

The loser gets `rowCount = 0`, which becomes `409 RIDE_ALREADY_ASSIGNED`. No
transaction isolation level to reason about, no lock held across a round trip.

Behind that sits a partial unique index, so the rule holds even against a
direct `psql` session:

```sql
CREATE UNIQUE INDEX uniq_driver_single_active_ride
  ON rides (driver_id)
  WHERE status IN ('ACCEPTED', 'DRIVER_ARRIVING', 'STARTED');
```

Duplicate form submissions are handled the same way — an `Idempotency-Key`
header plus a partial unique index — rather than by disabling the button and
hoping.

---

## Assumptions

1. **Distance is estimated, not routed.** With coordinates the app uses the
   haversine distance scaled by 1.25 to approximate road winding; with only
   addresses it derives a deterministic 2–28 km value by hashing the strings.
   The brief allows a mock; `estimateDistanceKm` is a single function and a real
   routing provider would replace its body without touching anything else.
2. **Fares are estimates.** The fare is computed at booking time from distance
   and never recomputed, so a customer sees one number for the life of the ride.
   No surge, no waiting charges, no tolls.
3. **One live ride per driver.** Enforced in the schema. Real dispatch systems
   allow queued jobs; that would be a different index.
4. **Money is integer paise.** No floats anywhere near a fare. Currency is INR
   throughout and is not configurable.
5. **A cancelled ride is terminal.** No reinstating, no rebooking flow.
6. **Admins observe, they do not drive.** An admin can see and cancel any ride
   but cannot accept one or move it through the driving statuses.
7. **Anyone signed in with a valid token exists.** There is no per-request
   database lookup to confirm the user still exists, which is the usual
   stateless-JWT trade-off.

---

## Known limitations

I would rather list these than have them found.

- **Updates are polled, not pushed.** The client re-fetches every 5 seconds
  while a ride is moving and stops at a terminal status. It is honest and it
  works; it is not a socket. The upgrade path is in
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#real-time-updates).
- **The login throttle is per-instance and in memory.** It slows a single
  attacker against one process. It does nothing across serverless instances,
  and it resets on deploy. Real answer: Redis, or the platform's rate limiter.
- **JWTs cannot be revoked before they expire.** Signing out clears the cookie,
  but a copied token stays valid until it expires (8 hours by default). Fixing
  it properly means short access tokens plus refresh tokens, or a session table
  — both of which cost a database read per request.
- **No refresh tokens.** After 8 hours you sign in again.
- **Distance is mocked** (see Assumptions).
- **No email, no notifications, no payments.** A completed ride records a fare;
  nothing collects it.
- **Admin filters do not persist in the URL.** Reloading the dashboard clears
  them, and a filtered view cannot be shared as a link. Worth fixing; it is
  about twenty lines with `useSearchParams`.
- **No pagination on the status history** of a single ride. Fine at six rows,
  wrong at six hundred.
- **Accessibility is decent but unaudited.** Semantic elements, labelled
  inputs, visible focus rings, and the status colours are distinguishable in
  greyscale because each status also carries a distinct label. I have not run a
  screen reader over it.

---

## Not built

Listed because the brief asks for honesty about scope rather than silence.

- Google Maps integration (explicitly optional; the mock is documented above).
- Live driver GPS tracking on a map. The schema has coordinate columns and the
  history table would carry pings, but there is no moving marker.
- Ratings, fare adjustments, driver earnings reports.
- Password reset and account self-registration. Users come from the seed script;
  in a real system an admin would invite them.

---

## AI assistance disclosure

The assignment asks for this explicitly, so here it is without hedging.

I used **Claude (Anthropic)** while building this project, mainly for:

- talking through the concurrency approach before committing to it,
- drafting boilerplate — the UI primitives, the Zod schemas, repetitive test
  cases,
- writing first drafts of this documentation,
- reviewing my SQL and pointing out that `SET search_path` would not survive a
  connection pool, which is why the test harness pins the schema on the
  connection string instead.

What I did myself, and what I can defend line by line: the data model and every
index on it, the decision to solve the accept race with a conditional `UPDATE`
plus a partial unique index rather than application logic, the layering
(routes → services → repositories), the choice to return `404` instead of `403`
for another customer's ride so the API never confirms it exists, and the
decision to compute available actions on the server so the UI cannot offer a
transition the API would reject.

I have read every file in this repository, and where I used generated code I
understand why it works. The commits are grouped by concern — schema, then data
access, then services, then API, then UI, then tests and docs — rather than being
a minute-by-minute record of the session.

---

## Repository layout

```
db/migrations/        SQL, applied in order and tracked in schema_migrations
scripts/              migrate, seed, reset
src/domain/           pure logic — status machine, fare, shared types
src/server/
  db/                 driver selection (pg or PGlite), migration runner
  auth/               password hashing, JWT signing and verification
  http/               route wrapper, error mapping, session, validation
  repositories/       every SQL statement in the codebase lives here
  services/           business rules; the only layer that knows the rules
src/app/api/          route handlers — parse, delegate, respond
src/app/              pages: sign-in, customer, driver, admin, ride detail
src/components/       reusable UI, including the lifecycle rail
src/lib/              client-side fetch wrapper, hooks, formatters, schemas
tests/                unit + integration, including the concurrency suite
```

