/**
 * Webhook signature verification — pure functions (no DB, no HTTP), so every
 * edge case (valid, tampered, expired, malformed) is unit-testable in
 * milliseconds. Two schemes:
 *
 *   Website / n8n (ours):  HMAC-SHA256 over `${timestamp}.${rawBody}`, timestamp
 *     in whole seconds since epoch, rejected outside a 5-minute replay window.
 *     Headers: X-LeadFlow-Timestamp, X-LeadFlow-Signature ("sha256=<hex>").
 *     Compared with a timing-safe equality check, not `===`.
 *
 *   HighLevel:  Ed25519 over the raw UTF-8 body only (HighLevel's Delivery URL
 *     scheme carries no timestamp — see IMPLEMENTATION_LOG.md, Phase 6, for the
 *     doc URL and date checked). Base64 signature in X-GHL-Signature. The public
 *     key is HighLevel's own fixed, published key; HIGHLEVEL_WEBHOOK_PUBLIC_KEY
 *     overrides it (used by tests, or if HighLevel ever rotates it).
 */
import { createHmac, timingSafeEqual, verify as ed25519Verify } from "node:crypto";

export const REPLAY_WINDOW_SECONDS = 300;

export type SignatureResult = { valid: true } | { valid: false; reason: string };

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false; // fixed-length hex digest — not a meaningful timing leak
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false; // malformed hex in the provided signature
  }
}

/** `nowMs` is injectable for tests (expired-timestamp cases). */
export function verifyHmacSignature(
  secret: string,
  rawBody: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
  nowMs: number = Date.now(),
): SignatureResult {
  if (!secret) return { valid: false, reason: "WEBHOOK_SIGNING_SECRET is not configured" };
  if (!timestampHeader || !signatureHeader) return { valid: false, reason: "Missing X-LeadFlow-Timestamp or X-LeadFlow-Signature header" };
  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return { valid: false, reason: "X-LeadFlow-Timestamp is not a number" };
  const ageSeconds = Math.abs(nowMs / 1000 - timestamp);
  if (ageSeconds > REPLAY_WINDOW_SECONDS) return { valid: false, reason: `Timestamp is ${Math.round(ageSeconds)}s old (max ${REPLAY_WINDOW_SECONDS}s) — rejected as a possible replay` };

  const expected = createHmac("sha256", secret).update(`${timestampHeader}.${rawBody}`).digest("hex");
  const provided = signatureHeader.startsWith("sha256=") ? signatureHeader.slice(7) : signatureHeader;
  if (!timingSafeEqualHex(expected, provided)) return { valid: false, reason: "Signature does not match" };
  return { valid: true };
}

/** Used by the test/demo sender (`npm run webhook:send`) and by tests. */
export function signHmac(secret: string, rawBody: string, timestampSeconds: number): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`).digest("hex")}`;
}

// Fixed, published across all HighLevel apps as of the 2026-09-22 doc check
// (marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide/) — not a secret.
export const HIGHLEVEL_ED25519_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`;

export function verifyGhlSignature(publicKeyPem: string, rawBody: string, signatureBase64: string | null): SignatureResult {
  if (!publicKeyPem) return { valid: false, reason: "No HighLevel Ed25519 public key configured" };
  if (!signatureBase64) return { valid: false, reason: "Missing X-GHL-Signature header" };
  try {
    const ok = ed25519Verify(null, Buffer.from(rawBody, "utf8"), publicKeyPem, Buffer.from(signatureBase64, "base64"));
    return ok ? { valid: true } : { valid: false, reason: "Signature does not match" };
  } catch (err) {
    return { valid: false, reason: `Could not verify: ${err instanceof Error ? err.message : String(err)}` };
  }
}
