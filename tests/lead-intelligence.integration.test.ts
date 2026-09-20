/**
 * Phase 3 integration tests against real Postgres (TEST_DATABASE_URL).
 * TEST SCENARIOS ONLY — all leads here are fictional (.example domains).
 */
import { hasTestDb } from "./helpers/test-db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDb, getDb } from "@/db/client";
import { auditLogs, contacts, leadScores, opportunities, routingDecisions, routingRules, users } from "@/db/schema";
import { seedDatabase } from "@/db/seed";
import { createContact, updateContact } from "@/server/services/contacts";
import { logInboundReply, loadWorkload, recalculateScore, routeLead, updateRepStatus } from "@/server/services/lead-intelligence";
import { saveRoutingRule } from "@/server/services/routing-rules";
import type { Actor } from "@/server/services/types";

const actor: Actor = { type: "user", userId: null, label: "test-runner" };
const db = () => getDb();

async function repId(email: string) {
  const [u] = await db().select().from(users).where(eq(users.email, email));
  return u.id;
}
async function contactByEmail(email: string) {
  const [c] = await db().select().from(contacts).where(eq(contacts.emailNormalized, email));
  return c;
}
async function events(contactId: string) {
  return (await db().select({ e: auditLogs.eventType }).from(auditLogs).where(eq(auditLogs.contactId, contactId))).map((r) => r.e);
}
async function resetReps() {
  await db().update(users).set({ isAvailable: true, isActive: true, maxOpenLeads: 25 }).where(eq(users.role, "sales_rep"));
  await db().update(users).set({ isAvailable: false }).where(eq(users.email, "liam@leadflow.example")); // seed state
  await db().update(routingRules).set({ isActive: true });
}

describe.skipIf(!hasTestDb)("scoring + routing (integration)", () => {
  beforeAll(async () => {
    await migrate(db(), { migrationsFolder: "./drizzle" });
    await seedDatabase(db());
  });
  beforeEach(resetReps);
  afterAll(async () => {
    await closeDb();
  });

  it("seed: every lead has a persisted score, and new leads were routed by the engine", async () => {
    const [{ unscored }] = await db().select({ unscored: sql<number>`count(*) filter (where lead_score is null)::int` }).from(contacts);
    expect(unscored).toBe(0);
    const decisions = await db().select().from(routingDecisions);
    expect(decisions.length).toBe(4);
    expect(decisions.every((d) => d.trigger === "seed" && d.outcome === "assigned")).toBe(true);
  });

  it("new lead → scored, assigned by rule, decision + audit persisted", async () => {
    const r = await createContact(db(), actor, {
      firstName: "Test", lastName: "Route", email: "route1@test.example", phone: "+1 415 555 0170", country: "US",
      leadSource: "google_ads", serviceInterest: "crm_automation", budgetAmount: "12000", company: "Route Co",
    });
    expect(r.status).toBe("created");
    if (r.status !== "created") return;
    expect(r.intelligence.errors).toEqual([]);
    expect(r.intelligence.routing).toMatchObject({ status: "assigned", userName: "Daniel Brooks" });
    const c = await contactByEmail("route1@test.example");
    expect(c.ownerId).toBe(await repId("daniel@leadflow.example"));
    expect(c.assignmentSource).toBe("routing");
    expect(c.leadScore).toBeGreaterThan(0);
    const [opp] = await db().select().from(opportunities).where(eq(opportunities.contactId, c.id));
    expect(opp.ownerId).toBe(c.ownerId); // opportunity follows the contact owner
    const [d] = await db().select().from(routingDecisions).where(eq(routingDecisions.contactId, c.id));
    expect(d).toMatchObject({ outcome: "assigned", ruleName: "CRM automation — North America", trigger: "contact.created" });
    expect(await events(c.id)).toEqual(expect.arrayContaining(["contact.created", "lead.scored", "owner.assigned"]));
  });

  it("score is recalculated when details change; owner stays (sticky); history row added", async () => {
    const c = await contactByEmail("route1@test.example");
    const before = c.leadScore!;
    const r = await updateContact(db(), actor, c.id, {
      firstName: "Test", lastName: "Route", email: "route1@test.example", phone: "+1 415 555 0170", country: "US",
      leadSource: "google_ads", serviceInterest: "crm_automation", budgetAmount: "800", company: "Route Co",
    });
    expect(r.status).toBe("updated");
    if (r.status !== "updated") return;
    expect(r.intelligence.score?.result.score).toBe(before - 28); // budget 30 → 2
    expect(r.intelligence.routing).toMatchObject({ status: "skipped", reason: expect.stringMatching(/sticky/) });
    const history = await db().select().from(leadScores).where(eq(leadScores.contactId, c.id));
    expect(history.length).toBe(2);
    expect(history.map((h) => h.trigger)).toEqual(expect.arrayContaining(["contact.created", "contact.updated"]));
  });

  it("recalculating with no change is idempotent (no new history, no audit noise)", async () => {
    const c = await contactByEmail("route1@test.example");
    const count = async () => (await db().select().from(leadScores).where(eq(leadScores.contactId, c.id))).length;
    const auditCount = async () => (await events(c.id)).filter((e) => e === "lead.scored").length;
    const [h0, a0] = [await count(), await auditCount()];
    const r = await recalculateScore(db(), actor, c.id, "manual");
    expect(r?.changed).toBe(false);
    expect([await count(), await auditCount()]).toEqual([h0, a0]);
  });

  it("logging an inbound reply raises engagement + response", async () => {
    const c = await contactByEmail("route1@test.example");
    const r = await logInboundReply(db(), actor, c.id, { channel: "email", body: "Yes, let's talk next week" });
    expect(r.status).toBe("logged");
    if (r.status !== "logged") return;
    const resp = r.outcome;
    const f = resp.score!.result.factors;
    expect(f.find((x) => x.factor === "response")!.points).toBe(15);
    expect(resp.score!.result.score).toBeGreaterThan(c.leadScore!);
    expect(await events(c.id)).toContain("message.received");
    expect((await logInboundReply(db(), actor, c.id, { body: "" })).status).toBe("invalid");
  });

  it("no eligible rep → visible Unassigned with reason; repeating does not duplicate history", async () => {
    await db().update(users).set({ isAvailable: false }).where(inArray(users.email, ["daniel@leadflow.example", "neha@leadflow.example"]));
    const r = await createContact(db(), actor, { firstName: "Nobody", email: "noone@test.example", country: "US", leadSource: "website_form", serviceInterest: "crm_automation" });
    if (r.status !== "created") throw new Error(r.status);
    expect(r.intelligence.routing?.status).toBe("unassigned");
    const c = await contactByEmail("noone@test.example");
    expect(c.ownerId).toBeNull();
    expect(c.unassignedReason).toMatch(/Daniel Brooks unavailable/);
    expect(c.unassignedReason).toMatch(/does not handle crm_automation/); // fallback refused non-specialists
    const again = await routeLead(db(), actor, c.id, { trigger: "retry" });
    expect(again.status).toBe("unchanged");
    const decisions = await db().select().from(routingDecisions).where(eq(routingDecisions.contactId, c.id));
    expect(decisions).toHaveLength(1);
    expect(await events(c.id)).toContain("lead.unassigned");
  });

  it("rep becomes available → waiting unassigned leads are routed to them", async () => {
    await db().update(users).set({ isAvailable: false }).where(eq(users.email, "neha@leadflow.example"));
    await db().update(users).set({ isAvailable: false }).where(eq(users.email, "daniel@leadflow.example"));
    const daniel = await repId("daniel@leadflow.example");
    const r = await updateRepStatus(db(), actor, daniel, { isAvailable: true });
    expect(r.status).toBe("updated");
    const c = await contactByEmail("noone@test.example");
    expect(c.ownerId).toBe(daniel);
    expect(c.unassignedReason).toBeNull();
  });

  it("rep becomes unavailable → only NOT-yet-contacted leads move; in-conversation leads stay", async () => {
    const aarav = await repId("aarav@leadflow.example");
    const priya = await contactByEmail("priya@sharmadental.example"); // new_lead, routed to Aarav
    const ananya = await contactByEmail("ananya@iyerco.example"); // contacted, owned by Aarav
    expect(priya.ownerId).toBe(aarav);
    expect(ananya.ownerId).toBe(aarav);
    const r = await updateRepStatus(db(), actor, aarav, { isAvailable: false });
    expect(r.status).toBe("updated");
    const p2 = await contactByEmail("priya@sharmadental.example");
    expect(p2.ownerId).not.toBe(aarav);
    expect(p2.ownerId).toBe(await repId("neha@leadflow.example")); // same regional rule
    expect((await contactByEmail("ananya@iyerco.example")).ownerId).toBe(aarav);
    expect(await events(priya.id)).toContain("owner.reassigned");
  });

  it("duplicate routing requests for the same lead: exactly one assignment", async () => {
    await db().update(users).set({ isAvailable: false }).where(inArray(users.email, ["daniel@leadflow.example", "neha@leadflow.example"]));
    const r = await createContact(db(), actor, { firstName: "Twice", email: "twice@test.example", country: "US", leadSource: "website_form", serviceInterest: "crm_automation" });
    if (r.status !== "created") throw new Error(r.status);
    await db().update(users).set({ isAvailable: true }).where(eq(users.email, "daniel@leadflow.example"));
    const c = await contactByEmail("twice@test.example");
    const results = await Promise.all(Array.from({ length: 4 }, () => routeLead(db(), actor, c.id, { trigger: "dup-test" })));
    expect(results.filter((x) => x.status === "assigned")).toHaveLength(1);
    expect(results.filter((x) => x.status === "skipped")).toHaveLength(3);
    const assigned = await db().select().from(routingDecisions).where(and(eq(routingDecisions.contactId, c.id), eq(routingDecisions.outcome, "assigned")));
    expect(assigned).toHaveLength(1);
  });

  it("concurrent assignments never exceed a rep's capacity", async () => {
    // Test scenario: only Sophie can take Brazil leads and she has exactly ONE free slot.
    const sophie = await repId("sophie@leadflow.example");
    const [br] = await db().insert(routingRules).values({ name: "TEST Brazil", priority: 1, conditions: { countries: ["BR"] }, strategy: "assign_user", targetUserIds: [sophie] }).returning();
    await db().update(routingRules).set({ isActive: false }).where(ne(routingRules.id, br.id));
    const load = (await loadWorkload(db())).get(sophie) ?? 0;
    await db().update(users).set({ maxOpenLeads: load + 1 }).where(eq(users.id, sophie));

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        createContact(db(), actor, { firstName: `Brasil${i}`, email: `br${i}@test.example`, country: "BR", leadSource: "website_form", serviceInterest: "seo" }),
      ),
    );
    const outcomes = results.map((r) => (r.status === "created" ? r.intelligence.routing?.status : r.status));
    expect(outcomes.filter((o) => o === "assigned")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "unassigned")).toHaveLength(4);
    expect((await loadWorkload(db())).get(sophie)).toBe(load + 1);
    const unassigned = await db().select().from(contacts).where(and(eq(contacts.country, "BR"), sql`owner_id is null`));
    expect(unassigned.every((c) => /at capacity/.test(c.unassignedReason ?? ""))).toBe(true);
    await db().delete(routingRules).where(eq(routingRules.id, br.id));
  });

  it("a manual owner choice is never overridden by automatic routing", async () => {
    const c = await contactByEmail("twice@test.example");
    const sophie = await repId("sophie@leadflow.example");
    const u = await updateContact(db(), actor, c.id, { firstName: "Twice", email: "twice@test.example", country: "US", leadSource: "website_form", serviceInterest: "crm_automation", ownerId: sophie });
    expect(u.status).toBe("updated");
    expect((await contactByEmail("twice@test.example")).assignmentSource).toBe("manual");
    await updateRepStatus(db(), actor, sophie, { isAvailable: false });
    expect((await contactByEmail("twice@test.example")).ownerId).toBe(sophie);
    expect((await routeLead(db(), actor, c.id, { trigger: "t" })).status).toBe("skipped");
  });

  it("routing rules: invalid input rejected; a new rule routes waiting leads; changes audited", async () => {
    const bad = await saveRoutingRule(db(), actor, null, { name: "x", priority: "0", strategy: "round_robin", isActive: true, services: "", countries: "Brazil", sources: "", requireServiceExpertise: false, targetUserIds: "" });
    expect(bad.status).toBe("invalid");
    if (bad.status === "invalid") expect(Object.keys(bad.errors)).toEqual(expect.arrayContaining(["name", "priority", "countries", "targetUserIds"]));

    // 4 never fit + 1 released when Sophie became unavailable in the previous test (not contacted yet → policy reroutes it).
    const waiting = await db().select().from(contacts).where(and(eq(contacts.country, "BR"), sql`owner_id is null`));
    expect(waiting.length).toBe(5);
    const aarav = await repId("aarav@leadflow.example");
    const ok = await saveRoutingRule(db(), actor, null, { name: "TEST Brazil overflow", priority: "5", strategy: "least_loaded", isActive: true, services: "", countries: "br", sources: "", minBudget: "", requireServiceExpertise: false, targetUserIds: aarav });
    // 5 Brazil leads + Hannah (DE, not yet contacted), who was released when Sophie became
    // unavailable in the previous test. Saving a rule retries EVERY waiting lead.
    expect(ok).toMatchObject({ status: "saved", rerouted: 6 });
    expect((await contactByEmail("hannah@fischerbikes.example")).ownerId).toBe(await repId("sophie@leadflow.example"));
    const after = await db().select().from(contacts).where(and(eq(contacts.country, "BR"), sql`owner_id is null`));
    expect(after).toHaveLength(0);
    const [audit] = await db().select().from(auditLogs).where(eq(auditLogs.eventType, "routing_rule.created"));
    expect(audit.message).toContain("TEST Brazil overflow");
  });

  it("owner changes keep opportunities in sync and workload counts only open leads", async () => {
    const wl = await loadWorkload(db());
    const [{ n }] = await db().select({ n: sql<number>`count(*)::int` }).from(contacts).where(sql`owner_id is not null and exists (select 1 from opportunities o where o.contact_id = contacts.id and o.status='open')`);
    expect([...wl.values()].reduce((a, b) => a + b, 0)).toBe(n);
    const mismatched = await db().execute(sql`select 1 from opportunities o join contacts c on c.id = o.contact_id where o.status = 'open' and o.owner_id is distinct from c.owner_id`);
    expect(mismatched.length).toBe(0);
  });
});
