import type { Database, Queryable, QueryResult } from "./types";

/**
 * Chooses a driver from the connection string:
 *   postgres://... | postgresql://...  -> node-postgres
 *   pglite://<dir> | pglite://memory   -> in-process Postgres (dev/test)
 */

// ---------------------------------------------------------------------------
// node-postgres
// ---------------------------------------------------------------------------
async function createPgDatabase(connectionString: string): Promise<Database> {
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Managed Postgres (Neon, Supabase, RDS) refuses non-TLS connections.
    ssl: /localhost|127\.0\.0\.1/.test(connectionString)
      ? undefined
      : { rejectUnauthorized: false },
  });

  return {
    async query<T>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>> {
      const result = await pool.query(text, params as unknown[]);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    },
    async exec(sql: string) {
      // No parameters, so node-postgres uses the simple query protocol, which
      // accepts several statements in one round trip.
      await pool.query(sql);
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tx: Queryable = {
          async query<R>(text: string, params?: readonly unknown[]) {
            const r = await client.query(text, params as unknown[]);
            return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
          },
          async exec(sql: string) {
            await client.query(sql);
          },
        };
        const out = await fn(tx);
        await client.query("COMMIT");
        return out;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

// ---------------------------------------------------------------------------
// PGlite (real Postgres, compiled to WASM, running in this process)
// ---------------------------------------------------------------------------
type PgliteLike = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>;
  exec: (sql: string) => Promise<unknown>;
};

function wrapPglite(client: PgliteLike): Queryable {
  return {
    async query<T>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>> {
      const result = await client.query(text, params ? [...params] : undefined);
      const rows = result.rows as T[];
      // PGlite reports SELECT counts via rows.length and writes via affectedRows.
      return { rows, rowCount: rows.length > 0 ? rows.length : result.affectedRows ?? 0 };
    },
    async exec(sql: string) {
      // PGlite's query() speaks the extended protocol, which is one statement
      // per call; exec() is the simple-protocol equivalent.
      await client.exec(sql);
    },
  };
}

async function createPgliteDatabase(connectionString: string): Promise<Database> {
  const { PGlite } = await import("@electric-sql/pglite");
  const target = connectionString.replace(/^pglite:\/\//, "");
  const pg = target === "" || target === "memory" ? new PGlite() : new PGlite(target);
  await pg.waitReady;

  const root = wrapPglite(pg as unknown as PgliteLike);

  return {
    query: root.query,
    exec: root.exec,
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return pg.transaction(async (tx) =>
        fn(wrapPglite(tx as unknown as PgliteLike)),
      ) as Promise<T>;
    },
    async close() {
      await pg.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Factory + singleton
// ---------------------------------------------------------------------------
export async function createDatabase(connectionString: string): Promise<Database> {
  if (connectionString.startsWith("pglite://")) return createPgliteDatabase(connectionString);
  if (/^postgres(ql)?:\/\//.test(connectionString)) return createPgDatabase(connectionString);
  throw new Error(
    `Unsupported DATABASE_URL "${connectionString.slice(0, 12)}...". ` +
      "Expected a postgres:// or pglite:// connection string.",
  );
}

// Next.js hot-reloads modules in development; caching on globalThis stops us
// from opening a brand-new connection pool on every code change.
const globalForDb = globalThis as unknown as { __fleetDb?: Promise<Database> };

export function getDb(): Promise<Database> {
  if (!globalForDb.__fleetDb) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and set it.");
    }
    globalForDb.__fleetDb = createDatabase(url);
  }
  return globalForDb.__fleetDb;
}

/** Test hook: swap in a database built by the test harness. */
export function setDb(db: Promise<Database> | undefined): void {
  globalForDb.__fleetDb = db;
}
