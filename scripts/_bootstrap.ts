import { config } from "dotenv";

// Load .env.local first (developer machine), then .env (checked-in defaults).
config({ path: ".env.local" });
config({ path: ".env" });

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "\n  DATABASE_URL is not set.\n" +
        "  Copy .env.example to .env.local and set a connection string.\n" +
        "  No Postgres installed? Use  DATABASE_URL=pglite://.pgdata  to run\n" +
        "  an embedded Postgres out of a local folder.\n",
    );
    process.exit(1);
  }
  return url;
}
