import { describe, expect, it } from "vitest";
import { normalizeEmail, normalizePhone } from "@/lib/normalize";

describe("normalizeEmail", () => {
  it("lower-cases and trims so duplicates match", () => {
    expect(normalizeEmail("  Priya@SharmaDental.Example ")).toBe("priya@sharmadental.example");
  });
  it("returns null for empty or malformed input", () => {
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});

describe("normalizePhone", () => {
  it("maps different human formats of the same number to one E.164 value", () => {
    const a = normalizePhone("+91 98220 11234");
    const b = normalizePhone("098220 11234", "IN");
    const c = normalizePhone("9822011234", "in");
    expect(a).toBe("+919822011234");
    expect(b).toBe(a);
    expect(c).toBe(a);
  });
  it("uses the lead's country for national-format numbers", () => {
    expect(normalizePhone("(415) 555-2671", "US")).toBe("+14155552671");
  });
  it("returns null for invalid numbers instead of storing garbage", () => {
    expect(normalizePhone("12345", "US")).toBeNull();
    expect(normalizePhone("   ")).toBeNull();
  });
});
