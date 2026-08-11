import bcrypt from "bcryptjs";

/**
 * Passwords are stored as bcrypt hashes, never in plain text and never
 * reversibly encrypted. bcryptjs is the pure-JS build, which avoids a native
 * compile step on serverless platforms.
 *
 * 10 rounds is the practical floor for 2026. Higher is safer but each
 * increment doubles login CPU time, which on a serverless platform is latency
 * the user feels.
 */
const SALT_ROUNDS = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}
