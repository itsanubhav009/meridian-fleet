import { randomUUID } from "node:crypto";
import type { Queryable } from "../db/types";
import type { Role } from "../../domain/rideStatus";
import type { UserSummary } from "../../domain/types";

/**
 * Every statement that touches `users` lives here.
 *
 * Services call these functions; they never write SQL themselves. That keeps
 * query changes (adding an index hint, renaming a column) inside one file, and
 * it is what lets the tests swap the database implementation underneath.
 */

interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: Role;
  phone: string | null;
  vehicle: string | null;
}

export interface UserWithSecret extends UserSummary {
  passwordHash: string;
}

function toSummary(row: UserRow): UserSummary {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    phone: row.phone,
    vehicle: row.vehicle,
  };
}

const SELECT_COLUMNS = "id, name, email, password_hash, role, phone, vehicle";

export async function findByEmail(
  db: Queryable,
  email: string,
): Promise<UserWithSecret | null> {
  const { rows } = await db.query<UserRow>(
    `SELECT ${SELECT_COLUMNS} FROM users WHERE email = $1`,
    [email.trim().toLowerCase()],
  );
  const row = rows[0];
  return row ? { ...toSummary(row), passwordHash: row.password_hash } : null;
}

export async function findById(db: Queryable, id: string): Promise<UserSummary | null> {
  const { rows } = await db.query<UserRow>(
    `SELECT ${SELECT_COLUMNS} FROM users WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? toSummary(row) : null;
}

export async function listByRole(db: Queryable, role: Role): Promise<UserSummary[]> {
  // Served by idx_users_role_name.
  const { rows } = await db.query<UserRow>(
    `SELECT ${SELECT_COLUMNS} FROM users WHERE role = $1 ORDER BY name ASC`,
    [role],
  );
  return rows.map(toSummary);
}

export interface CreateUserInput {
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
  phone?: string | null;
  vehicle?: string | null;
}

export async function create(db: Queryable, input: CreateUserInput): Promise<UserSummary> {
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users (id, name, email, password_hash, role, phone, vehicle)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${SELECT_COLUMNS}`,
    [
      randomUUID(),
      input.name.trim(),
      input.email.trim().toLowerCase(),
      input.passwordHash,
      input.role,
      input.phone ?? null,
      input.vehicle ?? null,
    ],
  );
  return toSummary(rows[0]!);
}

export async function countByRole(db: Queryable): Promise<Record<Role, number>> {
  const { rows } = await db.query<{ role: Role; count: string }>(
    "SELECT role, COUNT(*)::text AS count FROM users GROUP BY role",
  );
  const counts: Record<Role, number> = { CUSTOMER: 0, DRIVER: 0, ADMIN: 0 };
  for (const row of rows) counts[row.role] = Number(row.count);
  return counts;
}
