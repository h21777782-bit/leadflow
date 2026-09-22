import { generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { REPLAY_WINDOW_SECONDS, signHmac, verifyGhlSignature, verifyHmacSignature } from "@/lib/webhook-signature";

const SECRET = "test-secret-do-not-use-in-prod";

describe("HMAC signature (website / n8n)", () => {
  it("accepts a correctly signed, fresh request", () => {
    const body = JSON.stringify({ eventId: "1", firstName: "A" });
    const ts = Math.floor(Date.now() / 1000);
    const sig = signHmac(SECRET, body, ts);
    expect(verifyHmacSignature(SECRET, body, String(ts), sig)).toEqual({ valid: true });
  });

  it("rejects a tampered body (signature no longer matches)", () => {
    const body = JSON.stringify({ eventId: "1", firstName: "A" });
    const ts = Math.floor(Date.now() / 1000);
    const sig = signHmac(SECRET, body, ts);
    const tampered = JSON.stringify({ eventId: "1", firstName: "B" });
    const r = verifyHmacSignature(SECRET, tampered, String(ts), sig);
    expect(r).toMatchObject({ valid: false, reason: expect.stringContaining("does not match") });
  });

  it("rejects a tampered signature", () => {
    const body = JSON.stringify({ eventId: "1" });
    const ts = Math.floor(Date.now() / 1000);
    const r = verifyHmacSignature(SECRET, body, String(ts), "sha256=" + "0".repeat(64));
    expect(r.valid).toBe(false);
  });

  it("rejects a signature signed with the wrong secret", () => {
    const body = JSON.stringify({ eventId: "1" });
    const ts = Math.floor(Date.now() / 1000);
    const sig = signHmac("a-different-secret", body, ts);
    expect(verifyHmacSignature(SECRET, body, String(ts), sig).valid).toBe(false);
  });

  it("rejects an expired timestamp (replay protection)", () => {
    const body = JSON.stringify({ eventId: "1" });
    const staleTs = Math.floor(Date.now() / 1000) - (REPLAY_WINDOW_SECONDS + 60);
    const sig = signHmac(SECRET, body, staleTs);
    const r = verifyHmacSignature(SECRET, body, String(staleTs), sig);
    expect(r).toMatchObject({ valid: false, reason: expect.stringContaining("possible replay") });
  });

  it("rejects a timestamp from the future beyond the window (clock skew abuse)", () => {
    const body = JSON.stringify({ eventId: "1" });
    const futureTs = Math.floor(Date.now() / 1000) + REPLAY_WINDOW_SECONDS + 60;
    const sig = signHmac(SECRET, body, futureTs);
    expect(verifyHmacSignature(SECRET, body, String(futureTs), sig).valid).toBe(false);
  });

  it("accepts a timestamp right at the edge of the window, rejects just past it", () => {
    const body = JSON.stringify({ eventId: "1" });
    const nowMs = Date.now();
    const edgeTs = Math.floor(nowMs / 1000) - REPLAY_WINDOW_SECONDS + 5; // just inside
    expect(verifyHmacSignature(SECRET, body, String(edgeTs), signHmac(SECRET, body, edgeTs), nowMs).valid).toBe(true);
    const pastTs = Math.floor(nowMs / 1000) - REPLAY_WINDOW_SECONDS - 5; // just outside
    expect(verifyHmacSignature(SECRET, body, String(pastTs), signHmac(SECRET, body, pastTs), nowMs).valid).toBe(false);
  });

  it("rejects missing headers, a non-numeric timestamp, and an unconfigured secret", () => {
    expect(verifyHmacSignature(SECRET, "{}", null, null).valid).toBe(false);
    expect(verifyHmacSignature(SECRET, "{}", "not-a-number", "sha256=abc").valid).toBe(false);
    expect(verifyHmacSignature("", "{}", "123", "sha256=abc").valid).toBe(false);
  });

  it("accepts a signature header with or without the 'sha256=' prefix", () => {
    const body = "{}";
    const ts = Math.floor(Date.now() / 1000);
    const withPrefix = signHmac(SECRET, body, ts);
    const withoutPrefix = withPrefix.replace("sha256=", "");
    expect(verifyHmacSignature(SECRET, body, String(ts), withoutPrefix).valid).toBe(true);
  });
});

describe("Ed25519 signature (HighLevel)", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  function signGhl(body: string): string {
    return ed25519Sign(null, Buffer.from(body, "utf8"), privateKey).toString("base64");
  }

  it("accepts a correctly signed body", () => {
    const body = JSON.stringify({ type: "ContactCreate", webhookId: "wh_1" });
    expect(verifyGhlSignature(publicKeyPem, body, signGhl(body))).toEqual({ valid: true });
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify({ type: "ContactCreate" });
    const sig = signGhl(body);
    expect(verifyGhlSignature(publicKeyPem, JSON.stringify({ type: "ContactUpdate" }), sig).valid).toBe(false);
  });

  it("rejects a signature produced by a different keypair", () => {
    const other = generateKeyPairSync("ed25519");
    const body = JSON.stringify({ type: "ContactCreate" });
    const sig = ed25519Sign(null, Buffer.from(body, "utf8"), other.privateKey).toString("base64");
    expect(verifyGhlSignature(publicKeyPem, body, sig).valid).toBe(false);
  });

  it("rejects a missing signature or malformed base64/PEM without throwing", () => {
    expect(verifyGhlSignature(publicKeyPem, "{}", null).valid).toBe(false);
    expect(verifyGhlSignature(publicKeyPem, "{}", "not-valid-base64!!!").valid).toBe(false);
    expect(verifyGhlSignature("", "{}", "AAAA").valid).toBe(false);
  });
});
