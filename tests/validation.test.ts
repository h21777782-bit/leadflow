import { describe, expect, it } from "vitest";
import { parseCustomFields, parseTags, validateContact } from "@/lib/validation/contact";
import { decideStageChange } from "@/lib/stage-rules";

const base = { firstName: "Asha", leadSource: "website_form" };

describe("validateContact", () => {
  it("accepts a minimal lead with only an email and normalizes it", () => {
    const r = validateContact({ ...base, email: " Asha@Studio.Example " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.emailNormalized).toBe("asha@studio.example");
  });

  it("requires at least an email or a phone", () => {
    const r = validateContact(base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.email).toMatch(/email or a phone/);
  });

  it("rejects a phone that is invalid for the given country", () => {
    const r = validateContact({ ...base, phone: "12345", country: "in" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.phone).toMatch(/country IN/);
  });

  it("normalizes a local phone number using the country", () => {
    const r = validateContact({ ...base, phone: "098220 11234", country: "in" });
    expect(r.ok && r.data.phoneE164).toBe("+919822011234");
    expect(r.ok && r.data.country).toBe("IN");
  });

  it("rejects unknown lead source, bad budget, bad timezone", () => {
    const r = validateContact({ ...base, email: "a@b.example", leadSource: "tiktok", budgetAmount: "-5", timezone: "Mars/Base" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.leadSource).toBeTruthy();
      expect(r.errors.budgetAmount).toBeTruthy();
      expect(r.errors.timezone).toBeTruthy();
    }
  });

  it("parses budget with thousands separators", () => {
    const r = validateContact({ ...base, email: "a@b.example", budgetAmount: "12,500" });
    expect(r.ok && r.data.budgetAmount).toBe(12500);
  });
});

describe("tag and custom-field parsing", () => {
  it("dedupes and slugs tags", () => {
    expect(parseTags("Health Care, health care ,, VIP")).toEqual(["health-care", "vip"]);
  });
  it("parses key: value lines and ignores junk", () => {
    expect(parseCustomFields("clinics: 2\ncrm = none\n\nnot a pair")).toEqual({ clinics: "2", crm: "none" });
  });
});

describe("decideStageChange", () => {
  it("allows a normal forward move", () => {
    expect(decideStageChange({ from: "new_lead", to: "contacted" })).toEqual({ ok: true, status: "open", isReopen: false });
  });
  it("refuses a no-op move", () => {
    expect(decideStageChange({ from: "qualified", to: "qualified" }).ok).toBe(false);
  });
  it("requires a reason to mark lost", () => {
    expect(decideStageChange({ from: "qualified", to: "lost" }).ok).toBe(false);
    expect(decideStageChange({ from: "qualified", to: "lost", reason: "No budget" })).toMatchObject({ ok: true, status: "lost" });
  });
  it("sets status won when moving to won", () => {
    expect(decideStageChange({ from: "negotiation", to: "won" })).toMatchObject({ ok: true, status: "won" });
  });
  it("treats reopening a closed deal as an override that needs a reason", () => {
    expect(decideStageChange({ from: "lost", to: "qualified" }).ok).toBe(false);
    expect(decideStageChange({ from: "lost", to: "qualified", reason: "Came back with budget" })).toMatchObject({ ok: true, isReopen: true });
  });
});
