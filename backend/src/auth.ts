/**
 * Staff sign-in and session tokens (staff-auth spec).
 *
 * Token = base64url(payload) "." base64url(HMAC-SHA256(payload, secret)),
 * payload = {"sub": staff_id, "exp": unix seconds}. No secret ever reaches the
 * extension: it only holds the signed token for the browser session.
 */
import bcrypt from "bcryptjs";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Queryable } from "./db/types.js";

const COST = 10;
// Compared against when the username is unknown, so both failures take the same time.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", COST);

export interface Staff {
  staff_id: number;
  username: string;
  display_name: string | null;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, COST);
}

/** Returns the staff member, or null for unknown user / wrong password / inactive. */
export async function verifyLogin(q: Queryable, schema: string, username: string,
                                  password: string): Promise<Staff | null> {
  const row = (await q.query<Staff & { password_hash: string; active: boolean }>(
    `SELECT staff_id, username, display_name, password_hash, active FROM ${schema}.staff WHERE username = $1`,
    [username])).rows[0];
  const ok = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok || !row.active) return null;
  return { staff_id: row.staff_id, username: row.username, display_name: row.display_name };
}

function b64(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function mac(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function signToken(staffId: number, secret: string, ttlSeconds: number,
                          now = Date.now()): { token: string; expires_at: string } {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const payload = b64(JSON.stringify({ sub: staffId, exp }));
  return { token: `${payload}.${b64(mac(payload, secret))}`, expires_at: new Date(exp * 1000).toISOString() };
}

/** Staff id from a valid, unexpired, untampered token; otherwise null. */
export function verifyToken(token: string, secret: string, now = Date.now()): number | null {
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  const given = Buffer.from(sig, "base64url");
  const want = mac(payload, secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  try {
    const { sub, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!Number.isInteger(sub) || typeof exp !== "number" || exp * 1000 <= now) return null;
    return sub;
  } catch {
    return null;
  }
}

/** Active staff member for an id (checked on every request, so deactivation is immediate). */
export async function activeStaff(q: Queryable, schema: string, staffId: number): Promise<Staff | null> {
  return (await q.query<Staff>(
    `SELECT staff_id, username, display_name FROM ${schema}.staff WHERE staff_id = $1 AND active`,
    [staffId])).rows[0] ?? null;
}
