/**
 * Timezone utilities built on the platform's Intl API (no extra dependency).
 *
 * Rule of the system: store instants in UTC, keep the IANA zone next to them,
 * convert only at the edges (booking input and display).
 */

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset of `tz` from UTC at the given instant, in milliseconds (IST → +19800000). */
export function getTimeZoneOffsetMs(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const atSeconds = Math.floor(at.getTime() / 1000) * 1000;
  return asUtc - atSeconds;
}

/**
 * Convert a wall-clock time in `tz` (e.g. "11:00 on 2026-03-08 in America/New_York")
 * to the UTC instant. Handles DST by re-checking the offset at the candidate instant.
 */
export function zonedTimeToUtc(
  wall: { year: number; month: number; day: number; hour: number; minute?: number },
  tz: string,
): Date {
  if (!isValidTimeZone(tz)) throw new RangeError(`Invalid IANA timezone: ${tz}`);
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute ?? 0);
  let candidate = naive - getTimeZoneOffsetMs(tz, new Date(naive));
  // Second pass corrects the rare case where the first guess lands across a DST boundary.
  candidate = naive - getTimeZoneOffsetMs(tz, new Date(candidate));
  return new Date(candidate);
}

/** The calendar date (y/m/d) of an instant as seen in `tz`. */
export function zonedDateParts(at: Date, tz: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}
