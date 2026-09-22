/**
 * Admin session cookie — pure functions (no DB, no cookies API), so sign/verify/expiry
 * edge cases are unit-testable directly. Same shape as webhook-signature.ts: HMAC-SHA256,
 * timing-safe compare, no external session store.
 *
 * The cookie value is `${expiresAtMs}.${hmac}`, where the HMAC covers the expiry so a
 * visitor can't extend their own session by editing the cookie. The HMAC key is derived
 * from ADMIN_PASSWORD (not the password itself) so the cookie never lets anyone recover it.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const ADMIN_SESSION_COOKIE = "leadflow_admin";
export const ADMIN_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60; // 12h — a demo login, not a real tenant

function sessionKey(password: string): string {
  return createHash("sha256").update(`leadflow-admin-session:${password}`).digest("hex");
}

export function checkAdminPassword(configured: string, provided: string): boolean {
  const a = Buffer.from(createHash("sha256").update(configured).digest("hex"));
  const b = Buffer.from(createHash("sha256").update(provided).digest("hex"));
  return timingSafeEqual(a, b);
}

export function signAdminSession(password: string, expiresAtMs: number): string {
  const mac = createHmac("sha256", sessionKey(password)).update(String(expiresAtMs)).digest("hex");
  return `${expiresAtMs}.${mac}`;
}

export function verifyAdminSession(password: string, cookieValue: string | undefined | null, nowMs: number = Date.now()): boolean {
  if (!cookieValue) return false;
  const dot = cookieValue.indexOf(".");
  if (dot < 0) return false;
  const expiresAtRaw = cookieValue.slice(0, dot);
  const mac = cookieValue.slice(dot + 1);
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return false;

  const expected = createHmac("sha256", sessionKey(password)).update(expiresAtRaw).digest("hex");
  if (expected.length !== mac.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(mac, "hex"));
  } catch {
    return false;
  }
}
