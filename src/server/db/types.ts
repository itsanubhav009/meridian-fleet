/**
 * The rest of the application talks to Postgres through this interface only.
 *
 * Two implementations exist (see `client.ts`):
 *   - node-postgres, used against a real server (local, Neon, RDS)
 *   - PGlite, an in-process WASM build of Postgres, used by the test suite and
 *     by `pglite://` connection strings for zero-setup local development
 *
 * Because the repositories depend on `Queryable` rather than on `pg`, the test
 * suite runs real SQL against real Postgres semantics without a running server.
 */

export interface QueryResult<T> {
  rows: T[];
  /** Rows returned by a SELECT, or rows affected by INSERT/UPDATE/DELETE. */
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>>;
  /**
   * Runs a script that may contain several statements separated by semicolons
   * (migrations, teardown). Takes no bind parameters, which is why it is a
   * separate method: parameterised queries go through `query`, always.
   */
  exec(sql: string): Promise<void>;
}

export interface Database extends Queryable {
  /** Runs `fn` inside a transaction, rolling back if it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Postgres SQLSTATE for unique_violation. */
export const PG_UNIQUE_VIOLATION = "23505";

/** Narrow an unknown error to "this was a unique constraint violation". */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code !== PG_UNIQUE_VIOLATION) return false;
  if (!constraint) return true;
  const fields = error as { constraint_name?: unknown; constraint?: unknown };
  const actual = String(fields.constraint ?? fields.constraint_name ?? "");
  // PGlite surfaces the constraint name in the message rather than in a field.
  const message = String((error as { message?: unknown }).message ?? "");
  return actual === constraint || message.includes(constraint);
}
