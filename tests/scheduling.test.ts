import { describe, expect, it } from "vitest";
import { excludeBookedSlots, generateCandidateSlots, isSlotAvailable, type WorkingHours } from "@/lib/scheduling";

const nyRep: WorkingHours = { timezone: "America/New_York", startTime: "09:00", endTime: "17:00", workingDays: [1, 2, 3, 4, 5] };

describe("generateCandidateSlots", () => {
  it("generates 16 half-hour slots for an 8-hour working day", () => {
    // Monday 2026-09-21 in America/New_York (well clear of any DST transition).
    const rangeStart = new Date("2026-09-21T00:00:00Z");
    const rangeEnd = new Date("2026-09-22T00:00:00Z");
    const slots = generateCandidateSlots(nyRep, rangeStart, rangeEnd, 30);
    expect(slots).toHaveLength(16);
    expect(slots[0].startsAt.toISOString()).toBe("2026-09-21T13:00:00.000Z"); // 09:00 EDT = 13:00 UTC
    expect(slots[15].endsAt.toISOString()).toBe("2026-09-21T21:00:00.000Z"); // 17:00 EDT = 21:00 UTC (last slot ends exactly at close)
  });

  it("skips weekends and non-working days entirely", () => {
    // 2026-09-19 (Sat) through 2026-09-20 (Sun).
    const slots = generateCandidateSlots(nyRep, new Date("2026-09-19T00:00:00Z"), new Date("2026-09-21T00:00:00Z"), 30);
    expect(slots).toHaveLength(0);
  });

  it("respects a custom working-days list (e.g. a rep who works Tue–Sat)", () => {
    const tueToSat: WorkingHours = { ...nyRep, workingDays: [2, 3, 4, 5, 6] };
    // 2026-09-21 is a Monday — should be entirely excluded for this rep.
    const slots = generateCandidateSlots(tueToSat, new Date("2026-09-21T00:00:00Z"), new Date("2026-09-22T00:00:00Z"), 60);
    expect(slots).toHaveLength(0);
  });

  it("DST-safe: 09:00 local stays 09:00 local on both sides of the spring-forward transition (2026-03-08, America/New_York)", () => {
    // Friday 2026-03-06 (before, EST/UTC-5) through Tuesday 2026-03-10 (after, EDT/UTC-4).
    const slots = generateCandidateSlots(nyRep, new Date("2026-03-06T00:00:00Z"), new Date("2026-03-11T00:00:00Z"), 60);
    const friday = slots.filter((s) => s.startsAt.toISOString().startsWith("2026-03-06"));
    const tuesday = slots.filter((s) => s.startsAt.toISOString().startsWith("2026-03-10"));
    expect(friday[0].startsAt.toISOString()).toBe("2026-03-06T14:00:00.000Z"); // 09:00 EST = 14:00 UTC
    expect(tuesday[0].startsAt.toISOString()).toBe("2026-03-10T13:00:00.000Z"); // 09:00 EDT = 13:00 UTC (offset shifted)
    // Both a pre- and a post-transition working day still produce a full 8 one-hour slots — DST never
    // silently drops or duplicates an hour of the working window.
    expect(friday).toHaveLength(8);
    expect(tuesday).toHaveLength(8);
  });

  it("DST-safe across the fall-back transition (2026-11-01, America/New_York)", () => {
    const slots = generateCandidateSlots(nyRep, new Date("2026-10-30T00:00:00Z"), new Date("2026-11-04T00:00:00Z"), 60);
    const friday = slots.filter((s) => s.startsAt.toISOString().startsWith("2026-10-30")); // EDT, UTC-4
    const monday = slots.filter((s) => s.startsAt.toISOString().startsWith("2026-11-02")); // EST, UTC-5
    expect(friday[0].startsAt.toISOString()).toBe("2026-10-30T13:00:00.000Z");
    expect(monday[0].startsAt.toISOString()).toBe("2026-11-02T14:00:00.000Z");
    expect(friday).toHaveLength(8);
    expect(monday).toHaveLength(8);
  });

  it("caps the range at 31 days, matching HighLevel's own free-slots limit", () => {
    const slots = generateCandidateSlots(nyRep, new Date("2026-01-01T00:00:00Z"), new Date("2026-06-01T00:00:00Z"), 480);
    const last = slots[slots.length - 1];
    const daysCovered = Math.round((last.endsAt.getTime() - new Date("2026-01-01T00:00:00Z").getTime()) / 86_400_000);
    expect(daysCovered).toBeLessThanOrEqual(31);
  });

  it("rejects a non-positive duration and an inverted range", () => {
    expect(() => generateCandidateSlots(nyRep, new Date(), new Date(), 0)).toThrow(RangeError);
    expect(generateCandidateSlots(nyRep, new Date("2026-01-02T00:00:00Z"), new Date("2026-01-01T00:00:00Z"), 30)).toHaveLength(0);
  });
});

describe("excludeBookedSlots / isSlotAvailable", () => {
  const slots = generateCandidateSlots(nyRep, new Date("2026-09-21T00:00:00Z"), new Date("2026-09-22T00:00:00Z"), 60);

  it("removes a slot that overlaps an existing booking", () => {
    const booked = [{ startsAt: new Date("2026-09-21T13:00:00Z"), endsAt: new Date("2026-09-21T14:00:00Z") }];
    const remaining = excludeBookedSlots(slots, booked);
    expect(remaining).toHaveLength(slots.length - 1);
    expect(remaining.some((s) => s.startsAt.toISOString() === "2026-09-21T13:00:00.000Z")).toBe(false);
  });

  it("removes a slot that partially overlaps (not just an exact match)", () => {
    const booked = [{ startsAt: new Date("2026-09-21T13:30:00Z"), endsAt: new Date("2026-09-21T14:30:00Z") }];
    const remaining = excludeBookedSlots(slots, booked);
    // Both the 13:00-14:00 and 14:00-15:00 candidate slots touch this booking.
    expect(remaining.some((s) => s.startsAt.toISOString() === "2026-09-21T13:00:00.000Z")).toBe(false);
    expect(remaining.some((s) => s.startsAt.toISOString() === "2026-09-21T14:00:00.000Z")).toBe(false);
  });

  it("keeps every slot when nothing is booked", () => {
    expect(excludeBookedSlots(slots, [])).toHaveLength(slots.length);
  });

  it("isSlotAvailable matches the same overlap rule", () => {
    const booked = [{ startsAt: new Date("2026-09-21T13:00:00Z"), endsAt: new Date("2026-09-21T14:00:00Z") }];
    expect(isSlotAvailable({ startsAt: new Date("2026-09-21T14:00:00Z"), endsAt: new Date("2026-09-21T15:00:00Z") }, booked)).toBe(true); // back-to-back, not overlapping
    expect(isSlotAvailable({ startsAt: new Date("2026-09-21T13:30:00Z"), endsAt: new Date("2026-09-21T14:30:00Z") }, booked)).toBe(false);
  });
});
