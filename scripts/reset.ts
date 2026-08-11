import { requireDatabaseUrl } from "./_bootstrap";
import { createDatabase } from "../src/server/db/client";

/** Drops everything this project created. Destructive, and meant to be. */
async function main() {
  const db = await createDatabase(requireDatabaseUrl());
  await db.exec(`
    DROP TABLE IF EXISTS ride_status_history CASCADE;
    DROP TABLE IF EXISTS rides CASCADE;
    DROP TABLE IF EXISTS users CASCADE;
    DROP TABLE IF EXISTS schema_migrations CASCADE;
    DROP SEQUENCE IF EXISTS ride_reference_seq CASCADE;
  `);
  console.log("Dropped all tables. Run `npm run db:migrate` to rebuild.");
  await db.close();
}

main().catch((error) => {
  console.error("Reset failed:", error);
  process.exit(1);
});
