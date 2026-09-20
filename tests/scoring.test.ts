import { describe, expect, it } from "vitest";
import {
  bandFor, DEFAULT_SCORING_CONFIG as CFG, scoreAppointment, scoreBudget, scoreEngagement, scoreLead,
  scoreResponse, scoreService, validateScoringConfig, type ScoringInput,
} from "@/lib/scoring";

const blank: ScoringInput = {
  budgetAmount: null, serviceInterest: null, hasCompany: false, hasEmail: false, hasPhone: false,
  hasLocation: false, hasContext: false, inboundReplies: 0, outboundAttempts: 0, appointment: "none",
};
const best: ScoringInput = {
  budgetAmount: 50_000, serviceInterest: "crm_automation", hasCompany: true, hasEmail: true, hasPhone: true,
  hasLocation: true, hasContext: true, inboundReplies: 5, outboundAttempts: 3, appointment: "completed",
};

describe("scoring config", () => {
  it("is internally consistent (maxes sum to 100, best case of each factor = its max)", () => {
    expect(validateScoringConfig(CFG)).toEqual([]);
  });
  it("detects a broken config", () => {
    expect(validateScoringConfig({ ...CFG, max: { ...CFG.max, budget: 40 } }).length).toBeGreaterThan(0);
  });
});

describe("band boundaries", () => {
  it.each([
    [100, "hot"], [70, "hot"], [69, "warm"], [40, "warm"], [39, "cold"], [0, "cold"],
  ] as const)("score %i → %s", (score, band) => {
    expect(bandFor(score)).toBe(band);
  });
});

describe("scoreLead", () => {
  it("perfect lead scores exactly 100 and is Hot", () => {
    const r = scoreLead(best);
    expect(r.score).toBe(100);
    expect(r.band).toBe("hot");
    expect(r.factors.map((f) => f.factor)).toEqual(["budget", "service", "engagement", "response", "appointment"]);
  });

  it("a lead we know NOTHING about is not punished: gets neutral credit, not zero", () => {
    const r = scoreLead(blank);
    // budget 12 + service 8 + engagement 0 + response 7 (not contacted yet) + appointment 5 (not booked yet)
    expect(r.score).toBe(32);
    expect(r.factors.find((f) => f.factor === "budget")!.reason).toMatch(/neutral/);
    expect(r.factors.find((f) => f.factor === "response")!.reason).toMatch(/not a penalty/);
  });

  it("explanations exist for every factor and points never exceed each max", () => {
    for (const f of scoreLead(best).factors.concat(scoreLead(blank).factors)) {
      expect(f.reason.length).toBeGreaterThan(5);
      expect(f.points).toBeGreaterThanOrEqual(0);
      expect(f.points).toBeLessThanOrEqual(f.max);
    }
  });

  it("hits the exact Warm/Hot boundary", () => {
    // 24 (5k) + 20 (crm) + 8 (profile) + 0 + 7 + 5 = 64 → warm ; one reply: +6 engagement +8 response = 78 → hot
    const base = { ...blank, budgetAmount: 5000, serviceInterest: "crm_automation", hasCompany: true, hasEmail: true, hasPhone: true, hasLocation: true, hasContext: true };
    expect(scoreLead(base).score).toBe(64);
    expect(scoreLead(base).band).toBe("warm");
    expect(scoreLead({ ...base, inboundReplies: 1 }).score).toBe(78);
    expect(scoreLead({ ...base, inboundReplies: 1 }).band).toBe("hot");
  });

  it("real inputs landing exactly on 70 (hot), 40 (warm) and 38 (cold)", () => {
    const strong = { ...blank, budgetAmount: 10_000, serviceInterest: "crm_automation" };
    expect(scoreLead({ ...strong, appointment: "none" }).score).toBe(62); // 30+20+0+7+5
    const exact70 = scoreLead({ ...strong, appointment: "upcoming" }); // 30+20+0+7+13
    expect([exact70.score, exact70.band]).toEqual([70, "hot"]);
    const exact40 = scoreLead({ ...blank, budgetAmount: 2500, serviceInterest: "social_media", hasCompany: true }); // 16+10+2+7+5
    expect([exact40.score, exact40.band]).toEqual([40, "warm"]);
    const below = scoreLead({ ...blank, budgetAmount: 2500, serviceInterest: "social_media" }); // 16+10+0+7+5
    expect([below.score, below.band]).toEqual([38, "cold"]);
  });
});

describe("individual factors", () => {
  it("budget tiers including zero and exact tier edges", () => {
    expect(scoreBudget(10_000).points).toBe(30);
    expect(scoreBudget(9_999).points).toBe(24);
    expect(scoreBudget(5_000).points).toBe(24);
    expect(scoreBudget(2_500).points).toBe(16);
    expect(scoreBudget(1_000).points).toBe(8);
    expect(scoreBudget(999).points).toBe(2);
    expect(scoreBudget(0).points).toBe(2);
  });

  it("invalid budgets (negative, NaN, Infinity) are treated as unknown, not as zero", () => {
    for (const bad of [-100, Number.NaN, Number.POSITIVE_INFINITY, undefined, null]) {
      expect(scoreBudget(bad as number).points).toBe(CFG.budgetUnknownPoints);
    }
  });

  it("unknown or unrecognised service gets neutral credit", () => {
    expect(scoreService(null).points).toBe(8);
    expect(scoreService("underwater_basket_weaving").points).toBe(8);
    expect(scoreService("crm_automation").points).toBe(20);
  });

  it("response: replied > pending > ignored after 2+ attempts", () => {
    expect(scoreResponse({ ...blank, inboundReplies: 1 }).points).toBe(15);
    expect(scoreResponse({ ...blank, outboundAttempts: 0 }).points).toBe(7);
    expect(scoreResponse({ ...blank, outboundAttempts: 1 }).points).toBe(7);
    expect(scoreResponse({ ...blank, outboundAttempts: 2 }).points).toBe(3);
    expect(scoreResponse({ ...blank, outboundAttempts: -3 }).points).toBe(7); // garbage input = no evidence
  });

  it("engagement caps replies and never exceeds 20", () => {
    expect(scoreEngagement({ ...best, inboundReplies: 999 }).points).toBe(20);
    expect(scoreEngagement({ ...blank, inboundReplies: 1 }).points).toBe(6);
  });

  it("appointment signals", () => {
    expect(scoreAppointment("completed").points).toBe(15);
    expect(scoreAppointment("upcoming").points).toBe(13);
    expect(scoreAppointment("none").points).toBe(5);
    expect(scoreAppointment("cancelled").points).toBe(3);
    expect(scoreAppointment("no_show").points).toBe(2);
    expect(scoreAppointment("bogus" as never).points).toBe(5);
  });
});
