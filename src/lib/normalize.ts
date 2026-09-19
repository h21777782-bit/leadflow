import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

/**
 * Normalization is the foundation of duplicate detection.
 * "Priya@Acme.com " and "priya@acme.com" must map to the same key, and
 * "+91 98220 12345" / "098220 12345" (country IN) must map to the same E.164 number.
 * The database has UNIQUE indexes on the normalized columns, so even two
 * concurrent requests cannot create the same contact twice.
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const email = raw.trim().toLowerCase();
  // Structural check only; full input validation happens in Zod schemas.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export function normalizePhone(
  raw: string | null | undefined,
  defaultCountry?: string | null,
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const country = defaultCountry ? (defaultCountry.toUpperCase() as CountryCode) : undefined;
  const parsed = parsePhoneNumberFromString(trimmed, country);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number; // E.164, e.g. +919822012345
}

export function fullName(first: string, last?: string | null): string {
  return [first, last].filter(Boolean).join(" ").trim();
}
