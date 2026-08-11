import { requireDatabaseUrl } from "./_bootstrap";
import { createDatabase } from "../src/server/db/client";
import { runMigrations } from "../src/server/db/migrate";

async function main() {
  const db = await createDatabase(requireDatabaseUrl());
  const applied = await runMigrations(db);
  if (applied.length === 0) {
    console.log("Schema is already up to date.");
  } else {
    for (const name of applied) console.log(`Applied ${name}`);
  }
  await db.close();
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
