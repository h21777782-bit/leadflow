/**
 * Appointment slot calculation — pure, DST-safe, built on src/lib/timezone.ts.
 *
 * Rep working hours are wall-clock time IN THE REP'S OWN TIMEZONE ("09:00"–"17:00"
 * in America/New_York, say). Slots are generated one calendar day at a time: each
 * day's start/end wall-clock time is converted to a UTC instant independently via
 * `zonedTimeToUtc`, which re-derives the UTC offset for that specific date — so a
 * 9am start stays 9am local even on the day the clocks change, and a day that's
 * 23 or 25 hours long (DST transition) never shifts the working window.
 */
import { zonedTimeToUtc } from "./timezone";

export type WorkingHours = {
  timezone: string; // rep's IANA zone
  startTime: string; // "09:00"
  endTime: string; // "17:00"
  workingDays: number[]; // 0=Sun..6=Sat
};

export type Slot = { startsAt: Date; endsAt: Date };
export type Interval = { startsAt: Date; endsAt: Date };

const MAX_RANGE_DAYS = 31; // matches the cap HighLevel's own free-slots endpoint documents (Phase 5 doc-check)

function parseTime(t: string): { hour: number; minute: number } {
  const [h, m] = t.split(":").map(Number);
  return { hour: h, minute: m ?? 0 };
}

function addUtcDays(y: number, m: number, d: number, days: number): { year: number; month: number; day: number } {
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

/** Day-of-week (0=Sun..6=Sat) of a plain calendar date — timezone-independent by construction. */
function dayOfWeek(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Every working-hours slot of `durationMinutes` between `rangeStart` and `rangeEnd`
 * (UTC instants), before excluding already-booked time. Range is capped at 31 days.
 */
export function generateCandidateSlots(hours: WorkingHours, rangeStart: Date, rangeEnd: Date, durationMinutes: number): Slot[] {
  if (durationMinutes <= 0) throw new RangeError("durationMinutes must be positive");
  if (rangeEnd.getTime() <= rangeStart.getTime()) return [];
  const cappedEnd = new Date(Math.min(rangeEnd.getTime(), rangeStart.getTime() + MAX_RANGE_DAYS * 86_400_000));

  const start = parseTime(hours.startTime);
  const end = parseTime(hours.endTime);
  const slots: Slot[] = [];

  // Start the day-walk one calendar day early (in UTC) so a rep whose local date is
  // already ahead of rangeStart's UTC date still has that day considered.
  let cursor = { year: rangeStart.getUTCFullYear(), month: rangeStart.getUTCMonth() + 1, day: rangeStart.getUTCDate() };
  for (let i = 0; i < MAX_RANGE_DAYS + 2; i++) {
    const dow = dayOfWeek(cursor.year, cursor.month, cursor.day);
    if (hours.workingDays.includes(dow)) {
      const dayStart = zonedTimeToUtc({ year: cursor.year, month: cursor.month, day: cursor.day, hour: start.hour, minute: start.minute }, hours.timezone);
      const dayEnd = zonedTimeToUtc({ year: cursor.year, month: cursor.month, day: cursor.day, hour: end.hour, minute: end.minute }, hours.timezone);
      const stepMs = durationMinutes * 60_000;
      for (let t = dayStart.getTime(); t + stepMs <= dayEnd.getTime(); t += stepMs) {
        const slotStart = new Date(t);
        const slotEnd = new Date(t + stepMs);
        if (slotStart.getTime() >= rangeStart.getTime() && slotEnd.getTime() <= cappedEnd.getTime()) {
          slots.push({ startsAt: slotStart, endsAt: slotEnd });
        }
      }
    }
    cursor = addUtcDays(cursor.year, cursor.month, cursor.day, 1);
    if (Date.UTC(cursor.year, cursor.month - 1, cursor.day) > cappedEnd.getTime()) break;
  }
  return slots;
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.startsAt.getTime() < b.endsAt.getTime() && b.startsAt.getTime() < a.endsAt.getTime();
}

/** Removes any candidate slot that overlaps an already-booked interval. */
export function excludeBookedSlots(candidates: Slot[], booked: Interval[]): Slot[] {
  if (booked.length === 0) return candidates;
  return candidates.filter((slot) => !booked.some((b) => overlaps(slot, b)));
}

/** Pure availability check — same overlap rule the database's EXCLUDE constraint enforces. */
export function isSlotAvailable(candidate: Interval, booked: Interval[]): boolean {
  return !booked.some((b) => overlaps(candidate, b));
}
