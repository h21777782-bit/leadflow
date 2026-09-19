/**
 * Contact input validation (pure — no DB). Used by the UI server actions now
 * and by webhooks in Phase 6, so every entry point enforces the same rules.
 */
import { z } from "zod";
import { LEAD_SOURCES, SERVICES } from "@/lib/pipeline";
import { normalizeEmail, normalizePhone } from "@/lib/normalize";
import { isValidTimeZone } from "@/lib/timezone";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

/** "tag one, tag-two ,, TAG one" → ["tag one", "tag-two"] (lower-cased, deduped). */
export function parseTags(raw: string | string[] | undefined): string[] {
  const parts = Array.isArray(raw) ? raw : (raw ?? "").split(",");
  const seen = new Set<string>();
  for (const p of parts) {
    const t = p.trim().toLowerCase().replace(/\s+/g, "-");
    if (t && t.length <= 40) seen.add(t);
  }
  return [...seen].slice(0, 20);
}

/** "clinics: 2\ncrm = none" → { clinics: "2", crm: "none" }. Blank lines ignored. */
export function parseCustomFields(raw: string | Record<string, unknown> | undefined): Record<string, string> {
  if (!raw) return {};
  if (typeof raw === "object") {
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.trim(), String(v)]).filter(([k]) => k));
  }
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([^:=]+?)\s*[:=]\s*(.*?)\s*$/);
    if (m && m[1]) out[m[1].slice(0, 50)] = m[2].slice(0, 500);
  }
  return out;
}

export const contactInputSchema = z
  .object({
    firstName: z.string().trim().min(1, "First name is required").max(80),
    lastName: optionalText(80),
    email: optionalText(254),
    phone: optionalText(40),
    company: optionalText(120),
    leadSource: z.enum(LEAD_SOURCES, { error: "Choose a lead source" }),
    serviceInterest: z
      .enum(SERVICES, { error: "Choose a valid service" })
      .optional()
      .or(z.literal("").transform(() => undefined)),
    budgetAmount: z
      .union([z.number(), z.string()])
      .optional()
      .transform((v, ctx) => {
        if (v === undefined || v === "") return undefined;
        const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]/g, ""));
        if (!Number.isInteger(n) || n < 0 || n > 100_000_000) {
          ctx.addIssue({ code: "custom", message: "Budget must be a whole number of 0 or more" });
          return z.NEVER;
        }
        return n;
      }),
    country: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v ? v.toUpperCase() : undefined))
      .refine((v) => v === undefined || /^[A-Z]{2}$/.test(v), "Use a 2-letter country code, e.g. IN or US"),
    timezone: optionalText(64).refine((v) => v === undefined || isValidTimeZone(v), "Unknown timezone — use an IANA name like Asia/Kolkata"),
    ownerId: z
      .string()
      .optional()
      .transform((v) => (v ? v : undefined))
      .pipe(z.uuid("Invalid owner").optional()),
    tags: z.union([z.string(), z.array(z.string())]).optional().transform(parseTags),
    customFields: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().transform(parseCustomFields),
    notes: optionalText(4000),
  })
  .superRefine((c, ctx) => {
    if (!c.email && !c.phone) {
      ctx.addIssue({ code: "custom", path: ["email"], message: "Give at least an email or a phone number" });
    }
    if (c.email && !normalizeEmail(c.email)) {
      ctx.addIssue({ code: "custom", path: ["email"], message: "Email address is not valid" });
    }
    if (c.phone && !normalizePhone(c.phone, c.country)) {
      ctx.addIssue({
        code: "custom",
        path: ["phone"],
        message: c.country
          ? `Phone number is not valid for country ${c.country}`
          : "Phone number is not valid — add a country code (e.g. +91) or set the country",
      });
    }
  })
  .transform((c) => ({
    ...c,
    emailNormalized: normalizeEmail(c.email),
    phoneE164: normalizePhone(c.phone, c.country),
  }));

export type ContactInput = z.input<typeof contactInputSchema>;
export type ValidContact = z.output<typeof contactInputSchema>;

export type FieldErrors = Record<string, string>;

export function validateContact(input: unknown): { ok: true; data: ValidContact } | { ok: false; errors: FieldErrors } {
  const r = contactInputSchema.safeParse(input);
  if (r.success) return { ok: true, data: r.data };
  const errors: FieldErrors = {};
  for (const issue of r.error.issues) {
    const key = String(issue.path[0] ?? "form");
    errors[key] ??= issue.message;
  }
  // Zod skips superRefine when base fields fail, so re-check the cross-field
  // rule here: the user should see ALL problems in one round, not two.
  const raw = (input ?? {}) as Record<string, unknown>;
  const has = (v: unknown) => typeof v === "string" && v.trim() !== "";
  if (!has(raw.email) && !has(raw.phone)) errors.email ??= "Give at least an email or a phone number";
  return { ok: false, errors };
}
