import { describe, expect, it } from "vitest";
import { decideAssignment, decideRoutingNeed, orderCandidates, ruleMatches, type RepState, type RoutingRule } from "@/lib/routing";

const rep = (id: string, over: Partial<RepState> = {}): RepState => ({
  id, name: id, role: "sales_rep", isActive: true, isAvailable: true, services: ["seo"], regions: [],
  maxOpenLeads: 10, activeLeads: 0, lastAssignedAt: null, ...over,
});
const rule = (over: Partial<RoutingRule> = {}): RoutingRule => ({
  id: "r1", name: "R1", priority: 10, isActive: true, conditions: {}, strategy: "round_robin", targetUserIds: ["a", "b"], ...over,
});
const lead = { serviceInterest: "seo", country: "IN", leadSource: "website_form", budgetAmount: 5000 };

describe("ruleMatches", () => {
  it("matches on service, country, source and min budget", () => {
    const r = rule({ conditions: { services: ["seo"], countries: ["IN"], sources: ["website_form"], minBudget: 1000 } });
    expect(ruleMatches(r, lead).matched).toBe(true);
    expect(ruleMatches(r, { ...lead, country: "US" }).matched).toBe(false);
    expect(ruleMatches(r, { ...lead, budgetAmount: 500 }).matched).toBe(false);
  });
  it("does not match when the attribute it needs is unknown", () => {
    expect(ruleMatches(rule({ conditions: { countries: ["IN"] } }), { ...lead, country: null }).why).toMatch(/unknown/);
    expect(ruleMatches(rule({ conditions: { minBudget: 1 } }), { ...lead, budgetAmount: null }).matched).toBe(false);
  });
  it("paused rules never match", () => {
    expect(ruleMatches(rule({ isActive: false }), lead).matched).toBe(false);
  });
});

describe("eligibility", () => {
  it.each([
    ["inactive", { isActive: false }, /inactive/],
    ["unavailable", { isAvailable: false }, /unavailable/],
    ["at capacity", { activeLeads: 10, maxOpenLeads: 10 }, /capacity/],
    ["zero capacity", { maxOpenLeads: 0 }, /capacity/],
    ["admin", { role: "admin" as const }, /not a sales rep/],
  ])("never assigns to a rep who is %s", (_label, over, why) => {
    const d = decideAssignment(lead, [rule({ targetUserIds: ["a"] })], [rep("a", over)]);
    expect(d.status).toBe("unassigned");
    expect(d.reason).toMatch(why);
  });

  it("requireServiceExpertise excludes reps who don't sell the service", () => {
    const d = decideAssignment(lead, [rule({ conditions: { requireServiceExpertise: true }, targetUserIds: ["a"] })], [rep("a", { services: ["branding"] })]);
    expect(d.status).toBe("unassigned");
    expect(d.reason).toMatch(/does not handle seo/);
  });

  it("prefers a specialist over a non-specialist in the same rule", () => {
    const reps = [rep("a", { services: ["branding"], lastAssignedAt: null }), rep("b", { services: ["seo"], lastAssignedAt: new Date() })];
    const d = decideAssignment(lead, [rule()], reps);
    expect(d.status === "assigned" && d.userId).toBe("b");
  });
});

describe("fair distribution", () => {
  it("round robin picks the least recently assigned, and never-assigned first", () => {
    const reps = [rep("a", { lastAssignedAt: new Date("2026-09-10") }), rep("b", { lastAssignedAt: new Date("2026-09-01") }), rep("c")];
    expect(orderCandidates(reps, "round_robin").map((r) => r.id)).toEqual(["c", "b", "a"]);
  });
  it("least_loaded picks the lowest workload ratio", () => {
    const reps = [rep("a", { activeLeads: 5 }), rep("b", { activeLeads: 1 }), rep("c", { activeLeads: 3 })];
    expect(orderCandidates(reps, "least_loaded")[0].id).toBe("b");
  });
  it("is deterministic on full ties", () => {
    expect(orderCandidates([rep("b"), rep("a")], "round_robin").map((r) => r.id)).toEqual(["a", "b"]);
  });
  it("simulated: 6 leads across 3 equal reps → 2 each", () => {
    const reps = [rep("a"), rep("b"), rep("c")];
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 6; i++) {
      const d = decideAssignment(lead, [rule({ targetUserIds: ["a", "b", "c"] })], reps);
      if (d.status !== "assigned") throw new Error("expected assignment");
      counts[d.userId]++;
      const r = reps.find((x) => x.id === d.userId)!;
      r.activeLeads++;
      r.lastAssignedAt = new Date(2026, 0, 1, 0, i);
    }
    expect(counts).toEqual({ a: 2, b: 2, c: 2 });
  });
  it("assign_user respects the rule's order and falls to the next eligible", () => {
    const d = decideAssignment(lead, [rule({ strategy: "assign_user", targetUserIds: ["a", "b"] })], [rep("a", { isAvailable: false }), rep("b")]);
    expect(d.status === "assigned" && d.userId).toBe("b");
  });
});

describe("rule fall-through and no eligible rep", () => {
  it("skips a matched rule with no eligible reps and uses the next one", () => {
    const rules = [rule({ id: "r1", name: "First", priority: 1, targetUserIds: ["a"] }), rule({ id: "r2", name: "Second", priority: 2, targetUserIds: ["b"] })];
    const d = decideAssignment(lead, rules, [rep("a", { isAvailable: false }), rep("b")]);
    expect(d.status === "assigned" && d.ruleName).toBe("Second");
    expect(d.trace[0].why).toMatch(/no eligible rep/);
  });
  it("leaves the lead unassigned with a readable reason", () => {
    const d = decideAssignment(lead, [rule({ targetUserIds: ["a", "b"] })], [rep("a", { isAvailable: false }), rep("b", { activeLeads: 10 })]);
    expect(d.status).toBe("unassigned");
    expect(d.reason).toMatch(/a unavailable/);
    expect(d.reason).toMatch(/b at capacity/);
  });
  it("no matching rule at all", () => {
    const d = decideAssignment(lead, [rule({ conditions: { countries: ["US"] } })], [rep("a")]);
    expect(d).toMatchObject({ status: "unassigned", reason: "No routing rule matches this lead" });
  });
});

describe("reassignment policy", () => {
  const base = { hasOpenOpportunity: true, latestOpenStage: "new_lead", ownerId: "a", owner: { name: "A", isActive: true, isAvailable: true }, assignmentSource: "routing" as const, force: false };
  it("keeps an available owner even when details change (sticky)", () => {
    expect(decideRoutingNeed(base)).toMatchObject({ route: false, reason: expect.stringMatching(/sticky/) });
  });
  it("routes a lead with no owner", () => {
    expect(decideRoutingNeed({ ...base, ownerId: null, owner: null }).route).toBe(true);
  });
  it("reassigns when owner is unavailable and the lead is not contacted yet", () => {
    expect(decideRoutingNeed({ ...base, owner: { name: "A", isActive: true, isAvailable: false } }).route).toBe(true);
  });
  it("does NOT reassign an in-conversation lead just because the owner is away", () => {
    const r = decideRoutingNeed({ ...base, latestOpenStage: "qualified", owner: { name: "A", isActive: true, isAvailable: false } });
    expect(r).toMatchObject({ route: false, reason: expect.stringMatching(/manual decision/) });
  });
  it("never auto-routes manual assignments unless forced", () => {
    expect(decideRoutingNeed({ ...base, ownerId: null, owner: null, assignmentSource: "manual" }).route).toBe(false);
    expect(decideRoutingNeed({ ...base, ownerId: null, owner: null, assignmentSource: "manual", force: true }).route).toBe(true);
  });
  it("closed leads are never routed", () => {
    expect(decideRoutingNeed({ ...base, hasOpenOpportunity: false, ownerId: null }).route).toBe(false);
  });
});
