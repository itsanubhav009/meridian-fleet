import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Database } from "./types";

const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");

/**
 * Applies every .sql file in db/migrations in filename order, exactly once.
 * Deliberately tiny: a 25-line runner is easier to explain, and easier to
 * trust, than a migration framework this project does not need.
 */
export async function runMigrations(db: Database): Promise<string[]> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = await db.query<{ name: string }>("SELECT name FROM schema_migrations");
  const done = new Set(applied.rows.map((r) => r.name));

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const executed: string[] = [];

  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    });
    executed.push(file);
  }

  return executed;
}
