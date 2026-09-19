import { describe, expect, it } from "vitest";
import { SEED_FAILURES, SEED_LEADS, SEED_ROUTING_RULES, SEED_USERS } from "@/db/seed-data";
import { PIPELINE_STAGES, STAGE_META, stagePath } from "@/lib/pipeline";
import { normalizeEmail, normalizePhone } from "@/lib/normalize";
import { isValidTimeZone } from "@/lib/timezone";

const userKeys = new Set(SEED_USERS.map((u) => u.key));

describe("demo seed data", () => {
  it("has at least 20 leads covering every pipeline stage", () => {
    expect(SEED_LEADS.length).toBeGreaterThanOrEqual(20);
    for (const stage of PIPELINE_STAGES) {
      expect(SEED_LEADS.some((l) => l.stage === stage), `missing stage ${stage}`).toBe(true);
    }
  });

  it("has unique, valid, normalizable emails and phones (dedup keys)", () => {
    const emails = SEED_LEADS.map((l) => normalizeEmail(l.email));
    const phones = SEED_LEADS.map((l) => normalizePhone(l.phone, l.country));
    expect(emails.every(Boolean)).toBe(true);
    phones.forEach((p, i) => expect(p, `invalid phone for ${SEED_LEADS[i].firstName}`).toBeTruthy());
    expect(new Set(emails).size).toBe(emails.length);
    expect(new Set(phones).size).toBe(phones.length);
  });

  it("only uses reserved .example email domains", () => {
    for (const l of SEED_LEADS) expect(l.email.endsWith(".example")).toBe(true);
    for (const u of SEED_USERS) expect(u.email.endsWith(".example")).toBe(true);
  });

  it("uses valid timezones and known owners", () => {
    for (const l of SEED_LEADS) {
      expect(isValidTimeZone(l.timezone)).toBe(true);
      expect(userKeys.has(l.owner)).toBe(true);
    }
  });

  it("gives every lost deal a reason and an open 'lostAfter' stage", () => {
    for (const l of SEED_LEADS.filter((x) => x.stage === "lost")) {
      expect(l.lostReason).toBeTruthy();
      expect(l.lostAfter && !STAGE_META[l.lostAfter].terminal).toBe(true);
    }
  });

  it("references only existing users in routing rules and existing leads in failures", () => {
    for (const r of SEED_ROUTING_RULES) r.targets.forEach((t) => expect(userKeys.has(t)).toBe(true));
    const emails = new Set(SEED_LEADS.map((l) => l.email));
    for (const f of SEED_FAILURES) {
      expect(emails.has(f.leadEmail)).toBe(true);
      expect(f.error.startsWith("[demo seed]")).toBe(true);
    }
  });
});

describe("stagePath", () => {
  it("walks forward from new_lead", () => {
    expect(stagePath("qualified")).toEqual(["new_lead", "attempting_contact", "contacted", "qualified"]);
  });
  it("won deals never pass through lost", () => {
    expect(stagePath("won")).not.toContain("lost");
  });
  it("lost deals end in lost after the last open stage", () => {
    expect(stagePath("lost", "contacted")).toEqual(["new_lead", "attempting_contact", "contacted", "lost"]);
  });
  it("rejects a terminal lostAfter", () => {
    expect(() => stagePath("lost", "won")).toThrow();
  });
});
