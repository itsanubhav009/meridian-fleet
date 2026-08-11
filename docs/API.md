# API reference

Base URL: `/api`. Everything speaks JSON.

## Authenticating

Sign in once, then send the token either way:

```
Authorization: Bearer <token>
```

or rely on the `fleet_session` cookie, which login sets automatically
(httpOnly, `SameSite=Lax`, `Secure` in production). The browser app uses the
cookie; the examples below use the header because it is easier with `curl`.

## Error shape

Every failure looks the same:

```json
{
  "error": {
    "code": "INVALID_STATUS_TRANSITION",
    "message": "A ride cannot go from \"Driver assigned\" to \"Completed\".",
    "details": { "fieldName": ["why it failed"] }
  }
}
```

`details` appears only on validation errors. Unexpected server errors carry an
`incidentId` instead, which matches a line in the server log.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 422 | Body or query failed its schema |
| `UNAUTHENTICATED` | 401 | Missing, expired or tampered token |
| `INVALID_CREDENTIALS` | 401 | Wrong email or password |
| `FORBIDDEN` | 403 | Signed in, but not allowed to do this |
| `NOT_FOUND` | 404 | Does not exist, or is not yours to see |
| `RIDE_ALREADY_ASSIGNED` | 409 | Another driver got there first |
| `INVALID_STATUS_TRANSITION` | 409 | The lifecycle does not allow that move |
| `DRIVER_HAS_ACTIVE_RIDE` | 409 | A driver may hold one live ride |
| `DUPLICATE_REQUEST` | 409 | Idempotency key reused with a different body |
| `RATE_LIMITED` | 429 | Too many failed sign-ins |
| `INTERNAL_ERROR` | 500 | Logged with an incident ID |

---

## POST /api/auth/login

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"priya@meridianfleet.test","password":"Password123!"}'
```

```json
{
  "user": {
    "id": "fe4c0ea2-…",
    "name": "Priya Menon",
    "email": "priya@meridianfleet.test",
    "role": "CUSTOMER",
    "phone": "+91 98200 20001",
    "vehicle": null
  },
  "token": "eyJhbGciOiJIUzI1NiIs…"
}
```

`401` for both a wrong password and an unknown email — deliberately identical,
so the endpoint cannot be used to discover which accounts exist. After 8 failed
attempts for one email within 5 minutes: `429`.

## POST /api/auth/logout

Clears the cookie. Always `200`. The token itself stays valid until it expires;
see the limitations section of the README.

## GET /api/auth/me

Returns the signed-in user, or `401`. The client uses it to restore a session on
page load.

---

## POST /api/rides

Books a ride. **Customers only.**

```bash
curl -X POST http://localhost:3000/api/rides \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 6f1a…' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "pickupAddress": "Bandra Kurla Complex",
    "destinationAddress": "Airport Terminal 2",
    "requestedAt": "2026-08-12T09:30:00.000Z",
    "notes": "Two bags"
  }'
```

| Field | Rules |
| --- | --- |
| `pickupAddress` | 4–200 characters |
| `destinationAddress` | 4–200 characters, must differ from pickup |
| `requestedAt` | ISO 8601, not in the past, at most 30 days ahead |
| `notes` | optional, ≤ 300 characters |
| `pickup`, `destination` | optional `{ lat, lng }`; improves the distance estimate |
| `distanceKm` | optional; if a real routing provider supplied it |

`201` with the created ride. The server computes the reference, distance, fare
and status — anything the client sends for those is ignored.

**Idempotency.** Send an `Idempotency-Key` header and a retry returns the
original booking with `200` and `"duplicate": true` instead of creating a second
one. The key is scoped per customer. Reusing a key with a materially different
body is `409 DUPLICATE_REQUEST`.

## GET /api/rides

Lists rides, scoped automatically to the caller: a customer sees their own, a
driver sees theirs, an admin sees everything.

| Query | Notes |
| --- | --- |
| `status` | Comma-separated, e.g. `REQUESTED,ACCEPTED` |
| `scope` | `mine` (default) · `available` — drivers only, the open queue · `all` — admin only |
| `customerId`, `driverId` | Admin only |
| `from`, `to` | ISO timestamps, filtering on `created_at` |
| `search` | Matches reference, pickup or destination |
| `page`, `pageSize` | Default 1 and 20; `pageSize` caps at 100 |

```json
{ "items": [ … ], "total": 16, "page": 1, "pageSize": 20, "totalPages": 1 }
```

## GET /api/rides/:id

One ride, including its full status history and the actions available to the
caller. Returns `404` — not `403` — if the ride belongs to someone else.

```json
{
  "ride": {
    "id": "4a206721-…",
    "reference": "RD-01016",
    "status": "ACCEPTED",
    "customer": { "id": "…", "name": "Priya Menon", "phone": "+91 …" },
    "driver":   { "id": "…", "name": "Rahul Verma", "vehicle": "MH 01 AB 4412" },
    "pickupAddress": "Colaba Causeway",
    "destinationAddress": "Powai Lake",
    "estimatedDistanceKm": 21.4,
    "estimatedFareCents": 35030,
    "requestedAt": "2026-08-12T11:00:00.000Z",
    "createdAt": "2026-08-11T17:09:12.331Z",
    "availableActions": [
      { "to": "DRIVER_ARRIVING", "label": "On my way" },
      { "to": "CANCELLED", "label": "Cancel booking" }
    ],
    "history": [
      { "newStatus": "REQUESTED", "previousStatus": null, "changedBy": { "name": "Priya Menon", "role": "CUSTOMER" }, "createdAt": "…" },
      { "newStatus": "ACCEPTED",  "previousStatus": "REQUESTED", "changedBy": { "name": "Rahul Verma", "role": "DRIVER" }, "createdAt": "…" }
    ]
  }
}
```

`availableActions` is computed on the server from the state machine and the
caller's role, so the UI renders buttons from it rather than deciding for itself.
The client cannot offer a move the API would refuse.

## POST /api/rides/:id/accept

**Drivers only.** Claims a `REQUESTED` ride.

- `200` — it is yours, with the updated ride.
- `409 RIDE_ALREADY_ASSIGNED` — another driver won the race.
- `409 DRIVER_HAS_ACTIVE_RIDE` — you are already on a trip.
- `404` — no such ride.

A single conditional `UPDATE` decides this, so simultaneous requests produce
exactly one winner. See [ARCHITECTURE.md](ARCHITECTURE.md) and the concurrency
tests.

## PATCH /api/rides/:id/status

Moves a ride along. The assigned driver moves it through the driving statuses.

```bash
curl -X PATCH http://localhost:3000/api/rides/$ID/status \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $DRIVER_TOKEN" \
  -d '{"status":"STARTED","expectedStatus":"DRIVER_ARRIVING"}'
```

`expectedStatus` is optional but recommended: it makes the update a
compare-and-set, so a stale browser tab gets a `409` instead of overwriting a
change it never saw.

Refusals: `409` for an illegal transition, `403` for the wrong role, `404` for a
ride that is not yours.

## POST /api/rides/:id/cancel

Body: `{ "reason": "optional, ≤ 300 chars" }`.

A customer may cancel before the ride starts. An assigned driver may cancel
before starting. An admin may cancel any non-terminal ride. Cancelling a
`COMPLETED` or already-`CANCELLED` ride is `409`.

## GET /api/admin/metrics

**Admins only.** Accepts `from`, `to`, `driverId`, `customerId`.

```json
{
  "totals":  { "all": 16, "requested": 5, "active": 3, "completed": 6, "cancelled": 2 },
  "byStatus": { "REQUESTED": 5, "ACCEPTED": 1, "DRIVER_ARRIVING": 1, "STARTED": 1, "COMPLETED": 6, "CANCELLED": 2 },
  "revenue": { "completedRideRevenueCents": 146453, "averageCompletedFareCents": 24409, "currency": "INR" },
  "fleet":   { "totalDrivers": 4, "driversOnTrip": 3, "totalCustomers": 3 },
  "generatedAt": "2026-08-11T17:12:50.526Z"
}
```

Revenue counts **completed rides only** — a booked or cancelled ride has earned
nothing. Amounts are integer paise; divide by 100 to display.

## GET /api/users

**Admins only.** `{ "drivers": [...], "customers": [...] }`, used to populate the
dashboard's filter dropdowns. Never returns password hashes.
