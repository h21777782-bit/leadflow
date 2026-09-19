/**
 * Phase 2 service tests against a real Postgres (TEST_DATABASE_URL).
 * These prove the write paths do what the UI claims: duplicates are caught,
 * stage history and audit rows are written in the same transaction.
 */
import { hasTestDb } from "./helpers/test-db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDb, getDb } from "@/db/client";
import { auditLogs, contacts, opportunities, stageHistory } from "@/db/schema";
import { seedDatabase } from "@/db/seed";
import { createContact, mergeIntoContact, updateContact } from "@/server/services/contacts";
import { changeStage, createOpportunity } from "@/server/services/opportunities";
import type { Actor } from "@/server/services/types";

const actor: Actor = { type: "user", userId: null, label: "test-runner" };

async function auditFor(contactId: string) {
  return getDb().select().from(auditLogs).where(eq(auditLogs.contactId, contactId)).orderBy(desc(auditLogs.createdAt));
}

describe.skipIf(!hasTestDb)("contact & opportunity services (integration)", () => {
  beforeAll(async () => {
    await migrate(getDb(), { migrationsFolder: "./drizzle" });
    await seedDatabase(getDb());
  });
  afterAll(async () => {
    await closeDb();
  });

  it("creates a contact + New-lead opportunity + history + audit in one go", async () => {
    const r = await createContact(getDb(), actor, {
      firstName: "Test", lastName: "Create", email: "create@test.example", phone: "+91 90000 11111",
      leadSource: "website_form", serviceInterest: "seo", budgetAmount: "3000", tags: "phase-2-test",
    });
    expect(r.status).toBe("created");
    if (r.status !== "created") return;
    const [opp] = await getDb().select().from(opportunities).where(eq(opportunities.contactId, r.contactId));
    expect(opp.stage).toBe("new_lead");
    expect(opp.valueAmount).toBe(3000);
    const hist = await getDb().select().from(stageHistory).where(eq(stageHistory.opportunityId, opp.id));
    expect(hist).toHaveLength(1);
    const events = (await auditFor(r.contactId)).map((a) => a.eventType);
    expect(events).toEqual(expect.arrayContaining(["contact.created", "opportunity.created"]));
  });

  it("detects a duplicate by email regardless of case/whitespace", async () => {
    const r = await createContact(getDb(), actor, { firstName: "Priya", email: "  PRIYA@SharmaDental.example", leadSource: "google_ads" });
    expect(r.status).toBe("duplicate");
    if (r.status === "duplicate") {
      expect(r.matches[0].name).toBe("Priya Sharma");
      expect(r.matches[0].matchedOn).toEqual(["email"]);
    }
  });

  it("detects a duplicate by phone typed in a different format", async () => {
    const r = await createContact(getDb(), actor, { firstName: "P", phone: "098220 11234", country: "IN", leadSource: "referral" });
    expect(r.status).toBe("duplicate");
    if (r.status === "duplicate") expect(r.matches[0].matchedOn).toEqual(["phone"]);
  });

  it("reports BOTH people when email matches one contact and phone matches another", async () => {
    const r = await createContact(getDb(), actor, {
      firstName: "Mixed", email: "priya@sharmadental.example", phone: "+1 646 555 0142", leadSource: "referral",
    });
    expect(r.status).toBe("duplicate");
    if (r.status === "duplicate") expect(r.matches.map((m) => m.name).sort()).toEqual(["Marcus Reid", "Priya Sharma"]);
  });

  it("creates exactly ONE contact when the same lead is submitted 5 times concurrently", async () => {
    const payload = { firstName: "Race", email: "race@test.example", leadSource: "meta_ads" };
    const results = await Promise.all(Array.from({ length: 5 }, () => createContact(getDb(), actor, payload)));
    expect(results.filter((r) => r.status === "created")).toHaveLength(1);
    expect(results.filter((r) => r.status === "duplicate")).toHaveLength(4);
    const [{ n }] = await getDb().select({ n: sql<number>`count(*)::int` }).from(contacts).where(eq(contacts.emailNormalized, "race@test.example"));
    expect(n).toBe(1);
  });

  it("returns field errors instead of throwing on invalid input", async () => {
    const r = await createContact(getDb(), actor, { firstName: "", leadSource: "nope" });
    expect(r.status).toBe("invalid");
    if (r.status === "invalid") expect(Object.keys(r.errors)).toEqual(expect.arrayContaining(["firstName", "leadSource", "email"]));
  });

  it("updates a contact, audits changed fields, and records a manual owner override", async () => {
    const db = getDb();
    const [c] = await db.select().from(contacts).where(eq(contacts.emailNormalized, "create@test.example"));
    const [admin] = await db.execute<{ id: string }>(sql`select id from users where email = 'daniel@leadflow.example'`);
    const r = await updateContact(db, actor, c.id, {
      firstName: "Test", lastName: "Create", email: "create@test.example", phone: "+91 90000 11111",
      leadSource: "website_form", serviceInterest: "seo", budgetAmount: 4500, company: "Edited Co", ownerId: admin.id,
    });
    expect(r.status).toBe("updated");
    if (r.status === "updated") expect(r.changedFields).toEqual(expect.arrayContaining(["budgetAmount", "company", "ownerId"]));
    const events = (await auditFor(c.id)).map((a) => a.eventType);
    expect(events).toEqual(expect.arrayContaining(["contact.updated", "owner.changed"]));
    const again = await updateContact(db, actor, c.id, {
      firstName: "Test", lastName: "Create", email: "create@test.example", phone: "+91 90000 11111",
      leadSource: "website_form", serviceInterest: "seo", budgetAmount: 4500, company: "Edited Co", ownerId: admin.id,
    });
    expect(again.status).toBe("unchanged");
  });

  it("refuses to update a contact to another contact's email", async () => {
    const [c] = await getDb().select().from(contacts).where(eq(contacts.emailNormalized, "create@test.example"));
    const r = await updateContact(getDb(), actor, c.id, { firstName: "Test", email: "ethan@walkerhvac.example", leadSource: "website_form" });
    expect(r.status).toBe("duplicate");
  });

  it("merges a duplicate submission without erasing data and unions tags", async () => {
    const db = getDb();
    const [priya] = await db.select().from(contacts).where(eq(contacts.emailNormalized, "priya@sharmadental.example"));
    const r = await mergeIntoContact(db, actor, priya.id, {
      firstName: "Priya", email: "priya@sharmadental.example", leadSource: "google_ads", tags: "returning", notes: "Asked again via Google Ads",
    });
    expect(r.status).toBe("merged");
    const [after] = await db.select().from(contacts).where(eq(contacts.id, priya.id));
    expect(after.phone).toBe(priya.phone); // empty incoming phone did not erase it
    expect(after.lastName).toBe("Sharma");
    expect(after.tags).toEqual(expect.arrayContaining([...priya.tags, "returning"]));
    expect(after.notes).toContain("Asked again via Google Ads");
    expect((await auditFor(priya.id)).some((a) => a.eventType === "contact.merged")).toBe(true);
  });

  it("changes stage: writes stage_history + audit and sets status/timestamps", async () => {
    const db = getDb();
    const [c] = await db.select().from(contacts).where(eq(contacts.emailNormalized, "create@test.example"));
    const [opp] = await db.select().from(opportunities).where(eq(opportunities.contactId, c.id));
    const r1 = await changeStage(db, actor, { opportunityId: opp.id, toStage: "qualified", expectedFromStage: "new_lead" });
    expect(r1).toEqual({ status: "changed", from: "new_lead", to: "qualified" });
    const r2 = await changeStage(db, actor, { opportunityId: opp.id, toStage: "won" });
    expect(r2.status).toBe("changed");
    const [won] = await db.select().from(opportunities).where(eq(opportunities.id, opp.id));
    expect(won.status).toBe("won");
    expect(won.wonAt).not.toBeNull();
    const hist = await db.select().from(stageHistory).where(eq(stageHistory.opportunityId, opp.id));
    expect(hist.map((h) => h.toStage)).toEqual(["new_lead", "qualified", "won"]);
    const events = (await auditFor(c.id)).map((a) => a.eventType);
    expect(events).toEqual(expect.arrayContaining(["stage.changed", "opportunity.won"]));
  });

  it("refuses lost without a reason and a stale move (conflict), writing nothing", async () => {
    const db = getDb();
    const [c] = await db.select().from(contacts).where(eq(contacts.emailNormalized, "ethan@walkerhvac.example"));
    const [opp] = await db.select().from(opportunities).where(eq(opportunities.contactId, c.id));
    const before = await db.select().from(stageHistory).where(eq(stageHistory.opportunityId, opp.id));
    expect((await changeStage(db, actor, { opportunityId: opp.id, toStage: "lost" })).status).toBe("invalid");
    const stale = await changeStage(db, actor, { opportunityId: opp.id, toStage: "contacted", expectedFromStage: "qualified" });
    expect(stale.status).toBe("conflict");
    expect((await changeStage(db, actor, { opportunityId: opp.id, toStage: "bogus" })).status).toBe("invalid");
    const after = await db.select().from(stageHistory).where(eq(stageHistory.opportunityId, opp.id));
    expect(after).toHaveLength(before.length);
  });

  it("serializes two simultaneous drags of the same card: one wins, one gets a conflict", async () => {
    const db = getDb();
    const [c] = await db.select().from(contacts).where(eq(contacts.emailNormalized, "omar@haddadrealty.example"));
    const [opp] = await db.select().from(opportunities).where(eq(opportunities.contactId, c.id));
    const results = await Promise.all([
      changeStage(db, actor, { opportunityId: opp.id, toStage: "contacted", expectedFromStage: "new_lead" }),
      changeStage(db, actor, { opportunityId: opp.id, toStage: "qualified", expectedFromStage: "new_lead" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["changed", "conflict"]);
  });

  it("marks a deal lost with a reason and allows reopening only with a reason (manual override)", async () => {
    const db = getDb();
    const [c] = await db.select().from(contacts).where(eq(contacts.emailNormalized, "grace@brightside.example"));
    const [opp] = await db.select().from(opportunities).where(eq(opportunities.contactId, c.id));
    expect((await changeStage(db, actor, { opportunityId: opp.id, toStage: "lost", reason: "Went silent" })).status).toBe("changed");
    const [lost] = await db.select().from(opportunities).where(eq(opportunities.id, opp.id));
    expect(lost.lostReason).toBe("Went silent");
    expect((await changeStage(db, actor, { opportunityId: opp.id, toStage: "qualified" })).status).toBe("invalid");
    expect((await changeStage(db, actor, { opportunityId: opp.id, toStage: "qualified", reason: "Replied with budget" })).status).toBe("changed");
    const [reopened] = await db.select().from(opportunities).where(eq(opportunities.id, opp.id));
    expect(reopened.status).toBe("open");
    expect(reopened.lostReason).toBeNull();
    const override = await db.select().from(auditLogs).where(and(eq(auditLogs.contactId, c.id), eq(auditLogs.eventType, "manual.override")));
    expect(override).toHaveLength(1);
  });

  it("creates an additional opportunity for an existing contact", async () => {
    const db = getDb();
    const [c] = await db.select().from(contacts).where(eq(contacts.emailNormalized, "laura@alpenphysio.example"));
    const r = await createOpportunity(db, actor, c.id, { title: "Alpen Physio — Paid ads add-on", valueAmount: "1800" });
    expect(r.status).toBe("created");
    const opps = await db.select().from(opportunities).where(eq(opportunities.contactId, c.id));
    expect(opps).toHaveLength(2);
    expect((await createOpportunity(db, actor, c.id, { title: "x", valueAmount: -1 })).status).toBe("invalid");
  });
});
