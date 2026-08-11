import { randomUUID } from "node:crypto";
import { requireDatabaseUrl } from "./_bootstrap";
import { createDatabase } from "../src/server/db/client";
import { runMigrations } from "../src/server/db/migrate";
import { hashPassword } from "../src/server/auth/password";
import { calculateFare, fareConfigFromEnv, mockDistanceFromAddresses } from "../src/domain/fare";
import type { RideStatus } from "../src/domain/rideStatus";

/**
 * Demo data.
 *
 * Every account shares one password, read from SEED_PASSWORD. It is never
 * committed: .env.example carries a placeholder and .env* is gitignored.
 *
 * The rides are spread deliberately across the lifecycle so the admin
 * dashboard has something to show the moment you sign in — an empty dashboard
 * demos badly.
 */

const PASSWORD = process.env.SEED_PASSWORD || "Password123!";

const PEOPLE = {
  admin: { name: "Ananya Rao", email: "admin@meridianfleet.test", role: "ADMIN" as const, phone: "+91 98200 10001" },
  customers: [
    { name: "Priya Menon", email: "priya@meridianfleet.test", phone: "+91 98200 20001" },
    { name: "Arjun Shetty", email: "arjun@meridianfleet.test", phone: "+91 98200 20002" },
    { name: "Meera Iyer", email: "meera@meridianfleet.test", phone: "+91 98200 20003" },
  ],
  drivers: [
    { name: "Rahul Verma", email: "rahul@meridianfleet.test", phone: "+91 98200 30001", vehicle: "MH 01 AB 4412 · Toyota Etios" },
    { name: "Sunita Kaur", email: "sunita@meridianfleet.test", phone: "+91 98200 30002", vehicle: "MH 02 CD 7781 · Maruti Dzire" },
    { name: "Imran Sheikh", email: "imran@meridianfleet.test", phone: "+91 98200 30003", vehicle: "MH 03 EF 2290 · Hyundai Aura" },
    { name: "Deepa Nair", email: "deepa@meridianfleet.test", phone: "+91 98200 30004", vehicle: "MH 04 GH 5567 · Tata Tigor" },
  ],
};

const TRIPS: Array<{
  pickup: string;
  destination: string;
  status: RideStatus;
  customer: number;
  driver: number | null;
  hoursAgo: number;
  notes?: string;
}> = [
  { pickup: "Bandra Kurla Complex, Mumbai", destination: "Chhatrapati Shivaji Airport T2", status: "COMPLETED", customer: 0, driver: 0, hoursAgo: 74, notes: "Two check-in bags" },
  { pickup: "Powai Lake Road, Mumbai", destination: "Lower Parel, Mumbai", status: "COMPLETED", customer: 1, driver: 1, hoursAgo: 52 },
  { pickup: "Andheri East Metro Station", destination: "Nariman Point, Mumbai", status: "COMPLETED", customer: 0, driver: 2, hoursAgo: 47 },
  { pickup: "Juhu Beach, Mumbai", destination: "Thane Station West", status: "COMPLETED", customer: 2, driver: 3, hoursAgo: 30, notes: "Please call on arrival" },
  { pickup: "Colaba Causeway, Mumbai", destination: "Dadar TT Circle", status: "COMPLETED", customer: 1, driver: 0, hoursAgo: 26 },
  { pickup: "Worli Sea Face, Mumbai", destination: "Ghatkopar West", status: "CANCELLED", customer: 2, driver: null, hoursAgo: 22, notes: "Plans changed" },
  { pickup: "Vashi Sector 17, Navi Mumbai", destination: "Fort, Mumbai", status: "CANCELLED", customer: 0, driver: null, hoursAgo: 18 },
  { pickup: "Chembur Station Road", destination: "Bandra West, Mumbai", status: "STARTED", customer: 1, driver: 1, hoursAgo: 1 },
  { pickup: "Malad West, Mumbai", destination: "Goregaon Film City", status: "DRIVER_ARRIVING", customer: 2, driver: 2, hoursAgo: 0.5 },
  { pickup: "Kurla LBS Marg, Mumbai", destination: "Sion Circle, Mumbai", status: "ACCEPTED", customer: 0, driver: 3, hoursAgo: 0.3 },
  { pickup: "Marine Drive, Mumbai", destination: "Santacruz East, Mumbai", status: "REQUESTED", customer: 1, driver: null, hoursAgo: 0.2, notes: "Prefer a boot-friendly car" },
  { pickup: "Mulund Check Naka", destination: "Wadala Truck Terminal", status: "REQUESTED", customer: 2, driver: null, hoursAgo: 0.1 },
  { pickup: "Byculla Zoo Gate", destination: "Mahim Junction", status: "REQUESTED", customer: 0, driver: null, hoursAgo: 0.05 },
];

/** History rows to write for a ride that ended in `final`. */
function historyChain(final: RideStatus): RideStatus[] {
  switch (final) {
    case "REQUESTED": return ["REQUESTED"];
    case "ACCEPTED": return ["REQUESTED", "ACCEPTED"];
    case "DRIVER_ARRIVING": return ["REQUESTED", "ACCEPTED", "DRIVER_ARRIVING"];
    case "STARTED": return ["REQUESTED", "ACCEPTED", "DRIVER_ARRIVING", "STARTED"];
    case "COMPLETED": return ["REQUESTED", "ACCEPTED", "DRIVER_ARRIVING", "STARTED", "COMPLETED"];
    case "CANCELLED": return ["REQUESTED", "CANCELLED"];
  }
}

async function main() {
  const db = await createDatabase(requireDatabaseUrl());
  await runMigrations(db);

  const existing = await db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM users");
  if (Number(existing.rows[0]?.count ?? 0) > 0) {
    console.log("Users already exist — clearing demo data before reseeding.");
    await db.query("DELETE FROM ride_status_history");
    await db.query("DELETE FROM rides");
    await db.query("DELETE FROM users");
  }

  const passwordHash = await hashPassword(PASSWORD);
  const insertUser = async (
    name: string, email: string, role: string, phone: string, vehicle: string | null,
  ) => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO users (id, name, email, password_hash, role, phone, vehicle)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, name, email.toLowerCase(), passwordHash, role, phone, vehicle],
    );
    return id;
  };

  const adminId = await insertUser(
    PEOPLE.admin.name, PEOPLE.admin.email, "ADMIN", PEOPLE.admin.phone, null,
  );
  const customerIds: string[] = [];
  for (const c of PEOPLE.customers) {
    customerIds.push(await insertUser(c.name, c.email, "CUSTOMER", c.phone, null));
  }
  const driverIds: string[] = [];
  for (const d of PEOPLE.drivers) {
    driverIds.push(await insertUser(d.name, d.email, "DRIVER", d.phone, d.vehicle));
  }

  const fareConfig = fareConfigFromEnv();
  let rideCount = 0;

  for (const trip of TRIPS) {
    const rideId = randomUUID();
    const customerId = customerIds[trip.customer]!;
    const driverId = trip.driver === null ? null : driverIds[trip.driver]!;
    const createdAt = new Date(Date.now() - trip.hoursAgo * 3_600_000);
    const requestedAt = new Date(createdAt.getTime() + 20 * 60_000);
    const distanceKm = mockDistanceFromAddresses(trip.pickup, trip.destination);
    const fare = calculateFare(distanceKm, fareConfig);

    const stamp = (offsetMinutes: number) =>
      new Date(createdAt.getTime() + offsetMinutes * 60_000).toISOString();

    await db.query(
      `INSERT INTO rides (
         id, reference, customer_id, driver_id,
         pickup_address, destination_address,
         estimated_distance_km, estimated_fare_cents,
         status, notes, requested_at, created_at, updated_at,
         accepted_at, started_at, completed_at, cancelled_at, cancellation_reason
       ) VALUES (
         $1, 'RD-' || lpad(nextval('ride_reference_seq')::text, 5, '0'), $2, $3,
         $4, $5, $6, $7, $8, $9, $10, $11, $11,
         $12, $13, $14, $15, $16
       )`,
      [
        rideId, customerId, driverId,
        trip.pickup, trip.destination,
        distanceKm, fare.totalCents,
        trip.status, trip.notes ?? null,
        requestedAt.toISOString(), createdAt.toISOString(),
        ["ACCEPTED", "DRIVER_ARRIVING", "STARTED", "COMPLETED"].includes(trip.status) ? stamp(6) : null,
        ["STARTED", "COMPLETED"].includes(trip.status) ? stamp(18) : null,
        trip.status === "COMPLETED" ? stamp(46) : null,
        trip.status === "CANCELLED" ? stamp(9) : null,
        trip.status === "CANCELLED" ? (trip.notes ?? "Cancelled by customer") : null,
      ],
    );

    const chain = historyChain(trip.status);
    for (let i = 0; i < chain.length; i += 1) {
      const newStatus = chain[i]!;
      const previousStatus = i === 0 ? null : chain[i - 1]!;
      const isDriverAction = ["ACCEPTED", "DRIVER_ARRIVING", "STARTED", "COMPLETED"].includes(newStatus);
      await db.query(
        `INSERT INTO ride_status_history
           (id, ride_id, previous_status, new_status, changed_by, changed_by_role, note, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(), rideId, previousStatus, newStatus,
          isDriverAction && driverId ? driverId : customerId,
          isDriverAction && driverId ? "DRIVER" : "CUSTOMER",
          i === 0 ? "Booking created" : null,
          stamp(i * 12),
        ],
      );
    }
    rideCount += 1;
  }

  console.log(`
  Seeded ${1 + customerIds.length + driverIds.length} users and ${rideCount} rides.

  Sign in with any of these — the password for all of them is SEED_PASSWORD
  (default "Password123!"):

    Administrator  ${PEOPLE.admin.email}
    Customer       ${PEOPLE.customers[0]!.email}
    Driver         ${PEOPLE.drivers[0]!.email}
`);
  void adminId;
  await db.close();
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
