# Decisions

The reasoning behind the choices in this project, including the ones I am least
sure about. Organised roughly the way the assignment's question list is.

---

## Architecture

**Why Next.js rather than a separate React app and Express API?**

The requirement is one small product with three role-based views and about ten
endpoints. A split stack would mean two deployments, two dependency trees, a
CORS configuration, and duplicated TypeScript types across the boundary. Next
gives one codebase where the `Ride` type is imported by both the endpoint that
produces it and the component that renders it, so a field rename is a compile
error rather than a runtime surprise.

The trade-off is real: the API is coupled to a React framework and cannot be
consumed by a mobile app without dragging Next along. If a native client were on
the roadmap, I would have split them.

**Would this structure survive tripling in size?**

Mostly. The layering (routes → services → repositories) is the part that scales;
adding invoices means `invoiceService.ts` and `invoiceRepository.ts` alongside the
existing ones. The part that would strain is `rideService.ts`, which is already
the largest file and would want splitting by use case once there were more rules.
`src/domain` stays pure regardless, which is what keeps the rules testable.

**What was hardest?**

Getting the accept race right *and* being able to prove it. The logic took ten
minutes; realising my test could not actually demonstrate it took longer. PGlite
runs on a single connection, so eight "simultaneous" accepts were being
serialised by the test harness — the test passed and proved almost nothing. The
fix was making the harness able to run against real Postgres on an isolated
schema, and gating four concurrency tests on that. They now run in CI against
Postgres 16 with genuinely parallel connections.

---

## Frontend

**How is state managed?**

Three kinds, deliberately separated:

- *Server state* — rides, metrics, session — lives in TanStack Query. It is
  cached, deduplicated, refetched on window focus, and polled while a ride is
  moving. It is never copied into `useState`, because two copies of the same
  fact drift.
- *UI state* — which tab, is the cancel box open, filter values — is local
  `useState` in the component that owns it.
- *Form state* — controlled inputs plus a `fieldErrors` map populated from the
  API's 422 response, so client and server validation render identically.

No Redux, no Context for data. Query keys encode the parameters, so changing a
filter is a new key and a new cache entry rather than a manual invalidation.

**Which components are reusable, and how are they split?**

`src/components/ui.tsx` holds the primitives — `Button`, `Input`, `Select`,
`Field`, `Alert`, `Skeleton`, `EmptyState`, `ErrorState`. Above those sit
domain components used by more than one page: `StatusBadge`, `LifecycleRail`,
`HistoryTimeline`, `RideCard`, `AppShell`, `BookingForm`.

The split is by *what a thing knows*. A `Button` knows nothing about rides. A
`RideCard` knows about rides but not about who is looking at it — it takes
`viewerRole` and an optional `onAccept`, so the driver board and the customer
list use the same card without either importing the other's logic.

**How are loading, error and empty states handled?**

Every list renders one of four things, never a blank area: skeleton rows while
loading, an error panel with a retry button, an empty state with a next action,
or the data. Mutations disable their button and show a spinner in place of the
label, which prevents the double-submit that idempotency then catches anyway.

**How does the UI stay in sync when a driver changes status?**

The customer's ride detail view polls every 5 seconds while the ride is live and
stops at a terminal status. Mutations also invalidate the relevant query keys, so
the actor sees the change immediately and the other party sees it within a few
seconds.

**Why does the server decide which buttons exist?**

Each ride carries `availableActions`, computed from the state machine and the
caller's role. The alternative — the client deriving the same rules — means two
implementations that must agree forever. With one implementation the UI cannot
offer a move the API would reject, and adding a status changes the buttons
everywhere without touching a component.

---

## Backend

**How are requests validated?**

Zod schemas in `src/lib/schemas.ts`, shared by the API and the forms. Handlers
call `parseBody` / `parseQuery`, which throw a `VALIDATION_ERROR` carrying
per-field messages; the client maps that straight onto the form. Validation
happens before any business logic runs, so services can trust their inputs.

**How are errors handled centrally?**

Every route is wrapped by `route()`, which catches everything. `AppError`s carry
a code that maps to a status in exactly one place. Zod errors become 422s.
Anything unrecognised is logged with a generated incident ID and returned as a
generic 500 — the client gets the ID, never a stack trace.

**Why 404 instead of 403 for someone else's ride?**

A 403 confirms the resource exists. Given sequential-looking references, that
turns the endpoint into an enumeration oracle. Returning 404 for anything the
caller may not see costs nothing and reveals nothing. Role violations on a
resource you *can* see still return 403, because there is nothing left to hide.

**How is duplicate acceptance prevented?**

Not with a read-then-write check, which loses the race by construction. One
conditional statement:

```sql
UPDATE rides SET driver_id = $2, status = 'ACCEPTED', accepted_at = now()
 WHERE id = $1 AND status = 'REQUESTED' AND driver_id IS NULL
RETURNING *;
```

Postgres serialises the row update, so exactly one caller gets `rowCount = 1`
and the rest get zero, which becomes 409. Behind that, a partial unique index
enforces one live ride per driver even against a direct SQL session. Two layers,
both in the database, neither depending on application timing.

**Where would you add caching?**

Not on rides — they change constantly and staleness there is the one thing users
notice. The admin metrics endpoint is the candidate: aggregate queries, read far
more often than the underlying data changes. A 30-second cache would remove most
of that load, and at real volume I would precompute into a rollup table on ride
completion instead.

---

## Database

*(Full detail in [DATABASE.md](DATABASE.md); the short answers.)*

**Why these indexes?** Each one exists for a specific query, and every query in
the project lives in one of two repository files, so the list is finite and
checkable. The two most interesting are partial: the open-queue index only holds
`REQUESTED` rides, so the hottest read in the system touches an index that never
grows past the current backlog.

**Why integer paise for money?** Binary floating point cannot represent 0.1
exactly, so float arithmetic on money drifts. Integers of the smallest unit
cannot.

**Why a separate history table when the ride has timestamp columns?** The history
table is the audit trail — who changed what, when, in what order, including
transitions that do not have a column. The timestamp columns are a
denormalisation for reporting speed. Both are written in one transaction, so
they cannot disagree.

**Would you denormalise anything?** Not yet at this size. The first candidate
would be caching driver and customer names on the ride row to avoid two joins on
the admin list — I would only do it once a profile showed those joins mattering,
and it would introduce a real cost: names would need updating in two places.

---

## Security

**How are passwords stored?** bcrypt, 10 rounds. Never logged, never returned by
any endpoint, not even to an admin.

**How are tokens handled?** HS256 JWT in an httpOnly, `SameSite=Lax`,
`Secure`-in-production cookie, so JavaScript cannot read it and CSRF from another
origin cannot ride along on a state-changing request. The token is also returned
in the login body for API clients.

**What stops a customer calling an admin endpoint?** `requireRole` on the server,
checked per request from the verified token — not from anything the client sends.
The middleware that routes pages by role is convenience only; deleting it would
not expose data, and there is a test for exactly that.

**What are the weaknesses?** Three, honestly:

1. Tokens cannot be revoked before they expire. Sign-out clears the cookie, but a
   copied token works for up to 8 hours. The fix is short access tokens plus
   refresh tokens, or a session table — both cost a database read per request.
2. The login throttle is in-process memory. It slows one attacker against one
   instance and does nothing across serverless instances. It should be Redis.
3. No CSRF token. `SameSite=Lax` plus JSON-only endpoints covers the realistic
   attacks, but a defence-in-depth answer would add a double-submit token.

---

## Reliability

**What happens if the API is slow or fails?** Every request has a 15-second
abort. Reads retry twice with backoff; writes never retry automatically, because
a retried POST is a duplicate booking. Failures render an error panel with a
retry button rather than an empty screen.

**How are duplicate submissions handled?** The booking form disables its button
during submission, which handles the honest double-click. That is not sufficient
— a flaky connection can produce a genuine retry — so the real defence is an
`Idempotency-Key` header plus a partial unique index. A replay returns the
original booking with `duplicate: true`. There is a test that fires six identical
submissions simultaneously and asserts exactly one row exists.

**What if two drivers accept at the same instant?** One wins, the other gets a
409 and a clear message, and the queue refreshes the ride away. Covered above and
tested with eight parallel drivers against real Postgres.

---

## Testing

**What did you test, and why those?** 77 tests: 19 unit, 58 integration. I aimed
at the things that would actually break — the state machine's illegal
transitions, the authorisation boundaries between users, the concurrency
scenarios, and the fare arithmetic. Route handlers are tested by calling them
directly, so one test covers validation, auth, service rules and SQL together.

**What did you deliberately not test?** Component rendering. The UI is the part
most likely to change and the least likely to break silently; those tests would
have cost more to maintain than they returned. If this were long-lived I would
add end-to-end coverage of the one flow that must never break — book, accept,
complete — rather than unit tests per component.

**Why a real database in tests instead of mocks?** Because the guarantees being
tested *are* database behaviour. A mocked repository would happily confirm a
conditional UPDATE works while the real one deadlocked. Every test runs against
genuine Postgres — PGlite in the process by default, a real server in CI.

---

## If I did it again

**The thing I would change:** I would put admin filter state in the URL from the
start. It is currently component state, so a filtered dashboard cannot be
bookmarked or shared and a reload loses it. Retrofitting is about twenty lines
with `useSearchParams`; doing it first would have been free.

**The thing I nearly got wrong:** trusting a test that could not fail. The
concurrency suite passed on PGlite before it was capable of demonstrating
anything, and it would have passed just as happily against a naive
read-then-write implementation. A green test that cannot fail is worse than no
test, because it stops you looking.

**What I would build next:** driver location pings and a live map, which the
schema already anticipates with its coordinate columns. That is also the point
where polling stops being defensible and the app needs a socket.
