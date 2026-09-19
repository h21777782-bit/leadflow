import { describe, expect, it } from "vitest";
import { getTimeZoneOffsetMs, isValidTimeZone, zonedTimeToUtc } from "@/lib/timezone";

describe("timezone helpers", () => {
  it("validates IANA zone names", () => {
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });

  it("converts 11:00 IST to 05:30 UTC", () => {
    const d = zonedTimeToUtc({ year: 2026, month: 9, day: 21, hour: 11 }, "Asia/Kolkata");
    expect(d.toISOString()).toBe("2026-09-21T05:30:00.000Z");
  });

  it("handles daylight saving time (New York, before and after the March switch)", () => {
    const winter = zonedTimeToUtc({ year: 2026, month: 3, day: 7, hour: 11 }, "America/New_York");
    const summer = zonedTimeToUtc({ year: 2026, month: 3, day: 9, hour: 11 }, "America/New_York");
    expect(winter.toISOString()).toBe("2026-03-07T16:00:00.000Z"); // UTC-5
    expect(summer.toISOString()).toBe("2026-03-09T15:00:00.000Z"); // UTC-4
  });

  it("reports offsets in milliseconds", () => {
    expect(getTimeZoneOffsetMs("Asia/Kolkata", new Date("2026-01-01T00:00:00Z"))).toBe(5.5 * 3_600_000);
  });

  it("throws on an invalid zone instead of silently using UTC", () => {
    expect(() => zonedTimeToUtc({ year: 2026, month: 1, day: 1, hour: 9 }, "Nowhere/City")).toThrow(RangeError);
  });
});
