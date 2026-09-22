import { describe, expect, it } from "vitest";
import { checkAdminPassword, signAdminSession, verifyAdminSession } from "@/lib/admin-session";

const PASSWORD = "correct-horse-battery-staple";

describe("checkAdminPassword", () => {
  it("accepts the correct password", () => {
    expect(checkAdminPassword(PASSWORD, PASSWORD)).toBe(true);
  });

  it("rejects a wrong password", () => {
    expect(checkAdminPassword(PASSWORD, "wrong")).toBe(false);
  });

  it("rejects an empty password", () => {
    expect(checkAdminPassword(PASSWORD, "")).toBe(false);
  });
});

describe("admin session cookie", () => {
  it("accepts a freshly signed, unexpired session", () => {
    const now = Date.now();
    const cookie = signAdminSession(PASSWORD, now + 60_000);
    expect(verifyAdminSession(PASSWORD, cookie, now)).toBe(true);
  });

  it("rejects a missing cookie", () => {
    expect(verifyAdminSession(PASSWORD, undefined)).toBe(false);
    expect(verifyAdminSession(PASSWORD, null)).toBe(false);
    expect(verifyAdminSession(PASSWORD, "")).toBe(false);
  });

  it("rejects an expired session", () => {
    const now = Date.now();
    const cookie = signAdminSession(PASSWORD, now - 1000);
    expect(verifyAdminSession(PASSWORD, cookie, now)).toBe(false);
  });

  it("rejects a tampered expiry (extending your own session)", () => {
    const now = Date.now();
    const cookie = signAdminSession(PASSWORD, now + 60_000);
    const [, mac] = cookie.split(".");
    const tampered = `${now + 999_000_000}.${mac}`;
    expect(verifyAdminSession(PASSWORD, tampered, now)).toBe(false);
  });

  it("rejects a session signed with a different password", () => {
    const now = Date.now();
    const cookie = signAdminSession("a-different-password", now + 60_000);
    expect(verifyAdminSession(PASSWORD, cookie, now)).toBe(false);
  });

  it("rejects malformed cookie values", () => {
    expect(verifyAdminSession(PASSWORD, "not-a-valid-cookie")).toBe(false);
    expect(verifyAdminSession(PASSWORD, "abc.def")).toBe(false);
  });
});
